# FFmpeg Render Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an automatic FFmpeg post-production workflow that renders one polished final MP4 after WF8 creates its transformation plan.

**Architecture:** Extend WF8's existing planner schema so it produces render-ready metadata, then have WF8 create a `Render_Jobs` row. Add a separate WF8c workflow that reads one pending render job, downloads the source clip/watermark/music from Drive into `/data`, runs FFmpeg inside the n8n container, uploads the final MP4 to a final-render Drive folder, and updates `Render_Jobs`.

**Tech Stack:** Node.js CommonJS helpers, n8n generated workflow JSON, Google Sheets and Drive nodes, OpenAI structured output node, Execute Command node, Docker Compose, FFmpeg filters (`scale`, `crop`, `boxblur`, `overlay`, `drawbox`, `drawtext`, `volume`, `aloop`, `amix`).

---

## Preflight Notes

The phase worktree currently has unrelated uncommitted WF8/WF8b/backfill changes:

```text
.gitignore
.superpowers/sdd/progress.md
docs/google-sheets-structure.md
n8n/workflow-code/create-remaining-workflows.js
n8n/workflow-code/drive-storage-transform.js
n8n/workflows/08-drive-storage-transform.json
tests/remaining-workflows.test.js
n8n/workflows/08b-created-clips-transform-backfill.json
```

Do not revert these. Work with them. When committing render work, stage only the files named in each task.

## File Structure

- Modify `docs/google-sheets-structure.md`: document `Render_Jobs`, `Music_Library`, and `Channel_Branding`.
- Create `n8n/Dockerfile`: custom n8n image with FFmpeg and DejaVu fonts.
- Modify `n8n/compose.local.yaml`: build/use custom image and mount `./render-data:/data`.
- Modify `n8n/compose.prod.yaml`: build/use custom image and mount `./render-data:/data`.
- Modify `.gitignore`: ignore render runtime data while allowing directory placeholders if needed.
- Modify `n8n/workflow-code/drive-storage-transform.js`: extend WF8 schema and create `Render_Jobs` rows.
- Create `n8n/workflow-code/ffmpeg-render.js`: pure helper for music/branding selection, render job state updates, command generation, and final update shaping.
- Modify `n8n/workflow-code/create-remaining-workflows.js`: generate WF8 changes and new WF8c.
- Modify `n8n/workflows/08-drive-storage-transform.json`: regenerate from the generator.
- Create `n8n/workflows/08c-ffmpeg-render-final-clip.json`: generated WF8c workflow.
- Modify `tests/remaining-workflows.test.js`: helper and workflow structure coverage.

## Task 1: Document Render Sheets

**Files:**
- Modify: `docs/google-sheets-structure.md`

- [ ] **Step 1: Update workbook tab count**

Change the intro line from:

```markdown
Create 8 tabs with EXACT names below. Paste each header row into cell A1 of the matching tab
```

to:

```markdown
Create 11 tabs with EXACT names below. Paste each header row into cell A1 of the matching tab
```

- [ ] **Step 2: Add `Render_Jobs` after `Created_Clips`**

Insert this section after the `Created_Clips` notes:

```markdown
## Tab 7: `Render_Jobs`

```
render_id	created_clip_id	niche	source_drive_file_id	source_drive_url	source_file_name	final_drive_folder_id	hook_text	cta_text	cta_start_second	cta_end_second	music_id	music_drive_file_id	music_file_name	music_volume	watermark_drive_file_id	watermark_file_name	progress_bar_color	use_blurred_background	ffmpeg_command	render_status	final_local_path	final_drive_file_id	final_drive_url	warning_message	error_message	created_at	started_at	completed_at
```

- `render_status`: `PENDING` -> `DOWNLOADING_ASSETS` -> `RENDERING` -> `UPLOADING` -> `COMPLETED`; terminal failures use `FAILED`; intentional non-work rows can use `SKIPPED`.
- WF8 creates one `PENDING` row after it successfully parses the transformation plan.
- WF8c processes one pending render per run. It stores the generated FFmpeg command and final Drive URL here.
- `warning_message` is used for recoverable issues such as missing music. Missing source clip, branding, watermark, FFmpeg failure, and final Drive upload failure use `FAILED`.
```

- [ ] **Step 3: Add `Music_Library`**

Insert this section after `Render_Jobs`:

```markdown
## Tab 8: `Music_Library`

```
music_id	niche	mood	energy_level	track_name	artist_name	source	source_url	license_notes	drive_file_id	duration_seconds	recommended_volume	loop_allowed	active_status	times_used	created_at	last_used_at	notes
```

- WF8c selects active tracks in this order: `niche + mood + energy_level`, `niche + mood`, `niche + energy_level`, `Channel_Branding.music_default_id`, then no music with a warning.
- `recommended_volume` is clamped by WF8c to `0.04-0.14`.
- Music files are downloaded from Google Drive into the per-render `/data/jobs/<render_id>/` workspace.
```

- [ ] **Step 4: Add `Channel_Branding`**

Insert this section after `Music_Library`:

```markdown
## Tab 9: `Channel_Branding`

```
niche	watermark_drive_file_id	primary_color	secondary_color	progress_bar_color	default_cta	music_default_id	active_status	notes
```

- Branding is niche-level in this phase.
- WF8c requires exactly one active branding row for the render job's niche.
- Missing branding or missing watermark is a hard render failure.
- `progress_bar_color` must use FFmpeg-safe `0xRRGGBB` format.
```

- [ ] **Step 5: Renumber the remaining tabs**

Change:

```markdown
## Tab 7: `Error_Log`
## Tab 8: `Approved_For_Posting`
```

to:

```markdown
## Tab 10: `Error_Log`
## Tab 11: `Approved_For_Posting`
```

- [ ] **Step 6: Update the state machine section**

Add this block below the existing `Created_Clips.review_status` block:

```text
Render_Jobs.render_status:
  PENDING --(WF8c picked)--> DOWNLOADING_ASSETS
  DOWNLOADING_ASSETS --(assets ready)--> RENDERING
  RENDERING --(ffmpeg ok)--> UPLOADING
  UPLOADING --(Drive upload ok)--> COMPLETED
  any step --(hard failure)--> FAILED
```

- [ ] **Step 7: Verify the doc update**

Run:

```bash
rg -n "Create 11 tabs|Render_Jobs|Music_Library|Channel_Branding|Render_Jobs.render_status" docs/google-sheets-structure.md
```

Expected: all five terms are present.

- [ ] **Step 8: Commit**

