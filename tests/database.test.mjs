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
  const Matcher = runtime.load('src/lib/cardMatcher.js').default;
  return { matcher: new Matcher(), saved };
}

test('a bundled update supplements later reveals inside an already imported set', async () => {
  const { matcher, saved } = fixture(
    { gridSize: 16, cards: [card('rad-001', { imageUrl: 'C:/cards/local.webp' })] },
    { gridSize: 16, cards: [card('rad-001'), card('rad-219'), card('ven-001')] },
  );
  await matcher.initialize();
  assert.deepEqual(Array.from(matcher.cards, (c) => c.id), ['rad-001', 'rad-219', 'ven-001']);
  assert.equal(matcher.cards[0].imageUrl, 'C:/cards/local.webp');
  assert.equal(matcher.databaseUpdatedAt, 'new');
  assert.equal(saved.length, 1);
});

const GALLERY_IMAGE = 'https://cmsassets.rgpub.io/sanity/images/kaisa.png';
const supplement = (local, bundled) => createRuntime().load('src/lib/cardMatcher.js').supplementWithBundledCards(local, bundled);

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
  const { matcher, saved } = fixture(db, db);
  await matcher.initialize();
  assert.equal(saved.length, 0);
  assert.equal(matcher.databaseUpdatedAt, 'old');
});

test('incompatible feature grids are not mixed', async () => {
  const { matcher, saved } = fixture({ gridSize: 8, cards: [card('ogn-001')] }, { gridSize: 16, cards: [card('rad-001')] });
  await matcher.initialize();
  assert.equal(matcher.gridSize, 8);
  assert.equal(matcher.cards.length, 1);
  assert.equal(saved.length, 0);
});

test('missing bundled data retains the usable local database', async () => {
  const { matcher } = fixture({ gridSize: 16, cards: [card('rad-001')] }, null, { fetchError: true });
  await matcher.initialize();
  assert.equal(matcher.ready, true);
  assert.equal(matcher.cards[0].id, 'rad-001');
});

test('storage failure still makes new bundled cards available for this session', async () => {
  const { matcher } = fixture({ gridSize: 16, cards: [] }, { gridSize: 16, cards: [card('rad-001')] }, { saveError: true });
  await matcher.initialize();
  assert.equal(matcher.ready, true);
  assert.equal(matcher.cards[0].id, 'rad-001');
  assert.equal(matcher.databaseUpdatedAt, 'old');
});

test('a new installation uses the bundled database without a local import', async () => {
  const { matcher, saved } = fixture(null, { gridSize: 16, cards: [card('rad-001')] });
  await matcher.initialize();
  assert.equal(matcher.cards[0].id, 'rad-001');
  assert.equal(matcher.databaseSource, 'bundled');
  assert.equal(saved.length, 0);
});

test('an unreadable local payload falls back to bundled cards', async () => {
  const { matcher } = fixture({ gridSize: 16, cards: {} }, { gridSize: 16, cards: [card('rad-001')] });
  await matcher.initialize();
  assert.equal(matcher.cards[0].id, 'rad-001');
  assert.equal(matcher.databaseSource, 'bundled');
});

const mergeUpdate = (existing, update) => createRuntime().load('src/lib/cardMatcher.js').mergeCardDatabaseUpdate(existing, update);

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
