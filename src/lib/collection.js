import { isFoilOnly } from '../data/sampleCards.js';
import { resolveCardData } from './cardData.js';

let nextEntryId = 0;

export function createEntryId() {
  return globalThis.crypto?.randomUUID?.() || `entry-${Date.now()}-${++nextEntryId}`;
}

export function createCardEntry(payload, defaults = {}) {
  const entry = payload.cardData ? payload : { cardData: payload };
  const quantity = Number(entry.quantity ?? 1);
  return {
    ...entry,
    entryId: entry.entryId || createEntryId(),
    quantity: Number.isFinite(quantity) ? Math.max(1, Math.trunc(quantity)) : 1,
    condition: entry.condition || defaults.condition || 'Near Mint',
    language: entry.language || defaults.language || 'English',
    foil: isFoilOnly(entry.cardData) || Boolean(entry.foil ?? defaults.foil),
    promo: Boolean(entry.promo),
    scanTimestamp: entry.scanTimestamp ?? Date.now(),
  };
}

// Add stable row identities to older localStorage saves without merging rows,
// and refresh each entry's card data from the card database by id.
export function restoreCardEntries(entries = [], cards = []) {
  const usedIds = new Set();
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  return entries.map((entry) => {
    const current = cardsById.get(entry.cardData?.id);
    const restored = createCardEntry(current ? { ...entry, cardData: resolveCardData(current) } : entry);
    if (usedIds.has(restored.entryId)) restored.entryId = createEntryId();
    usedIds.add(restored.entryId);
    return restored;
  });
}

export function getCardVariantKey(entry) {
  return JSON.stringify([
    entry.cardData.id,
    Boolean(entry.foil),
    Boolean(entry.promo),
    entry.condition || 'Near Mint',
    entry.language || 'English',
  ]);
}

// A pending row keeps the learned references of every user-confirmed scan
// merged into it, oldest first, so removing the row can undo them all.
function mergedLearnedReferenceIds(row, entry) {
  const ids = [...(row.learnedReferenceIds || []), ...(entry.learnedReferenceIds || [])];
  return ids.length ? { learnedReferenceIds: ids } : {};
}

export function mergeCardEntries(existing, incoming) {
  const updated = [...existing];
  for (const payload of incoming) {
    const entry = createCardEntry(payload);
    const key = getCardVariantKey(entry);
    const index = updated.findIndex((candidate) => getCardVariantKey(candidate) === key);
    if (index < 0) {
      // A split or corrected pending row may share an id with a collection row.
      if (updated.some((candidate) => candidate.entryId === entry.entryId)) {
        entry.entryId = createEntryId();
      }
      updated.push(entry);
    } else {
      updated[index] = { ...updated[index], quantity: updated[index].quantity + entry.quantity,
        ...mergedLearnedReferenceIds(updated[index], entry) };
    }
  }
  return updated;
}

export function matchesPendingScan(event, entry) {
  if (event.entryId) return event.entryId === entry.entryId;
  if (event.variantKey) return event.variantKey === getCardVariantKey(entry);
  return event.cardId === entry.cardData.id;
}
