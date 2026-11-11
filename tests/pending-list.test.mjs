import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingList, updatePendingList, refreshPendingList, isDuplicateAdd, recentPendingRows,
  DUPLICATE_ADD_WINDOW_MS } from '../src/lib/pendingList.js';
import { createCardEntry } from '../src/lib/collection.js';
import { resolveCardData } from '../src/lib/cardData.js';

const card = resolveCardData({ id: 'fixture-001', name: 'Fixture Card', code: 'FIX-001/100', set: 'FIX', rarity: 'common' });
const other = resolveCardData({ id: 'fixture-002', name: 'Other Card', code: 'FIX-002/100', set: 'FIX', rarity: 'common' });

const entryOf = (cardData = card, patch = {}) => createCardEntry({ cardData, scanTimestamp: 1, ...patch });
// Applies events in order and returns the last result.
const run = (list, ...events) => events.reduce((result, event) => updatePendingList(result.list, event), { list });
const accepted = (now, cardData = card, patch = {}) => ({ type: 'accepted-scan', entry: entryOf(cardData, patch), now });
const confirmed = (now, learnedReferenceId, cardData = card) => ({ type: 'user-confirmed-scan',
  entry: entryOf(cardData, { userConfirmed: true }), learnedReferenceId, now });
const byHand = (cardData = card, patch = {}) => ({ type: 'added-by-hand', entry: entryOf(cardData, { manualAdded: true, ...patch }), now: 0 });

test('an accepted scan adds a pending row and reports the entry it added', () => {
  const event = accepted(1000);
  const { list, outcome, effects } = updatePendingList(createPendingList(), event);
  assert.equal(outcome, 'added');
  assert.equal(list.rows.length, 1);
  assert.equal(list.rows[0].cardData.id, card.id);
  assert.equal(effects.added, event.entry);
  assert.deepEqual(effects.forget, []);
  assert.deepEqual(effects.toCollection, []);
});

test('the same card scanned again merges into its pending row', () => {
  const { list } = run(createPendingList(), accepted(1000), accepted(1000 + DUPLICATE_ADD_WINDOW_MS));
  assert.equal(list.rows.length, 1);
  assert.equal(list.rows[0].quantity, 2);
});

test('standard and foil copies stay on separate pending rows', () => {
  const { list } = run(createPendingList(), byHand(card, { quantity: 2, foil: false }), byHand(card, { quantity: 3, foil: true }));
  assert.deepEqual(list.rows.map((row) => [row.quantity, row.foil]), [[2, false], [3, true]]);
});

test('the same card added again inside the duplicate window is a duplicate and changes nothing', () => {
  const first = run(createPendingList(), accepted(1000));
  const again = updatePendingList(first.list, accepted(1000 + DUPLICATE_ADD_WINDOW_MS - 1));
  assert.equal(again.outcome, 'duplicate');
  assert.equal(again.list, first.list);
  assert.equal(again.effects.added, null);
  const pick = updatePendingList(first.list, confirmed(1000 + DUPLICATE_ADD_WINDOW_MS - 1, 'learned-1'));
  assert.equal(pick.outcome, 'duplicate', 'a pick right after the scanner added the card is the same physical card');
  assert.equal(pick.list.rows[0].quantity, 1);
});

test('the duplicate window is per card, ends after 1.5 s, and restarts only on an add', () => {
  const first = run(createPendingList(), accepted(1000));
  assert.equal(isDuplicateAdd(first.list, card.id, 1000 + DUPLICATE_ADD_WINDOW_MS - 1), true);
  assert.equal(isDuplicateAdd(first.list, card.id, 1000 + DUPLICATE_ADD_WINDOW_MS), false);
  assert.equal(isDuplicateAdd(first.list, other.id, 1001), false);
  assert.equal(updatePendingList(first.list, accepted(1001, other)).outcome, 'added');
  // A rejected duplicate does not extend the window.
  const rejected = updatePendingList(first.list, accepted(2000));
  assert.equal(updatePendingList(rejected.list, accepted(1000 + DUPLICATE_ADD_WINDOW_MS)).outcome, 'added');
});

