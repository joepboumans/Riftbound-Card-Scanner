import { AUTOMATIC_ARTWORK_MINIMUM, ARTWORK_SEPARATION } from './scanAcceptance.js';

export const SCAN_MATCHING_STORAGE_KEY = 'riftbound_scan_matching';
export const DEFAULT_SCAN_MATCHING = Object.freeze({
  minSimilarity: AUTOMATIC_ARTWORK_MINIMUM,
  minSimilarityGap: ARTWORK_SEPARATION,
});
// Recognition never accepts artwork below 68% match, so the slider stops there.
export const SCAN_MATCHING_LIMITS = Object.freeze({
  minSimilarity: { min: 0.68, max: 0.98 },
  minSimilarityGap: { min: 0.01, max: 0.15 },
});

function clampSetting(value, key) {
  if (!Number.isFinite(value)) return DEFAULT_SCAN_MATCHING[key];
  const { min, max } = SCAN_MATCHING_LIMITS[key];
  return Math.round(Math.max(min, Math.min(max, value)) * 100) / 100;
}

export function normalizeScanMatching(value) {
  return {
    minSimilarity: clampSetting(value?.minSimilarity, 'minSimilarity'),
    minSimilarityGap: clampSetting(value?.minSimilarityGap, 'minSimilarityGap'),
  };
}
