import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from './helpers/runtime.mjs';

const runtime = createRuntime();
const { mergeLearnedCandidates } = runtime.load('src/lib/learnedCandidates.js');

// A 2x2 RGB grid with structure. `seed` varies the pattern.
const grid = (seed = 0) => Float32Array.from({ length: 12 }, (_, i) => .5 + .4 * Math.sin(i * 1.3 + seed));
const scanFeatures = grid(3);
const artwork = { features: () => scanFeatures };
const card = (id, set = 'OGN') => ({ id, name: id, code: `${set}-${id}/100`, set, f: grid(id.length) });
const matcher = { gridSize: 2, cards: ['first', 'second', 'third', 'mine'].map((id) => card(id)) };
const shown = (id, similarity) => ({ id, name: id, code: `OGN-${id}/100`, similarity, sim: (similarity * 100).toFixed(1) });
const official = [shown('first', .8), shown('second', .75), shown('third', .7)];
const learned = (cardId, features = scanFeatures, patch = {}) =>
  ({ id: `learned-${cardId}`, cardId, features, gridSize: 2, savedAt: 1, officialSimilarity: null, ...patch });

test('a learned match lifts a card into the shown top 3, marked as from your scans', () => {
  const candidates = mergeLearnedCandidates(official, { artwork, references: [learned('mine')], matcher });
  assert.deepEqual(candidates.map((candidate) => candidate.id), ['mine', 'first', 'second']);
  assert.equal(candidates[0].fromLearnedReference, true);
  assert.ok(Math.abs(candidates[0].similarity - 1) < 1e-9, 'same artwork as the learned reference');
  assert.equal(candidates[0].sim, '100.0');
  assert.equal(candidates[0].name, 'mine');
  assert.ok(candidates.slice(1).every((candidate) => !candidate.fromLearnedReference));
});

test('a card shown from both sources appears once, with its best score', () => {
  const weaker = learned('third', grid(3.6));
  const [lifted] = mergeLearnedCandidates(official, { artwork, references: [learned('third'), weaker], matcher });
  assert.equal(lifted.id, 'third');
  assert.equal(lifted.fromLearnedReference, true);
  const strongOfficial = [shown('third', 1), ...official.slice(0, 2)];
  const candidates = mergeLearnedCandidates(strongOfficial, { artwork, references: [weaker], matcher });
  assert.deepEqual(candidates, strongOfficial, 'an official score that is already better stays, unmarked');
  const all = mergeLearnedCandidates(official, { artwork, references: [learned('third')], matcher });
  assert.deepEqual(all.map((candidate) => candidate.id), ['third', 'first', 'second']);
});

test('learned references honour the scan set filter', () => {
  const filtered = { ...matcher, cards: [...matcher.cards, card('other', 'SFD')] };
  const candidates = mergeLearnedCandidates(official, { artwork, references: [learned('other')], matcher: filtered, setFilter: 'OGN' });
  assert.deepEqual(candidates, official);
});

test('a learned reference for a card no longer in the card database, or of another grid size, is unused', () => {
  const nineCell = Float32Array.from({ length: 27 }, (_, i) => .5 + .4 * Math.sin(i * 1.3));
  const references = [learned('retired'), learned('mine', nineCell, { gridSize: 3 })];
  assert.deepEqual(mergeLearnedCandidates(official, { artwork, references, matcher }), official);
  const two = official.slice(0, 2);
  assert.deepEqual(mergeLearnedCandidates(two, { artwork, references, matcher }), two, 'not even in a free slot');
});

test('the scan artwork is not read when no learned reference is usable', () => {
  let reads = 0;
  const counted = { features: () => { reads += 1; return scanFeatures; } };
  const unusable = [learned('retired'), learned('mine', grid(1), { gridSize: 3 }), learned('first', new Float32Array(27))];
  assert.deepEqual(mergeLearnedCandidates(official, { artwork: counted, references: unusable, matcher }), official);
  assert.equal(reads, 0);
  mergeLearnedCandidates(official, { artwork: counted, references: [learned('mine')], matcher });
  assert.equal(reads, 1);
});

test('an unused learned reference is used again once its card returns', () => {
  const references = [learned('retired')];
  const updated = { ...matcher, cards: [...matcher.cards, card('retired')] };
  assert.deepEqual(mergeLearnedCandidates(official, { artwork, references, matcher }), official);
  assert.equal(mergeLearnedCandidates(official, { artwork, references, matcher: updated })[0].id, 'retired');
});

const textOf = (node) => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node)
  : Array.isArray(node) ? node.map(textOf).join('') : textOf(node.props?.children);

test('a candidate tile scored from a learned reference says it is from your scans', () => {
  const { CandidateTile } = runtime.load('src/components/scanner/ChoiceStrip.jsx');
  const tile = (candidate) => textOf(CandidateTile({ card: candidate, rank: 1, onPick() {} }));
  assert.match(tile({ ...shown('mine', .91), fromLearnedReference: true }), /91% match.*from your scans/);
  assert.doesNotMatch(tile(shown('first', .8)), /from your scans/);
});