```bash
git add docs/google-sheets-structure.md
git commit -m "docs(n8n): add render workflow sheet schema"
```

## Task 2: Add FFmpeg Runtime Image

**Files:**
- Create: `n8n/Dockerfile`
- Modify: `n8n/compose.local.yaml`
- Modify: `n8n/compose.prod.yaml`
- Modify: `.gitignore`

- [ ] **Step 1: Create `n8n/Dockerfile`**

```dockerfile
ARG N8N_VERSION=2.25.7
FROM docker.n8n.io/n8nio/n8n:${N8N_VERSION}

USER root

RUN apk add --no-cache \
  ffmpeg \
  fontconfig \
  ttf-dejavu

RUN mkdir -p \
  /data/input/ssemble \
  /data/output/final \
  /data/assets/music \
  /data/assets/watermarks \
  /data/jobs \
  /data/logs \
  && chown -R node:node /data

USER node
```

- [ ] **Step 2: Update `n8n/compose.local.yaml` n8n service**

Replace the current n8n image line:

```yaml
    image: docker.n8n.io/n8nio/n8n:${N8N_VERSION:-2.25.7}
```

with:

```yaml
    build:
      context: .
      dockerfile: Dockerfile
      args:
        N8N_VERSION: ${N8N_VERSION:-2.25.7}
    image: short-videos/n8n-ffmpeg:${N8N_VERSION:-2.25.7}
```

Add this volume below `./local-files:/files`:

```yaml
      - ./render-data:/data
```

- [ ] **Step 3: Update `n8n/compose.prod.yaml` n8n service**

Make the same replacement and add the same `/data` volume:

```yaml
    build:
      context: .
      dockerfile: Dockerfile
      args:
        N8N_VERSION: ${N8N_VERSION:-2.25.7}
    image: short-videos/n8n-ffmpeg:${N8N_VERSION:-2.25.7}
```

```yaml
      - ./render-data:/data
```

- [ ] **Step 4: Ignore render runtime data**

Add this block to `.gitignore`:

```gitignore
# n8n FFmpeg render runtime data
n8n/render-data/*
!n8n/render-data/.gitkeep
```

- [ ] **Step 5: Create runtime directory placeholder**

Create `n8n/render-data/.gitkeep`.

- [ ] **Step 6: Verify compose parses**

Run:

```bash
docker compose -f n8n/compose.local.yaml config >/tmp/short-videos-compose-local.yaml
docker compose -f n8n/compose.prod.yaml config >/tmp/short-videos-compose-prod.yaml
rg -n "short-videos/n8n-ffmpeg|render-data:/data" /tmp/short-videos-compose-local.yaml /tmp/short-videos-compose-prod.yaml
```

Expected: both rendered compose configs include the custom image and `/data` mount.

- [ ] **Step 7: Commit**

```bash
git add .gitignore n8n/Dockerfile n8n/compose.local.yaml n8n/compose.prod.yaml n8n/render-data/.gitkeep
git commit -m "chore(n8n): add FFmpeg render runtime"
```

## Task 3: Extend WF8 Planner and Render Job Builder

**Files:**
- Modify: `n8n/workflow-code/drive-storage-transform.js`
- Modify: `tests/remaining-workflows.test.js`

- [ ] **Step 1: Update imports in `tests/remaining-workflows.test.js`**

Extend the existing destructuring import from `drive-storage-transform` to include:

```js
  buildRenderJobRow,
  normalizeRenderPlan,
```

- [ ] **Step 2: Add failing test for render schema**

Add this test after `WF8 planner request carries the strict JSON schema and schema instructions`:

```js
test('WF8 planner schema includes render instructions for FFmpeg', () => {
  const planner = buildPlannerRequest({
    created_clip_id: 'CC-1',
    niche: 'FINANCE_BUSINESS',
    clip_title: 'Money',
    duration_seconds: 45,
  });
  const schema = JSON.parse(planner.transformation_schema);

  assert(schema.required.includes('render'));
  assert.equal(schema.properties.render.type, 'object');
  assert(schema.properties.render.required.includes('top_hook_text'));
  assert(schema.properties.render.required.includes('music_mood'));
  assert(schema.properties.render.required.includes('progress_bar_color'));
  assert.match(planner.user_message, /captions are already burned/i);
  assert.match(planner.user_message, /FFmpeg render plan/i);
});
```

- [ ] **Step 3: Add failing test for render normalization and row creation**

Add this test after the parser field promotion test:

```js
test('WF8 builds normalized Render_Jobs rows from transformation plans', () => {
  const meta = {
    created_clip_id: 'CC-99',
    video_id: 'VID-99',
    niche: 'FINANCE_BUSINESS',
    drive_file_id: 'SRC-DRIVE-99',
    drive_url: 'https://drive/source',
    file_name: 'FINANCE_BUSINESS_CC-99.mp4',
  };
  const parsed = parseTransformationPlan(meta, {
    content_thesis: 'Money habits decide the outcome.',
    best_title: 'Track Your Money',
    alternative_titles: ['Know Where It Goes', 'Money Needs Direction'],
    hook: 'You cannot fix money you do not track.',
    narration_script: 'Track spending before chasing income.',
    commentary_angle: 'Make this practical for Kenyan earners.',
    kenyan_african_localization: 'Mention M-Pesa statements and chama discipline.',
    bible_verse_if_relevant: null,
    on_screen_text_beats: ['Track it', 'Review weekly'],
    broll_plan: ['Budget notebook'],
    editing_style: 'Clean finance education',
    caption: 'Track first. Optimize second.',
    hashtags: ['FinanceBusiness'],
    cta: 'Follow for practical money lessons.',
    risk_warning: 'No guaranteed results.',
    originality_checklist: ['Adds original commentary'],
    render: {
      top_hook_text: 'Why your money disappears',
      cta_text: 'Follow for practical money lessons',
      cta_start_second: 50,
      cta_end_second: 5,
      music_mood: 'focused',
      music_energy_level: 'medium',
      music_volume: 0.3,
      use_blurred_background: true,
      progress_bar_color: '#137546',
    },
  });

  const row = buildRenderJobRow(parsed, '2026-06-29T10:00:00.000Z');

  assert.equal(row.render_id, 'RENDER_CC-99');
  assert.equal(row.created_clip_id, 'CC-99');
  assert.equal(row.source_drive_file_id, 'SRC-DRIVE-99');
  assert.equal(row.hook_text, 'Why your money disappears');
  assert.equal(row.cta_start_second, 42);
  assert.equal(row.cta_end_second, 45);
  assert.equal(row.music_volume, 0.14);
  assert.equal(row.progress_bar_color, '0x137546');
  assert.equal(row.render_status, 'PENDING');
});
```

