import { createCardEntry } from './collection.js';
import { emitScanDiagnostic } from './scanDiagnostics.js';
import { getLearnedReferences } from './learnedReferences.js';

// A user-confirmed scan: the user vouches for the card, so no acceptance rule
// is applied. `rank` is 1-3 for a candidate, null for a card picked by search.
export function createUserConfirmedEntry(scan, card, { from, rank = null }, defaults = {}) {
  const { sim, similarity, ...cardData } = card;
  return createCardEntry({
    cardData,
    confidence: scan?.confidence,
    similarity: rank ? similarity ?? null : null,
    scanTimestamp: Date.now(),
    userConfirmed: true,
    confirmedFrom: from,
    candidateRank: rank,
    topCandidateId: scan?.reviewCandidates?.[0]?.id ?? scan?.cardData?.id ?? null,
  }, defaults);
}

// Hand-off point to learned references, which decide whether the crop is
// clear enough to save. Returns the id of the learned reference it saved, or
// null, so the pending row can undo it later.
export function onUserConfirmed(confirmation) {
  emitScanDiagnostic('user-confirmed', confirmation);
  return getLearnedReferences().save({ cardId: confirmation.card?.id, artwork: confirmation.artwork });
}

export const CHOICE_STRIP_HOLD_MS = 3000;
export const CHOICE_STRIP_INITIAL = Object.freeze({ candidates: null, scan: null, seenAt: 0, live: false, frozen: false, suppressedIds: [], confirmingId: null });

// The top three candidates of a detection. While the scanner is confirming a
// card (a matched frame), that card is always among them.
function offeredCandidates(detection) {
  const candidates = detection.reviewCandidates || [];
  if (detection.matched && detection.cardData?.id && !candidates.slice(0, 3).some((card) => card.id === detection.cardData.id))
    return [{ ...detection.cardData, similarity: detection.similarity }, ...candidates].slice(0, 3);
  return candidates.length ? candidates.slice(0, 3) : null;
}

// Choice strip state, driven by each published detection. It offers the top
// three candidates of a card the scanner has not accepted (marking the one it
// is confirming, if any), holds them
// for CHOICE_STRIP_HOLD_MS after that card leaves the frame, and freezes while
// the pointer is over the strip.
export function choiceStripReducer(state, event) {
  switch (event.type) {
    case 'observe': {
      const detection = event.detection;
      // The card left the frame: it may be offered again.
      if (!detection?.box) state = { ...state, suppressedIds: [] };
      const offered = detection?.box ? offeredCandidates(detection) : null;
      if (!offered || state.suppressedIds.includes(detection.matched ? detection.cardData.id : offered[0].id))
        return { ...state, live: false, confirmingId: null, seenAt: state.live ? event.now : state.seenAt };
      const confirmingId = detection.matched ? detection.cardData.id : null;
      if (state.frozen && state.candidates) return { ...state, confirmingId };
      return { ...state, candidates: offered, scan: detection, seenAt: event.now, live: true, confirmingId };
    }
    case 'pointer':
      // Leaving restarts the hold countdown.
      return { ...state, frozen: event.over, seenAt: event.over ? state.seenAt : event.now };
    case 'confirmed':
    case 'dismiss':
      return { ...state, candidates: null, scan: null, live: false, frozen: false, confirmingId: null,
        suppressedIds: state.candidates ? [...state.suppressedIds, state.candidates[0].id] : state.suppressedIds };
    case 'added': {
      const suppressed = { ...state, suppressedIds: [...state.suppressedIds, event.cardId] };
      // The scanner got the card the strip was showing: nothing left to pick.
      const shown = state.confirmingId === event.cardId || state.candidates?.[0]?.id === event.cardId;
      return shown ? { ...suppressed, candidates: null, scan: null, live: false, frozen: false, confirmingId: null } : suppressed;
    }
    default:
      return state;
  }
}

export function choiceStripView(state, now) {
  const expired = !state.live && !state.frozen && now - state.seenAt > CHOICE_STRIP_HOLD_MS;
  if (!state.candidates || expired) return { candidates: null, scan: null, remainingMs: null, confirmingId: null };
  return { candidates: state.candidates, scan: state.scan, confirmingId: state.live || state.frozen ? state.confirmingId : null,
    remainingMs: state.live || state.frozen ? null : Math.max(0, CHOICE_STRIP_HOLD_MS - (now - state.seenAt)) };
}

const isTypingTarget = (target) => Boolean(target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable));

// Keys shared by the Choice strip and Snap review. `count` is how many
// candidates are shown; search is always available.
export function choiceKeyAction(event, { count }) {
  if (isTypingTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === 'Escape') return { type: 'dismiss' };
  if (event.key === 's' || event.key === 'S') return { type: 'search' };
  const rank = event.key === 'Enter' ? 1 : ['1', '2', '3'].indexOf(event.key) + 1;
  return rank > 0 && rank <= count ? { type: 'pick', rank } : null;
}