// The live detection path, with learned references loaded from storage.
const textured = () => {
  const width = 64, height = 88, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 190 : 40;
    data[i + 3] = 255;
  }
  return { data, width, height };
};
const canvasDocument = () => ({ createElement: () => ({ width: 0, height: 0,
  getContext: () => ({ drawImage() {}, translate() {}, rotate() {}, getImageData: textured }) }) });

async function detectWith(references, ranked, options = { includeCandidate: true, offerCandidates: true }) {
  const crop = { width: 300, height: 420 };
  const detector = { state: 'ready', initialize: async () => {},
    detect: async () => [{ confidence: 0.99, box: { cx: 250, cy: 350, w: 300, h: 420, angle: 0 }, cropCanvas: crop }] };
  const liveMatcher = { ...matcher, ready: true, revision: 1, rank: () => ranked,
    artworkFeatures: () => { liveMatcher.featureReads += 1; return scanFeatures; }, featureReads: 0 };
  const textVerifier = { reset() {}, getGeometryHint: () => null, observe: () => ({ status: 'pending' }) };
  const runtime = createRuntime({ globals: { document: canvasDocument() }, mocks: {
    'src/lib/yoloDetector.js': { getDetector: () => detector, DetectorState: { READY: 'ready', UNLOADED: 'unloaded', LOADING: 'loading', ERROR: 'error' } },
    'src/lib/cardMatcher.js': { getMatcher: () => liveMatcher, filterCardsBySet: (cards) => cards },
    'src/lib/indexedDB.js': { loadLearnedReferences: async () => references, writeLearnedReferences: async () => {} },
  } });
  await runtime.load('src/lib/learnedReferences.js').getLearnedReferences().settled();
  const scan = runtime.load('src/lib/cardScan.js').createCardScan({ getDetector: () => detector, getMatcher: () => liveMatcher,
    getLearnedReferences: () => runtime.load('src/lib/learnedReferences.js').getLearnedReferences() });
  const frame = { width: 800, height: 900, frameId: 1, capturedAt: Date.now(),
    scanRegion: { x: 400, y: 100, guide: { x: 100, y: 100, width: 300, height: 500 } } };
  const { result } = await scan.scanFrame(frame, { setFilter: 'all', minSimilarity: 0.9, minSimilarityGap: 0.05, textVerifier }, options);
  return Object.assign(result, { featureReads: liveMatcher.featureReads });
}

const acceptanceInputs = (result) => JSON.parse(JSON.stringify({ cardData: result.cardData, similarity: result.similarity,
  similarityGap: result.similarityGap, visualCandidates: result.visualCandidates, matched: result.matched,
  reason: result.reason, acceptanceDecision: result.acceptanceDecision }));

test('learned references change only the shown candidates, never what acceptance reads', async () => {
  const ranked = ['first', 'second', 'third'].map((id, index) => ({ card: card(id), similarity: .8 - index / 20 }));
  const without = await detectWith([], ranked);
  const withLearned = await detectWith([learned('mine')], ranked);
  assert.deepEqual(Array.from(without.reviewCandidates, (candidate) => candidate.id), ['first', 'second', 'third']);
  assert.deepEqual(Array.from(withLearned.reviewCandidates, (candidate) => candidate.id), ['mine', 'first', 'second']);
  assert.equal(withLearned.reviewCandidates[0].fromLearnedReference, true);
  assert.ok(without.visualCandidates.length, 'acceptance inputs are present to compare');
  assert.deepEqual(acceptanceInputs(withLearned), acceptanceInputs(without));
});

test('a learned reference of the top card never lowers its similarity gap', async () => {
  const ranked = ['first', 'second'].map((id, index) => ({ card: card(id), similarity: .92 - index / 10 }));
  const without = await detectWith([], ranked);
  const withLearned = await detectWith([learned('first')], ranked);
  assert.equal(withLearned.reviewCandidates[0].id, 'first');
  assert.equal(withLearned.reviewCandidates[0].fromLearnedReference, true);
  assert.equal(withLearned.reviewCandidates.length, 2, 'the same card is not its own runner-up');
  assert.equal(withLearned.similarityGap, without.similarityGap);
  assert.deepEqual(acceptanceInputs(withLearned), acceptanceInputs(without));
});

test('a frame that offers no candidates never reads its artwork for learned references', async () => {
  const ranked = ['first', 'second', 'third'].map((id, index) => ({ card: card(id), similarity: .8 - index / 20 }));
  const quiet = await detectWith([learned('mine')], ranked, { includeCandidate: true });
  assert.equal(quiet.featureReads, 0);
  assert.deepEqual(Array.from(quiet.reviewCandidates, (candidate) => candidate.id), ['first', 'second', 'third']);
  const offered = await detectWith([learned('mine')], ranked);
  assert.equal(offered.featureReads, 1);
  const snapped = await detectWith([learned('mine')], ranked, { includeCandidate: true, includeReview: true });
  assert.equal(snapped.reviewCandidates[0].id, 'mine', 'Snap review always offers candidates');
});
