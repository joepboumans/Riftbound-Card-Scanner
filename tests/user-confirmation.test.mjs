import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, componentProps } from './helpers/runtime.mjs';
import { resolveCardData } from '../src/lib/cardData.js';
import { choiceStripReducer, choiceStripView, CHOICE_STRIP_INITIAL, CHOICE_STRIP_HOLD_MS, choiceKeyAction, DUPLICATE_ADD_WINDOW_MS } from '../src/lib/userConfirmation.js';

const top = resolveCardData({ id: 'ogn-039-298', name: "Kai'Sa", code: 'OGN-039/298', set: 'OGN', rarity: 'rare' });
const second = resolveCardData({ id: 'ogn-039a-298', name: "Kai'Sa", code: 'OGN-039a/298', set: 'OGN', rarity: 'rare' });
const third = resolveCardData({ id: 'rad-sp4-005', name: "Kai'Sa", code: 'RAD-SP4/005', set: 'RAD', rarity: 'rare' });
const candidates = [{ ...top, similarity: .81 }, { ...second, similarity: .78 }, { ...third, similarity: .74 }];
const goodQuality = { acceptable: true, score: .8 };
// A scan the scanner will not accept: low similarity, no separation.
const weakScan = (patch = {}) => ({ cardData: top, matched: false, similarity: .81, similarityGap: .03, confidence: .9,
  quality: goodQuality, box: { cx: 1, cy: 1, w: 1, h: 1, angle: 0 }, reviewCandidates: candidates, ...patch });

function appFixture({ realTimers = false, clock = null } = {}) {
  let next = null, calls = 0, autoScanOptions = null;
  const globals = { ...(realTimers ? { setTimeout, clearTimeout } : {}),
    ...(clock ? { Date: class extends Date { static now() { return clock.now; } } } : {}) };
  const mocks = {
    'src/hooks/useCamera.js': { useCamera: () => ({ isActive: true, captureFrame: () => ({}), stopCamera() {} }) },
    'src/hooks/useCardDetection.js': { useCardDetection: () => ({ isProcessing: false,
      detectSingleFrame: async () => { calls++; return next; } }) },
  };
  const runtime = createRuntime({ globals, mocks });
  // Wrap the real auto scan to reach the callback it calls when it accepts a card.
  const realAutoScan = runtime.load('src/hooks/useAutoScan.js');
  mocks['src/hooks/useAutoScan.js'] = { useAutoScan: (options) => { autoScanOptions = options; return realAutoScan.useAutoScan(options); } };
  const app = runtime.mount(runtime.load('src/App.jsx').default, [false]);
  const tree = () => app.render();
  const scan = () => componentProps(tree(), 'ScanTab');
  const review = () => componentProps(tree(), 'ManualScanReview');
  const snap = async (result) => { next = result; await scan().onSnapScan(); };
  const autoAccept = (result) => { tree(); return autoScanOptions.onCardDetected(result); };
  return { runtime, app, tree, scan, review, snap, autoAccept, get calls() { return calls; } };
}

test('picking a candidate in Snap review queues a user-confirmed entry with its rank', async () => {
  const f = appFixture();
  await f.snap(weakScan());
  f.review().onSelect(candidates[1], 2);
  const [entry] = f.scan().pendingCards;
  assert.equal(f.scan().pendingCards.length, 1);
  assert.equal(entry.cardData.id, second.id);
  assert.equal(entry.userConfirmed, true);
  assert.equal(entry.confirmedFrom, 'snap');
  assert.equal(entry.candidateRank, 2);
  assert.equal(entry.similarity, .78);
  assert.equal(entry.topCandidateId, top.id);
  assert.equal(entry.manualAdded, undefined);
  assert.equal(entry.cardData.similarity, undefined, 'match scores stay off the card data');
});

