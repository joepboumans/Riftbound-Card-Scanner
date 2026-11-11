import { isReliableScanResult } from './scanQuality.js';
import { hasLocalArtworkSupport } from './localArtwork.js';
import { hasStrongVisualProof } from './cardVisualProof.js';
import { hasRuneArtwork, hasRuneTextArtwork } from './cardRuneVerification.js';

export const POST_ACCEPT_COOLDOWN_MS = 1000;
const TEXT_FRAME_WINDOW_MS = 2000;
const MAX_TRACKED_FRAMES = 8;
const MISS_LIMIT = 4;
const INTERRUPTION_MS = 1500;

/**
 * Decides, frame by frame, when auto scan has seen a card often enough to
 * accept it. It has no timers and no side effects: the caller feeds it each
 * scan outcome with the time, and acts on the decision.
 *
 *   observe(outcome, now, { validate, locking }) returns one of
 *     { type: 'skip', reason, diagnostic }   the frame does not count
 *     { type: 'wait', reason, diagnostic }   it counts; more frames are needed
 *     { type: 'accept', cardId, visualFrames, consensus }
 *   each with `best`: the best outcome of the card being counted, null once
 *   counting stopped, or undefined when unchanged.
 *     validate: the caller's own check on an outcome (default: none)
 *     locking: apply the duplicate lock and the cooldown (default: true)
 *   lock(cardId, now)  the card was added: do not accept it again until a
 *                      different card is accepted, and pause before the next
 *   unlock()           forget the duplicate lock and the cooldown
 *   reset()            forget every frame seen so far; the lock stays
 */