test('a card added by hand is never a duplicate and does not start the window', () => {
  const { list, outcome } = run(createPendingList(), accepted(1000), byHand());
  assert.equal(outcome, 'added');
  assert.equal(list.rows[0].quantity, 2);
  const fresh = run(createPendingList(), byHand());
  assert.equal(isDuplicateAdd(fresh.list, card.id, 1), false);
});

test('a user-confirmed scan records the learned reference it saved on its pending row', () => {
  const saved = run(createPendingList(), confirmed(1000, 'learned-1'));
  assert.deepEqual(saved.list.rows[0].learnedReferenceIds, ['learned-1']);
  assert.equal(saved.effects.added.userConfirmed, true);
  const unsaved = run(createPendingList(), confirmed(1000, null));
  assert.deepEqual(unsaved.list.rows[0].learnedReferenceIds, []);
});

// One accepted scan and two user-confirmed scans of the same card, merged into one row.
const mergedRow = () => run(createPendingList(), accepted(1000), confirmed(4000, 'learned-1'), confirmed(7000, 'learned-2')).list;

test('a merged pending row keeps the learned references of every user-confirmed scan in it, oldest first', () => {
  const [row] = mergedRow().rows;
  assert.equal(row.quantity, 3);
  assert.deepEqual(row.learnedReferenceIds, ['learned-1', 'learned-2']);
});

test('removing a pending row forgets all of its learned references', () => {
  const list = mergedRow();
  const { list: after, effects } = updatePendingList(list, { type: 'row-removed', entryId: list.rows[0].entryId, now: 8000 });
  assert.equal(after.rows.length, 0);
  assert.deepEqual(effects.forget, ['learned-1', 'learned-2']);
  assert.deepEqual(recentPendingRows(after), []);
});

test('lowering a row forgets its most recent learned references first; lowering to zero removes the row', () => {
  const list = mergedRow();
  const entryId = list.rows[0].entryId;
  const lowered = updatePendingList(list, { type: 'quantity-adjusted', entryId, delta: -1, now: 8000 });
  assert.deepEqual(lowered.effects.forget, ['learned-2']);
  assert.equal(lowered.list.rows[0].quantity, 2);
  assert.deepEqual(lowered.list.rows[0].learnedReferenceIds, ['learned-1']);
  const removed = updatePendingList(lowered.list, { type: 'quantity-adjusted', entryId, delta: -2, now: 9000 });
  assert.equal(removed.list.rows.length, 0);
  assert.deepEqual(removed.effects.forget, ['learned-1']);
});

test('raising a row keeps its learned references and counts as its most recent scan', () => {
  const list = run(createPendingList(), confirmed(1000, 'learned-1'), accepted(2000, other)).list;
  const raised = updatePendingList(list, { type: 'quantity-adjusted', entryId: list.rows[0].entryId, delta: 2, now: 9000 });
  assert.equal(raised.list.rows[0].quantity, 3);
  assert.deepEqual(raised.list.rows[0].learnedReferenceIds, ['learned-1']);
  assert.deepEqual(raised.effects.forget, []);
  const [latest] = recentPendingRows(raised.list);
  assert.equal(latest.cardData.id, card.id);
  assert.equal(latest.recentScanTimestamp, 9000);
});

test('adjusting an unknown row or by zero changes nothing', () => {
  const list = mergedRow();
  assert.equal(updatePendingList(list, { type: 'quantity-adjusted', entryId: 'missing', delta: 1, now: 1 }).list, list);
  assert.equal(updatePendingList(list, { type: 'quantity-adjusted', entryId: list.rows[0].entryId, delta: 0, now: 1 }).list, list);
});

