import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { CandidateTile, SearchTile } from './ChoiceStrip.jsx';
import { useChoiceKeys } from '../../hooks/useChoiceKeys.js';

// Snap review: pick the card for a Snap the scanner did not accept.
export default function ManualScanReview({ result, qualityWarning = false, onSelect, onSearch, onClose }) {
  const candidates = (result.reviewCandidates || []).slice(0, 3);
  useChoiceKeys(true, { count: candidates.length,
    pick: (rank) => onSelect(candidates[rank - 1], rank), search: onSearch, dismiss: onClose });

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-label="Confirm scanned card">
      <div className="w-full max-w-2xl max-h-[90dvh] overflow-y-auto rounded-2xl border border-gold-400/30 bg-rift-900 p-5 shadow-xl">
        <h2 className="text-lg font-semibold text-gold-300">Which card is this?</h2>
        <p className="mt-2 text-sm text-rift-300">
          {candidates.length ? 'Check the name and code, then choose the card you are holding.' : 'No close match was found. Search for the card you are holding.'}
        </p>
        {qualityWarning && (
          <p role="alert" className="mt-2 flex items-center gap-2 text-sm text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0" /> Image quality is low (blur/glare). Check the card carefully.
          </p>
        )}
        {result.textVerification?.status === 'conflict' && <p className="mt-2 text-sm text-amber-200">The printed text and image did not agree. Review the choice carefully.</p>}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {candidates.map((card, index) => <CandidateTile key={card.id} card={card} rank={index + 1} onPick={onSelect} className="bg-rift-800" />)}
          <SearchTile onSearch={onSearch} className="min-h-[6rem]" />
        </div>
        <button type="button" className="btn-secondary mt-4 w-full" onClick={onClose}>Cancel <span className="text-xs text-rift-400">(Esc)</span></button>
      </div>
    </div>
  );
}
