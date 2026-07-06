# Moment Discovery — Pre-Transcript Scoring Test Harness

**Date:** 2026-07-06
**Status:** Approved design, pending implementation
**Branch:** feat/n8n-video-pipeline-phase1

## Problem

The pipeline currently transcribes and AI-scores entire videos (WF4 → WF5). For a
2-hour podcast, most of that cost is wasted: only a few moments are clip-worthy.
YouTube exposes crowd signals *before* any transcript exists:

1. **"Most Replayed" heatmap** — replay-intensity segments in the player response
   (`startMillis`, `durationMillis`, `intensityScoreNormalized` 0–1). Extractable
   via yt-dlp (`heatmap` field in info JSON). Only present on videos with enough
   views (~50k+), which the existing Stage 1 filter already selects for.
2. **Timestamped comments** — viewers hand-label highlights ("34:20 had me in
   tears"). Fetched via `commentThreads.list` (1 quota unit per call).
3. **Chapters** — free topic-level structure from creator, in yt-dlp info JSON.

Goal of this task: a **standalone test harness** that runs these signals against
YouTube videos the user already knows well, so signal quality and thresholds can
be judged before the feature is integrated into the n8n workflows.

## Scope

**In scope (v1):**
- Pure-logic module for heatmap parsing, peak merging, comment-timestamp
  clustering, chapter extraction, and deterministic candidate-window scoring.
- CLI runner taking YouTube URLs, producing console output + markdown report.
- Fixture-based unit tests.

**Out of scope (recorded for later):**
- n8n workflow integration (new stage between WF2/WF3 and WF4).
- AI scoring of chapter titles (v1 extracts and lists chapters only).
- Google Sheets reads/writes.
- Pinned-comment / creator-shorts / public-clips signals.

## Architecture

Three files, following existing repo conventions (pure logic in
`n8n/workflow-code/`, tests in `tests/` run by `node --test`):

### 1. `n8n/workflow-code/moment-discovery.js` — pure logic, no I/O

Exports:

| Function | Input → Output |
|---|---|
| `parseHeatmap(infoJson)` | yt-dlp info JSON → `[{startSec, endSec, intensity}]` |
| `pickHeatmapPeaks(segments, opts)` | segments → merged peak windows. Defaults: `minIntensity: 0.7`, `ignoreFirstSec: 90`, `mergeGapSec: 30` |
| `extractTimestampsFromComments(comments)` | comment list → `[{sec, text, author}]` using regex `\b(\d{1,2}:)?\d{1,2}:\d{2}\b` (supports `h:mm:ss` and `mm:ss`) |
| `clusterCommentTimestamps(hits, opts)` | timestamp hits → clusters. Defaults: `windowSec: 120`, `minMentions: 3`. Each cluster keeps sample quotes |
| `extractChapters(infoJson)` | info JSON → `[{startSec, endSec, title}]` |
| `scoreCandidateWindows({peaks, clusters, chapters, durationSec})` | all signals → ranked candidate windows |

Candidate window shape:

```js
{
  startSec, endSec,          // padded transcription range (signal span ±90s, clamped to [0, duration])
  score,                     // 0–1
  signals: ['heatmap', 'comments', 'chapter'],  // which contributed
  evidence: {
    heatIntensity,           // max intensity if heatmap signal
    commentMentions,         // count if comment signal
    sampleComments,          // up to 3 quotes
    chapterTitle             // if window overlaps a chapter
  }
}
```

### 2. `scripts/discover-moments.js` — CLI runner

Usage: `node scripts/discover-moments.js <url> [<url> ...]`

Per URL:
1. Run `yt-dlp -J --skip-download <url>` as subprocess → info JSON (heatmap,
   chapters, duration, title, video id).
2. If `YOUTUBE_API_KEY` env var set: fetch top ~100 comments via
   `commentThreads.list` (order=relevance, maxResults=100, one call).
3. Run pure-logic scoring.
4. Print ranked table to console.
5. Write markdown report to
   `n8n/local-files/moment-discovery-report-<YYYY-MM-DD>.md` — per video: ranked
   windows with clickable `https://youtu.be/<id>?t=<sec>` links, evidence
   (intensity, mention count, sample comment quotes, chapter title), plus full
   chapter list for manual judgment.

### 3. `tests/moment-discovery.test.js`

Fixture-based tests of the pure functions: fake heatmap arrays, fake comment
sets, synthetic overlaps. No network, no yt-dlp. Follows existing test style.

## Scoring model (v1, deterministic)

- **Heatmap peak:** base score = max `intensityScoreNormalized` of the merged
  segment (0–1).
- **Comment cluster:** score = `min(1, mentions / 6)`.
- **Overlap bonus:** window where heatmap peak and comment cluster overlap →
  `score = 0.5 + 0.5 × (heatScore + commentScore) / 2`. Always ≥ either
  standalone signal; these process first.
- **Chapter overlap:** +0.1 to window score (cap at 1.0) and `chapterTitle`
  recorded. Chapters also listed separately in the report.
- **Intro noise:** heatmap segments in first 90s ignored entirely. Comment
  timestamps in first 90s kept but flagged `introFlag: true`.
- **Padding:** final window = merged signal span padded ±90s each side, clamped
  to `[0, durationSec]` — this is the "transcribe only this" range.

All numbers above are tuning knobs exposed as option objects with these
defaults. Expectation: defaults change after runs against known videos —
that is the point of this harness.

## Error handling / degradation

| Failure | Behavior |
|---|---|
| yt-dlp not installed / extraction fails | Clear message; continue with comments + chapters only |
| No heatmap in info JSON (low-view video) | Report notes "no heatmap"; comment-only scoring |
| `YOUTUBE_API_KEY` missing or quota/API error | Warn; heatmap + chapters only |
| Zero signals for a video | Report states it explicitly (useful negative test data) |

Signals fail independently; the run never aborts on a single-signal failure.

## Prerequisites

- `yt-dlp` on PATH (not currently installed: `pipx install yt-dlp` or
  `pip install yt-dlp`).
- `YOUTUBE_API_KEY` env var (or in `.env`) for comment fetching; script
  degrades gracefully without it.
- Node 18+ (global `fetch` used for the comments API call).

## Success criteria

- Running the script against 3–5 videos the user knows produces ranked windows
  the user recognizes as the actual good moments.
- Unit tests pass under `npm test` alongside the existing 152+ tests.
- Signal-quality observations (heatmap vs comments per video type) recorded to
  inform integration thresholds.

## Integration path (future, out of scope)

Once thresholds are tuned: `moment-discovery.js` becomes a new pipeline stage
between WF2/WF3 (candidate videos) and WF4 (transcript fetch). It writes
candidate windows (likely a new sheet tab or columns), and WF4 transcribes only
those windows instead of full videos — cutting transcript/AI cost sharply on
long-form sources. yt-dlp extraction stays isolated in one node/service so it
can be patched easily when YouTube changes internals, failing over to
comments + chapters.
