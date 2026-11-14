import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoScanSession, POST_ADD_COOLDOWN_MS } from '../src/lib/autoScanSession.js';
import { resolveCardData } from '../src/lib/cardData.js';

const card = resolveCardData({ id: 'fixture-001', name: 'Fixture Card', code: 'FIX-001/100', set: 'FIX', rarity: 'common' });
const other = { ...card, id: 'other-card' };

// A frame the scanner would accept by itself, strong enough for the fast path.
const strong = (patch = {}) => ({ cardData: card, confidence: .99, similarity: .99, similarityGap: .08, matched: true,
  quality: { acceptable: true, score: .8 }, ...patch });
// Acceptable, but only through the stable three-frame sequence.
const moderate = (patch = {}) => strong({ similarity: .92, similarityGap: .06, ...patch });

// Feeds outcomes to a session 250 ms apart and adds every accepted card, as auto scan does.
function autoScan(options) {
  const session = createAutoScanSession();
  let now = 0;
  const accepted = [];
  const observe = (outcome) => {
    now += 250;
    const decision = session.observe(outcome, now, options);
    if (decision.type === 'accept') { accepted.push(decision); session.lock(decision.cardId, now); }
    return decision;
  };
  const feed = (...outcomes) => outcomes.map(observe);
  const repeat = (count, outcome) => feed(...Array.from({ length: count }, () => outcome));
  return { session, accepted, observe, feed, repeat, get now() { return now; }, wait(ms) { now += ms; } };
}

test('two strong frames in a row are accepted', () => {
  const scan = autoScan();
  const [first, second] = scan.feed(strong({ frameId: 1 }), strong({ frameId: 2 }));
  assert.equal(first.type, 'wait');
  assert.equal(first.reason, 'collecting-visual-frames');
  assert.deepEqual(first.diagnostic, { frameId: 1, cardId: card.id, reason: 'collecting-visual-frames', visualFrames: 1, sourceFrameIds: [1] });
  assert.equal(second.type, 'accept');
  assert.equal(second.reason, 'enough-frames');
  assert.equal(second.cardId, card.id);
  assert.equal(second.visualFrames, 2);
  assert.deepEqual(second.consensus, { hits: 2, matchedHits: 2, aggregateScore: second.consensus.aggregateScore,
    consecutiveHits: 2, sourceFrameIds: [1, 2], durationMs: 250 });
});

test('moderate artwork needs three frames in a row over at least half a second', () => {
  const scan = autoScan();
  const decisions = scan.feed(strong({ frameId: 1 }), moderate({ frameId: 2 }), moderate({ frameId: 3 }));
  assert.deepEqual(decisions.map((decision) => decision.type), ['wait', 'wait', 'accept']);
  assert.equal(decisions[2].consensus.consecutiveHits, 3);
  assert.deepEqual(decisions[2].consensus.sourceFrameIds, [1, 2, 3]);
});

test('three moderate frames inside half a second are not enough yet', () => {
  const session = createAutoScanSession();
  assert.equal(session.observe(moderate(), 100).type, 'wait');
  assert.equal(session.observe(moderate(), 200).type, 'wait');
  assert.equal(session.observe(moderate(), 300).type, 'wait');
  assert.equal(session.observe(moderate(), 600).type, 'accept');
});

test('the best outcome of the card being counted is reported, and cleared when counting stops', () => {
  const scan = autoScan();
  const clearer = moderate({ similarity: .95 });
  const [first, second, weaker] = scan.feed(moderate(), clearer, moderate({ similarity: .91 }));
  assert.equal(first.best.similarity, .92);
  assert.equal(second.best, clearer);
  assert.equal(weaker.best, clearer, 'a weaker frame does not replace the best one');
  const fresh = autoScan();
  fresh.feed(moderate());
  const misses = fresh.repeat(4, null);
  assert.equal(misses[0].best, undefined, 'unchanged while the card may still come back');
  assert.equal(misses[3].best, null);
});

test('an accepted card stays locked across disappearance until a different card is accepted', () => {
  const scan = autoScan();
  scan.repeat(3, strong());
  scan.repeat(5, null);
  const again = scan.repeat(3, strong());
  assert.deepEqual(scan.accepted.map((decision) => decision.cardId), [card.id]);
  assert.ok(again.every((decision) => decision.type === 'skip' && decision.reason === 'duplicate-card-lock'));
  scan.repeat(4, strong({ cardData: other }));
  assert.deepEqual(scan.accepted.map((decision) => decision.cardId), [card.id, other.id]);
});