test('clearing the pending list keeps the learned references its rows saved', () => {
  const { list, effects } = updatePendingList(mergedRow(), { type: 'cleared', now: 8000 });
  assert.equal(list.rows.length, 0);
  assert.deepEqual(recentPendingRows(list), []);
  assert.deepEqual(effects.forget, [], 'clearing is not undoing a wrong pick');
});

test('moving one row to the collection hands it over whole, keeps the others and forgets nothing', () => {
  const list = run(createPendingList(), byHand(card, { quantity: 5, foil: false }), byHand(card, { quantity: 2, foil: true }),
    confirmed(1000, 'learned-1', other)).list;
  const [standard, foil, picked] = list.rows;
  const moved = updatePendingList(list, { type: 'moved-to-collection', entryIds: [standard.entryId, picked.entryId], now: 2000 });
  assert.deepEqual(moved.effects.toCollection, [standard, picked]);
  assert.deepEqual(moved.list.rows, [foil]);
  assert.deepEqual(moved.effects.forget, []);
  assert.equal(updatePendingList(list, { type: 'moved-to-collection', entryIds: ['missing'], now: 1 }).list, list);
});

test('moving all rows to the collection uses the edits made to them', () => {
  const list = run(createPendingList(), byHand(card, { quantity: 5 })).list;
  const edited = updatePendingList(list, { type: 'row-edited', entryId: list.rows[0].entryId, patch: { quantity: 7, foil: true, promo: true }, now: 1 });
  assert.equal(edited.list.rows[0].entryId, list.rows[0].entryId);
  const moved = updatePendingList(edited.list, { type: 'moved-to-collection', all: true, now: 2 });
  assert.equal(moved.list.rows.length, 0);
  const [row] = moved.effects.toCollection;
  assert.deepEqual([row.quantity, row.foil, row.promo], [7, true, true]);
});

test('the most recent scans come first, at most three, and follow their row', () => {
  const cards = [1, 2, 3, 4].map((n) => resolveCardData({ id: `recent-${n}`, name: `Card ${n}`, code: `FIX-00${n}/100`, set: 'FIX', rarity: 'common' }));
  const list = run(createPendingList(), ...cards.map((cardData, index) => accepted(1000 * (index + 1), cardData, { scanTimestamp: 10 + index }))).list;
  const recent = recentPendingRows(list);
  assert.deepEqual(recent.map((row) => row.cardData.id), ['recent-4', 'recent-3', 'recent-2']);
  assert.equal(recent[0].recentScanTimestamp, 13);
  const moved = updatePendingList(list, { type: 'moved-to-collection', entryIds: [list.rows[3].entryId], now: 9000 });
  assert.deepEqual(recentPendingRows(moved.list).map((row) => row.cardData.id), ['recent-3', 'recent-2', 'recent-1']);
});

test('a recent scan follows the finish it was scanned in, not just the card', () => {
  const list = run(createPendingList(), byHand(card, { foil: false }), accepted(1000, card, { foil: true })).list;
  const [latest] = recentPendingRows(list);
  assert.equal(latest.foil, true);
});

test('a pending list saved without recent scans shows its last scanned rows, not the ones added by hand', () => {
  const list = createPendingList({ rows: [entryOf(card), entryOf(other, { manualAdded: true })] });
  assert.deepEqual(recentPendingRows(list).map((row) => row.cardData.id), [card.id]);
});

test('a restored pending list gets row ids, and a card database refresh updates card data by id', () => {
  const list = createPendingList({ rows: [{ cardData: { id: card.id, name: 'Old name' }, quantity: 2 }], recentScans: [{ cardId: card.id, scanTimestamp: 5 }] });
  assert.ok(list.rows[0].entryId);
  assert.equal(recentPendingRows(list)[0].recentScanTimestamp, 5);
  const refreshed = refreshPendingList(list, [card]);
  assert.equal(refreshed.rows[0].cardData.name, card.name);
  assert.equal(refreshed.rows[0].quantity, 2);
  assert.equal(refreshed.rows[0].entryId, list.rows[0].entryId);
});
