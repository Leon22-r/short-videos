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

module.exports = {
  parseHeatmap,
  pickHeatmapPeaks,
};