test('a card locked from outside is not accepted again, and unlocking allows it', () => {
  const scan = autoScan();
  scan.session.lock(card.id, 0);
  scan.wait(POST_ADD_COOLDOWN_MS);
  scan.repeat(3, strong());
  assert.equal(scan.accepted.length, 0);
  scan.session.unlock();
  scan.repeat(2, strong());
  assert.equal(scan.accepted.length, 1);
});

test('without locking, neither the duplicate lock nor the cooldown applies', () => {
  const scan = autoScan({ locking: false });
  scan.session.lock(card.id, 0);
  const decisions = scan.repeat(2, strong());
  assert.equal(decisions[1].type, 'accept');
});

test('after an accept the next card waits out the cooldown', () => {
  const scan = autoScan();
  scan.repeat(2, strong());
  const next = moderate({ cardData: other });
  const during = scan.repeat(3, next);
  assert.deepEqual(during.map((decision) => decision.reason), ['cooldown', 'cooldown', 'cooldown']);
  assert.equal(during[0].diagnostic.remainingMs, POST_ADD_COOLDOWN_MS - 250);
  const after = scan.repeat(3, next);
  assert.deepEqual(after.map((decision) => decision.type), ['wait', 'wait', 'accept']);
});

test('a repeating ambiguous or unusable image is never promoted', () => {
  const scan = autoScan();
  const ambiguous = strong({ similarity: .952, similarityGap: 0, matched: false });
  scan.repeat(12, ambiguous);
  scan.repeat(5, { ...ambiguous, matched: true });
  scan.repeat(5, { ...ambiguous, matched: true, similarityGap: .1, quality: { acceptable: false, score: .1 } });
  assert.equal(scan.accepted.length, 0);
  scan.repeat(3, strong());
  assert.equal(scan.accepted.length, 1);
});

test('the caller can reject outcomes with its own check', () => {
  const scan = autoScan({ validate: (outcome) => outcome.similarity >= .95 });
  const rejected = scan.repeat(3, moderate());
  assert.ok(rejected.every((decision) => decision.type === 'skip'));
  assert.equal(scan.repeat(2, strong())[1].type, 'accept');
});

test('a buffered frame cannot count as several independent observations', () => {
  const scan = autoScan();
  const decisions = scan.repeat(10, strong({ frameId: 10 }));
  assert.equal(scan.accepted.length, 0);
  assert.deepEqual(decisions[1].diagnostic, { frameId: 10, reason: 'repeated-source' });
  scan.observe(strong({ frameId: 11 }));
  assert.equal(scan.accepted.length, 1);
});

test('an unclear frame breaks the run of reliable frames', () => {
  const scan = autoScan();
  const [, unclear] = scan.feed(strong(), strong({ matched: false, similarityGap: 0, reason: 'ambiguous' }), strong());
  assert.deepEqual(unclear.diagnostic, { frameId: undefined, cardId: card.id, reason: 'ambiguous' });
  assert.equal(scan.accepted.length, 0);
  scan.observe(strong());
  assert.equal(scan.accepted.length, 1);
});

test('three misses in a row only break the run', () => {
  const scan = autoScan();
  scan.feed(moderate(), moderate());
  scan.repeat(3, null);
  scan.observe(moderate());
  assert.equal(scan.accepted.length, 0, 'three misses only break the run');
  scan.repeat(2, moderate());
  assert.equal(scan.accepted.length, 1);
  assert.equal(scan.accepted[0].consensus.hits, 5, 'hits before the misses still count');
});

test('four misses in a row start the count again', () => {
  const forgotten = autoScan();
  forgotten.feed(moderate(), moderate());
  forgotten.repeat(4, null);
  forgotten.repeat(3, moderate());
  assert.equal(forgotten.accepted[0].consensus.hits, 3);
});

test('polls without a fresh frame are not counted', () => {
  const brief = autoScan();
  brief.observe(strong({ frameId: 1 }));
  const empty = brief.repeat(3, { skipped: true });
  assert.ok(empty.every((decision) => decision.type === 'skip' && decision.reason === 'no-fresh-source'));
  brief.observe(strong({ frameId: 2 }));
  assert.equal(brief.accepted.length, 1);
});

