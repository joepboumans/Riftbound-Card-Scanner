import { createCardEntry, getCardVariantKey, mergeCardEntries, restoreCardEntries } from './collection.js';

// The pending list: scanned cards waiting for the user to add them to the
// collection. It is a plain value, { rows, recentScans, lastAdd }, changed
// only through updatePendingList, which never touches anything else: what to
// forget, hand to the collection or announce comes back as data.

// A pick and an automatic add of the same card this close together are one
// physical card seen twice (e.g. Enter pressed as the scanner locks on).
export const DUPLICATE_ADD_WINDOW_MS = 1500;
const MAX_RECENT_SCANS = 12;
const RECENT_ROWS_SHOWN = 3;

export function createPendingList({ rows = [], recentScans = [] } = {}) {
  return { rows: restoreCardEntries(rows), recentScans, lastAdd: null };
}

// Refreshes each row's card data from the card database by id.
export function refreshPendingList(list, cards) {
  return { ...list, rows: restoreCardEntries(list.rows, cards) };
}

export function isDuplicateAdd(list, cardId, now) {
  const last = list.lastAdd;
  return Boolean(last && last.cardId === cardId && now - last.at < DUPLICATE_ADD_WINDOW_MS);
}

function matchesRecentScan(scan, row) {
  if (scan.entryId) return scan.entryId === row.entryId;
  if (scan.variantKey) return scan.variantKey === getCardVariantKey(row);
  return scan.cardId === row.cardData.id;
}

// The rows scanned most recently, newest first, each with the time of that scan.
export function recentPendingRows({ rows, recentScans }) {
  if (recentScans.length > 0) {
    return recentScans.slice(-RECENT_ROWS_SHOWN).reverse()
      .map((scan) => {
        const row = rows.find((other) => matchesRecentScan(scan, other));
        return row ? { ...row, recentScanTimestamp: scan.scanTimestamp } : null;
      })
      .filter(Boolean);
  }
  // A list saved before recent scans were recorded.
  return rows.filter((row) => !row.manualAdded).slice(-RECENT_ROWS_SHOWN).reverse();
}

const withRecentScan = (recentScans, row, scanTimestamp) => [...recentScans,
  { cardId: row.cardData.id, variantKey: getCardVariantKey(row), scanTimestamp }].slice(-MAX_RECENT_SCANS);

const withoutRecentScansOf = (recentScans, row) => recentScans.filter((scan) => !matchesRecentScan(scan, row));

const step = (list, { outcome = null, added = null, forgetLearnedReferences = [], toCollection = [] } = {}) =>
  ({ list, outcome, effects: { added, forgetLearnedReferences, toCollection } });

function addRow(list, entry) {
  return { ...list, rows: mergeCardEntries(list.rows, [entry]),
    recentScans: withRecentScan(list.recentScans, entry, entry.scanTimestamp) };
}

// A scan, by the scanner or by the user, is dropped when the same card was
// added a moment ago. Only an add starts the window.
function addScan(list, entry, now) {
  if (isDuplicateAdd(list, entry.cardData.id, now)) return step(list, { outcome: 'duplicate' });
  return step({ ...addRow(list, entry), lastAdd: { cardId: entry.cardData.id, at: now } }, { outcome: 'added', added: entry });
}

function removeRow(list, row) {
  return step({ ...list, rows: list.rows.filter((other) => other !== row),
    recentScans: withoutRecentScansOf(list.recentScans, row) }, { forgetLearnedReferences: row.learnedReferenceIds || [] });
}

function adjustQuantity(list, row, delta, now) {
  if (row.quantity + delta <= 0) return removeRow(list, row);
  // Lowering the quantity undoes the most recent user-confirmed scans first.
  const ids = row.learnedReferenceIds || [];
  const kept = delta < 0 ? ids.slice(0, Math.max(0, ids.length + delta)) : ids;
  const adjusted = { ...row, quantity: Math.max(1, row.quantity + delta), ...(delta < 0 ? { learnedReferenceIds: kept } : {}) };
  return step({ ...list, rows: list.rows.map((other) => other === row ? adjusted : other),
    recentScans: delta > 0 ? withRecentScan(list.recentScans, row, now) : list.recentScans }, { forgetLearnedReferences: ids.slice(kept.length) });
}

// Moving rows to the collection is not undoing: their learned references stay.
function moveToCollection(list, rows) {
  if (rows.length === 0) return step(list);
  return step({ ...list, rows: list.rows.filter((row) => !rows.includes(row)),
    recentScans: rows.reduce(withoutRecentScansOf, list.recentScans) }, { toCollection: rows });
}

/**
 * Applies one event to the pending list and returns
 * { list, outcome, effects: { added, forgetLearnedReferences, toCollection } }.
 *
 * Events. The two scans and quantity-adjusted also carry `now`:
 *   accepted-scan        { entry }                     the scanner accepted a card
 *   user-confirmed-scan  { entry, learnedReferenceId } the user picked the card; the id of the
 *                                                      learned reference that scan saved, or null
 *   added-by-hand        { entry }
 *   row-edited           { entryId, patch }
 *   quantity-adjusted    { entryId, delta }
 *   row-removed          { entryId }
 *   cleared              {}
 *   moved-to-collection  { entryIds } or { all: true }
 *
 * `outcome` is 'added' or 'duplicate' for the two scans, 'added' for
 * added-by-hand, otherwise null. `effects.added` is the entry to announce,
 * `effects.forgetLearnedReferences` the ids of the learned references to
 * delete, `effects.toCollection` the rows to add to the collection.
 */
export function updatePendingList(list, event) {
  const rowOf = (entryId) => list.rows.find((row) => row.entryId === entryId);
  switch (event.type) {
    case 'accepted-scan':
      return addScan(list, event.entry, event.now);
    case 'user-confirmed-scan':
      return addScan(list, { ...event.entry, learnedReferenceIds: event.learnedReferenceId ? [event.learnedReferenceId] : [] }, event.now);
    case 'added-by-hand':
      return step(addRow(list, event.entry), { outcome: 'added', added: event.entry });
    case 'row-edited':
      return step({ ...list, rows: list.rows.map((row) => row.entryId === event.entryId
        ? createCardEntry({ ...row, ...event.patch, entryId: row.entryId }) : row) });
    case 'quantity-adjusted': {
      const row = rowOf(event.entryId);
      return row && event.delta !== 0 ? adjustQuantity(list, row, event.delta, event.now) : step(list);
    }
    case 'row-removed': {
      const row = rowOf(event.entryId);
      return row ? removeRow(list, row) : step(list);
    }
    case 'cleared':
      // Clearing is not undoing: learned references saved by these rows stay.
      return step({ ...list, rows: [], recentScans: [] });
    case 'moved-to-collection':
      return moveToCollection(list, event.all ? list.rows : event.entryIds.map(rowOf).filter(Boolean));
    default:
      return step(list);
  }
}