- [ ] **Step 4: Run tests to verify failure**

Run:

```bash
node --test tests/remaining-workflows.test.js
```

Expected: FAIL because `buildRenderJobRow` / `normalizeRenderPlan` are not exported and schema does not include `render`.

- [ ] **Step 5: Extend `TRANSFORMATION_SCHEMA`**

In `n8n/workflow-code/drive-storage-transform.js`, add the `render` property:

```js
    render: {
      type: 'object',
      properties: {
        top_hook_text: { type: 'string' },
        cta_text: { type: 'string' },
        cta_start_second: { type: 'number' },
        cta_end_second: { type: 'number' },
        music_mood: { type: 'string' },
        music_energy_level: { type: 'string' },
        music_volume: { type: 'number' },
        use_blurred_background: { type: 'boolean' },
        progress_bar_color: { type: 'string' },
      },
      required: [
        'top_hook_text',
        'cta_text',
        'cta_start_second',
        'cta_end_second',
        'music_mood',
        'music_energy_level',
        'music_volume',
        'use_blurred_background',
        'progress_bar_color',
      ],
      additionalProperties: false,
    },
```

Add `'render'` to the schema `required` array.

- [ ] **Step 6: Update schema instructions**

Add these strings inside `buildSchemaInstructions()` before `The JSON must conform...`:

```js
    'The captions are already burned into the Ssemble video. Do not create subtitle or caption-burn instructions.',
    'Add a render object for the FFmpeg render plan: top hook text, CTA text/timing, music mood/energy/volume, blurred-background choice, and progress bar color.',
    'progress_bar_color must use FFmpeg-safe 0xRRGGBB format.',
    'music_volume must be a decimal between 0.04 and 0.14.',
```

- [ ] **Step 7: Add normalizer helpers**

Add these helpers above `parseTransformationPlan()`:

```js
function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampNumber(value, min, max, fallback) {
  return Math.min(max, Math.max(min, numberValue(value, fallback)));
}

function normalizeFfmpegColor(value, fallback = '0xFFFFFF') {
  const raw = String(value || '').trim();
  const hex = raw.startsWith('#') ? raw.slice(1) : raw.replace(/^0x/i, '');
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `0x${hex.toUpperCase()}` : fallback;
}

function boolValue(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  const text = String(value || '').trim().toLowerCase();
  if (['true', 'yes', '1'].includes(text)) return true;
  if (['false', 'no', '0'].includes(text)) return false;
  return fallback;
}

function normalizeRenderPlan(plan = {}, meta = {}) {
  const duration = Math.max(1, numberValue(meta.duration_seconds, numberValue(meta.clip_duration, 45)));
  const render = plan && typeof plan.render === 'object' ? plan.render : {};
  const ctaText = textValue(render.cta_text || plan.cta || 'Follow for more.', 120);
  const startFallback = Math.max(0, Math.floor(duration - 4));
  let start = clampNumber(render.cta_start_second, 0, duration, startFallback);
  let end = clampNumber(render.cta_end_second, 0, duration, duration);
  if (end <= start) {
    end = duration;
    start = Math.max(0, Math.floor(duration - 3));
  }

  return {
    top_hook_text: textValue(render.top_hook_text || plan.hook || plan.best_title || meta.suggested_title || meta.clip_title || 'Watch this', 100),
    cta_text: ctaText,
    cta_start_second: Math.round(start),
    cta_end_second: Math.round(end),
    music_mood: textValue(render.music_mood || 'focused', 80),
    music_energy_level: textValue(render.music_energy_level || 'medium', 80),
    music_volume: clampNumber(render.music_volume, 0.04, 0.14, 0.09),
    use_blurred_background: boolValue(render.use_blurred_background, true),
    progress_bar_color: normalizeFfmpegColor(render.progress_bar_color, '0xFFFFFF'),
  };
}
```

- [ ] **Step 8: Include normalized render plan in parsed output**

Inside `parseTransformationPlan()`, after `const title = ...`, add:

```js
  const render = normalizeRenderPlan(plan, meta);
```

Add these returned fields:

```js
    duration_seconds: meta.duration_seconds,
    render_plan: render,
```

The existing `transformation_plan` must continue to store the raw parsed plan.

- [ ] **Step 9: Add `buildRenderJobRow()`**

Add this function below `parseTransformationPlan()`:

```js
function buildRenderJobRow(parsed, now = new Date().toISOString()) {
  const render = parsed.render_plan || normalizeRenderPlan({}, parsed);
  return {
    render_id: `RENDER_${parsed.created_clip_id}`,
    created_clip_id: parsed.created_clip_id,
    niche: parsed.niche,
    source_drive_file_id: parsed.google_drive_file_id,
    source_drive_url: parsed.google_drive_url,
    source_file_name: parsed.local_file_name || `${parsed.niche}_${parsed.created_clip_id}.mp4`,
    final_drive_folder_id: '',
    hook_text: render.top_hook_text,
    cta_text: render.cta_text,
    cta_start_second: render.cta_start_second,
    cta_end_second: render.cta_end_second,
    music_id: '',
    music_drive_file_id: '',
    music_file_name: '',
    music_volume: render.music_volume,
    watermark_drive_file_id: '',
    watermark_file_name: '',
    progress_bar_color: render.progress_bar_color,
    use_blurred_background: render.use_blurred_background ? 'TRUE' : 'FALSE',
    ffmpeg_command: '',
    render_status: parsed.review_status === 'NEEDS_REVIEW' ? 'PENDING' : 'SKIPPED',
    final_local_path: '',
    final_drive_file_id: '',
    final_drive_url: '',
    warning_message: '',
    error_message: parsed.review_status === 'NEEDS_REVIEW' ? '' : 'Transformation plan unavailable; render skipped.',
    created_at: now,
    started_at: '',
    completed_at: '',
    music_mood: render.music_mood,
    music_energy_level: render.music_energy_level,
  };
}
```

- [ ] **Step 10: Export helpers**

Add these to `module.exports`:

```js
  buildRenderJobRow,
  normalizeFfmpegColor,
  normalizeRenderPlan,
```

- [ ] **Step 11: Run tests**

```bash
node --test tests/remaining-workflows.test.js
```

Expected: PASS for the new helper tests. Existing unrelated test failures must be investigated before proceeding.

