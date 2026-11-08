import React, { useEffect, useState } from 'react';
import CardImage from '../CardImage.jsx';
import { resolveCardImageSource } from '../../lib/cardMatcher.js';
import { CHOICE_STRIP_HOLD_MS, CHOICE_STRIP_INITIAL, choiceStripReducer, choiceStripView } from '../../lib/userConfirmation.js';
import { useChoiceKeys } from '../../hooks/useChoiceKeys.js';

const percent = (card) => `${Math.round((card.similarity ?? 0) * 100)}%`;

export function ChoiceKey({ children }) {
  return <kbd className="rounded border border-white/30 bg-white/10 px-1 text-[10px] font-semibold text-white/80">{children}</kbd>;
}

// One candidate tile, shared with Snap review.
export function CandidateTile({ card, rank, onPick, confirming = false, className = '' }) {
  const border = confirming ? 'border-emerald-400 ring-2 ring-emerald-400/60 animate-pulse'
    : rank === 1 ? 'border-gold-400/70 bg-gold-500/10' : 'border-white/15';
  return (
    <button type="button" onClick={() => onPick(card, rank)} aria-label={`Use ${card.name} ${card.code || card.id}`}
      className={`relative rounded-xl border p-2 text-left hover:border-gold-400 ${border} ${className}`}>
      {confirming && <span className="absolute left-1 top-1 rounded bg-emerald-500/90 px-1 text-[10px] font-semibold text-black">Confirming</span>}
      <span className="absolute right-1 top-1"><ChoiceKey>{rank === 1 ? '1 / Enter' : rank}</ChoiceKey></span>
      <CardImage src={resolveCardImageSource(card.imageUrl, card.id)} alt={card.name} className="mx-auto h-32 rounded-md object-contain" />
      <span className="mt-1 block truncate text-xs font-semibold text-white">{card.name}</span>
      <span className="block truncate text-[10px] text-rift-300">{card.code || card.id}</span>
      <span className="mt-1 block h-1 rounded bg-white/10"><span className="block h-full rounded bg-gold-400" style={{ width: percent(card) }} /></span>
      <span className="block text-[10px] text-rift-300">{percent(card)} match</span>
      {card.fromLearnedReference && <span className="block truncate text-[10px] text-gold-300">from your scans</span>}
    </button>
  );
}

export function SearchTile({ onSearch, className = '' }) {
  return (
    <button type="button" onClick={onSearch} className={`rounded-xl border border-dashed border-white/20 p-2 text-xs text-rift-200 hover:border-gold-400 ${className}`}>
      Not these, search… <ChoiceKey>S</ChoiceKey>
    </button>
  );
}

// The picker over the live camera view for a card the scanner has not
// accepted. While the scanner is confirming a card it stays up and marks that
// card. Shown only while `enabled` (auto scan on, never fake or debug).
export default function ChoiceStrip({ enabled, detection, lastAddedCardId, lastAddedAt, onPick, onSearch }) {
  const [state, setState] = useState(CHOICE_STRIP_INITIAL);
  const [, setTick] = useState(0);
  const dispatch = (event) => setState((previous) => choiceStripReducer(previous, event));

  useEffect(() => { if (!enabled) setState(CHOICE_STRIP_INITIAL); }, [enabled]);
  useEffect(() => { if (enabled) dispatch({ type: 'observe', detection, now: Date.now() }); }, [enabled, detection]);
  useEffect(() => { if (lastAddedCardId) dispatch({ type: 'added', cardId: lastAddedCardId, now: Date.now() }); }, [lastAddedCardId, lastAddedAt]);

  const view = enabled ? choiceStripView(state, Date.now()) : { candidates: null };
  const counting = view.remainingMs != null;
  useEffect(() => {
    if (!counting) return undefined;
    // Re-render for the countdown bar; the strip hides when it runs out.
    const timer = setInterval(() => setTick((tick) => tick + 1), 100);
    return () => clearInterval(timer);
  }, [counting]);

  const visible = Boolean(view.candidates);

  const pick = (card, rank) => { onPick(view.scan, card, rank); dispatch({ type: 'confirmed', now: Date.now() }); };
  const search = () => { onSearch(view.scan); dispatch({ type: 'dismiss', now: Date.now() }); };
  useChoiceKeys(visible, { count: view.candidates?.length || 0,
    pick: (rank) => pick(view.candidates[rank - 1], rank), search,
    dismiss: () => dispatch({ type: 'dismiss', now: Date.now() }) });

  if (!visible) return null;
  return (
    <div role="dialog" aria-label="Which card is this?" onClick={(event) => event.stopPropagation()}
      onPointerEnter={() => dispatch({ type: 'pointer', over: true, now: Date.now() })}
      onPointerLeave={() => dispatch({ type: 'pointer', over: false, now: Date.now() })}
      className={`absolute bottom-16 left-1/2 z-40 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-2xl border ${view.confirmingId ? 'border-emerald-400/50' : 'border-amber-400/40'} bg-black/80 p-3 text-white shadow-xl backdrop-blur-sm`}>
      <div role="status" aria-live="polite" className={`mb-2 text-center text-xs font-semibold ${view.confirmingId ? 'text-emerald-300' : 'text-amber-300'}`}>
        {view.confirmingId ? 'Locking on… hold steady, or pick the card yourself' : 'Which card is this?'}
      </div>
      <div className="flex gap-2 overflow-x-auto">
        {view.candidates.map((card, index) => <CandidateTile key={card.id} card={card} rank={index + 1} onPick={pick}
          confirming={card.id === view.confirmingId} className="w-28 shrink-0" />)}
        <SearchTile onSearch={search} className="w-20 shrink-0" />
      </div>
      {counting && (
        <div className="mt-2 h-1 overflow-hidden rounded bg-white/10" aria-hidden="true">
          <div className="h-full bg-gold-400" style={{ width: `${(view.remainingMs / CHOICE_STRIP_HOLD_MS) * 100}%` }} />
        </div>
      )}
    </div>
  );
}
