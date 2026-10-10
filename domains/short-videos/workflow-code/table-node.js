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
// Follows upsert-publishing-jobs.sql in taking the rows as a jsonb array in
// $1, but it cannot reuse that file's `row->>'column'` projection: that works
// only because publishing_jobs is entirely text. The pipeline-store tables
// have integer, bigint, numeric, boolean and timestamptz columns, and Postgres
// will not implicitly cast text to those in an INSERT — it fails with
// `column "duration_seconds" is of type integer but expression is of type
// text`. jsonb_populate_record casts through the table's own row type instead,
// so the statement needs no column-type list and cannot drift from the schema.
//
// Two further differences from a naive projection, both about what Sheets did:
//   - An empty string is stripped to absent before typing. '' is a valid text
//     value but not a valid integer or timestamp, and a blank cell was how
//     Sheets spelled "no value".
//   - `columns` is the list of columns the calling node actually writes, not
//     the table's full column list. Sheets' appendOrUpdate wrote the columns it
//     was given and left the rest, and naming them here is what reproduces
//     that: a wider list would blank every column the incoming row omits, and
//     coalescing to the stored row instead would make clearing a column
//     impossible — which WF2 needs when a backfill finishes and the page token
//     has to go away.
const upsertFromJsonb = ({ table, key, columns }) => {
  const qualified = `short_videos.${table}`;
  const assignments = columns
    .filter((column) => column !== key)
    .map((column) => `  ${column} = EXCLUDED.${column}`)
    .join(',\n');
  return `WITH incoming AS (
  SELECT (
    SELECT jsonb_object_agg(field.key, field.value)
    FROM jsonb_each(element) AS field
    WHERE NULLIF(btrim(field.value #>> '{}'), '') IS NOT NULL
  ) AS row
  FROM jsonb_array_elements($1::jsonb) AS element
  WHERE NULLIF(btrim(element->>'${key}'), '') IS NOT NULL
), typed AS (
  SELECT jsonb_populate_record(NULL::${qualified}, row) AS record
  FROM incoming
  WHERE row IS NOT NULL
)
INSERT INTO ${qualified} (${columns.join(', ')})
SELECT ${columns.map((column) => `(record).${column}`).join(',\n       ')}
FROM typed
ON CONFLICT (${key}) DO UPDATE SET
${assignments}
RETURNING *;`;
};

// A state transition on rows that already exist: WF3 classifying candidates,
// WF2 clearing a channel's backfill token. These cannot use the upsert above.
// `INSERT ... ON CONFLICT` builds the insert row first, so a statement naming
// only the columns it writes fails on every NOT NULL column it omits —
// `null value in column "niche" of relation "source_channels" violates
// not-null constraint` — even though the row exists and the intent is an
// update. An UPDATE names only what it changes, and a blank cell still lands
// as NULL, so clearing a column works.
//
// A key with no stored row is skipped rather than inserted. Every caller here
// is a transition on a row an earlier workflow created.
const updateFromJsonb = ({ table, key, columns }) => {
  const qualified = `short_videos.${table}`;
  const assignments = columns
    .filter((column) => column !== key)
    .map((column) => `  ${column} = (incoming.record).${column}`)
    .join(',\n');
  return `WITH rows AS (
  SELECT (
    SELECT jsonb_object_agg(field.key, field.value)
    FROM jsonb_each(element) AS field
    WHERE NULLIF(btrim(field.value #>> '{}'), '') IS NOT NULL
  ) AS row
  FROM jsonb_array_elements($1::jsonb) AS element
  WHERE NULLIF(btrim(element->>'${key}'), '') IS NOT NULL
), incoming AS (
  SELECT jsonb_populate_record(NULL::${qualified}, row) AS record
  FROM rows
  WHERE row IS NOT NULL
)
UPDATE ${qualified} AS target SET
${assignments}
FROM incoming
WHERE target.${key} = (incoming.record).${key}
RETURNING target.*;`;
};

module.exports = { querySql, postgresNode, selectAll, upsertFromJsonb, updateFromJsonb };