- [ ] **Step 12: Commit**

```bash
git add n8n/workflow-code/drive-storage-transform.js tests/remaining-workflows.test.js
git commit -m "feat(wf8): build render jobs from planner output"
```

## Task 4: Add FFmpeg Render Helper

**Files:**
- Create: `n8n/workflow-code/ffmpeg-render.js`
- Modify: `tests/remaining-workflows.test.js`

- [ ] **Step 1: Add import for new helper tests**

Add this destructuring import near the top of `tests/remaining-workflows.test.js`:

```js
const {
  buildAssetDownloadPlan,
  buildCompletedRenderUpdate,
  buildFfmpegCommand,
  buildRenderFailureUpdate,
  buildRenderStatusUpdate,
  pickPendingRenderJob,
  selectMusicTrack,
} = require('../n8n/workflow-code/ffmpeg-render');
```

- [ ] **Step 2: Add failing helper tests**

Add these tests before the WF9 tests:

```js
test('WF8c picks one oldest pending render job', () => {
  const picked = pickPendingRenderJob([
    { render_id: 'RENDER-new', render_status: 'PENDING', created_at: '2026-06-29T10:05:00.000Z' },
    { render_id: 'RENDER-old', render_status: 'PENDING', created_at: '2026-06-29T10:00:00.000Z' },
    { render_id: 'RENDER-done', render_status: 'COMPLETED', created_at: '2026-06-29T09:00:00.000Z' },
  ]);

  assert.equal(picked.render_id, 'RENDER-old');
});

test('WF8c selects music by niche mood energy and default fallback', () => {
  const rows = [
    { music_id: 'FIN-DEFAULT', niche: 'FINANCE_BUSINESS', mood: 'premium', energy_level: 'low', drive_file_id: 'DRIVE-D', recommended_volume: '0.07', active_status: 'TRUE' },
    { music_id: 'FIN-FOCUSED', niche: 'FINANCE_BUSINESS', mood: 'focused', energy_level: 'medium', drive_file_id: 'DRIVE-F', recommended_volume: '0.09', active_status: 'TRUE' },
  ];
  const exact = selectMusicTrack(
    { niche: 'FINANCE_BUSINESS', music_mood: 'focused', music_energy_level: 'medium', music_volume: 0.2 },
    rows,
    { music_default_id: 'FIN-DEFAULT' },
  );
  const fallback = selectMusicTrack(
    { niche: 'FINANCE_BUSINESS', music_mood: 'missing', music_energy_level: 'missing', music_volume: 0.01 },
    rows,
    { music_default_id: 'FIN-DEFAULT' },
  );

  assert.equal(exact.music_id, 'FIN-FOCUSED');
  assert.equal(exact.music_volume, 0.14);
  assert.equal(fallback.music_id, 'FIN-DEFAULT');
  assert.equal(fallback.music_volume, 0.04);
});

test('WF8c builds asset plan and fails when branding is missing', () => {
  const job = { render_id: 'RENDER-1', niche: 'FINANCE_BUSINESS', source_drive_file_id: 'SRC', music_mood: 'focused', music_energy_level: 'medium' };
  const plan = buildAssetDownloadPlan(
    job,
    [{ niche: 'FINANCE_BUSINESS', watermark_drive_file_id: 'WM', progress_bar_color: '0x137546', default_cta: 'Follow', active_status: 'TRUE' }],
    [],
    { FINANCE_BUSINESS: 'FINAL-FOLDER' },
  );
  const missing = buildAssetDownloadPlan(job, [], [], { FINANCE_BUSINESS: 'FINAL-FOLDER' });

  assert.equal(plan.watermark_drive_file_id, 'WM');
  assert.equal(plan.final_drive_folder_id, 'FINAL-FOLDER');
  assert.equal(plan.render_status, 'DOWNLOADING_ASSETS');
  assert.equal(missing.render_status, 'FAILED');
  assert.match(missing.error_message, /branding/i);
});

test('WF8c FFmpeg command escapes text and uses explicit fontfile', () => {
  const command = buildFfmpegCommand({
    render_id: 'RENDER-1',
    input_path: '/data/jobs/RENDER-1/input.mp4',
    watermark_path: '/data/jobs/RENDER-1/watermark.png',
    music_path: '/data/jobs/RENDER-1/music.mp3',
    output_path: '/data/jobs/RENDER-1/output.mp4',
    log_path: '/data/jobs/RENDER-1/render.log',
    hook_text: "Don't waste money: track it",
    cta_text: 'Follow for money lessons',
    cta_start_second: 38,
    cta_end_second: 42,
    duration_seconds: 42,
    progress_bar_color: '0x137546',
    music_volume: 0.09,
    fontfile: '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  });

  assert.match(command, /ffmpeg -y/);
  assert.match(command, /fontfile='\\/usr\\/share\\/fonts\\/dejavu\\/DejaVuSans.ttf'/);
  assert.match(command, /amix=inputs=2/);
  assert.match(command, /0x137546/);
  assert(!command.includes("Don't waste"));
  assert.match(command, /render.log 2>&1/);
});
```

- [ ] **Step 3: Run tests to verify failure**

```bash
node --test tests/remaining-workflows.test.js
```

Expected: FAIL with `Cannot find module '../n8n/workflow-code/ffmpeg-render'`.

- [ ] **Step 4: Create `n8n/workflow-code/ffmpeg-render.js`**

