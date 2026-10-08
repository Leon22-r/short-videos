const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { upsertFromJsonb, updateFromJsonb } = require('../workflow-code/table-node');

const root = path.resolve(__dirname, '..');
const pgBin = process.env.POSTIZ_TEST_PG_BIN || '/usr/lib/postgresql/16/bin';
const available = ['initdb', 'pg_ctl', 'psql'].every((name) => fs.existsSync(path.join(pgBin, name)));

// A port no other test in the repo uses: postiz holds 55439, the pipeline-store
// replay test holds 55441.
const PORT = '55443';

// The generator emits SQL as a string, so the only way to know Postgres accepts
// it is to run it. These tables carry integer, bigint, numeric, boolean and
// timestamptz columns, and the text projection the publishing queue uses fails
// on every one of them.
async function withCluster(body, migrations = ['004-pipeline-store-sources.sql']) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'table-node-test-'));
  const data = path.join(temp, 'data');
  const args = ['-X', '-h', temp, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'];
  const command = (name, extra) => execFileSync(path.join(pgBin, name), extra, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const sql = (statement) => command('psql', [...args, '-c', statement]).trim();
  let started = false;
  try {
    command('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale']);
    command('pg_ctl', ['-D', data, '-l', path.join(temp, 'postgres.log'), '-o', `-h '' -k ${temp} -p ${PORT}`, '-w', 'start']);
    started = true;
    sql('CREATE SCHEMA IF NOT EXISTS short_videos;');
    for (const migration of migrations) {
      sql(fs.readFileSync(path.join(root, 'postgres/migrations', migration), 'utf8'));
    }
    // Rows arrive from a Code node as a jsonb array, so $1 is substituted the
    // way the Postgres node substitutes queryReplacement.
    const run = (statement, rows) => {
      const file = path.join(temp, 'query.sql');
      fs.writeFileSync(file, statement.replace('$1::jsonb', `'${JSON.stringify(rows)}'::jsonb`));
      return command('psql', [...args, '-f', file]).trim();
    };
    await body({ sql, run });
  } finally {
    if (started) { try { command('pg_ctl', ['-D', data, '-w', 'stop']); } catch {} }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const COLUMNS = ['video_id', 'niche', 'youtube_video_id', 'duration_seconds',
  'view_count', 'transcript_available', 'published_at', 'processing_status'];
const statement = () => upsertFromJsonb({ table: 'candidate_videos', key: 'video_id', columns: COLUMNS });

test('real Postgres: the upsert accepts a row of typed columns from jsonb', { skip: !available }, async () => {
  await withCluster(async ({ sql, run }) => {
    run(statement(), [{
      video_id: 'v1', niche: 'FINANCE_BUSINESS', youtube_video_id: 'yt1',
      duration_seconds: '58', view_count: '1200', transcript_available: 'true',
      published_at: '2026-10-01T00:00:00Z', processing_status: 'NEW',
    }]);
    assert.equal(sql("SELECT duration_seconds, view_count, transcript_available FROM short_videos.candidate_videos WHERE video_id = 'v1';"), '58|1200|t');
  });
});

test('real Postgres: a blank cell becomes NULL rather than failing the batch', { skip: !available }, async () => {
  await withCluster(async ({ sql, run }) => {
    run(statement(), [{
      video_id: 'v2', niche: 'FINANCE_BUSINESS', youtube_video_id: 'yt2',
      duration_seconds: '', view_count: '', transcript_available: '',
      published_at: '', processing_status: 'NEW',
    }]);
    assert.equal(sql("SELECT duration_seconds IS NULL, published_at IS NULL FROM short_videos.candidate_videos WHERE video_id = 'v2';"), 't|t');
  });
});

test('real Postgres: a row with a blank key is skipped, not inserted as empty', { skip: !available }, async () => {
  await withCluster(async ({ sql, run }) => {
    run(statement(), [{ video_id: '   ', niche: 'FINANCE_BUSINESS', youtube_video_id: 'yt9', processing_status: 'NEW' }]);
    assert.equal(sql('SELECT count(*) FROM short_videos.candidate_videos;'), '0');
  });
});

test('real Postgres: an update leaves the columns it does not name alone', { skip: !available }, async () => {
  await withCluster(async ({ sql, run }) => {
    run(statement(), [{
      video_id: 'v1', niche: 'FINANCE_BUSINESS', youtube_video_id: 'yt1',
      duration_seconds: '58', view_count: '1200', transcript_available: 'true',
      published_at: '2026-10-01T00:00:00Z', processing_status: 'NEW',
    }]);
    // What WF3 does: it owns the classification columns and nothing else.
    run(updateFromJsonb({
      table: 'candidate_videos',
      key: 'video_id',
      columns: ['video_id', 'validity_status', 'processing_status'],
    }), [{ video_id: 'v1', validity_status: 'VALID', processing_status: 'ANALYZED' }]);
    assert.equal(sql("SELECT duration_seconds, view_count, validity_status, processing_status FROM short_videos.candidate_videos WHERE video_id = 'v1';"), '58|1200|VALID|ANALYZED');
    assert.equal(sql('SELECT count(*) FROM short_videos.candidate_videos;'), '1');
  });
});

// `INSERT ... ON CONFLICT` builds its insert row before the conflict is
// detected, so a narrow upsert cannot be used for a state transition on a table
// with NOT NULL columns. This is why updateFromJsonb exists.
test('real Postgres: a narrow upsert fails on the NOT NULL columns it omits', { skip: !available }, async () => {
  await withCluster(async ({ run }) => {
    const narrow = upsertFromJsonb({
      table: 'source_channels', key: 'source_id', columns: ['source_id', 'backfill_status'],
    });
    assert.throws(() => run(narrow, [{ source_id: 'src-1', backfill_status: 'COMPLETE' }]),
      /null value in column "niche".*violates not-null constraint/s);
  });
});

// WF2 clears backfill_next_page_token when a channel's backfill finishes. The
// Code node emits '' for "no more pages", which must land as NULL, not ''.
test('real Postgres: an update writes its own columns and can clear one', { skip: !available }, async () => {
  await withCluster(async ({ sql, run }) => {
    run(upsertFromJsonb({
      table: 'source_channels',
      key: 'source_id',
      columns: ['source_id', 'niche', 'source_name', 'youtube_channel_url', 'backfill_next_page_token', 'backfill_status'],
    }), [{
      source_id: 'src-1', niche: 'FINANCE_BUSINESS', source_name: 'Example',
      youtube_channel_url: 'https://youtube.com/@example',
      backfill_next_page_token: 'PAGE2', backfill_status: 'IN_PROGRESS',
    }]);
    assert.equal(sql("SELECT backfill_next_page_token FROM short_videos.source_channels WHERE source_id = 'src-1';"), 'PAGE2');

    run(updateFromJsonb({
      table: 'source_channels',
      key: 'source_id',
      columns: ['source_id', 'backfill_next_page_token', 'backfill_status'],
    }), [{ source_id: 'src-1', backfill_next_page_token: '', backfill_status: 'COMPLETE' }]);
    assert.equal(sql("SELECT backfill_next_page_token IS NULL, backfill_status, source_name FROM short_videos.source_channels WHERE source_id = 'src-1';"), 't|COMPLETE|Example');
  });
});

test('real Postgres: an update for an unknown key changes nothing', { skip: !available }, async () => {
  await withCluster(async ({ sql, run }) => {
    run(updateFromJsonb({
      table: 'source_channels', key: 'source_id', columns: ['source_id', 'backfill_status'],
    }), [{ source_id: 'does-not-exist', backfill_status: 'COMPLETE' }]);
    assert.equal(sql('SELECT count(*) FROM short_videos.source_channels;'), '0');
  });
});

// The committed .sql files are what the workflows actually run, so a column
// renamed in a migration shows up here rather than at runtime in n8n.
test('real Postgres: every committed WF1-WF3 query runs against the schema', { skip: !available }, async () => {
  const queries = {
    'select-source-channels': null,
    'select-candidate-videos': null,
    'upsert-candidate-videos': [{
      video_id: 'v1', niche: 'FINANCE_BUSINESS', youtube_video_id: 'yt1',
      video_title: 'A Title', duration_seconds: '1800', view_count: '50000',
      like_count: '1200', comment_count: '40', like_percentage: '0.024',
      comment_percentage: '0.0008', engagement_percentage: '0.0248',
      transcript_available: 'true', language: 'en', processing_status: 'NEW',
      published_at: '2026-10-01T00:00:00Z',
    }],
    'update-candidate-validity': [{
      video_id: 'v1', like_percentage: '0.024', comment_percentage: '0.0008',
      engagement_percentage: '0.0248', validity_status: 'VALID',
      validity_score: '8', rejection_reason: '', processing_status: 'ANALYZED',
    }],
    'update-source-resolution': [{
      source_id: 'src-1', youtube_channel_id: 'UC0123456789012345678901',
      uploads_playlist_id: 'UU0123456789012345678901',
      last_checked_at: '2026-10-08T00:00:00Z', notes: '',
    }],
    'update-source-backfill-state': [{
      source_id: 'src-1', backfill_next_page_token: '', backfill_status: 'COMPLETE',
      videos_known_count: '120', videos_fetched_count: '120',
      backfill_last_run_at: '2026-10-08T00:00:00Z', last_checked_at: '2026-10-08T00:00:00Z',
    }],
  };

  await withCluster(async ({ sql, run }) => {
    sql(`INSERT INTO short_videos.source_channels (source_id, niche, source_name, youtube_channel_url)
         VALUES ('src-1', 'FINANCE_BUSINESS', 'Example', 'https://youtube.com/@example');`);
    for (const [name, rows] of Object.entries(queries)) {
      const statement = fs.readFileSync(path.join(root, 'postgres/queries', `${name}.sql`), 'utf8');
      if (rows === null) {
        sql(statement.replace(/;\s*$/, ''));
      } else {
        run(statement, rows);
      }
    }
    // The chain end to end: WF1 resolved the channel, WF2 wrote the candidate
    // and cleared the backfill token, WF3 classified it.
    assert.equal(sql("SELECT uploads_playlist_id, backfill_next_page_token IS NULL, videos_fetched_count FROM short_videos.source_channels WHERE source_id = 'src-1';"), 'UU0123456789012345678901|t|120');
    assert.equal(sql("SELECT validity_status, validity_score, rejection_reason IS NULL, processing_status FROM short_videos.candidate_videos WHERE video_id = 'v1';"), 'VALID|8|t|ANALYZED');
  });
});

// WF4, WF5 and WF6 write five more tables. Same reason as the WF1-WF3 case:
// the committed .sql is what n8n runs, so a column renamed in a migration has
// to fail here rather than at runtime.
test('real Postgres: every committed WF4-WF6 query runs against the schema', { skip: !available }, async () => {
  const q = (name) => fs.readFileSync(path.join(root, 'postgres/queries', `${name}.sql`), 'utf8');
  await withCluster(async ({ sql, run }) => {
    sql(`INSERT INTO short_videos.source_channels (source_id, niche, source_name, youtube_channel_url)
         VALUES ('src-1', 'FINANCE_BUSINESS', 'Example', 'https://youtube.com/@example');`);
    run(q('upsert-candidate-videos'), [{
      video_id: 'v1', niche: 'FINANCE_BUSINESS', source_id: 'src-1', youtube_video_id: 'yt1',
      video_title: 'A Title', duration_seconds: '1800', view_count: '50000', validity_status: 'VALID', processing_status: 'NEW',
    }]);

    // WF4: a transcript far past the old 45k cell limit, and no Drive columns.
    const transcript = 'x'.repeat(120000);
    run(q('upsert-transcript-analysis'), [{
      analysis_id: 'AN-yt1', video_id: 'v1', niche: 'FINANCE_BUSINESS', source_id: 'src-1',
      video_title: 'A Title', video_url: 'https://youtu.be/yt1', transcript_status: 'FETCHED',
      transcript_text: transcript, transcript_length_words: '20000',
      created_at: '2026-10-08T00:00:00Z',
    }]);
    assert.equal(sql("SELECT length(transcript_text) FROM short_videos.transcript_analysis WHERE analysis_id = 'AN-yt1';"), '120000');

    run(q('update-candidate-transcript-ok'), [{ video_id: 'v1', transcript_available: 'true', language: 'en' }]);
    run(q('update-candidate-transcript-failed'), [{
      video_id: 'v1', transcript_available: 'false', validity_status: 'REJECTED',
      rejection_reason: 'TRANSCRIPT_IP_BLOCKED', processing_status: 'SKIPPED',
    }]);

    // WF5: the AI fields, including jsonb, and a clip moment.
    run(q('update-transcript-analysis-ai'), [{
      analysis_id: 'AN-yt1', ai_episode_score: '8.5', recommended_strategy: 'USE_20_MIN_WINDOW',
      recommended_start_sec: '120', recommended_end_sec: '1320', reason_for_strategy: 'dense',
      rights_risk: 'low', permission_risk: 'low', monetization_risk: 'low',
      originality_potential: '7', kenya_relevance: 'high',
      // The Code node hands the object over, not a string: a JSON string would
      // land in the jsonb column as a string scalar.
      ai_json_output: { clips: [{ rank: 1 }] },
    }]);
    assert.equal(sql("SELECT ai_json_output->'clips'->0->>'rank', recommended_start_sec FROM short_videos.transcript_analysis WHERE analysis_id = 'AN-yt1';"), '1|120');

    run(q('upsert-clip-moments'), [{
      clip_moment_id: 'CM-1', video_id: 'v1', niche: 'FINANCE_BUSINESS', source_id: 'src-1',
      rank: '1', start_sec: '120', end_sec: '180', clip_length_seconds: '60',
      core_idea: 'An idea', needs_extra_context: 'false', originality_score: '7.5',
      clip_score: '8', rights_risk: 'low', final_recommendation: 'clip',
      download_status: 'AWAITING_MANUAL_APPROVAL', strategy: 'USE_20_MIN_WINDOW',
      source_video_url: 'https://youtu.be/yt1', created_at: '2026-10-08T00:00:00Z',
    }]);
    run(q('update-candidate-analyzed'), [{ video_id: 'v1', processing_status: 'ANALYZED' }]);
    run(q('update-candidate-skipped'), [{
      video_id: 'v1', processing_status: 'SKIPPED', validity_status: 'REJECTED',
      rejection_reason: 'Channel auto-paused: low yield',
    }]);
    run(q('update-source-health'), [{
      source_id: 'src-1', total_analyzed_count: '12', channel_skip_rate: '0.75',
      active_status: 'false', auto_paused_at: '2026-10-08T00:00:00Z',
      auto_paused_reason: 'low yield', health_reset_at: '',
    }]);
    assert.equal(sql("SELECT active_status, channel_skip_rate, health_reset_at IS NULL FROM short_videos.source_channels WHERE source_id = 'src-1';"), 'f|0.75|t');

    // WF6: the download status transition and the created clip.
    run(q('update-moment-download-status'), [{ clip_moment_id: 'CM-1', download_status: 'SUBMITTED', download_job_id: 'YTDLP-CM-1' }]);
    run(q('upsert-created-clips'), [{
      created_clip_id: 'CC-CM-1', download_job_id: 'YTDLP-CM-1', video_id: 'v1',
      clip_moment_id: 'CM-1', niche: 'FINANCE_BUSINESS', clip_title: 'A Clip',
      clip_url: '', local_file_name: 'CC-CM-1.mp4', google_drive_file_id: 'drive-1',
      google_drive_url: 'https://drive.google.com/file/d/drive-1/view',
      duration_seconds: '60', transcript_excerpt: '', suggested_title: 'Suggested',
      suggested_caption: 'Caption', transformation_plan: '', review_status: 'AWAITING_DOWNLOAD',
      reviewer_notes: 'provider=yt-dlp', created_at: '2026-10-08T00:00:00Z',
    }]);
    run(q('update-moment-download-status'), [{ clip_moment_id: 'CM-1', download_status: 'COMPLETED', download_job_id: 'YTDLP-CM-1' }]);

    assert.equal(sql("SELECT download_status FROM short_videos.clip_moments WHERE clip_moment_id = 'CM-1';"), 'COMPLETED');
    assert.equal(sql("SELECT review_status, duration_seconds, transformation_plan IS NULL, clip_url IS NULL FROM short_videos.created_clips WHERE created_clip_id = 'CC-CM-1';"), 'AWAITING_DOWNLOAD|60|t|t');

    for (const name of ['select-transcript-analysis', 'select-clip-moments', 'select-created-clips']) {
      sql(q(name).replace(/;\s*$/, ''));
    }
  }, ['004-pipeline-store-sources.sql', '005-pipeline-store-analysis.sql', '006-pipeline-store-clips.sql']);
});

// WF8, WF8b, WF8c, WF8d and WF10. The arrays and the two jsonb columns are the
// reason this one matters: a newline-joined string fails a text[] column as a
// malformed array literal, and a stringified object lands in jsonb as a string
// scalar rather than an object.
test('real Postgres: every committed WF8-WF10 query runs against the schema', { skip: !available }, async () => {
  const q = (name) => fs.readFileSync(path.join(root, 'postgres/queries', `${name}.sql`), 'utf8');
  await withCluster(async ({ sql, run }) => {
    sql(`INSERT INTO short_videos.source_channels (source_id, niche, source_name, youtube_channel_url)
         VALUES ('src-1', 'FINANCE_BUSINESS', 'Example', 'https://youtube.com/@example');`);
    run(q('upsert-candidate-videos'), [{ video_id: 'v1', niche: 'FINANCE_BUSINESS', source_id: 'src-1', youtube_video_id: 'yt1', processing_status: 'NEW' }]);
    run(q('upsert-created-clips'), [{
      created_clip_id: 'CC-1', download_job_id: 'YTDLP-CM-1', video_id: 'v1',
      niche: 'FINANCE_BUSINESS', review_status: 'AWAITING_DOWNLOAD', created_at: '2026-10-08T00:00:00Z',
    }]);

    run(q('update-clip-drive-ids'), [{
      created_clip_id: 'CC-1', local_file_name: 'CC-1.mp4',
      google_drive_file_id: 'drive-1', google_drive_url: 'https://drive.google.com/file/d/drive-1/view',
    }]);

    // The four list columns are text[] and the plan is jsonb, so the Code node
    // hands over arrays and an object.
    run(q('update-clip-transformation'), [{
      created_clip_id: 'CC-1', suggested_title: 'A Title', suggested_caption: 'Caption',
      content_thesis: 'Thesis', hook: 'Hook', narration_script: 'Script',
      commentary_angle: 'Angle', kenyan_african_localization: 'Local', bible_verse_if_relevant: '',
      alternative_titles: ['Alt One', 'Alt Two'],
      on_screen_text_beats: ['Beat one', 'Beat two'],
      broll_plan: ['Founder on phone'],
      editing_style: 'Fast', hashtags: ['#KenyaBusiness', '#Startups'],
      cta: 'Follow', risk_warning: '', originality_checklist: ['Adds local context'],
      transformation_plan: { render_plan: { use_blurred_background: true } },
      review_status: 'NEEDS_REVIEW',
    }]);
    assert.equal(sql("SELECT array_length(alternative_titles, 1), hashtags[1], transformation_plan->'render_plan'->>'use_blurred_background', review_status FROM short_videos.created_clips WHERE created_clip_id = 'CC-1';"), '2|#KenyaBusiness|true|NEEDS_REVIEW');

    // WF8 writes NEEDS_RETRY when the plan fails to parse. It has to be a
    // value the review_status CHECK accepts.
    run(q('update-clip-transformation'), [{
      created_clip_id: 'CC-1', suggested_title: '', review_status: 'NEEDS_RETRY',
      transformation_plan: { parse_error: 'not valid JSON' },
    }]);
    assert.equal(sql("SELECT review_status, transformation_plan->>'parse_error' FROM short_videos.created_clips WHERE created_clip_id = 'CC-1';"), 'NEEDS_RETRY|not valid JSON');

    run(q('upsert-render-jobs'), [{
      render_id: 'RENDER-CC-1', created_clip_id: 'CC-1', niche: 'FINANCE_BUSINESS',
      source_drive_file_id: 'drive-1', source_file_name: 'CC-1.mp4',
      cta_start_second: '41', cta_end_second: '45', music_volume: '0.12',
      use_blurred_background: 'TRUE', render_status: 'PENDING',
      created_at: '2026-10-08T00:00:00Z',
    }]);
    run(q('update-render-asset-plan'), [{
      render_id: 'RENDER-CC-1', final_drive_folder_id: 'folder-1', hook_text: 'Hook',
      music_id: 'MUS-1', music_volume: '0.1', use_blurred_background: 'FALSE',
      ffmpeg_command: 'ffmpeg -y', render_status: 'DOWNLOADING_ASSETS',
      started_at: '', completed_at: '', warning_message: '', error_message: '',
    }]);
    run(q('update-render-status'), [{ render_id: 'RENDER-CC-1', render_status: 'RENDERING', started_at: '2026-10-08T01:00:00Z', completed_at: '' }]);
    run(q('update-render-completed'), [{
      render_id: 'RENDER-CC-1', render_status: 'COMPLETED', started_at: '2026-10-08T01:00:00Z',
      completed_at: '2026-10-08T01:05:00Z', final_drive_file_id: 'final-1',
      final_drive_url: 'https://drive.google.com/file/d/final-1/view',
      final_local_path: '/data/jobs/RENDER-CC-1/final.mp4', error_message: '',
    }]);
    assert.equal(sql("SELECT render_status, use_blurred_background, music_volume, completed_at IS NOT NULL FROM short_videos.render_jobs WHERE render_id = 'RENDER-CC-1';"), 'COMPLETED|f|0.1|t');

    run(q('update-render-failed'), [{ render_id: 'RENDER-CC-1', render_status: 'FAILED', started_at: '2026-10-08T01:00:00Z', completed_at: '2026-10-08T01:02:00Z', error_message: 'ffmpeg exited 1' }]);
    assert.equal(sql("SELECT render_status, error_message FROM short_videos.render_jobs WHERE render_id = 'RENDER-CC-1';"), 'FAILED|ffmpeg exited 1');

    // WF10 appends and never updates, so a repeated error_id must not add a row.
    const errorRow = [{
      error_id: 'ERR-1', workflow_name: 'WF8c FFmpeg Render', node_name: 'Run FFmpeg',
      related_video_id: 'v1', error_type: 'WorkflowError', error_message: 'boom',
      raw_payload: { execution: { id: '42' } },
    }];
    run(q('insert-error-log'), errorRow);
    run(q('insert-error-log'), errorRow);
    assert.equal(sql("SELECT count(*), max(raw_payload->'execution'->>'id') FROM short_videos.error_log;"), '1|42');

    for (const name of ['select-render-jobs', 'select-music-library', 'select-channel-branding']) {
      sql(q(name).replace(/;\s*$/, ''));
    }
  }, ['004-pipeline-store-sources.sql', '005-pipeline-store-analysis.sql', '006-pipeline-store-clips.sql', '007-pipeline-store-assets.sql']);
});