test('an overlay pick skips the acceptance rules and hands the artwork crop to learned references', () => {
  const f = appFixture();
  const { attachScanArtwork } = f.runtime.load('src/lib/scanEvidence.js');
  const { subscribeScanDiagnostics } = f.runtime.load('src/lib/scanDiagnostics.js');
  const handed = [];
  subscribeScanDiagnostics((type, details) => { if (type === 'user-confirmed') handed.push(details); });
  const crop = { width: 300, height: 420 };
  const scan = attachScanArtwork(weakScan({ similarity: .41, similarityGap: -.2 }), { crop, quality: goodQuality });
  assert.equal(f.scan().onConfirmCandidate(scan, candidates[2], { from: 'overlay', rank: 3 }), true);
  const [entry] = f.scan().pendingCards;
  assert.equal(entry.cardData.id, third.id);
  assert.equal(entry.confirmedFrom, 'overlay');
  assert.equal(entry.candidateRank, 3);
  assert.equal(handed.length, 1);
  assert.equal(handed[0].card.id, third.id);
  assert.equal(handed[0].artwork.crop, crop);
  assert.equal(handed[0].artwork.quality, goodQuality);
});

test('nothing is user-confirmed while debug mode owns the camera', () => {
  const f = appFixture();
  const { subscribeScanDiagnostics } = f.runtime.load('src/lib/scanDiagnostics.js');
  let handed = 0;
  subscribeScanDiagnostics((type) => { if (type === 'user-confirmed') handed++; });
  f.scan().onDebugChange(true);
  assert.equal(f.scan().onConfirmCandidate(weakScan(), candidates[0], { from: 'overlay', rank: 1 }), false);
  assert.equal(f.scan().pendingCards.length, 0);
  assert.equal(handed, 0);
});

test('"Not these, search…" confirms the searched card for that scan, and cancelling adds nothing', async () => {
  const f = appFixture();
  const { attachScanArtwork } = f.runtime.load('src/lib/scanEvidence.js');
  const { subscribeScanDiagnostics } = f.runtime.load('src/lib/scanDiagnostics.js');
  const handed = [];
  subscribeScanDiagnostics((type, details) => { if (type === 'user-confirmed') handed.push(details); });
  const crop = { width: 300, height: 420 };
  const searched = resolveCardData({ id: 'sfd-100-221', name: 'Searched', code: 'SFD-100/221', set: 'SFD', rarity: 'common' });

  await f.snap(attachScanArtwork(weakScan(), { crop, quality: goodQuality }));
  f.review().onSearch();
  assert.throws(() => f.review(), /Component missing/, 'search replaces the review dialog');
  componentProps(f.tree(), 'CandidateSearch').onClose();
  assert.throws(() => componentProps(f.tree(), 'CandidateSearch'), /Component missing/);
  assert.equal(f.scan().pendingCards.length, 0);

  await f.snap(attachScanArtwork(weakScan(), { crop, quality: goodQuality }));
  f.review().onSearch();
  componentProps(f.tree(), 'CandidateSearch').onPick(searched);
  const [entry] = f.scan().pendingCards;
  assert.equal(entry.cardData.id, searched.id);
  assert.equal(entry.userConfirmed, true);
  assert.equal(entry.confirmedFrom, 'snap');
  assert.equal(entry.candidateRank, null);
  assert.equal(entry.similarity, null);
  assert.equal(entry.topCandidateId, top.id);
  assert.equal(handed[0].artwork.crop, crop);
  assert.throws(() => componentProps(f.tree(), 'CandidateSearch'), /Component missing/);
});

test('the overlay search hides the Choice strip while it is open, and only auto scan offers the strip', () => {
  const f = appFixture();
  assert.equal(f.scan().choiceStripEnabled, false, 'no strip while auto scan is off');
  f.scan().onToggleAutoScan();
  assert.equal(f.scan().choiceStripEnabled, true);
  f.scan().onSearchCandidate(weakScan(), 'overlay');
  assert.equal(f.scan().choiceStripEnabled, false);
  componentProps(f.tree(), 'CandidateSearch').onPick(second);
  assert.equal(f.scan().choiceStripEnabled, true);
  assert.equal(f.scan().pendingCards[0].confirmedFrom, 'overlay');
  assert.equal(f.scan().pendingCards[0].candidateRank, null);
  f.scan().onDebugChange(true);
  assert.equal(f.scan().choiceStripEnabled, false, 'never in debug mode');
});

