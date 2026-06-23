/**
 * Channel health check utilities
 * Pure logic for evaluating channel health and detecting manual re-enables
 */

/**
 * Detects when a human has manually re-enabled a previously auto-paused channel
 * @param {Object} channelRow - Source_Channels row object
 * @returns {boolean} true if active_status='TRUE' AND auto_paused_at is non-empty
 */
function detectReEnable(channelRow) {
  return (
    String(channelRow.active_status || '').toUpperCase() === 'TRUE' &&
    Boolean(channelRow.auto_paused_at)
  );
}

/**
 * Evaluates the all-time skip rate for a channel
 * Respects a reset cutoff date to prevent re-pause loops
 *
 * @param {string} sourceId - The channel's source_id
 * @param {Array} allTranscriptRows - Array of Transcript_Analysis sheet rows
 *   Each row has: source_id, ai_episode_score, recommended_strategy, created_at
 * @param {string|null} healthResetAt - ISO timestamp or null/empty
 *   If set, only rows with created_at > healthResetAt are counted
 *
 * @returns {Object} { shouldPause, total, skipCount?, skipRate?, reason? }
 *   - If total < 10: { shouldPause: false, total, skipRate: null }
 *   - Otherwise: { shouldPause, total, skipCount, skipRate, reason }
 */
function evaluateChannelHealth(sourceId, allTranscriptRows, healthResetAt) {
  // Filter rows: source_id match + has ai_episode_score + respects healthResetAt cutoff
  const filtered = allTranscriptRows.filter((row) => {
    if (String(row.source_id || '') !== sourceId) return false;
    if (!row.ai_episode_score) return false; // Ignore unanalyzed rows
    if (healthResetAt) {
      // Only count rows created AFTER the cutoff (strict >)
      return new Date(row.created_at) > new Date(healthResetAt);
    }
    return true;
  });

  const total = filtered.length;

  // Below threshold: not enough data
  if (total < 10) {
    return {
      shouldPause: false,
      total,
      skipRate: null,
    };
  }

  // Count skips and calculate rate
  const skipCount = filtered.filter(
    (row) => String(row.recommended_strategy || '') === 'SKIP_THIS_VIDEO',
  ).length;
  const skipRate = skipCount / total;

  return {
    shouldPause: skipRate >= 0.7,
    total,
    skipCount,
    skipRate,
    reason: `skip_rate=${Math.round(skipRate * 100)}% (${skipCount}/${total} videos)`,
  };
}

module.exports = {
  detectReEnable,
  evaluateChannelHealth,
};
