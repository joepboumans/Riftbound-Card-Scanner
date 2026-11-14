import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from './helpers/runtime.mjs';

const sandbox = createRuntime();
const { snapScan } = sandbox.load('src/lib/cardScan.js');
const { isReliableScanResult } = sandbox.load('src/lib/scanQuality.js');

const card = { id: 'fixture-001', name: 'Fixture Card', code: 'FIX-001/100' };
const good = { acceptable: true, score: .8 };
const box = { cx: 1, cy: 1, w: 1, h: 1, angle: 0 };
const accepted = { cardData: card, matched: true, similarity: .99, similarityGap: .1, quality: good, box };
const unclear = (patch = {}) => ({ cardData: card, matched: false, similarity: .8, similarityGap: .01, quality: good, box, ...patch });

// Feeds Snap one outcome per scan on a fake clock: each scan takes 100 ms.
async function snap(outcomes, { textVerifier = null, minSimilarity = .9 } = {}) {
  let now = 0, scans = 0;
  const waits = [];
  const result = await snapScan(async () => { now += 100; return outcomes[Math.min(scans++, outcomes.length - 1)]; },
    { accepts: (outcome) => isReliableScanResult(outcome, minSimilarity), textVerifier,
      now: () => now, wait: async (ms) => { waits.push(ms); now += ms; } });
  return { ...result, scans, waits, now };
}
const reader = (resets = { count: 0 }) => ({ reset() { resets.count++; } });

test('Snap stops as soon as the scanner accepts the card', async () => {
  const { result, scans } = await snap([accepted], { textVerifier: reader() });
  assert.equal(result, accepted);
  assert.equal(scans, 1);
});

test('without text verification Snap scans a single frame', async () => {
  const { result, review, scans } = await snap([unclear()]);
  assert.equal(scans, 1);
  assert.equal(result.matched, false);
  assert.equal(review, result);
});

test('with text verification Snap retries every 125 ms while the text is being read, for up to two seconds', async () => {
  const resets = { count: 0 };
  const reading = unclear({ textVerification: { status: 'pending' } });
  const { scans, waits, now } = await snap([reading], { textVerifier: reader(resets) });
  assert.equal(resets.count, 1, 'a Snap starts a fresh reading');
  assert.ok(waits.every((ms) => ms === 125));
  assert.equal(scans, 9);
  assert.ok(now >= 2000);
});

test('Snap stops once the text has been read, accepted or not', async () => {
  const reading = unclear({ textVerification: { status: 'pending' } });
  const read = unclear({ textVerification: { status: 'unreadable' } });
  const { result, scans } = await snap([reading, reading, read], { textVerifier: reader() });
  assert.equal(scans, 3);
  assert.equal(result, read);
});

test('Snap review gets the latest outlined card, preferring one with acceptable quality', async () => {
  const sharp = unclear({ textVerification: { status: 'pending' }, frameId: 1 });
  const blurry = unclear({ quality: { acceptable: false, issue: 'blurry' }, frameId: 2 });
  const sharper = unclear({ textVerification: { status: 'pending' }, frameId: 3 });
  const kept = await snap([sharp, blurry, null], { textVerifier: reader() });
  assert.equal(kept.review, sharp, 'a blurry or empty frame does not replace a sharp one');
  const latest = await snap([sharp, sharper, null], { textVerifier: reader() });
  assert.equal(latest.review, sharper);
  const onlyBlurry = await snap([blurry]);
  assert.equal(onlyBlurry.review, blurry, 'a blurry card is still offered for review');
  const nothing = await snap([null]);
  assert.equal(nothing.review, null);
});

test('while text is still being read, the scan matching threshold decides whether artwork alone ends Snap', async () => {
  // Text still being read, but this card may be accepted on its artwork alone.
  const borderline = { ...accepted, similarity: .87, minSimilarity: .85,
    textVerification: { status: 'pending', artworkFallbackAllowed: true } };
  const reading = { textVerifier: reader() };
  assert.equal((await snap([borderline], { ...reading, minSimilarity: .85 })).scans, 1);
  assert.ok((await snap([borderline], { ...reading, minSimilarity: .9 })).scans > 1, 'below the user threshold Snap keeps reading');
});

