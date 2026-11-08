import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from './helpers/runtime.mjs';

const runtime = createRuntime();
const { createLearnedReferences, describeScanArtwork, MAX_LEARNED_REFERENCES_PER_CARD } = runtime.load('src/lib/learnedReferences.js');

// A 2x2 RGB grid with structure. `seed` varies the pattern.
const grid = (seed = 0) => Float32Array.from({ length: 12 }, (_, i) => .5 + .4 * Math.sin(i * 1.3 + seed));
const flat = () => new Float32Array(12).fill(.5);

function memoryStore(initial = []) {
  const rows = new Map(initial.map((record) => [record.id, record]));
  return {
    rows,
    load: async () => [...rows.values()],
    write: async ({ put = [], remove = [] }) => { for (const id of remove) rows.delete(id); for (const record of put) rows.set(record.id, record); },
  };
}

// The matcher reads a crop's artwork as its feature vector; a test crop carries it.
const matcher = { revision: 7, cards: [{ id: 'ogn-001', f: grid(0) }], samplings: [],
  artworkFeatures(crop, { areaSampling }) { this.samplings.push(areaSampling); return crop.features; } };
const clearQuality = { acceptable: true, issue: null, score: .8, reflectionRisk: false };
const clearArtwork = (features = grid(.2), patch = {}) =>
  describeScanArtwork({ crop: { features }, quality: clearQuality, outlined: true, matcher, ...patch });

function fixture({ store = memoryStore() } = {}) {
  let clock = 1000;
  const learned = createLearnedReferences({ store, now: () => clock++ });
  return { learned, store };
}
const ids = (learned) => [...learned.references()].map((record) => record.id);

test('an acceptable crop from a user-confirmed scan saves the vector the matcher ranked, without a photo', async () => {
  const { learned, store } = fixture();
  const features = grid(.2);
  const id = learned.save({ cardId: 'ogn-001', artwork: clearArtwork(features, { areaSampling: true }) });
  await learned.settled();
  assert.ok(id);
  assert.equal(matcher.samplings.at(-1), true, 'same sampling mode as live matching');
  const [record] = learned.references();
  assert.deepEqual(Object.keys(record).sort(), ['cardId', 'features', 'gridSize', 'id', 'officialSimilarity', 'savedAt']);
  assert.equal(record.id, id);
  assert.equal(record.cardId, 'ogn-001');
  assert.deepEqual([...record.features], [...features]);
  assert.equal(record.gridSize, 2);
  assert.equal(record.savedAt, 1000);
  assert.ok(record.officialSimilarity > 0 && record.officialSimilarity < 1);
  assert.deepEqual([...store.rows.values()], [record]);
});

test('a card with no official reference still saves, with no official similarity', async () => {
  const { learned } = fixture();
  learned.save({ cardId: 'not-in-catalog', artwork: clearArtwork() });
  await learned.settled();
  assert.equal(learned.references()[0].officialSimilarity, null);
});

test('glare, a failed quality check, no detected outline or flat artwork save nothing', async () => {
  const { learned, store } = fixture();
  const rejected = {
    glare: clearArtwork(grid(.2), { quality: { ...clearQuality, reflectionRisk: true } }),
    'glare issue': clearArtwork(grid(.2), { quality: { ...clearQuality, issue: 'glare' } }),
    'failed quality': clearArtwork(grid(.2), { quality: { ...clearQuality, acceptable: false, issue: 'blurred' } }),
    'no outline': clearArtwork(grid(.2), { outlined: false }),
    'flat artwork': clearArtwork(flat()),
    'no artwork': null,
  };
  for (const [reason, artwork] of Object.entries(rejected))
    assert.equal(learned.save({ cardId: 'ogn-001', artwork }), null, reason);
  await learned.settled();
  assert.equal(learned.references().length, 0);
  assert.equal(store.rows.size, 0);
});

test('a new reference at least 0.98 similar to one of the same card replaces it', async () => {
  const { learned, store } = fixture();
  const first = learned.save({ cardId: 'ogn-001', artwork: clearArtwork(grid(1)) });
  const other = learned.save({ cardId: 'ogn-002', artwork: clearArtwork(grid(1)) });
  const nearCopy = grid(1).map((value, i) => value + (i % 2 ? .004 : -.004));
  const replacement = learned.save({ cardId: 'ogn-001', artwork: clearArtwork(nearCopy) });
  await learned.settled();
  assert.deepEqual([...learned.references()].map((record) => record.id).sort(), [other, replacement].sort());
  assert.deepEqual([...store.rows.keys()].sort(), [other, replacement].sort(), 'the replaced one is deleted from storage');
  assert.ok(!store.rows.has(first));
});

test('a sixth distinct reference of a card drops its oldest, including ones stored earlier', async () => {
  const stored = memoryStore([{ id: 'stored', cardId: 'ogn-001', features: grid(10), gridSize: 2, savedAt: 1, officialSimilarity: null }]);
  const { learned, store } = fixture({ store: stored });
  assert.equal(MAX_LEARNED_REFERENCES_PER_CARD, 5);
  const ids = [0, 2, 4, 6, 8].map((seed) => learned.save({ cardId: 'ogn-001', artwork: clearArtwork(grid(seed)) }));
  await learned.settled();
  assert.deepEqual([...learned.references()].map((record) => record.id).sort(), [...ids].sort());
  assert.deepEqual([...store.rows.keys()].sort(), [...ids].sort());
  learned.save({ cardId: 'ogn-001', artwork: clearArtwork(grid(12)) });
  await learned.settled();
  assert.equal(learned.references().length, 5);
  assert.ok(!learned.references().some((record) => record.id === ids[0]), 'the oldest saved is dropped next');
});

