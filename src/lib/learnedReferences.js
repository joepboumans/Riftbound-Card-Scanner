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
    officialFeatures: (cardId) => matcher.officialFeatures(cardId) };
}

// Feature vectors are RGB grids: three values per cell of a gridSize x gridSize grid.
const featureLength = (gridSize) => gridSize * gridSize * 3;
const gridSizeOf = (features) => Math.round(Math.sqrt(features.length / 3));

/**
 * Whether the matcher can use a learned reference: its card is in the card
 * database (`cardIds`) and its feature vector has the card database's grid
 * size. An unusable one is kept, unused, until its card returns.
 */
export function isUsableLearnedReference(reference, { cardIds, gridSize }) {
  return cardIds.has(reference.cardId) && reference.gridSize === gridSize &&
    reference.features?.length === featureLength(gridSize);
}

// See issue #6 (learned references): the crop came from a detected card outline and passed the quality check
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

/** Settings counts, with `unused` by the same rule as the matcher's learned pass. */
export function summarizeLearnedReferences(references, { cards = [], gridSize = null } = {}) {
  const usable = { cardIds: new Set(cards.map((card) => card.id)), gridSize };
  return { references: references.length, cards: new Set(references.map((record) => record.cardId)).size,
    unused: references.filter((record) => !isUsableLearnedReference(record, usable)).length };
}

export const LEARNED_REFERENCES_BACKUP_FORMAT = 'riftbound-learned-references';
export const LEARNED_REFERENCES_BACKUP_VERSION = 1;

// One backup record as a learned reference, or null when it is malformed.
function readBackupRecord(record) {
  const gridSize = Number(record?.gridSize);
  if (typeof record?.cardId !== 'string' || !record.cardId || !Array.isArray(record.features) ||
    !Number.isInteger(gridSize) || gridSize < 1 || record.features.length !== featureLength(gridSize) ||
    !record.features.every(Number.isFinite)) return null;
  return { id: typeof record.id === 'string' && record.id ? record.id : null, cardId: record.cardId,
    features: Float32Array.from(record.features), gridSize,
    savedAt: Number.isFinite(record.savedAt) ? record.savedAt : 0,
    officialSimilarity: Number.isFinite(record.officialSimilarity) ? record.officialSimilarity : null };
}

/**
 * @param {{ store?: { load(): Promise<object[]>, write(change: { put?: object[], remove?: string[] }): Promise<void> },
 *   now?: () => number, createId?: () => string }} options
 */
export function createLearnedReferences({ store = indexedDBStore, now = Date.now, createId = createReferenceId } = {}) {
  let records = [];
  const listeners = new Set();
  const notify = () => { for (const listener of listeners) listener(); };
  // Every change runs after the initial load and after the previous change.
  let queue = Promise.resolve().then(() => store.load()).then((loaded) => { records = loaded || []; })
    .catch((error) => console.warn('[LearnedReferences] Could not load learned references:', error))
    .then(notify);
  const enqueue = (change) => {
    queue = queue.then(change).catch((error) => console.warn('[LearnedReferences] Could not store learned references:', error))
      .then(notify);
    return queue;
  };

  // Applies the per-card limits of issue #6: a near-duplicate is replaced, otherwise
  // the card keeps its newest references. Resolves to whether `record` was kept
  // (an imported one can be older than all of a full card's references).
  async function add(record) {
    const sameCard = records.filter((other) => other.cardId === record.cardId);
    const duplicate = sameCard.find((other) => other.gridSize === record.gridSize &&
      compareFeatures(record.features, other.features).similarity >= LEARNED_REFERENCE_DUPLICATE_SIMILARITY);
    const removed = duplicate ? [duplicate] : [...sameCard, record].sort((a, b) => a.savedAt - b.savedAt)
      .slice(0, Math.max(0, sameCard.length + 1 - MAX_LEARNED_REFERENCES_PER_CARD));
    if (removed.includes(record)) return false;
    const removedIds = new Set(removed.map((other) => other.id));
    records = [...records.filter((other) => !removedIds.has(other.id)), record];
    await store.write({ put: [record], remove: [...removedIds] });
    return true;
  }

  // Deletes the learned references `matches` selects, when there are any.
  const removeWhere = (matches) => enqueue(() => {
    const removed = records.filter(matches).map((record) => record.id);
    if (!removed.length) return;
    records = records.filter((record) => !matches(record));
    return store.write({ remove: removed });
  });

  return {
    /**
     * Offers a user-confirmed scan's artwork. Returns the id of the learned
     * reference it saves, or null when the crop is not clear enough. The
     * decision is immediate; storing it completes in the background.
     */
    save({ cardId, artwork }) {
      const features = cardId && isClearCrop(artwork) ? rankableFeatures(artwork) : null;
      if (!features) return null;
      const record = { id: createId(), cardId, features, gridSize: gridSizeOf(features),
        savedAt: now(), officialSimilarity: officialSimilarity(features, artwork.officialFeatures?.(cardId)) };
      enqueue(() => add(record));
      return record.id;
    },
    /** Undoes one save: deletes the learned reference with this id. */
    remove: (id) => removeWhere((record) => id != null && record.id === id),
    /** "Forget my scans of this card": deletes all of the card's learned references. */
    forgetCard: (cardId) => removeWhere((record) => cardId != null && record.cardId === cardId),
    /** "Clear all": deletes every learned reference. */
    clear: () => removeWhere(() => true),
    /**
     * The JSON backup of every learned reference. A backup only, not a format
     * for other apps. `gridSize` is the current card database's.
     */
    exportBackup: ({ gridSize = null } = {}) => ({ format: LEARNED_REFERENCES_BACKUP_FORMAT,
      formatVersion: LEARNED_REFERENCES_BACKUP_VERSION, gridSize,
      records: records.map((record) => ({ ...record, features: [...record.features] })) }),
    /**
     * Merges a backup into the stored learned references, applying the same
     * per-card limit and duplicate rule as saving. Records already stored are
     * skipped. Resolves to how many were merged; rejects an invalid backup.
     */
    async importBackup(backup) {
      if (backup?.format !== LEARNED_REFERENCES_BACKUP_FORMAT || backup.formatVersion !== LEARNED_REFERENCES_BACKUP_VERSION ||
        !Array.isArray(backup.records)) throw new Error('Not a learned references backup');
      const incoming = backup.records.map(readBackupRecord).filter(Boolean).sort((a, b) => a.savedAt - b.savedAt);
      const merged = new Set();
      await enqueue(async () => {
        for (const record of incoming) {
          if (records.some((other) => other.id === record.id)) continue;
          const id = record.id ?? createId();
          if (await add({ ...record, id })) merged.add(id);
        }
      });
      // A record merged early can be evicted by a later one of the same card.
      return records.filter((record) => merged.has(record.id)).length;
    },
    /** Every stored learned reference, for the matcher's learned pass. */
    references: () => records,
    /** How many learned references a card has ("Forget my scans of this card"). */
    countForCard: (cardId) => records.filter((record) => record.cardId === cardId).length,
    /** Calls `listener` after loading and after every change; returns the unsubscribe function. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
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