// A detector and matcher that answer instantly, for the scan module itself.
function moduleFixture() {
  const textured = () => {
    const width = 64, height = 88, data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 190 : 40;
      data[i + 3] = 255;
    }
    return { data, width, height };
  };
  const runtime = createRuntime({ globals: { document: { createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ drawImage() {}, translate() {}, rotate() {}, getImageData: textured }) }) } } });
  let release = null;
  const detector = { detect: () => new Promise((resolve) => { release = () => resolve([{ confidence: .99,
    box: { cx: 250, cy: 350, w: 300, h: 420, angle: 0 }, cropCanvas: { width: 300, height: 420 } }]); }) };
  const matcher = { ready: true, revision: 1,
    identify: () => ({ card: { id: 'correct', name: 'Correct', code: 'FIX-001/100' }, similarity: .96, secondBestSim: .8 }) };
  const scan = runtime.load('src/lib/cardScan.js').createCardScan({ getDetector: () => detector, getMatcher: () => matcher,
    getLearnedReferences: () => runtime.load('src/lib/learnedReferences.js').getLearnedReferences() });
  const frame = { width: 800, height: 900, frameId: 1, capturedAt: Date.now(),
    scanRegion: { x: 400, y: 100, guide: { x: 100, y: 100, width: 300, height: 500 } } };
  const settings = { setFilter: 'all', minSimilarity: .9, minSimilarityGap: .05 };
  return { scan, frame, settings, matcher, release: () => release() };
}

test('a scan returns what the scanner saw and the result to act on', async () => {
  const fixture = moduleFixture();
  const pending = fixture.scan.scanFrame(fixture.frame, fixture.settings);
  fixture.release();
  const { observation, result } = await pending;
  assert.equal(result.cardData.id, 'correct');
  assert.equal(result.matched, true);
  assert.equal(observation, result);
});

test('reset cancels a scan in flight: it returns nothing and shows nothing', async () => {
  const fixture = moduleFixture();
  const pending = fixture.scan.scanFrame(fixture.frame, fixture.settings);
  fixture.scan.reset();
  fixture.release();
  const { observation, result } = await pending;
  assert.equal(observation, null);
  assert.equal(result, null);
});

test('a card database update during a scan cancels it', async () => {
  const fixture = moduleFixture();
  const pending = fixture.scan.scanFrame(fixture.frame, fixture.settings);
  fixture.matcher.revision = 2;
  fixture.release();
  const { observation, result } = await pending;
  assert.equal(observation, null);
  assert.equal(result, null);
});

test('a moving or badly lit frame is shown with its reason and never reaches the detector', async () => {
  const fixture = moduleFixture();
  const moving = await fixture.scan.scanFrame({ ...fixture.frame, scanMoving: true }, fixture.settings);
  assert.equal(moving.result, null);
  assert.equal(moving.observation.reason, 'moving');
  const dark = await fixture.scan.scanFrame({ ...fixture.frame, scanQuality: { issue: 'too-dark' } }, fixture.settings);
  assert.equal(dark.observation.reason, 'too-dark');
});

