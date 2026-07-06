// Pre-transcript moment discovery: heatmap peaks, timestamped-comment clusters,
// chapters → ranked candidate clip windows. Pure logic, no I/O — portable into
// an n8n Code node. Spec: docs/superpowers/specs/2026-07-06-moment-discovery-design.md

function parseHeatmap(infoJson) {
  const heatmap = infoJson && Array.isArray(infoJson.heatmap) ? infoJson.heatmap : [];
  return heatmap
    .map((seg) => ({
      startSec: Number(seg.start_time || 0),
      endSec: Number(seg.end_time || 0),
      intensity: Number(seg.value || 0),
    }))
    .filter((seg) => Number.isFinite(seg.startSec) && Number.isFinite(seg.endSec) && seg.endSec > seg.startSec);
}

function pickHeatmapPeaks(segments, options = {}) {
  const minIntensity = options.minIntensity ?? 0.7;
  const ignoreFirstSec = options.ignoreFirstSec ?? 90;
  const mergeGapSec = options.mergeGapSec ?? 30;

  const eligible = (segments || [])
    .filter((seg) => seg.intensity >= minIntensity && seg.startSec >= ignoreFirstSec)
    .sort((a, b) => a.startSec - b.startSec);

  const peaks = [];
  for (const seg of eligible) {
    const last = peaks[peaks.length - 1];
    if (last && seg.startSec - last.endSec <= mergeGapSec) {
      last.endSec = Math.max(last.endSec, seg.endSec);
      last.intensity = Math.max(last.intensity, seg.intensity);
    } else {
      peaks.push({ startSec: seg.startSec, endSec: seg.endSec, intensity: seg.intensity });
    }
  }
  return peaks;
}

const TIMESTAMP_RE = /\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g;

function extractTimestampsFromComments(comments) {
  const hits = [];
  for (const comment of comments || []) {
    const text = String((comment && comment.text) || '');
    const author = String((comment && comment.author) || '');
    if (!text) continue;
    for (const match of text.matchAll(TIMESTAMP_RE)) {
      const hours = match[1] ? Number(match[1]) : 0;
      const minutes = Number(match[2]);
      const seconds = Number(match[3]);
      if (minutes >= 60 || seconds >= 60) continue;
      hits.push({ sec: hours * 3600 + minutes * 60 + seconds, text, author });
    }
  }
  return hits;
}

function clusterCommentTimestamps(hits, options = {}) {
  const windowSec = options.windowSec ?? 120;
  const minMentions = options.minMentions ?? 3;
  const ignoreFirstSec = options.ignoreFirstSec ?? 90;

  const sorted = [...(hits || [])].sort((a, b) => a.sec - b.sec);
  const clusters = [];
  for (const hit of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && hit.sec - last.startSec <= windowSec) {
      last.endSec = Math.max(last.endSec, hit.sec);
      last.mentions += 1;
      if (last.sampleComments.length < 3 && !last.sampleComments.includes(hit.text)) {
        last.sampleComments.push(hit.text);
      }
    } else {
      clusters.push({
        startSec: hit.sec,
        endSec: hit.sec,
        mentions: 1,
        sampleComments: [hit.text],
        introFlag: hit.sec < ignoreFirstSec,
      });
    }
  }
  return clusters.filter((cluster) => cluster.mentions >= minMentions);
}

module.exports = {
  parseHeatmap,
  pickHeatmapPeaks,
  extractTimestampsFromComments,
  clusterCommentTimestamps,
};