test('Snap review opens with a warning on failed quality, and with only search when nothing ranked', async () => {
  const f = appFixture({ realTimers: true });
  const blurry = weakScan({ quality: { acceptable: false, issue: 'blurry' }, reason: 'blurry' });
  await f.snap(blurry);
  assert.equal(f.review().result, blurry);
  assert.equal(f.review().qualityWarning, true);
  assert.equal(f.scan().pendingCards.length, 0, 'a failed-quality scan is never accepted by itself');
  f.review().onClose();

  const nothingRanked = weakScan({ cardData: undefined, reviewCandidates: [] });
  await f.snap(nothingRanked);
  assert.equal(f.review().result, nothingRanked);
  assert.equal(f.review().qualityWarning, false);
  f.review().onClose();

  await f.snap(null);
  assert.throws(() => f.review(), /Component missing/, 'no outline keeps today\'s notification');
});

const clearFeatures = Float32Array.from({ length: 12 }, (_, i) => .5 + .4 * Math.sin(i * 1.3));
const artworkMatcher = { cards: [], artworkFeatures: (crop) => crop.features };
const scanArtwork = (runtime, quality) => runtime.load('src/lib/learnedReferences.js')
  .describeScanArtwork({ crop: { features: clearFeatures }, quality, outlined: true, matcher: artworkMatcher });

test('a clear user-confirmed scan saves a learned reference, and its pending row records which one', async () => {
  const f = appFixture();
  const { attachScanArtwork } = f.runtime.load('src/lib/scanEvidence.js');
  const learned = f.runtime.load('src/lib/learnedReferences.js').getLearnedReferences();
  const scan = attachScanArtwork(weakScan(), scanArtwork(f.runtime, goodQuality));
  f.scan().onConfirmCandidate(scan, candidates[2], { from: 'overlay', rank: 3 });
  await learned.settled();
  const [entry] = f.scan().pendingCards;
  const [reference] = learned.references();
  assert.equal(learned.references().length, 1);
  assert.equal(reference.cardId, third.id);
  assert.equal(entry.learnedReferenceId, reference.id);
});

test('a card confirmed in Snap review after a failed quality check never saves a learned reference', async () => {
  const f = appFixture({ realTimers: true });
  const { attachScanArtwork } = f.runtime.load('src/lib/scanEvidence.js');
  const learned = f.runtime.load('src/lib/learnedReferences.js').getLearnedReferences();
  const blurry = { acceptable: false, issue: 'blurred' };
  await f.snap(attachScanArtwork(weakScan({ quality: blurry, reason: 'blurred' }), scanArtwork(f.runtime, blurry)));
  f.review().onSelect(candidates[0], 1);
  await learned.settled();
  assert.equal(f.scan().pendingCards.length, 1, 'the user-confirmed row is still queued');
  assert.equal(f.scan().pendingCards[0].learnedReferenceId, null);
  assert.equal(learned.references().length, 0);
});

const gone = { matched: false, reason: 'outside-guide' };
const strip = (...events) => events.reduce(choiceStripReducer, CHOICE_STRIP_INITIAL);
const observe = (detection, now) => ({ type: 'observe', detection, now });

test('the Choice strip shows the top 3 candidates and holds them 3 s after the card leaves', () => {
  const scan = weakScan({ reviewCandidates: [...candidates, { ...third, id: 'fourth', similarity: .7 }] });
  let state = strip(observe(scan, 1000));
  let view = choiceStripView(state, 1000);
  assert.deepEqual(view.candidates.map((card) => card.id), [top.id, second.id, third.id]);
  assert.equal(view.scan, scan);
  assert.equal(view.remainingMs, null, 'no countdown while the card is in frame');
  state = choiceStripReducer(state, observe(gone, 1500));
  assert.equal(choiceStripView(state, 2500).remainingMs, CHOICE_STRIP_HOLD_MS - 1000);
  assert.equal(choiceStripView(state, 1500 + CHOICE_STRIP_HOLD_MS).candidates.length, 3);
  assert.equal(choiceStripView(state, 1501 + CHOICE_STRIP_HOLD_MS).candidates, null);
});

