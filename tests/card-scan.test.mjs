import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from './helpers/runtime.mjs';

const { snapScan } = createRuntime().load('src/lib/cardScan.js');

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
    { textVerifier, minSimilarity, now: () => now, wait: async (ms) => { waits.push(ms); now += ms; } });
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
