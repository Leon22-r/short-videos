// Grouping that PostgREST cannot do. Counts that must be exact are views
// (migration 014); this is for the one roll-up that keeps a row's text — the
// newest message per group — which a GROUP BY view cannot return cheaply.
//
// Pure functions, no I/O and no environment, so each one is testable on its own.

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

module.exports = { groupErrors };
