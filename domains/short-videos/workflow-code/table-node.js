const fs = require('node:fs');
const path = require('node:path');

const DOMAIN_ROOT = path.join(__dirname, '..');

const querySql = (name) => fs.readFileSync(
  path.join(DOMAIN_ROOT, 'postgres/queries', `${name}.sql`), 'utf8').trim();

// typeVersion 2.6 and this options block match the Postgres nodes the
// publishing workflows already use, so there is one node shape in the repo.
// replaceEmptyStrings stays true: with nullable columns (D6) an empty field
// becoming NULL is now the correct behaviour rather than a workaround.
const postgresNode = (id, name, position, query, queryReplacement = '', extra = {}) => ({
  id,
  name,
  type: 'n8n-nodes-base.postgres',
  typeVersion: 2.6,
  position,
  parameters: {
    resource: 'database',
    operation: 'executeQuery',
    query,
    options: { queryBatching: 'single', queryReplacement, replaceEmptyStrings: true },
  },
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 5000,
  ...extra,
});

// The Code nodes downstream were written against "every row in the tab", so
// a plain SELECT keeps them working unchanged. Fair-share still runs in
// JavaScript (spec Section 2).
const selectAll = (table) => `SELECT * FROM short_videos.${table};`;

// One atomic statement replacing Sheets' read-then-write appendOrUpdate.
// Follows upsert-publishing-jobs.sql: the rows arrive as a jsonb array in $1.
const upsertFromJsonb = ({ table, key, columns }) => {
  const assignments = columns
    .filter((column) => column !== key)
    .map((column) => `  ${column} = EXCLUDED.${column}`)
    .join(',\n');
  return `WITH incoming AS (
  SELECT value AS row
  FROM jsonb_array_elements($1::jsonb)
  WHERE NULLIF(btrim(value->>'${key}'), '') IS NOT NULL
)
INSERT INTO short_videos.${table} (${columns.join(', ')})
SELECT ${columns.map((column) => `  row->>'${column}'`).join(',\n       ')}
FROM incoming
ON CONFLICT (${key}) DO UPDATE SET
${assignments}
RETURNING *;`;
};

module.exports = { querySql, postgresNode, selectAll, upsertFromJsonb };