test('a long capture interruption forgets the card being counted', () => {
  const long = autoScan();
  long.observe(strong({ frameId: 1 }));
  long.repeat(8, { skipped: true });
  long.observe(strong({ frameId: 2 }));
  assert.equal(long.accepted.length, 0);
  long.observe(strong({ frameId: 3 }));
  assert.equal(long.accepted.length, 1);
});

test('frames seen while text was being read count once the text is confirmed, with their real scores', () => {
  const scan = autoScan();
  const reading = (frameId) => moderate({ frameId, capturedAt: frameId * 250, minSimilarity: .9, recognitionEpoch: 'track-1',
    matched: false, reason: 'reading-text', textVerification: { status: 'pending' },
    visualCandidates: [{ id: card.id, similarity: .92, similarityGap: .06 }] });
  const proof = { status: 'confirmed', cardId: card.id, nameConfidence: 96, codeConfidence: 96, sourceFrameIds: [1, 2] };
  scan.feed(reading(1), reading(2));
  assert.equal(scan.accepted.length, 0);
  scan.observe({ ...reading(3), matched: true, reason: null, confirmationMethod: 'text', confirmationReason: 'name-number', textVerification: proof });
  assert.equal(scan.accepted.length, 1);
  assert.deepEqual(scan.accepted[0].consensus.sourceFrameIds, [1, 2, 3]);
  assert.equal(scan.accepted[0].consensus.durationMs, 500);
});

test('frames that deferred to text cannot seed a later artwork-only accept', () => {
  const scan = autoScan();
  const frame = (frameId, deferred) => strong({ frameId, capturedAt: frameId * 250, similarity: .94, minSimilarity: .9,
    requiresTextConfirmation: deferred, matched: !deferred, recognitionEpoch: 'same-track', confirmationMethod: 'artwork',
    textVerification: deferred ? { status: 'pending', artworkFallbackAllowed: true } : { status: 'unavailable' },
    visualCandidates: [{ id: card.id, similarity: .94, similarityGap: .08, localStructureSimilarity: .8 }] });
  scan.feed(frame(1, true), frame(2, true), frame(3, false), frame(4, false));
  assert.equal(scan.accepted.length, 0);
  scan.observe(frame(5, false));
  assert.equal(scan.accepted.length, 1);
  assert.deepEqual(scan.accepted[0].consensus.sourceFrameIds, [3, 4, 5]);
});

test('reset forgets the frames seen so far but keeps the duplicate lock', () => {
  const scan = autoScan();
  scan.observe(strong({ frameId: 5 }));
  scan.session.reset();
  const [first] = scan.feed(strong({ frameId: 5 }), strong({ frameId: 6 }));
  assert.equal(first.type, 'wait', 'the same frame id counts again after a reset');
  assert.equal(first.diagnostic.visualFrames, 1);
  assert.equal(scan.accepted.length, 1);
  scan.session.reset();
  scan.wait(POST_ADD_COOLDOWN_MS);
  scan.repeat(3, strong());
  assert.equal(scan.accepted.length, 1, 'still locked');
});

test('a new text reading track starts the count again', () => {
  const scan = autoScan();
  const tracked = (frameId, recognitionEpoch) => moderate({ frameId, recognitionEpoch, textVerification: { status: 'unavailable' } });
  scan.feed(tracked(1, 'track-1'), tracked(2, 'track-1'));
  const [restarted] = scan.feed(tracked(3, 'track-2'));
  assert.equal(restarted.diagnostic.visualFrames, 1);
  assert.deepEqual(restarted.diagnostic.sourceFrameIds, [3]);
});

test('text-reading frames older than two seconds are not reused', () => {
  const scan = autoScan();
  const reading = (frameId, capturedAt) => moderate({ frameId, capturedAt, minSimilarity: .9, recognitionEpoch: 'track-1',
    matched: false, reason: 'reading-text', textVerification: { status: 'pending' },
    visualCandidates: [{ id: card.id, similarity: .92, similarityGap: .06 }] });
  const proof = { status: 'confirmed', cardId: card.id, nameConfidence: 96, codeConfidence: 96, sourceFrameIds: [1, 2] };
  scan.feed(reading(1, 0), reading(2, 1000));
  const [decision] = scan.feed({ ...reading(3, 2500), matched: true, reason: null, confirmationMethod: 'text',
    confirmationReason: 'name-number', textVerification: proof });
  assert.equal(decision.type, 'wait');
  assert.deepEqual(decision.diagnostic.sourceFrameIds, [2, 3], 'frame 1 fell out of the two-second window');
});