test('the pointer freezes the Choice strip, and the hold restarts when it leaves', () => {
  const later = weakScan({ reviewCandidates: [candidates[1], candidates[0]] });
  let state = strip(observe(weakScan(), 1000), { type: 'pointer', over: true, now: 1100 }, observe(gone, 1200), observe(later, 1300));
  assert.equal(choiceStripView(state, 1300).candidates[0].id, top.id, 'a new frame does not swap the strip under the pointer');
  state = choiceStripReducer(state, observe(gone, 1400));
  assert.equal(choiceStripView(state, 60000).candidates[0].id, top.id, 'frozen while the pointer is over it');
  state = choiceStripReducer(state, { type: 'pointer', over: false, now: 60000 });
  assert.equal(choiceStripView(state, 60000 + CHOICE_STRIP_HOLD_MS).candidates.length, 3);
  assert.equal(choiceStripView(state, 60001 + CHOICE_STRIP_HOLD_MS).candidates, null);
});

test('while the scanner is locking on, the Choice strip stays up and marks the card it is confirming', () => {
  const confirming = (cardData, patch = {}) => weakScan({ matched: true, cardData, ...patch });
  let state = strip(observe(weakScan(), 1000), observe(confirming(top), 1100));
  let view = choiceStripView(state, 1100);
  assert.deepEqual(view.candidates.map((card) => card.id), [top.id, second.id, third.id]);
  assert.equal(view.confirmingId, top.id);
  state = choiceStripReducer(state, observe(weakScan(), 1200));
  assert.equal(choiceStripView(state, 1200).confirmingId, null, 'an unclear frame drops the marker');

  view = choiceStripView(strip(observe(confirming(third), 1000)), 1000);
  assert.equal(view.confirmingId, third.id, 'text can confirm a lower-ranked candidate');
  const outside = resolveCardData({ id: 'text-only', name: 'Text only', code: 'TXT-001/100', set: 'TXT', rarity: 'common' });
  view = choiceStripView(strip(observe(confirming(outside, { similarity: .7 }), 1000)), 1000);
  assert.deepEqual(view.candidates.map((card) => card.id), [outside.id, top.id, second.id], 'the confirming card is always shown');
  assert.equal(view.candidates[0].similarity, .7);

  const frozen = strip(observe(weakScan(), 1000), { type: 'pointer', over: true, now: 1050 }, observe(confirming(second), 1100));
  view = choiceStripView(frozen, 1100);
  assert.equal(view.candidates[0].id, top.id, 'tiles do not move under the pointer');
  assert.equal(view.confirmingId, second.id);
});

test('a card the scanner is confirming is not offered again once it was picked or added', () => {
  const state = strip({ type: 'added', cardId: top.id, now: 1000 }, observe(weakScan({ matched: true }), 1100));
  assert.equal(choiceStripView(state, 1100).candidates, null);
});

test('after a confirm or dismiss the Choice strip is not offered for that card until it leaves the frame', () => {
  for (const type of ['confirmed', 'dismiss']) {
    let state = strip(observe(weakScan(), 1000), { type, now: 1100 });
    assert.equal(choiceStripView(state, 1100).candidates, null, type);
    state = choiceStripReducer(state, observe(weakScan(), 1200));
    assert.equal(choiceStripView(state, 1200).candidates, null, `${type}: same card still in frame`);
    const other = weakScan({ reviewCandidates: [candidates[2], candidates[0]] });
    assert.equal(choiceStripView(choiceStripReducer(state, observe(other, 1250)), 1250).candidates[0].id, third.id,
      `${type}: a different top candidate is offered`);
    state = choiceStripReducer(choiceStripReducer(state, observe(gone, 1300)), observe(weakScan(), 1400));
    assert.equal(choiceStripView(state, 1400).candidates[0].id, top.id, `${type}: offered again after leaving`);
  }
});

test('a card the scanner just added is not offered on the Choice strip while it stays in frame', () => {
  let state = strip({ type: 'added', cardId: top.id, now: 1000 }, observe(weakScan(), 1100));
  assert.equal(choiceStripView(state, 1100).candidates, null);
  state = choiceStripReducer(choiceStripReducer(state, observe(gone, 1200)), observe(weakScan(), 1300));
  assert.equal(choiceStripView(state, 1300).candidates.length, 3);
});