// A photo with cards found by a fake detector and ranked by a fake matcher.
function photoFixture({ ranked = [{ card: { id: 'match', name: 'Match', code: 'FIX-001/100' }, similarity: .95 }],
  detections = [{ confidence: .99, box: { cx: 100, cy: 150, w: 63, h: 88, angle: 0 } }], ready = 'ready' } = {}) {
  const draws = [];
  const context = { drawImage: (source, x, y) => draws.push({ source, x, y }), translate() {}, rotate() {},
    getImageData: () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) }) };
  const runtime = createRuntime({ globals: { document: { createElement: () => ({ width: 0, height: 0, getContext: () => context }) } } });
  const { scanPhoto } = runtime.load('src/lib/cardScan.js');
  const detector = { state: ready, detect: async () => detections };
  const matcher = { ready: true, cards: ranked.map((entry) => entry.card), rank: () => ranked };
  const image = { naturalWidth: 400, naturalHeight: 600 };
  const original = { naturalWidth: 800, naturalHeight: 1200 };
  const settings = { setFilter: 'all', minSimilarity: .9, minSimilarityGap: .05 };
  const scan = (patch = {}) => scanPhoto(image, { original, detector, matcher, settings, ...patch });
  return { scan, detector, matcher, image, original, draws, settings };
}

test('a photo is scanned for every card, each cropped from the full-resolution original', async () => {
  const fixture = photoFixture({ detections: [
    { confidence: .99, box: { cx: 100, cy: 150, w: 63, h: 88, angle: 0 } },
    { confidence: .98, box: { cx: 300, cy: 400, w: 63, h: 88, angle: 0 } }] });
  const { status, cards } = await fixture.scan();
  assert.equal(status, 'scanned');
  assert.deepEqual(JSON.parse(JSON.stringify(cards.map((card) => [card.cx, card.cy, card.confidence]))), [[100, 150, .99], [300, 400, .98]],
    'boxes stay in the coordinates of the photo as shown');
  assert.ok(cards.every((card) => card.matchResult.card.id === 'match'));
  const crops = fixture.draws.filter((draw) => draw.source === fixture.original);
  assert.deepEqual(crops.map((draw) => [draw.x, draw.y]), [[-200, -300], [-600, -800]], 'crops use the original, scaled up');
});

test('a photo without cards, or before the detector is ready, says so', async () => {
  const empty = await photoFixture({ detections: [] }).scan();
  assert.equal(empty.status, 'no-cards');
  assert.equal(empty.cards.length, 0);
  const notReady = await photoFixture({ ready: 'loading' }).scan();
  assert.equal(notReady.status, 'detector-not-ready');
});

test('picking another photo stops the scan', async () => {
  let current = true;
  const fixture = photoFixture();
  fixture.detector.detect = async () => { current = false; return [{ confidence: .99, box: { cx: 1, cy: 1, w: 63, h: 88, angle: 0 } }]; };
  assert.equal(await fixture.scan({ isCurrent: () => current }), null);
});

test('a photo lists cards that match or come close, not ones far below the threshold', async () => {
  const card = (id) => ({ id, name: id, code: `FIX-${id}/100` });
  const close = await photoFixture({ ranked: [{ card: card('close'), similarity: .91 }, { card: card('next'), similarity: .5 }] }).scan();
  assert.equal(close.cards.length, 1);
  assert.equal(close.cards[0].recognitionResult.matched, false, 'without a quality reading a photo card is listed, not accepted');
  const far = await photoFixture({ ranked: [{ card: card('far'), similarity: .7 }, { card: card('next'), similarity: .5 }] }).scan();
  assert.equal(far.status, 'scanned');
  assert.equal(far.cards.length, 0);
});

test('photo text that confirms another candidate puts that candidate first', async () => {
  const card = (id) => ({ id, name: id, code: `FIX-${id}/100` });
  const ranked = [{ card: card('first'), similarity: .92 }, { card: card('second'), similarity: .91 }];
  const fixture = photoFixture({ ranked });
  const textVerifier = { verifyPhoto: async (_crop, { frameId }) => ({ status: 'confirmed', cardId: 'second', frameId,
    nameConfidence: 96, codeConfidence: 96, sourceFrameIds: [frameId] }) };
  const { cards } = await fixture.scan({ settings: { ...fixture.settings, textVerifier }, photoId: 'photo-7' });
  assert.equal(cards[0].matchResult.card.id, 'second');
  assert.equal(cards[0].textVerification.frameId, 'photo-7-0');
  assert.equal(cards[0].recognitionResult.confirmationMethod, 'text');
});
