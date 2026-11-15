import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from './helpers/runtime.mjs';

const card = (id, extra = {}) => ({ id, set: id.split('-')[0].toUpperCase(), f: [0.2, 0.4, 0.6], ...extra });
function fixture(local, bundled, { fetchError, saveError } = {}) {
  const saved = [];
  const runtime = createRuntime({
    mocks: { 'src/lib/indexedDB.js': {
      loadMatcherDatabase: async () => local && ({ database: local, updatedAt: 'old' }),
      saveMatcherDatabase: async (database) => {
        if (saveError) throw new Error('Storage full');
        saved.push(database);
        return { updatedAt: 'new' };
      },
    } },
    globals: { fetch: async () => {
      if (fetchError) throw new Error('Offline');
      return { ok: true, json: async () => bundled };
    }, console: { ...console, warn() {} } },
  });
  return { database: runtime.load('src/lib/cardDatabase.js').createCardDatabase(), saved };
}

test('a bundled update supplements later reveals inside an already imported set', async () => {
  const { database, saved } = fixture(
    { gridSize: 16, cards: [card('rad-001', { imageUrl: 'C:/cards/local.webp' })] },
    { gridSize: 16, cards: [card('rad-001'), card('rad-219'), card('ven-001')] },
  );
  await database.load();
  assert.deepEqual(Array.from(database.cards, (c) => c.id), ['rad-001', 'rad-219', 'ven-001']);
  assert.equal(database.cards[0].imageUrl, 'C:/cards/local.webp');
  assert.equal(database.updatedAt, 'new');
  assert.equal(saved.length, 1);
});

const GALLERY_IMAGE = 'https://cmsassets.rgpub.io/sanity/images/kaisa.png';
const supplement = (local, bundled) => createRuntime().load('src/lib/cardDatabase.js').supplementWithBundledCards(local, bundled);

test('a bundled top-up overwrites metadata of an existing card and keeps its local features', () => {
  const local = card('rad-005', { name: "Kai'Sa", subtitle: '', text: 'Old text', imageUrl: 'C:/cards/rad-005.webp', sourceImageUrl: GALLERY_IMAGE, f: [0.9, 0.9, 0.9] });
  const bundled = card('rad-005', { name: "Kai'Sa", subtitle: 'Rebel', text: 'New text', imageUrl: GALLERY_IMAGE, f: [0.1, 0.1, 0.1] });
  const [refreshed] = supplement({ gridSize: 16, cards: [local] }, { gridSize: 16, cards: [bundled] }).cards;
  assert.equal(refreshed.subtitle, 'Rebel');
  assert.equal(refreshed.text, 'New text');
  assert.deepEqual(Array.from(refreshed.f), [0.9, 0.9, 0.9]);
  assert.equal(refreshed.imageUrl, 'C:/cards/rad-005.webp');
});

test('a bundled card with a different image URL replaces the local record whole', () => {
  const local = card('rad-005', { text: 'Old text', imageUrl: 'C:/cards/rad-005.webp', sourceImageUrl: GALLERY_IMAGE, f: [0.9, 0.9, 0.9] });
  const bundled = card('rad-005', { text: 'New text', imageUrl: 'https://cmsassets.rgpub.io/sanity/images/kaisa-v2.png', f: [0.1, 0.1, 0.1] });
  const [replaced] = supplement({ gridSize: 16, cards: [local] }, { gridSize: 16, cards: [bundled] }).cards;
  assert.deepEqual(replaced, bundled);
});

test('two bundled records with the same image URL keep the local features', () => {
  const local = card('rad-005', { text: 'Old text', imageUrl: GALLERY_IMAGE, f: [0.9, 0.9, 0.9] });
  const bundled = card('rad-005', { text: 'New text', imageUrl: GALLERY_IMAGE, f: [0.1, 0.1, 0.1] });
  const [kept] = supplement({ gridSize: 16, cards: [local] }, { gridSize: 16, cards: [bundled] }).cards;
  assert.deepEqual([kept.text, Array.from(kept.f)], ['New text', [0.9, 0.9, 0.9]]);
});

test('a local card absent from the bundled database is kept', () => {
  const result = supplement({ gridSize: 16, cards: [card('rad-001'), card('rad-999')] }, { gridSize: 16, cards: [card('rad-001')] });
  assert.deepEqual(Array.from(result.cards, (c) => c.id), ['rad-001', 'rad-999']);
});

test('a current local database is not rewritten at every startup', async () => {
  const db = { gridSize: 16, cards: [card('rad-001')] };
  const { database, saved } = fixture(db, db);
  await database.load();
  assert.equal(saved.length, 0);
  assert.equal(database.updatedAt, 'old');
});

