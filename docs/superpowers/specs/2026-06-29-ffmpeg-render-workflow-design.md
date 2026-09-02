# FFmpeg Render Workflow Design

## Goal

Add an automatic post-production render stage after the existing Ssemble and WF8 Drive/transformation workflow. The first version produces a polished final MP4 from each Ssemble clip by adding a blurred background, centered speaker video, top hook text, niche watermark, progress bar, optional low-volume background music, and end CTA.

The render stage must keep the current pipeline shape intact:

```text
WF7 / WF7b
→ Created_Clips review_status=AWAITING_DOWNLOAD
→ WF8 downloads the Ssemble clip, uploads it to Drive, and creates an enhanced transformation plan
→ WF8 creates Render_Jobs render_status=PENDING
→ WF8c renders one pending job with FFmpeg inside the n8n container
→ WF8c uploads the final MP4 to a niche-specific Drive folder
→ WF8c updates Render_Jobs
```

Ssemble already burns captions, so this phase must not add subtitles or burn captions again.

## Current Repo Fit

The repo already has `WF8 Drive Storage + Transformation Planner`, backed by:

- `n8n/workflow-code/drive-storage-transform.js`
- `n8n/workflow-code/create-remaining-workflows.js`
- `n8n/workflows/08-drive-storage-transform.json`
- `tests/remaining-workflows.test.js`

WF8 currently reads `Created_Clips.review_status = AWAITING_DOWNLOAD`, downloads/uploads the Ssemble clip, runs the OpenAI transformation planner, and updates `Created_Clips` to `NEEDS_REVIEW`. This design extends WF8 instead of adding another AI planner, so render-specific instructions are generated in the existing transformation plan and parsed into a new `Render_Jobs` row.

## Sheet Schema

Add a `Render_Jobs` tab:

```text
render_id
created_clip_id
niche
source_drive_file_id
source_drive_url
source_file_name
final_drive_folder_id
hook_text
cta_text
cta_start_second
cta_end_second
music_id
music_drive_file_id
music_file_name
music_volume
watermark_drive_file_id
watermark_file_name
progress_bar_color
use_blurred_background
ffmpeg_command
render_status
final_local_path
final_drive_file_id
final_drive_url
warning_message
error_message
created_at
started_at
completed_at
```

`render_status` values:

```text
PENDING
DOWNLOADING_ASSETS
RENDERING
UPLOADING
COMPLETED
FAILED
SKIPPED
```

Add a `Music_Library` tab:

```text
music_id
niche
mood
energy_level
track_name
artist_name
source
source_url
license_notes
drive_file_id
duration_seconds
recommended_volume
loop_allowed
active_status
times_used
created_at
last_used_at
notes
```

Add a `Channel_Branding` tab. Branding is niche-level for this phase, not source/channel-level:

```text
niche
watermark_drive_file_id
primary_color
secondary_color
progress_bar_color
default_cta
music_default_id
active_status
notes
```

Keep `Created_Clips` mostly unchanged. It continues to store the full `transformation_plan` JSON. The render workflow reads the detailed render fields from `Render_Jobs`, not from additional flat columns on `Created_Clips`.

## WF8 Planner Changes

Extend the existing `TRANSFORMATION_SCHEMA` and prompt in `drive-storage-transform.js`. The planner keeps its existing originality and review fields:

```text
content_thesis
best_title
alternative_titles
hook
narration_script
commentary_angle
kenyan_african_localization
bible_verse_if_relevant
on_screen_text_beats
broll_plan
editing_style
caption
hashtags
cta
risk_warning
originality_checklist
```

Add a required `render` object:

```json
{
  "render": {
    "top_hook_text": "",
    "cta_text": "",
    "cta_start_second": 38,
    "cta_end_second": 42,
    "music_mood": "focused",
    "music_energy_level": "medium",
    "music_volume": 0.09,
    "use_blurred_background": true,
    "progress_bar_color": "0x137546"
  }
}
```

WF8 parses the enhanced plan, updates `Created_Clips`, and creates one `Render_Jobs` row:

```text
render_id = RENDER_<created_clip_id>
render_status = PENDING
source_drive_file_id = Created_Clips.google_drive_file_id
hook_text = render.top_hook_text fallback to hook or suggested_title
cta_text = render.cta_text fallback to cta
```

Normalization rules:

- Clamp `music_volume` to `0.04-0.14`.
- Clamp `cta_start_second` and `cta_end_second` inside the clip duration.
- Require FFmpeg colors in `0xRRGGBB` format.
- If the model omits the `render` object, create deterministic defaults from the existing planner fields and niche defaults.
- Keep the full raw plan in `Created_Clips.transformation_plan` for audit/debugging.

## WF8c Render Workflow

Create a separate workflow named `WF8c FFmpeg Render Final Clip`.

WF8c processes one render per run:

