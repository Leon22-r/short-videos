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

function extractChapters(infoJson) {
  const chapters = infoJson && Array.isArray(infoJson.chapters) ? infoJson.chapters : [];
  return chapters.map((chapter) => ({
    startSec: Number(chapter.start_time || 0),
    endSec: Number(chapter.end_time || 0),
    title: String(chapter.title || ''),
  }));
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

function scoreCandidateWindows({ peaks = [], clusters = [], chapters = [], durationSec = 0 } = {}, options = {}) {
  const padSec = options.padSec ?? 90;
  const chapterBonus = options.chapterBonus ?? 0.1;
  const commentScoreDivisor = options.commentScoreDivisor ?? 6;

  const usedClusters = new Set();
  const raw = [];

  for (const peak of peaks) {
    const overlapping = clusters.filter(
      (cluster) => rangesOverlap(peak.startSec, peak.endSec, cluster.startSec, cluster.endSec),
    );
    overlapping.forEach((cluster) => usedClusters.add(cluster));

    if (overlapping.length > 0) {
      const mentions = overlapping.reduce((sum, cluster) => sum + cluster.mentions, 0);
      const commentScore = Math.min(1, mentions / commentScoreDivisor);
      raw.push({
        startSec: Math.min(peak.startSec, ...overlapping.map((c) => c.startSec)),
        endSec: Math.max(peak.endSec, ...overlapping.map((c) => c.endSec)),
        score: 0.5 + 0.5 * ((peak.intensity + commentScore) / 2),
        signals: ['heatmap', 'comments'],
        introFlag: overlapping.some((c) => c.introFlag),
        heatIntensity: peak.intensity,
        commentMentions: mentions,
        sampleComments: overlapping.flatMap((c) => c.sampleComments).slice(0, 3),
      });
    } else {
      raw.push({
        startSec: peak.startSec,
        endSec: peak.endSec,
        score: peak.intensity,
        signals: ['heatmap'],
        introFlag: false,
        heatIntensity: peak.intensity,
        commentMentions: null,
        sampleComments: [],
      });
    }
  }

  for (const cluster of clusters) {
    if (usedClusters.has(cluster)) continue;
    raw.push({
      startSec: cluster.startSec,
      endSec: cluster.endSec,
      score: Math.min(1, cluster.mentions / commentScoreDivisor),
      signals: ['comments'],
      introFlag: Boolean(cluster.introFlag),
      heatIntensity: null,
      commentMentions: cluster.mentions,
      sampleComments: cluster.sampleComments.slice(0, 3),
    });
  }

  const windows = raw.map((win) => {
    const chapter = chapters.find((ch) => rangesOverlap(win.startSec, win.endSec, ch.startSec, ch.endSec));
    const score = chapter ? Math.min(1, win.score + chapterBonus) : win.score;
    const signals = chapter ? [...win.signals, 'chapter'] : win.signals;
    return {
      startSec: Math.max(0, win.startSec - padSec),
      endSec: durationSec > 0 ? Math.min(durationSec, win.endSec + padSec) : win.endSec + padSec,
      score,
      signals,
      introFlag: win.introFlag,
      evidence: {
        heatIntensity: win.heatIntensity,
        commentMentions: win.commentMentions,
        sampleComments: win.sampleComments,
        chapterTitle: chapter ? chapter.title : null,
      },
    };
  });

  return windows.sort((a, b) => b.score - a.score);
}

module.exports = {
  parseHeatmap,
  pickHeatmapPeaks,
  extractTimestampsFromComments,
  clusterCommentTimestamps,
  extractChapters,
  scoreCandidateWindows,
};