```js
const FINAL_FOLDER_BY_NICHE = {
  CHRISTIAN_CONTENT: 'GOOGLE_DRIVE_FINAL_FOLDER_CHRISTIAN_CONTENT',
  MOTIVATION_DISCIPLINE: 'GOOGLE_DRIVE_FINAL_FOLDER_MOTIVATION_DISCIPLINE',
  FINANCE_BUSINESS: 'GOOGLE_DRIVE_FINAL_FOLDER_FINANCE_BUSINESS',
  LIFE_VALUES_RELATIONSHIPS: 'GOOGLE_DRIVE_FINAL_FOLDER_LIFE_VALUES_RELATIONSHIPS',
  AFRICAN_KENYAN_SUCCESS: 'GOOGLE_DRIVE_FINAL_FOLDER_AFRICAN_KENYAN_SUCCESS',
};

const DEFAULT_FONTFILE = '/usr/share/fonts/dejavu/DejaVuSans.ttf';

function active(row) {
  return ['true', 'active', 'yes', '1'].includes(String(row.active_status || '').trim().toLowerCase());
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  const safe = Number.isFinite(number) ? number : fallback;
  return Math.min(max, Math.max(min, safe));
}

function pickPendingRenderJob(rows) {
  return (rows || [])
    .filter((row) => String(row.render_status || '').toUpperCase() === 'PENDING')
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))[0] || null;
}

function selectMusicTrack(job, rows, branding = {}) {
  const activeRows = (rows || []).filter(active).filter((row) => row.niche === job.niche);
  const mood = String(job.music_mood || '').toLowerCase();
  const energy = String(job.music_energy_level || '').toLowerCase();
  const tests = [
    (row) => String(row.mood || '').toLowerCase() === mood && String(row.energy_level || '').toLowerCase() === energy,
    (row) => String(row.mood || '').toLowerCase() === mood,
    (row) => String(row.energy_level || '').toLowerCase() === energy,
    (row) => row.music_id && row.music_id === branding.music_default_id,
  ];
  const picked = tests.map((fn) => activeRows.find(fn)).find(Boolean);
  if (!picked) return null;

  return {
    music_id: picked.music_id,
    music_drive_file_id: picked.drive_file_id,
    music_file_name: `${picked.music_id || 'music'}.mp3`,
    music_volume: clampNumber(job.music_volume || picked.recommended_volume, 0.04, 0.14, 0.09),
  };
}

function buildRenderStatusUpdate(job, status, now = new Date().toISOString(), extra = {}) {
  return {
    render_id: job.render_id,
    render_status: status,
    started_at: status === 'DOWNLOADING_ASSETS' ? now : (job.started_at || ''),
    completed_at: ['COMPLETED', 'FAILED', 'SKIPPED'].includes(status) ? now : (job.completed_at || ''),
    ...extra,
  };
}

function buildRenderFailureUpdate(job, message, now = new Date().toISOString()) {
  return buildRenderStatusUpdate(job, 'FAILED', now, { error_message: String(message || 'Render failed').slice(0, 2000) });
}

function buildAssetDownloadPlan(job, brandingRows, musicRows, finalFolders = FINAL_FOLDER_BY_NICHE, now = new Date().toISOString()) {
  if (!job || !job.render_id) return buildRenderFailureUpdate({ render_id: '' }, 'Missing render job', now);
  if (!job.source_drive_file_id) return buildRenderFailureUpdate(job, 'Missing source Drive file ID', now);

  const branding = (brandingRows || []).filter(active).find((row) => row.niche === job.niche);
  if (!branding) return buildRenderFailureUpdate(job, `Missing active Channel_Branding row for niche ${job.niche}`, now);
  if (!branding.watermark_drive_file_id) return buildRenderFailureUpdate(job, `Missing watermark Drive file ID for niche ${job.niche}`, now);

  const music = selectMusicTrack(job, musicRows, branding);
  const warning = music ? '' : 'No active matching music found; rendering without background music.';

  return buildRenderStatusUpdate(job, 'DOWNLOADING_ASSETS', now, {
    final_drive_folder_id: finalFolders[job.niche] || '',
    watermark_drive_file_id: branding.watermark_drive_file_id,
    watermark_file_name: `${job.niche}_watermark.png`,
    progress_bar_color: job.progress_bar_color || branding.progress_bar_color || '0xFFFFFF',
    cta_text: job.cta_text || branding.default_cta || '',
    warning_message: warning,
    ...(music || { music_id: '', music_drive_file_id: '', music_file_name: '', music_volume: '' }),
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function escapeDrawtext(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\\\'")
    .replace(/\n/g, ' ');
}

function buildFfmpegCommand(options) {
  const fontfile = options.fontfile || DEFAULT_FONTFILE;
  const duration = Math.max(1, Number(options.duration_seconds || 45));
  const hook = escapeDrawtext(options.hook_text);
  const cta = escapeDrawtext(options.cta_text);
  const progress = options.progress_bar_color || '0xFFFFFF';
  const baseFilters = [
    '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:1[bg]',
    '[0:v]scale=950:-1[fg]',
    '[bg][fg]overlay=(W-w)/2:(H-h)/2[base]',
    '[base]drawbox=x=0:y=0:w=1080:h=180:color=black@0.35:t=fill[tbox]',
    `[tbox]drawtext=fontfile=${shellQuote(fontfile)}:text='${hook}':fontcolor=white:fontsize=58:x=(w-text_w)/2:y=60:box=1:boxcolor=black@0.25:boxborderw=18[title]`,
    `[title]drawbox=x=0:y=h-12:w='1080*t/${duration}':h=12:color=${progress}@0.95:t=fill[progress]`,
    `[progress]drawtext=fontfile=${shellQuote(fontfile)}:text='${cta}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=1580:box=1:boxcolor=black@0.45:boxborderw=18:enable='between(t,${Number(options.cta_start_second || Math.max(0, duration - 4))},${Number(options.cta_end_second || duration)})'[cta]`,
    '[1:v]scale=110:-1[wm]',
    '[cta][wm]overlay=x=W-w-35:y=35[vout]',
  ];
  const hasMusic = Boolean(options.music_path);
  const audioFilters = hasMusic
    ? `;[0:a]volume=1.0[a0];[2:a]volume=${clampNumber(options.music_volume, 0.04, 0.14, 0.09)},aloop=loop=-1:size=2e+09[bgm];[a0][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]`
    : ';[0:a]volume=1.0[aout]';
  const inputs = [
    `-i ${shellQuote(options.input_path)}`,
    `-i ${shellQuote(options.watermark_path)}`,
    hasMusic ? `-i ${shellQuote(options.music_path)}` : '',
  ].filter(Boolean).join(' ');

  return [
    'mkdir -p ' + shellQuote(options.workdir || `/data/jobs/${options.render_id}`),
    '&&',
    'ffmpeg -y',
    inputs,
    '-filter_complex',
    shellQuote(`${baseFilters.join(';')}${audioFilters}`),
    '-map "[vout]" -map "[aout]" -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -shortest',
    shellQuote(options.output_path),
    '>',
    shellQuote(options.log_path),
    '2>&1',
  ].join(' ');
}

function buildCompletedRenderUpdate(job, drive, now = new Date().toISOString()) {
  return buildRenderStatusUpdate(job, 'COMPLETED', now, {
    final_drive_file_id: drive.id,
    final_drive_url: drive.webViewLink || `https://drive.google.com/file/d/${drive.id}/view`,
    final_local_path: job.final_local_path || `/data/jobs/${job.render_id}/output.mp4`,
    error_message: '',
  });
}