export function createAutoScanSession() {
  // The run of frames of one card that is being counted towards acceptance.
  let run = null;
  let lockedCardId = null;
  let cooldownUntil = 0;
  let lastFrameId = null;
  // Frames seen while text was being read, reusable once the text is confirmed.
  let textFrames = { key: null, frames: [] };

  function observe(outcome, now, { validate = () => true, locking = true } = {}) {
    let best;
    const stopCounting = () => { run = null; best = null; };
    const decide = (type, diagnostic, extra = {}) => ({ type, reason: diagnostic?.reason, diagnostic, best, ...extra });

    if (outcome?.skipped) {
      if (run && !run.committed && now - run.lastSeenAt > INTERRUPTION_MS) stopCounting();
      return decide('skip', { reason: 'no-fresh-source' });
    }
    // A buffered image is one observation, even if it is selected twice.
    if (outcome?.frameId != null) {
      if (lastFrameId != null && outcome.frameId <= lastFrameId) return decide('skip', { frameId: outcome.frameId, reason: 'repeated-source' });
      lastFrameId = outcome.frameId;
    }
    if (outcome?.textVerification && outcome.frameId != null && outcome.quality?.acceptable) {
      if (textFrames.key !== outcome.recognitionEpoch) {
        textFrames.key = outcome.recognitionEpoch; textFrames.frames = [];
        if (run && !run.committed) stopCounting();
      }
      textFrames.frames.push({ frameId: outcome.frameId, at: outcome.capturedAt ?? now,
        candidates: outcome.visualCandidates || [], runeArtwork: outcome.visualVerification,
        geometryConflict: outcome.geometryConflict, requiresTextConfirmation: outcome.requiresTextConfirmation });
      // Compare capture times. Inference latency must not consume the
      // freshness window between independent camera observations.
      const capturedAt = outcome.capturedAt ?? now;
      textFrames.frames = textFrames.frames.filter((f) => capturedAt >= f.at && capturedAt - f.at <= TEXT_FRAME_WINDOW_MS).slice(-MAX_TRACKED_FRAMES);
    } else { textFrames.frames = []; textFrames.key = null; }

    if (!isReliableScanResult(outcome) || !validate(outcome)) {
      if (run) {
        run.misses++;
        run.consecutive = 0;
        run.fastConsecutive = 0;
        run.geometryConsecutive = 0;
        run.sourceFrameIds = [];
        if (run.misses >= MISS_LIMIT) stopCounting();
      }
      return decide('skip', { frameId: outcome?.frameId, cardId: outcome?.cardData?.id, reason: outcome?.reason || 'no-eligible-result' });
    }
    const cardId = outcome.cardData.id;
    if (locking && lockedCardId === cardId) {
      if (run?.committed) run.misses = 0;
      return decide('skip', { frameId: outcome.frameId, cardId, reason: 'duplicate-card-lock' });
    }
    if (run?.committed) stopCounting();
    if (locking && !run && now < cooldownUntil && !hasStrongVisualProof(outcome) && outcome.confirmationMethod !== 'rune-text')
      return decide('skip', { frameId: outcome.frameId, cardId, reason: 'cooldown', remainingMs: cooldownUntil - now });

    const qualityScore = Number.isFinite(outcome.quality.score) ? outcome.quality.score : 0.5;
    const score = outcome.similarity * 0.65 + qualityScore * 0.25 + outcome.confidence * 0.1;
    if (!run || run.cardId !== cardId || run.recognitionEpoch !== outcome.recognitionEpoch || (hasStrongVisualProof(outcome) && now - run.lastSeenAt > 1000)) {
      run = { cardId, recognitionEpoch: outcome.recognitionEpoch, firstSeenAt: now, lastSeenAt: now, hits: 0, consecutive: 0,
        fastConsecutive: 0, geometryConsecutive: 0, sourceFrameIds: [], misses: 0, committed: false, bestScore: -1 };
      // Reuse actual visual observations gathered while OCR was pending.
      // Text callbacks and preprocessing retries never increment this count.
      if (outcome.confirmationMethod === 'rune-text' && hasRuneTextArtwork(outcome.textVerification, cardId)) {
        const sources = outcome.textVerification.sourceFrameIds.filter((id) => id !== outcome.frameId);
        run.sourceFrameIds = [...new Set(sources)]; run.hits = run.consecutive = run.sourceFrameIds.length;
      } else if (outcome.textVerification && !hasStrongVisualProof(outcome)) {
        const eligible = [];
        for (let i = textFrames.frames.length - 1; i >= 0; i--) {
          const f = textFrames.frames[i], candidate = f.candidates.find((c) => c.id === cardId);
          const runeText = outcome.confirmationMethod === 'rune-text' && !f.geometryConflict && hasRuneArtwork(f.runeArtwork, cardId, f.frameId);
          const localText = ['name-number-local-artwork', 'name-number-aligned-artwork'].includes(outcome.confirmationReason) && hasLocalArtworkSupport(candidate);
          if (!candidate || (!runeText && !localText && candidate.similarity < outcome.minSimilarity) ||
            (!runeText && outcome.confirmationMethod !== 'text' && (f.geometryConflict || f.requiresTextConfirmation || candidate.similarityGap < .05))) break;
          eligible.unshift(f);
        }
        if (eligible.length) {
          run.firstSeenAt = eligible[0].at; run.hits = eligible.length - 1; run.consecutive = eligible.length - 1;
          run.sourceFrameIds = eligible.slice(0, -1).map((value) => value.frameId);
        }
      }
    }
    run.hits++;
    run.consecutive++;
    run.fastConsecutive = outcome.similarity >= .96 && outcome.similarityGap >= .07 ? (run.fastConsecutive || 0) + 1 : 0;
    run.geometryConsecutive = hasStrongVisualProof(outcome) && outcome.frameId != null ? (run.geometryConsecutive || 0) + 1 : 0;
    if (outcome.frameId != null) run.sourceFrameIds = [...(run.sourceFrameIds || []), outcome.frameId].slice(-MAX_TRACKED_FRAMES);
    run.misses = 0;
    run.lastSeenAt = now;
    if (outcome.textVerification || score >= run.bestScore) { run.bestResult = outcome; run.bestScore = score; }
    best = run.bestResult;
    const fastReady = run.fastConsecutive >= 2 || run.geometryConsecutive >= 2 || (outcome.confirmationMethod === 'rune-text' && run.consecutive >= 2);
    const stableReady = run.consecutive >= 3 && now - run.firstSeenAt >= 500;
    if (!fastReady && !stableReady)
      return decide('wait', { frameId: outcome.frameId, cardId, reason: 'collecting-visual-frames', visualFrames: run.consecutive, sourceFrameIds: run.sourceFrameIds });
    // Repetition can strengthen an unambiguous match, never promote an
    // ambiguous/poor-quality candidate into a valid match.
    return decide('accept', null, { cardId, visualFrames: run.consecutive,
      consensus: { hits: run.hits, matchedHits: run.hits, aggregateScore: run.bestScore, consecutiveHits: run.consecutive,
        sourceFrameIds: run.sourceFrameIds, durationMs: Math.max(0, now - run.firstSeenAt) } });
  }

  function lock(cardId, now) {
    cooldownUntil = now + POST_ACCEPT_COOLDOWN_MS;
    lockedCardId = cardId;
    run = { cardId, committed: true, misses: 0, consecutive: 0, fastConsecutive: 0, sourceFrameIds: [] };
  }

  function unlock() {
    cooldownUntil = 0;
    lockedCardId = null;
  }

  function reset() {
    run = null;
    lastFrameId = null;
    textFrames = { key: null, frames: [] };
  }

  return { observe, lock, unlock, reset };
}