```text
Schedule/manual trigger
→ Read Render_Jobs
→ Pick oldest render_status=PENDING
→ Mark DOWNLOADING_ASSETS
→ Read Channel_Branding
→ Read Music_Library
→ Select active branding by niche
→ Select music by niche + planner mood/energy
→ Download source clip from Drive
→ Download watermark from Drive
→ Download music from Drive if selected
→ Build FFmpeg command
→ Execute Command
→ Upload final MP4 to final Drive folder for the niche
→ Mark Render_Jobs COMPLETED
```

Failure behavior:

```text
missing source clip      → FAILED
missing branding row     → FAILED
missing watermark        → FAILED
missing/invalid music    → render without music and set warning_message
FFmpeg nonzero exit      → FAILED with render log/error
Drive upload failure     → FAILED
```

Per-render workspace:

```text
/data/jobs/<render_id>/input.mp4
/data/jobs/<render_id>/watermark.png
/data/jobs/<render_id>/music.mp3
/data/jobs/<render_id>/output.mp4
/data/jobs/<render_id>/render.log
```

Store the generated command in `Render_Jobs.ffmpeg_command`. It must not contain secrets.

## Music Selection

WF8c reads `Music_Library` and selects an active track in this order:

```text
1. niche + mood + energy_level
2. niche + mood
3. niche + energy_level
4. Channel_Branding.music_default_id
5. no music with warning
```

The selected row supplies `music_id`, `drive_file_id`, and `recommended_volume`. WF8 planner volume can override the library value only after clamping to `0.04-0.14`.

## Drive Output

Final rendered MP4s go to separate final-render Drive folders per niche. Add placeholders for the generated workflow:

```text
GOOGLE_DRIVE_FINAL_FOLDER_CHRISTIAN_CONTENT
GOOGLE_DRIVE_FINAL_FOLDER_MOTIVATION_DISCIPLINE
GOOGLE_DRIVE_FINAL_FOLDER_FINANCE_BUSINESS
GOOGLE_DRIVE_FINAL_FOLDER_LIFE_VALUES_RELATIONSHIPS
GOOGLE_DRIVE_FINAL_FOLDER_AFRICAN_KENYAN_SUCCESS
```

The existing WF8 source-clip Drive folders remain separate from final-render folders.

## Docker and Runtime

FFmpeg runs inside the n8n container using the Execute Command node. Add a custom image:

```text
n8n/Dockerfile
```

The image should be based on the current pinned n8n version and install:

```text
ffmpeg
fontconfig
DejaVu Sans or another stable open-source font
```

Update both compose files to use the custom image and mount:

```text
./render-data:/data
```

Runtime folders:

```text
/data/input/ssemble
/data/output/final
/data/assets/music
/data/assets/watermarks
/data/jobs
/data/logs
```

FFmpeg `drawtext` must use an explicit `fontfile` path so local and production renders match.

## FFmpeg MVP Template

The MVP output:

```text
Ssemble burned captions stay unchanged
+ blurred 1080x1920 background
+ centered foreground video
+ top hook text
+ niche watermark
+ bottom progress bar
+ optional low-volume background music
+ end CTA
```

No B-roll is rendered in this phase.

The command builder must use official FFmpeg filter behavior for `scale`, `crop`, `boxblur`, `overlay`, `drawbox`, `drawtext`, `volume`, `aloop`, and `amix`. Planning reference: https://ffmpeg.org/ffmpeg-filters.html

Implementation rules:

- Escape hook and CTA text before inserting into `drawtext`.
- Use `fontfile=<known-font-path>`.
- Use `0xRRGGBB` progress colors.
- Use a no-music command variant when no valid music file exists.
- Keep original clip audio at normal volume.
- Mix music only when a downloaded music file exists.
- Write stdout/stderr to `/data/jobs/<render_id>/render.log`.

## Out of Scope for MVP

Do not add B-roll search/download/rendering in this phase. These are later phases:

- `Broll_Library`
- Pexels API search
- Pixabay API search
- B-roll cache reuse
- Fullscreen cutaways
- Picture-in-picture overlays
- Multiple render templates by niche
- Auto-adding rows to `Approved_For_Posting`

The existing `broll_plan` can remain useful for review and future phases, but WF8c ignores it for the MVP.

## Testing and Verification

Repo-level tests should cover pure helper behavior before workflow generation:

- WF8 parser accepts the enhanced render object.
- WF8 render-job builder creates deterministic `RENDER_<created_clip_id>` rows.
- Volume, CTA timing, and color normalization are bounded.
- Music selection follows the priority order.
- Missing watermark/branding/source failures produce `FAILED`.
- Missing music produces warning plus no-music command variant.
- FFmpeg command builder escapes text and includes explicit `fontfile`.
- Generated WF8 and WF8c workflow JSON contain the expected nodes and connections.

Verification commands should include:

```bash
node --test tests/*.test.js
python3 -m json.tool n8n/workflows/08-drive-storage-transform.json > /dev/null
python3 -m json.tool n8n/workflows/08c-ffmpeg-render-final-clip.json > /dev/null
docker compose -f n8n/compose.local.yaml build n8n
```

Live n8n verification remains separate from repo-owned completion because credentials, Drive folders, and sheet tabs must be created or confirmed in the n8n UI / Google Drive / Google Sheets.
