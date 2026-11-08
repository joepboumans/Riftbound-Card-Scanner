// Learned references: artwork fingerprints saved from the user's own
// user-confirmed scans. This module owns when one is saved, how many a card
// keeps, and where they are stored. It never touches the matcher database, so
// saving one never bumps `matcher.revision`.
import { compareFeatures, describeFeatures, MIN_STRUCTURE_NORM } from './cardSimilarity.js';
import { loadLearnedReferences, writeLearnedReferences } from './indexedDB.js';

export const MAX_LEARNED_REFERENCES_PER_CARD = 5;
// A new reference this similar to one of the same card replaces it.
export const LEARNED_REFERENCE_DUPLICATE_SIMILARITY = 0.98;

const officialSimilarity = (features, official) =>
  official?.length === features.length ? compareFeatures(features, official).similarity : null;

let idCounter = 0;
const createReferenceId = () => `learned-${Date.now().toString(36)}-${(idCounter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * The artwork of one scan, as learned references need it. Features are
 * computed only when a user-confirmed scan is offered, with the same crop and
 * sampling mode the matcher ranked.
 */
export function describeScanArtwork({ crop, quality, outlined, areaSampling = false, matcher }) {
  let features;
  return { crop, quality, outlined: Boolean(outlined),
    features: () => (features ||= matcher.artworkFeatures(crop, { areaSampling })),
    officialFeatures: (cardId) => matcher.cards.find((card) => card.id === cardId)?.f || null };
}

// §2: the crop came from a detected card outline and passed the quality check
// without glare. A failed-quality Snap review crop never qualifies.
const isClearCrop = (artwork) => Boolean(artwork?.outlined && artwork.quality?.acceptable === true &&
  artwork.quality.issue !== 'glare' && !artwork.quality.reflectionRisk);

// The artwork's feature vector, when it has enough structure to be ranked.
function rankableFeatures(artwork) {
  try {
    const features = Float32Array.from(artwork.features() || []);
    return describeFeatures(features)?.structureNorm >= MIN_STRUCTURE_NORM ? features : null;
  } catch (error) {
    console.warn('[LearnedReferences] Could not read scan artwork:', error);
    return null;
  }
}

/**
 * @param {{ store?: { load(): Promise<object[]>, write(change: { put?: object[], remove?: string[] }): Promise<void> },
 *   now?: () => number, createId?: () => string }} options
 */
export function createLearnedReferences({ store = indexedDBStore, now = Date.now, createId = createReferenceId } = {}) {
  let records = [];
  // Every change runs after the initial load and after the previous change.
  let queue = Promise.resolve().then(() => store.load()).then((loaded) => { records = loaded || []; })
    .catch((error) => console.warn('[LearnedReferences] Could not load learned references:', error));
  const enqueue = (change) => {
    queue = queue.then(change).catch((error) => console.warn('[LearnedReferences] Could not store learned references:', error));
    return queue;
  };

  // Applies §3 limits for one card: a near-duplicate is replaced, otherwise the
  // oldest goes once the card is at its limit.
  function add(record) {
    const sameCard = records.filter((other) => other.cardId === record.cardId);
    const duplicate = sameCard.find((other) => other.gridSize === record.gridSize &&
      compareFeatures(record.features, other.features).similarity >= LEARNED_REFERENCE_DUPLICATE_SIMILARITY);
    const removed = duplicate ? [duplicate]
      : sameCard.sort((a, b) => a.savedAt - b.savedAt).slice(0, Math.max(0, sameCard.length - MAX_LEARNED_REFERENCES_PER_CARD + 1));
    const removedIds = new Set(removed.map((other) => other.id));
    records = [...records.filter((other) => !removedIds.has(other.id)), record];
    return store.write({ put: [record], remove: [...removedIds] });
  }

  return {
    /**
     * Offers a user-confirmed scan's artwork. Returns the id of the learned
     * reference it saves, or null when the crop is not clear enough. The
     * decision is immediate; storing it completes in the background.
     */
    save({ cardId, artwork }) {
      const features = cardId && isClearCrop(artwork) ? rankableFeatures(artwork) : null;
      if (!features) return null;
      const record = { id: createId(), cardId, features, gridSize: Math.round(Math.sqrt(features.length / 3)),
        savedAt: now(), officialSimilarity: officialSimilarity(features, artwork.officialFeatures?.(cardId)) };
      enqueue(() => add(record));
      return record.id;
    },
    /** Every stored learned reference, for the matcher's learned pass. */
    references: () => records,
    /** Resolves once every change so far is stored. */
    settled: () => queue,
  };
}

const indexedDBStore = { load: loadLearnedReferences, write: writeLearnedReferences };

let instance = null;
export function getLearnedReferences() {
  instance ||= createLearnedReferences();
  return instance;
}