test('incompatible feature grids are not mixed', async () => {
  const { database, saved } = fixture({ gridSize: 8, cards: [card('ogn-001')] }, { gridSize: 16, cards: [card('rad-001')] });
  await database.load();
  assert.equal(database.gridSize, 8);
  assert.equal(database.cards.length, 1);
  assert.equal(saved.length, 0);
});

test('missing bundled data retains the usable local database', async () => {
  const { database } = fixture({ gridSize: 16, cards: [card('rad-001')] }, null, { fetchError: true });
  await database.load();
  assert.equal(database.ready, true);
  assert.equal(database.cards[0].id, 'rad-001');
});

test('storage failure still makes new bundled cards available for this session', async () => {
  const { database } = fixture({ gridSize: 16, cards: [] }, { gridSize: 16, cards: [card('rad-001')] }, { saveError: true });
  await database.load();
  assert.equal(database.ready, true);
  assert.equal(database.cards[0].id, 'rad-001');
  assert.equal(database.updatedAt, 'old');
});

test('a new installation uses the bundled database without a local import', async () => {
  const { database, saved } = fixture(null, { gridSize: 16, cards: [card('rad-001')] });
  await database.load();
  assert.equal(database.cards[0].id, 'rad-001');
  assert.equal(database.source, 'bundled');
  assert.equal(saved.length, 0);
});

test('an unreadable local payload falls back to bundled cards', async () => {
  const { database } = fixture({ gridSize: 16, cards: {} }, { gridSize: 16, cards: [card('rad-001')] });
  await database.load();
  assert.equal(database.cards[0].id, 'rad-001');
  assert.equal(database.source, 'bundled');
});

const mergeUpdate = (existing, update) => createRuntime().load('src/lib/cardDatabase.js').mergeCardDatabaseUpdate(existing, update);

test('an in-app update refreshes metadata and keeps local features and image path', () => {
  const existing = { gridSize: 16, cards: [card('rad-001', { text: 'Old text', imageUrl: 'C:/cards/rad-001.webp', f: [0.9, 0.9, 0.9] })] };
  const update = { gridSize: 16, cards: [{ id: 'rad-001', set: 'RAD', text: 'New text', sourceImageUrl: GALLERY_IMAGE }] };
  const [refreshed] = mergeUpdate(existing, update).cards;
  assert.equal(refreshed.text, 'New text');
  assert.equal(refreshed.sourceImageUrl, GALLERY_IMAGE);
  assert.deepEqual(Array.from(refreshed.f), [0.9, 0.9, 0.9]);
  assert.equal(refreshed.imageUrl, 'C:/cards/rad-001.webp');
});

test('an in-app update replaces re-hashed cards, adds new ones and keeps cards missing from the gallery', () => {
  const existing = { gridSize: 16, cards: [card('rad-001', { f: [0.9] }), card('rad-999')] };
  const update = { gridSize: 16, cards: [card('rad-001', { f: [0.1], imageUrl: 'C:/cards/rad-001.webp' }), card('rad-002')] };
  const merged = mergeUpdate(existing, update);
  assert.deepEqual(Array.from(merged.cards, (c) => c.id), ['rad-001', 'rad-999', 'rad-002']);
  assert.deepEqual(Array.from(merged.cards[0].f), [0.1]);
});

test('an in-app metadata refresh for an unknown card is not added without features', () => {
  const merged = mergeUpdate({ gridSize: 16, cards: [] }, { gridSize: 16, cards: [{ id: 'rad-001', text: 'Text' }] });
  assert.equal(merged.cards.length, 0);
});

// An update source that answers from memory, as the desktop gallery update would.
function memoryUpdateSource(changes, progress = []) {
  const asked = [];
  return { asked, async fetch({ knownCards, gridSize, onProgress }) {
    asked.push({ knownCards, gridSize });
    for (const step of progress) onProgress(step);
    return changes;
  } };
}

