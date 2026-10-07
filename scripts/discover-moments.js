#!/usr/bin/env node
// Moment-discovery test harness: score YouTube videos for clip-worthy moments
// using pre-transcript signals (heatmap, timestamped comments, chapters).
//
// Usage: node scripts/discover-moments.js <youtube-url> [<youtube-url> ...]
// Requires: yt-dlp on PATH (heatmap+chapters), YOUTUBE_API_KEY env (comments).
// Spec: docs/superpowers/specs/2026-07-06-moment-discovery-design.md

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseHeatmap,
  pickHeatmapPeaks,
  extractTimestampsFromComments,
  clusterCommentTimestamps,
  extractChapters,
  scoreCandidateWindows,
} = require('../domains/short-videos/workflow-code/moment-discovery');

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.join(__dirname, '..');

function loadApiKey() {
  if (process.env.YOUTUBE_API_KEY) return process.env.YOUTUBE_API_KEY;
  for (const envPath of [path.join(REPO_ROOT, '.env'), path.join(REPO_ROOT, 'hosts', '.env')]) {
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const match = line.match(/^\s*YOUTUBE_API_KEY\s*=\s*"?([^"\s#]+)"?/);
      if (match) return match[1];
    }
  }
  return null;
}

function parseVideoId(url) {
  const match = String(url).match(/(?:v=|youtu\.be\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/);
  return match ? match[1] : null;
}

async function fetchInfoJson(url) {
  const { stdout } = await execFileAsync('yt-dlp', ['-J', '--skip-download', url], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function fetchComments(videoId, apiKey) {
  const endpoint = new URL('https://www.googleapis.com/youtube/v3/commentThreads');
  endpoint.searchParams.set('part', 'snippet');
  endpoint.searchParams.set('videoId', videoId);
  endpoint.searchParams.set('maxResults', '100');
  endpoint.searchParams.set('order', 'relevance');
  endpoint.searchParams.set('textFormat', 'plainText');
  endpoint.searchParams.set('key', apiKey);

  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`commentThreads.list failed: HTTP ${response.status} ${await response.text()}`);
  }
  const body = await response.json();
  return (body.items || []).map((item) => {
    const snippet = item.snippet.topLevelComment.snippet;
    return { text: snippet.textDisplay || '', author: snippet.authorDisplayName || '' };
  });
}

function formatTime(totalSec) {
  const sec = Math.floor(totalSec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

async function processVideo(url, apiKey) {
  const result = {
    url,
    videoId: parseVideoId(url),
    title: null,
    durationSec: 0,
    windows: [],
    chapters: [],
    notes: [],
  };

  let infoJson = null;
  try {
    infoJson = await fetchInfoJson(url);
    result.videoId = infoJson.id || result.videoId;
    result.title = infoJson.title || null;
    result.durationSec = Number(infoJson.duration || 0);
  } catch (error) {
    result.notes.push(`yt-dlp failed (${error.message.split('\n')[0]}) — heatmap and chapters unavailable`);
  }

  const heatSegments = parseHeatmap(infoJson);
  if (infoJson && heatSegments.length === 0) {
    result.notes.push('no heatmap on this video (likely too few views) — comment/chapter signals only');
  }
  const peaks = pickHeatmapPeaks(heatSegments);
  result.chapters = extractChapters(infoJson);

  let clusters = [];
  if (!apiKey) {
    result.notes.push('YOUTUBE_API_KEY not set — comment signal skipped');
  } else if (!result.videoId) {
    result.notes.push('could not determine video id — comment signal skipped');
  } else {
    try {
      const comments = await fetchComments(result.videoId, apiKey);
      clusters = clusterCommentTimestamps(extractTimestampsFromComments(comments));
    } catch (error) {
      result.notes.push(`comments fetch failed (${error.message.split('\n')[0]}) — comment signal skipped`);
    }
  }

  result.windows = scoreCandidateWindows({
    peaks,
    clusters,
    chapters: result.chapters,
    durationSec: result.durationSec,
  });
  if (result.windows.length === 0) {
    result.notes.push('zero signals found — no candidate windows for this video');
  }
  return result;
}

function renderConsole(result) {
  console.log(`\n=== ${result.title || result.url} ===`);
  for (const note of result.notes) console.log(`  ! ${note}`);
  if (result.windows.length === 0) return;
  console.log('  rank  score  window                signals');
  result.windows.forEach((win, index) => {
    const range = `${formatTime(win.startSec)} - ${formatTime(win.endSec)}`;
    const flags = win.introFlag ? ' [intro]' : '';
    console.log(
      `  ${String(index + 1).padStart(4)}  ${win.score.toFixed(2)}   ${range.padEnd(20)} ${win.signals.join('+')}${flags}`,
    );
  });
}

function renderMarkdown(results) {
  const lines = [`# Moment Discovery Report — ${new Date().toISOString().slice(0, 10)}`, ''];
  for (const result of results) {
    lines.push(`## ${result.title || result.url}`, '');
    lines.push(`- URL: ${result.url}`);
    if (result.durationSec) lines.push(`- Duration: ${formatTime(result.durationSec)}`);
    for (const note of result.notes) lines.push(`- ⚠ ${note}`);
    lines.push('');
    if (result.windows.length > 0) {
      lines.push('| # | Score | Window | Signals | Evidence |');
      lines.push('|---|-------|--------|---------|----------|');
      result.windows.forEach((win, index) => {
        const link = result.videoId
          ? `[${formatTime(win.startSec)}](https://youtu.be/${result.videoId}?t=${Math.floor(win.startSec)})`
          : formatTime(win.startSec);
        const evidence = [];
        if (win.evidence.heatIntensity != null) evidence.push(`heat ${win.evidence.heatIntensity.toFixed(2)}`);
        if (win.evidence.commentMentions != null) evidence.push(`${win.evidence.commentMentions} comment mentions`);
        if (win.evidence.sampleComments.length > 0) {
          evidence.push(`"${win.evidence.sampleComments[0].replace(/\|/g, '\\|').slice(0, 80)}"`);
        }
        if (win.evidence.chapterTitle) evidence.push(`chapter: ${win.evidence.chapterTitle.replace(/\|/g, '\\|')}`);
        if (win.introFlag) evidence.push('intro-flagged');
        lines.push(
          `| ${index + 1} | ${win.score.toFixed(2)} | ${link} → ${formatTime(win.endSec)} | ${win.signals.join('+')} | ${evidence.join('; ')} |`,
        );
      });
      lines.push('');
    }
    if (result.chapters.length > 0) {
      lines.push('<details><summary>Chapters</summary>', '');
      for (const chapter of result.chapters) {
        lines.push(`- ${formatTime(chapter.startSec)} — ${chapter.title}`);
      }
      lines.push('', '</details>', '');
    }
  }
  return lines.join('\n');
}

async function main() {
  const urls = process.argv.slice(2);
  if (urls.length === 0) {
    console.error('Usage: node scripts/discover-moments.js <youtube-url> [<youtube-url> ...]');
    process.exit(1);
  }

  const apiKey = loadApiKey();
  const results = [];
  for (const url of urls) {
    try {
      const result = await processVideo(url, apiKey);
      results.push(result);
      renderConsole(result);
    } catch (error) {
      console.error(`\n=== ${url} ===\n  ! unexpected failure: ${error.message}`);
      results.push({ url, videoId: parseVideoId(url), title: null, durationSec: 0, windows: [], chapters: [], notes: [`unexpected failure: ${error.message}`] });
    }
  }

  // domains/short-videos/local-files is a root-owned docker mount — keep reports in repo-root reports/ instead
  const reportDir = path.join(REPO_ROOT, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `moment-discovery-report-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(reportPath, renderMarkdown(results));
  console.log(`\nReport written: ${reportPath}`);
}

main();