module.exports = {
  DEFAULT_FONTFILE,
  FINAL_FOLDER_BY_NICHE,
  buildAssetDownloadPlan,
  buildCompletedRenderUpdate,
  buildFfmpegCommand,
  buildRenderFailureUpdate,
  buildRenderStatusUpdate,
  pickPendingRenderJob,
  selectMusicTrack,
};
```

- [ ] **Step 5: Run helper tests**

```bash
node --test tests/remaining-workflows.test.js
```

Expected: PASS for the new helper tests.

- [ ] **Step 6: Commit**

```bash
git add n8n/workflow-code/ffmpeg-render.js tests/remaining-workflows.test.js
git commit -m "feat(wf8c): add FFmpeg render helpers"
```

## Task 5: Generate WF8 Render Job Handoff and WF8c Workflow

**Files:**
- Modify: `n8n/workflow-code/create-remaining-workflows.js`
- Modify: `n8n/workflows/08-drive-storage-transform.json`
- Create: `n8n/workflows/08c-ffmpeg-render-final-clip.json`
- Modify: `tests/remaining-workflows.test.js`

- [ ] **Step 1: Add workflow structure tests**

Add these tests before the WF9 tests:

```js
test('WF8 creates Render_Jobs rows after updating Created_Clips', () => {
  const workflow = requireWorkflow('08', 'drive-storage-transform');
  const names = workflow.nodes.map((node) => node.name);

  assert(names.includes('Build Render Job'));
  assert(names.includes('Create Render Job'));
  assert.equal(workflow.connections['Update Created Clip'].main[0][0].node, 'Build Render Job');
  assert.equal(workflow.connections['Build Render Job'].main[0][0].node, 'Create Render Job');
  assert.equal(workflow.connections['Create Render Job'].main[0][0].node, 'Clip Loop');
});

test('WF8c workflow renders one pending job and stores FFmpeg command', () => {
  const workflow = requireWorkflow('08c', 'ffmpeg-render-final-clip');
  const names = workflow.nodes.map((node) => node.name);

  assert(names.includes('Read Render_Jobs'));
  assert(names.includes('Pick Pending Render'));
  assert(names.includes('Read Channel_Branding'));
  assert(names.includes('Read Music_Library'));
  assert(names.includes('Build Asset Plan'));
  assert(names.includes('Download Source Clip'));
  assert(names.includes('Write Source Clip'));
  assert(names.includes('Download Watermark'));
  assert(names.includes('Write Watermark'));
  assert(names.includes('Download Music'));
  assert(names.includes('Write Music'));
  assert(names.includes('Build FFmpeg Command'));
  assert(names.includes('Run FFmpeg'));
  assert(names.includes('Read Final Output'));
  assert(names.includes('Upload Final To Drive'));
  assert(names.includes('Mark Render Completed'));
  assert.equal(workflow.nodes.find((node) => node.name === 'Run FFmpeg').type, 'n8n-nodes-base.executeCommand');
  assert.equal(workflow.nodes.find((node) => node.name === 'Write Source Clip').type, 'n8n-nodes-base.readWriteFile');
  assert.equal(workflow.nodes.find((node) => node.name === 'Read Final Output').type, 'n8n-nodes-base.readWriteFile');
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
node --test tests/remaining-workflows.test.js
```

Expected: FAIL because generated WF8 lacks `Build Render Job`, and WF8c JSON does not exist.

- [ ] **Step 3: Update `create-remaining-workflows.js` helper loader**

No change is needed to `helper(name)`. It already embeds helper modules by file name. Use `helper('ffmpeg-render')` for WF8c.

- [ ] **Step 4: Add WF8 render nodes**

In `wf8()`, after `Update Created Clip`, add:

```js
      codeNode('wf8-016', 'Build Render Job', [3300, 120], `${h}
const parsed = $('Parse Plan').first().json;
return [{ json: buildRenderJobRow(parsed), pairedItem: { item: 0 } }];`),
      sheetsNode('wf8-017', 'Create Render Job', [3520, 120], sheet('appendOrUpdate', 'Render_Jobs', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['render_id'] } })),
```

Change the WF8 connection tail from:

```js
      'Parse Plan': { main: [[{ node: 'Update Created Clip', type: 'main', index: 0 }]] },
      'Update Created Clip': { main: [[{ node: 'Clip Loop', type: 'main', index: 0 }]] },
```

to:

```js
      'Parse Plan': { main: [[{ node: 'Update Created Clip', type: 'main', index: 0 }]] },
      'Update Created Clip': { main: [[{ node: 'Build Render Job', type: 'main', index: 0 }]] },
      'Build Render Job': { main: [[{ node: 'Create Render Job', type: 'main', index: 0 }]] },
      'Create Render Job': { main: [[{ node: 'Clip Loop', type: 'main', index: 0 }]] },