test('saving a learned reference never bumps the matcher revision', async () => {
  const { learned } = fixture();
  learned.save({ cardId: 'ogn-001', artwork: clearArtwork() });
  await learned.settled();
  assert.equal(matcher.revision, 7);
  assert.equal(matcher.cards.length, 1, 'learned references never become official reference rows');
});

test('removing a learned reference deletes only that one, from storage too', async () => {
  const { learned, store } = fixture();
  const wrong = learned.save({ cardId: 'ogn-001', artwork: clearArtwork(grid(1)) });
  const kept = learned.save({ cardId: 'ogn-001', artwork: clearArtwork(grid(5)) });
  learned.remove(wrong);
  learned.remove(null);
  await learned.settled();
  assert.deepEqual(ids(learned), [kept]);
  assert.deepEqual([...store.rows.keys()], [kept]);
});

test('forgetting my scans of a card deletes all its learned references and no others', async () => {
  const { learned, store } = fixture();
  learned.save({ cardId: 'ogn-001', artwork: clearArtwork(grid(1)) });
  learned.save({ cardId: 'ogn-001', artwork: clearArtwork(grid(5)) });
  const other = learned.save({ cardId: 'ogn-002', artwork: clearArtwork(grid(1)) });
  learned.forgetCard('ogn-001');
  await learned.settled();
  assert.deepEqual(ids(learned), [other]);
  assert.deepEqual([...store.rows.keys()], [other]);
});

const plain = (learned) => [...learned.references()].map((record) => ({ ...record, features: [...record.features] }))
  .sort((a, b) => a.id.localeCompare(b.id));

test('an export backup survives clear all and import as JSON, without bumping the matcher revision', async () => {
  const { learned, store } = fixture();
  learned.save({ cardId: 'ogn-001', artwork: clearArtwork(grid(1)) });
  learned.save({ cardId: 'ogn-002', artwork: clearArtwork(grid(5)) });
  await learned.settled();
  const before = plain(learned);
  const backup = JSON.parse(JSON.stringify(learned.exportBackup({ gridSize: 2 })));
  assert.equal(backup.formatVersion, 1);
  assert.equal(backup.gridSize, 2);
  assert.equal(backup.records.length, 2);

  learned.clear();
  await learned.settled();
  assert.equal(learned.references().length, 0);
  assert.equal(store.rows.size, 0);

  assert.equal(await learned.importBackup(backup), 2);
  assert.deepEqual(plain(learned), before);
  assert.ok(ArrayBuffer.isView(learned.references()[0].features), 'features come back as a typed vector');
  assert.equal(store.rows.size, 2);
  assert.equal(matcher.revision, 7);
});

test('import merges with the five-per-card limit and the duplicate rule, skipping malformed records', async () => {
  const stored = { id: 'stored', cardId: 'ogn-002', features: grid(1), gridSize: 2, savedAt: 1, officialSimilarity: null };
  const { learned, store } = fixture({ store: memoryStore([stored]) });
  const record = (id, cardId, features, savedAt) => ({ id, cardId, features: [...features], gridSize: 2, savedAt, officialSimilarity: null });
  const nearCopy = grid(1).map((value, i) => value + (i % 2 ? .004 : -.004));
  const backup = { format: 'riftbound-learned-references', formatVersion: 1, gridSize: 2, records: [
    ...[0, 2, 4, 6, 8, 10, 12].map((seed, i) => record(`a${i}`, 'ogn-001', grid(seed), 100 + i)),
    record('copy', 'ogn-002', nearCopy, 200),
    { id: 'broken', cardId: 'ogn-003', features: [1, 2], gridSize: 2, savedAt: 300 },
  ] };
  assert.equal(await learned.importBackup(backup), 8);
  assert.deepEqual(ids(learned).sort(), ['a2', 'a3', 'a4', 'a5', 'a6', 'copy']);
  assert.deepEqual([...store.rows.keys()].sort(), ['a2', 'a3', 'a4', 'a5', 'a6', 'copy']);
  assert.equal(await learned.importBackup(backup), 0, 'records already stored are skipped');
  await assert.rejects(learned.importBackup({ records: [] }), /Not a learned references backup/);
});

test('the summary counts references, cards, and unused ones with an unknown card id or another grid size', () => {
  const { summarizeLearnedReferences } = runtime.load('src/lib/learnedReferences.js');
  const record = (cardId, gridSize = 2) => ({ cardId, gridSize });
  const references = [record('ogn-001'), record('ogn-001'), record('ogn-001', 3), record('gone'), record('ogn-002')];
  const cards = [{ id: 'ogn-001' }, { id: 'ogn-002' }, { id: 'ogn-003' }];
  assert.deepEqual({ ...summarizeLearnedReferences(references, { cards, gridSize: 2 }) }, { references: 5, cards: 3, unused: 2 });
  assert.deepEqual({ ...summarizeLearnedReferences(references, { cards: [], gridSize: 2 }) }, { references: 5, cards: 3, unused: 5 });
  assert.deepEqual({ ...summarizeLearnedReferences([], { cards, gridSize: 2 }) }, { references: 0, cards: 0, unused: 0 });
});