test('Choice keys: Enter or 1 picks the top candidate, 2/3 the others, S searches, Esc dismisses', () => {
  const key = (keyName, options = {}) => choiceKeyAction({ key: keyName, ...options.event }, { count: 3, ...options });
  assert.deepEqual(key('Enter'), { type: 'pick', rank: 1 });
  assert.deepEqual(key('1'), { type: 'pick', rank: 1 });
  assert.deepEqual(key('2'), { type: 'pick', rank: 2 });
  assert.deepEqual(key('3'), { type: 'pick', rank: 3 });
  assert.equal(key('3', { count: 2 }), null, 'no third candidate');
  assert.equal(key('Enter', { count: 0 }), null, 'only search when nothing ranked');
  assert.deepEqual(key('s'), { type: 'search' });
  assert.deepEqual(key('S'), { type: 'search' });
  assert.deepEqual(key('Escape'), { type: 'dismiss' });
  assert.equal(key('4'), null);
  assert.equal(key('s', { event: { ctrlKey: true } }), null, 'shortcuts with modifiers are left alone');
});

test('Choice keys are ignored while a text field has focus', () => {
  for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
    for (const keyName of ['Enter', '1', 's', 'Escape']) assert.equal(choiceKeyAction({ key: keyName, target }, { count: 3 }), null);
  }
  assert.deepEqual(choiceKeyAction({ key: '1', target: { tagName: 'BUTTON' } }, { count: 3 }), { type: 'pick', rank: 1 });
});

test('picking candidate 2 keeps the Choice strip away for the same card while it stays in frame', () => {
  const state = strip(observe(weakScan(), 1000), { type: 'confirmed', now: 1100 },
    { type: 'added', cardId: second.id, now: 1100 }, observe(weakScan(), 1200));
  assert.equal(choiceStripView(state, 1200).candidates, null);
});

test('the Choice strip closes as soon as the scanner adds the card it was confirming', () => {
  const state = strip(observe(weakScan({ matched: true }), 1000), { type: 'added', cardId: top.id, now: 1100 });
  assert.equal(choiceStripView(state, 1100).candidates, null);
  const other = strip(observe(weakScan(), 1000), { type: 'added', cardId: 'something-else', now: 1100 });
  assert.equal(choiceStripView(other, 1100).candidates.length, 3, 'an unrelated add leaves the strip alone');
});

const acceptedScan = (cardData = top) => weakScan({ cardData, matched: true, similarity: .96, similarityGap: .1, timestamp: 0 });
const pendingCopies = (f, id) => f.scan().pendingCards.filter((entry) => entry.cardData.id === id).reduce((sum, entry) => sum + entry.quantity, 0);

test('a pick right after the scanner added the same card is dropped', () => {
  const clock = { now: 10000 };
  const f = appFixture({ clock });
  assert.equal(f.autoAccept(acceptedScan()), true);
  clock.now += DUPLICATE_ADD_WINDOW_MS - 1;
  assert.equal(f.scan().onConfirmCandidate(weakScan(), candidates[0], { from: 'overlay', rank: 1 }), false);
  assert.equal(pendingCopies(f, top.id), 1);
  assert.equal(f.scan().onConfirmCandidate(weakScan(), candidates[1], { from: 'overlay', rank: 2 }), true, 'a different card is still added');
  clock.now += 2;
  assert.equal(f.scan().onConfirmCandidate(weakScan(), candidates[0], { from: 'overlay', rank: 1 }), true, 'after the window a second copy is allowed');
  assert.equal(pendingCopies(f, top.id), 2);
});

test('the scanner adding the same card right after a pick is dropped, and counts as handled', () => {
  const clock = { now: 10000 };
  const f = appFixture({ clock });
  f.scan().onConfirmCandidate(weakScan(), candidates[0], { from: 'overlay', rank: 1 });
  clock.now += DUPLICATE_ADD_WINDOW_MS - 1;
  assert.equal(f.autoAccept(acceptedScan()), true, 'auto scan locks the card instead of retrying');
  assert.equal(pendingCopies(f, top.id), 1);
  clock.now += 2;
  assert.equal(f.autoAccept(acceptedScan()), true);
  assert.equal(pendingCopies(f, top.id), 2);
});