```

- [ ] **Step 5: Add `wf8c()` generator**

Add this function after `wf8b()`:

```js
function wf8c() {
  const h = helper('ffmpeg-render');
  const finalFolders = `{
  CHRISTIAN_CONTENT: 'GOOGLE_DRIVE_FINAL_FOLDER_CHRISTIAN_CONTENT',
  MOTIVATION_DISCIPLINE: 'GOOGLE_DRIVE_FINAL_FOLDER_MOTIVATION_DISCIPLINE',
  FINANCE_BUSINESS: 'GOOGLE_DRIVE_FINAL_FOLDER_FINANCE_BUSINESS',
  LIFE_VALUES_RELATIONSHIPS: 'GOOGLE_DRIVE_FINAL_FOLDER_LIFE_VALUES_RELATIONSHIPS',
  AFRICAN_KENYAN_SUCCESS: 'GOOGLE_DRIVE_FINAL_FOLDER_AFRICAN_KENYAN_SUCCESS',
}`;
  writeWorkflow('n8n/workflows/08c-ffmpeg-render-final-clip.json', {
    name: 'WF8c FFmpeg Render Final Clip',
    nodes: [
      node('wf8c-001', 'Schedule 15m', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } }),
      sheetsNode('wf8c-002', 'Read Render_Jobs', [220, 0], sheet('read', 'Render_Jobs')),
      codeNode('wf8c-003', 'Pick Pending Render', [440, 0], `${h}
const job = pickPendingRenderJob($input.all().map(i => i.json));
return job ? [{ json: job, pairedItem: { item: 0 } }] : [];`),
      sheetsNode('wf8c-004', 'Read Channel_Branding', [660, 0], sheet('read', 'Channel_Branding'), { alwaysOutputData: true }),
      sheetsNode('wf8c-005', 'Read Music_Library', [880, 0], sheet('read', 'Music_Library'), { alwaysOutputData: true }),
      codeNode('wf8c-006', 'Build Asset Plan', [1100, 0], `${h}
const job = $('Pick Pending Render').first().json;
const plan = buildAssetDownloadPlan(
  job,
  $('Read Channel_Branding').all().map(i => i.json),
  $('Read Music_Library').all().map(i => i.json),
  ${finalFolders},
);
return [{ json: { ...job, ...plan }, pairedItem: { item: 0 } }];`),
      sheetsNode('wf8c-007', 'Save Asset Plan', [1320, 0], sheet('appendOrUpdate', 'Render_Jobs', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['render_id'] } })),
      routeIfNode('wf8c-008', 'Assets Ready?', [1540, 0], 'DOWNLOADING_ASSETS'),
      node('wf8c-009', 'Download Source Clip', 'n8n-nodes-base.googleDrive', 3, [1760, -120], { resource: 'file', operation: 'download', fileId: { __rl: true, mode: 'id', value: '={{ $json.source_drive_file_id }}' }, options: { binaryPropertyName: 'source' } }),
      node('wf8c-010', 'Write Source Clip', 'n8n-nodes-base.readWriteFile', 1, [1980, -120], { operation: 'write', fileName: '={{ "/data/jobs/" + $("Build Asset Plan").first().json.render_id + "/input.mp4" }}', dataPropertyName: 'source', options: {} }),
      node('wf8c-011', 'Download Watermark', 'n8n-nodes-base.googleDrive', 3, [2200, -120], { resource: 'file', operation: 'download', fileId: { __rl: true, mode: 'id', value: '={{ $("Build Asset Plan").first().json.watermark_drive_file_id }}' }, options: { binaryPropertyName: 'watermark' } }),
      node('wf8c-012', 'Write Watermark', 'n8n-nodes-base.readWriteFile', 1, [2420, -120], { operation: 'write', fileName: '={{ "/data/jobs/" + $("Build Asset Plan").first().json.render_id + "/watermark.png" }}', dataPropertyName: 'watermark', options: {} }),
      node('wf8c-013', 'Download Music', 'n8n-nodes-base.googleDrive', 3, [2640, -120], { resource: 'file', operation: 'download', fileId: { __rl: true, mode: 'id', value: '={{ $("Build Asset Plan").first().json.music_drive_file_id }}' }, options: { binaryPropertyName: 'music' } }, { onError: 'continueRegularOutput' }),
      node('wf8c-014', 'Write Music', 'n8n-nodes-base.readWriteFile', 1, [2860, -120], { operation: 'write', fileName: '={{ "/data/jobs/" + $("Build Asset Plan").first().json.render_id + "/music.mp3" }}', dataPropertyName: 'music', options: {} }, { onError: 'continueRegularOutput' }),
      codeNode('wf8c-015', 'Build FFmpeg Command', [3080, -120], `${h}
const job = $('Build Asset Plan').first().json;
const workdir = \`/data/jobs/\${job.render_id}\`;
const hasMusic = Boolean(job.music_drive_file_id);
const command = buildFfmpegCommand({
  ...job,
  workdir,
  input_path: \`\${workdir}/input.mp4\`,
  watermark_path: \`\${workdir}/watermark.png\`,
  music_path: hasMusic ? \`\${workdir}/music.mp3\` : '',
  output_path: \`\${workdir}/output.mp4\`,
  log_path: \`\${workdir}/render.log\`,
});
return [{
  json: {
    ...buildRenderStatusUpdate(job, 'RENDERING', new Date().toISOString(), {
      ffmpeg_command: command,
      final_local_path: \`\${workdir}/output.mp4\`,
    }),
    command,
  },
  pairedItem: { item: 0 },
}];`),
      sheetsNode('wf8c-016', 'Mark Rendering', [3300, -120], sheet('appendOrUpdate', 'Render_Jobs', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['render_id'] } })),
      node('wf8c-017', 'Run FFmpeg', 'n8n-nodes-base.executeCommand', 1, [3520, -120], { command: '={{ $json.command }}' }, { onError: 'continueRegularOutput' }),
      codeNode('wf8c-018', 'Mark Uploading', [3740, -120], `${h}
const job = $('Build Asset Plan').first().json;
return [{ json: buildRenderStatusUpdate(job, 'UPLOADING'), pairedItem: { item: 0 } }];`),
      sheetsNode('wf8c-019', 'Save Uploading', [3960, -120], sheet('appendOrUpdate', 'Render_Jobs', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['render_id'] } })),
      node('wf8c-020', 'Read Final Output', 'n8n-nodes-base.readWriteFile', 1, [4180, -120], { operation: 'read', fileSelector: '={{ "/data/jobs/" + $("Build Asset Plan").first().json.render_id + "/output.mp4" }}', options: { dataPropertyName: 'data' } }),
      node('wf8c-021', 'Upload Final To Drive', 'n8n-nodes-base.googleDrive', 3, [4400, -120], { resource: 'file', operation: 'upload', name: '={{ $("Build Asset Plan").first().json.render_id }}_final.mp4', driveId: { __rl: true, mode: 'list', value: 'My Drive' }, folderId: { __rl: true, mode: 'id', value: '={{ $("Build Asset Plan").first().json.final_drive_folder_id }}' }, inputDataFieldName: 'data', options: {} }),
      codeNode('wf8c-022', 'Build Completed Update', [4620, -120], `${h}
const job = $('Build Asset Plan').first().json;
const drive = $input.first().json;
return [{ json: buildCompletedRenderUpdate(job, drive), pairedItem: { item: 0 } }];`),
      sheetsNode('wf8c-023', 'Mark Render Completed', [4840, -120], sheet('appendOrUpdate', 'Render_Jobs', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['render_id'] } })),
      codeNode('wf8c-024', 'Build Asset Failure', [1760, 160], `${h}
const job = $('Build Asset Plan').first().json;
return [{ json: buildRenderFailureUpdate(job, job.error_message || 'Render asset setup failed'), pairedItem: { item: 0 } }];`),
      sheetsNode('wf8c-025', 'Mark Asset Failure', [1980, 160], sheet('appendOrUpdate', 'Render_Jobs', { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['render_id'] } })),
    ],
    connections: {
      'Schedule 15m': { main: [[{ node: 'Read Render_Jobs', type: 'main', index: 0 }]] },
      'Read Render_Jobs': { main: [[{ node: 'Pick Pending Render', type: 'main', index: 0 }]] },
      'Pick Pending Render': { main: [[{ node: 'Read Channel_Branding', type: 'main', index: 0 }]] },
      'Read Channel_Branding': { main: [[{ node: 'Read Music_Library', type: 'main', index: 0 }]] },
      'Read Music_Library': { main: [[{ node: 'Build Asset Plan', type: 'main', index: 0 }]] },
      'Build Asset Plan': { main: [[{ node: 'Save Asset Plan', type: 'main', index: 0 }]] },
      'Save Asset Plan': { main: [[{ node: 'Assets Ready?', type: 'main', index: 0 }]] },
      'Assets Ready?': { main: [[{ node: 'Download Source Clip', type: 'main', index: 0 }], [{ node: 'Build Asset Failure', type: 'main', index: 0 }]] },
      'Download Source Clip': { main: [[{ node: 'Write Source Clip', type: 'main', index: 0 }]] },
      'Write Source Clip': { main: [[{ node: 'Download Watermark', type: 'main', index: 0 }]] },
      'Download Watermark': { main: [[{ node: 'Write Watermark', type: 'main', index: 0 }]] },
      'Write Watermark': { main: [[{ node: 'Download Music', type: 'main', index: 0 }]] },
      'Download Music': { main: [[{ node: 'Write Music', type: 'main', index: 0 }]] },
      'Write Music': { main: [[{ node: 'Build FFmpeg Command', type: 'main', index: 0 }]] },
      'Build FFmpeg Command': { main: [[{ node: 'Mark Rendering', type: 'main', index: 0 }]] },
      'Mark Rendering': { main: [[{ node: 'Run FFmpeg', type: 'main', index: 0 }]] },
      'Run FFmpeg': { main: [[{ node: 'Mark Uploading', type: 'main', index: 0 }]] },
      'Mark Uploading': { main: [[{ node: 'Save Uploading', type: 'main', index: 0 }]] },
      'Save Uploading': { main: [[{ node: 'Read Final Output', type: 'main', index: 0 }]] },
      'Read Final Output': { main: [[{ node: 'Upload Final To Drive', type: 'main', index: 0 }]] },
      'Upload Final To Drive': { main: [[{ node: 'Build Completed Update', type: 'main', index: 0 }]] },
      'Build Completed Update': { main: [[{ node: 'Mark Render Completed', type: 'main', index: 0 }]] },
      'Build Asset Failure': { main: [[{ node: 'Mark Asset Failure', type: 'main', index: 0 }]] },
    },
  });
}
```

- [ ] **Step 6: Call the generator**

At the bottom of `create-remaining-workflows.js`, add `wf8c();` after `wf8b();`:

```js
wf8();
wf8b();
wf8c();
wf9();
```

- [ ] **Step 7: Regenerate workflows**

Run:

```bash
node n8n/workflow-code/create-remaining-workflows.js
```

Expected:

```text
n8n/workflows/08-drive-storage-transform.json changes
n8n/workflows/08c-ffmpeg-render-final-clip.json exists
```

- [ ] **Step 8: Validate generated JSON**

```bash
python3 -m json.tool n8n/workflows/08-drive-storage-transform.json >/dev/null
python3 -m json.tool n8n/workflows/08c-ffmpeg-render-final-clip.json >/dev/null
```

Expected: both commands exit 0.

- [ ] **Step 9: Run tests**

```bash
node --test tests/remaining-workflows.test.js
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add n8n/workflow-code/create-remaining-workflows.js n8n/workflows/08-drive-storage-transform.json n8n/workflows/08c-ffmpeg-render-final-clip.json tests/remaining-workflows.test.js
git commit -m "feat(n8n): add WF8c FFmpeg render workflow"
```

## Task 6: Final Verification

**Files:**
- Verify: `docs/google-sheets-structure.md`
- Verify: `n8n/Dockerfile`
- Verify: `n8n/compose.local.yaml`
- Verify: `n8n/compose.prod.yaml`
- Verify: `n8n/workflow-code/drive-storage-transform.js`
- Verify: `n8n/workflow-code/ffmpeg-render.js`
- Verify: `n8n/workflow-code/create-remaining-workflows.js`
- Verify: `n8n/workflows/08-drive-storage-transform.json`
- Verify: `n8n/workflows/08c-ffmpeg-render-final-clip.json`
- Verify: `tests/remaining-workflows.test.js`

- [ ] **Step 1: Run full Node test suite**

```bash
node --test tests/*.test.js
```

Expected: PASS.

- [ ] **Step 2: Validate all workflow JSON**

```bash
for f in n8n/workflows/*.json; do python3 -m json.tool "$f" >/dev/null && echo "OK $f"; done
```

Expected: every workflow prints `OK`.

- [ ] **Step 3: Verify generated workflow contains expected placeholders**

```bash
rg -n "GOOGLE_DRIVE_FINAL_FOLDER_|Render_Jobs|Channel_Branding|Music_Library|Execute Command|executeCommand" n8n/workflows/08c-ffmpeg-render-final-clip.json n8n/workflows/08-drive-storage-transform.json
```

Expected: final folder placeholders and all three sheet names are present.

- [ ] **Step 4: Build the local n8n image**

```bash
docker compose -f n8n/compose.local.yaml build n8n
```

Expected: build succeeds and installs FFmpeg.

- [ ] **Step 5: Verify FFmpeg exists in the built image**

```bash
docker compose -f n8n/compose.local.yaml run --rm n8n ffmpeg -version
```

Expected: output starts with `ffmpeg version`.

- [ ] **Step 6: Check git status**

```bash
git status --short
```

Expected: only pre-existing unrelated dirty files remain, or the worktree is clean if those were committed separately. No untracked generated render files should remain except intentionally ignored `n8n/render-data/` content.

- [ ] **Step 7: Handoff notes**

Before live activation, tell the user to create/confirm:

```text
Google Sheets tabs: Render_Jobs, Music_Library, Channel_Branding
Drive folders: one final-render folder per niche
Music_Library rows with active_status=TRUE and drive_file_id
Channel_Branding rows with active_status=TRUE and watermark_drive_file_id
n8n credentials: Google Sheets account and Google Drive account on the new WF8c nodes
WF8c final folder placeholders replaced in n8n
Workflow error workflow set to WF10
```

Do not claim live completion until the workflow is imported, credentials/folders are selected, and one seeded render job has completed in the live n8n execution log.
