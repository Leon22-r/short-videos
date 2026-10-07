function defaultCompare(sortKey) {
  return (a, b) => {
    const av = String(a[sortKey] || '');
    const bv = String(b[sortKey] || '');
    if (av && bv && av !== bv) return av.localeCompare(bv);
    if (av && !bv) return -1;
    if (!av && bv) return 1;
    return 0;
  };
}

function pickFairBySource(rows, options = {}) {
  const limit = Number(options.limit || rows.length || 0);
  const perSourceLimit = Number(options.perSourceLimit || limit || 1);
  const sourceKey = options.sourceKey || 'source_id';
  const fallbackKeys = options.fallbackKeys || [];
  const compare = options.compare || defaultCompare(options.sortKey || 'created_at');

  if (limit <= 0 || perSourceLimit <= 0) return [];

  const buckets = new Map();
  for (const row of rows || []) {
    const keyValues = [sourceKey, ...fallbackKeys].map((key) => row[key]).filter(Boolean);
    const source = String(keyValues[0] || '__unknown__');
    if (!buckets.has(source)) buckets.set(source, []);
    buckets.get(source).push(row);
  }

  const sourceOrder = [...buckets.keys()];
  for (const source of sourceOrder) {
    buckets.get(source).sort(compare);
  }

  const picked = [];
  const pickedBySource = {};
  let madeProgress = true;

  while (picked.length < limit && madeProgress) {
    madeProgress = false;
    for (const source of sourceOrder) {
      if (picked.length >= limit) break;
      pickedBySource[source] = pickedBySource[source] || 0;
      if (pickedBySource[source] >= perSourceLimit) continue;

      const bucket = buckets.get(source);
      if (!bucket || bucket.length === 0) continue;

      picked.push(bucket.shift());
      pickedBySource[source] += 1;
      madeProgress = true;
    }
  }

  return picked;
}

function pickFairByGroup(rows, options = {}) {
  const limit = Number(options.limit || (rows || []).length || 0);
  const perSourceLimit = Number(options.perSourceLimit || limit || 1);
  const groupKey = options.groupKey || 'niche';
  const groupFallbackKeys = options.groupFallbackKeys || [];
  const sourceKey = options.sourceKey || 'source_id';
  const sourceFallbackKeys = options.sourceFallbackKeys || [];
  const compare = options.compare || defaultCompare(options.sortKey || 'created_at');

  if (limit <= 0 || perSourceLimit <= 0) return [];

  const groups = new Map();
  for (const row of rows || []) {
    const groupValues = [groupKey, ...groupFallbackKeys].map((key) => row[key]).filter(Boolean);
    const sourceValues = [sourceKey, ...sourceFallbackKeys].map((key) => row[key]).filter(Boolean);
    const group = String(groupValues[0] || '__unknown_group__');
    const source = String(sourceValues[0] || '__unknown_source__');

    if (!groups.has(group)) {
      groups.set(group, {
        sourceOrder: [],
        buckets: new Map(),
        pickedBySource: {},
        nextSourceIndex: 0,
      });
    }
    const groupBucket = groups.get(group);
    if (!groupBucket.buckets.has(source)) {
      groupBucket.buckets.set(source, []);
      groupBucket.sourceOrder.push(source);
    }
    groupBucket.buckets.get(source).push(row);
  }

  const groupOrder = [...groups.keys()];
  for (const group of groupOrder) {
    const groupBucket = groups.get(group);
    for (const source of groupBucket.sourceOrder) {
      groupBucket.buckets.get(source).sort(compare);
    }
  }

  function pickFromGroup(groupBucket) {
    const totalSources = groupBucket.sourceOrder.length;
    if (totalSources === 0) return null;

    for (let attempts = 0; attempts < totalSources; attempts += 1) {
      const index = (groupBucket.nextSourceIndex + attempts) % totalSources;
      const source = groupBucket.sourceOrder[index];
      groupBucket.pickedBySource[source] = groupBucket.pickedBySource[source] || 0;
      if (groupBucket.pickedBySource[source] >= perSourceLimit) continue;

      const bucket = groupBucket.buckets.get(source);
      if (!bucket || bucket.length === 0) continue;

      groupBucket.nextSourceIndex = (index + 1) % totalSources;
      groupBucket.pickedBySource[source] += 1;
      return bucket.shift();
    }

    return null;
  }

  const picked = [];
  let madeProgress = true;
  while (picked.length < limit && madeProgress) {
    madeProgress = false;
    for (const group of groupOrder) {
      if (picked.length >= limit) break;
      const row = pickFromGroup(groups.get(group));
      if (!row) continue;
      picked.push(row);
      madeProgress = true;
    }
  }

  return picked;
}

module.exports = {
  pickFairByGroup,
  pickFairBySource,
};
