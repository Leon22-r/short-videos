// Grouping that PostgREST cannot do. It has no GROUP BY, and the alternative
// is a view per roll-up; at this scale (a few hundred rows read with one or two
// columns selected) grouping here is cheaper than more schema.
//
// Pure functions, no I/O and no environment, so each one is testable on its own.

const dayKey = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
};

// error_log rows grouped by the workflow and node that raised them, newest
// message kept. The raw payload is deliberately not carried through: it holds
// provider references and credential slots and has no place in a page.
const groupErrors = (rows = []) => {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.workflow_name || ''}\u0000${row.node_name || ''}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        workflow_name: row.workflow_name || '',
        node_name: row.node_name || '',
        count: 1,
        latest: row.created_at,
        error_message: row.error_message || '',
      });
      continue;
    }
    existing.count += 1;
    if (new Date(row.created_at) > new Date(existing.latest)) {
      existing.latest = row.created_at;
      existing.error_message = row.error_message || '';
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count
    || String(a.workflow_name).localeCompare(String(b.workflow_name)));
};

// Clips created, approved and rejected per day. Approvals are counted from the
// clip's own status rather than approved_for_posting, so one read covers all
// three columns and the ratio always refers to the same population.
const dailyThroughput = (clips = [], days = 7, now = Date.now()) => {
  const buckets = new Map();
  for (let back = days - 1; back >= 0; back -= 1) {
    buckets.set(dayKey(now - back * 86400000), { day: '', created: 0, approved: 0, rejected: 0 });
  }
  for (const [day, bucket] of buckets) bucket.day = day;
  for (const clip of clips) {
    const bucket = buckets.get(dayKey(clip.created_at));
    if (!bucket) continue;
    bucket.created += 1;
    if (clip.review_status === 'APPROVED') bucket.approved += 1;
    if (clip.review_status === 'REJECTED') bucket.rejected += 1;
  }
  return [...buckets.values()];
};

// Which gate is eating the inventory. One video failing a rule is an override;
// a whole class failing it is a threshold to change, and that only shows up
// once they are counted together.
const countReasons = (rows = []) => {
  const counts = new Map();
  for (const row of rows) {
    const reason = row.rejection_reason || '';
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
};

module.exports = { groupErrors, dailyThroughput, countReasons, dayKey };
