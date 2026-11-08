import React, { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import CardImage from '../CardImage.jsx';
import { getMatcher, resolveCardImageSource } from '../../lib/cardMatcher.js';
import { fullNameOf, resolveCardData } from '../../lib/cardData.js';
import { searchCards } from '../../lib/cardSearch.js';

// "Not these, search…": pick the card for a scan the scanner did not accept.
export default function CandidateSearch({ setFilter = 'all', onPick, onClose }) {
  const [query, setQuery] = useState('');
  const results = useMemo(() => {
    const matcher = getMatcher();
    return matcher.ready ? searchCards(matcher.cards, query, setFilter) : [];
  }, [query, setFilter]);

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[110] flex items-start justify-center bg-black/70 p-4 pt-[12dvh]" role="dialog" aria-modal="true" aria-label="Search for the scanned card" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-gold-400/30 bg-rift-900 p-4 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <h2 className="text-sm font-semibold text-gold-300">Which card is this?</h2>
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-rift-500" />
          <input type="text" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name or ID"
            className="w-full rounded-lg border border-rift-600/40 bg-rift-800/70 py-2 pl-9 pr-3 text-sm text-rift-100 placeholder-rift-500 outline-none focus:border-gold-400/50 focus:ring-1 focus:ring-gold-400/20" />
        </div>
        {query.trim().length < 2 && <p className="mt-2 text-[11px] text-rift-400">Type at least 2 characters</p>}
        {query.trim().length >= 2 && results.length === 0 && <p className="mt-2 text-[11px] text-rift-400">No cards found</p>}
        {results.length > 0 && (
          <div className="mt-2 max-h-[50dvh] space-y-1 overflow-y-auto">
            {results.map((card) => (
              <button key={card.id} type="button" onClick={() => onPick(resolveCardData(card))}
                className="flex w-full items-center gap-3 rounded-lg border border-rift-600/30 bg-rift-800/60 p-2 text-left hover:border-gold-400/40 hover:bg-rift-700/70">
                <CardImage src={resolveCardImageSource(card.imageUrl, card.id)} alt={fullNameOf(card)} className="h-12 w-9 shrink-0 rounded object-contain" loading="lazy" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-rift-100">{fullNameOf(card)}</span>
                  <span className="block text-[10px] uppercase tracking-wider text-rift-400">{card.code || card.id} · {card.setName || card.set}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        <button type="button" className="btn-secondary mt-3 w-full" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