test('an update sends the known cards, merges the changes, saves and tells subscribers', async () => {
  const local = { gridSize: 16, cards: [
    card('rad-001', { text: 'Old text', imageUrl: 'C:/cards/rad-001.webp', sourceImageUrl: GALLERY_IMAGE }),
    card('rad-999', { imageUrl: 'https://cmsassets.rgpub.io/sanity/images/retired.png' })] };
  const { database, saved } = fixture(local, local);
  await database.load();
  const heard = [];
  database.subscribe((current) => heard.push(current.cards.map((c) => c.id)));
  const progress = [];
  const source = memoryUpdateSource({ gridSize: 16, skippedCards: 2, cards: [
    { id: 'rad-001', set: 'RAD', text: 'New text', sourceImageUrl: GALLERY_IMAGE }, card('rad-002')] },
  [{ percent: 0.5, message: 'Hashing' }]);
  const savesBefore = saved.length;
  let mergedBeforeSave = false;
  const result = await database.update(source, { onProgress: (step) => progress.push(step),
    onMerged: () => { mergedBeforeSave = saved.length === savesBefore; } });
  assert.deepEqual(JSON.parse(JSON.stringify(source.asked)), [{ gridSize: 16, knownCards: [
    { id: 'rad-001', sourceImageUrl: GALLERY_IMAGE },
    { id: 'rad-999', sourceImageUrl: 'https://cmsassets.rgpub.io/sanity/images/retired.png' }] }]);
  assert.equal(progress[0].message, 'Hashing');
  assert.equal(mergedBeforeSave, true);
  assert.deepEqual({ ...result }, { count: 3, skippedCards: 2 });
  assert.deepEqual(Array.from(database.cards, (c) => c.id), ['rad-001', 'rad-999', 'rad-002'], 'a card missing from the update is kept');
  assert.equal(database.cards[0].text, 'New text');
  assert.equal(database.cards[0].imageUrl, 'C:/cards/rad-001.webp');
  assert.equal(saved.length, savesBefore + 1);
  assert.equal(database.source, 'local');
  assert.equal(database.updatedAt, 'new');
  assert.deepEqual(JSON.parse(JSON.stringify(heard)), [['rad-001', 'rad-999', 'rad-002']]);
});

test('a failed update changes nothing', async () => {
  const local = { gridSize: 16, cards: [card('rad-001')] };
  const { database, saved } = fixture(local, local);
  await database.load();
  const revision = database.revision;
  const failing = { fetch: async () => { throw new Error('Offline'); } };
  await assert.rejects(database.update(failing), /Offline/);
  assert.equal(database.revision, revision);
  assert.equal(saved.length, 0);
});

test('a card-hashes.json file replaces the card database; an invalid file is refused', async () => {
  const { database, saved } = fixture(null, { gridSize: 16, cards: [card('rad-001')] });
  await database.load();
  await assert.rejects(database.replaceFromFile('{"cards":[]}'), /does not look like a valid card-hashes.json/);
  await assert.rejects(database.replaceFromFile('not json'));
  assert.equal(saved.length, 0);
  const count = await database.replaceFromFile(JSON.stringify({ gridSize: 16, cards: [card('ogn-001'), card('ogn-002')] }));
  assert.equal(count, 2);
  assert.deepEqual(Array.from(database.cards, (c) => c.id), ['ogn-001', 'ogn-002']);
  assert.equal(database.source, 'local');
});

test('every change bumps the revision and reaches subscribers until they stop listening', async () => {
  const { database } = fixture(null, { gridSize: 16, cards: [card('rad-001')] });
  const revisions = [];
  const stop = database.subscribe((current) => revisions.push(current.revision));
  await database.load();
  await database.replace({ gridSize: 16, cards: [card('rad-002')] });
  stop();
  await database.replace({ gridSize: 16, cards: [card('rad-003')] });
  assert.deepEqual(revisions, [1, 2]);
  assert.equal(database.revision, 3);
});

test('the matcher follows the card database: every change becomes its official references', async () => {
  const runtime = createRuntime();
  const database = runtime.load('src/lib/cardDatabase.js').createCardDatabase();
  database._apply({ gridSize: 1, cards: [card('rad-001')] });
  const Matcher = runtime.load('src/lib/cardMatcher.js').default;
  const matcher = new Matcher(database);
  assert.equal(matcher.ready, true, 'a matcher created after loading catches up');
  assert.deepEqual(Array.from(matcher.references, (c) => c.id), ['rad-001']);
  assert.ok(matcher.references[0].featureStats, 'references carry the prepared fingerprint');
  assert.equal(database.cards[0].featureStats, undefined, 'the card database keeps plain card records');
  database._apply({ gridSize: 1, cards: [card('rad-002')] });
  assert.deepEqual(Array.from(matcher.references, (c) => c.id), ['rad-002']);
  assert.equal(matcher.revision, database.revision);
  assert.equal(matcher.officialFeatures('rad-002').length, 3);
  assert.equal('cards' in matcher, false);
});

test('a local copy saved by an earlier version loads without the matcher fields it stored', async () => {
  const legacy = card('rad-001', { featureStats: { norm: 1 }, localArtwork: [1], broadArtwork: [2] });
  const { database } = fixture({ gridSize: 16, cards: [legacy] }, null, { fetchError: true });
  await database.load();
  assert.deepEqual(Object.keys(database.cards[0]).filter((key) => /Artwork|featureStats/.test(key)), []);
});
