import React, { useEffect, useRef, useState } from 'react';
import { Brain, Download, Upload, Trash2 } from 'lucide-react';
import { getMatcher } from '../../lib/cardMatcher.js';
import { getLearnedReferences, summarizeLearnedReferences } from '../../lib/learnedReferences.js';

// Settings "Learned references": counts, Export backup, Import and Clear all.
// None of these bump `matcher.revision`.
export default function LearnedReferencesSettings() {
  const learned = getLearnedReferences();
  const fileInputRef = useRef(null);
  const [summary, setSummary] = useState(null);
  const [message, setMessage] = useState(null);

  const refresh = async () => {
    await learned.settled();
    const matcher = getMatcher();
    setSummary(summarizeLearnedReferences(learned.references(), { cards: matcher.cards, gridSize: matcher.gridSize }));
  };
  useEffect(() => { refresh(); }, []);

  const exportBackup = async () => {
    await learned.settled();
    const backup = learned.exportBackup({ gridSize: getMatcher().gridSize });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
    link.download = `riftbound-learned-references-${new Date().toISOString().slice(0, 10)}.json`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => { URL.revokeObjectURL(link.href); document.body.removeChild(link); }, 100);
    setMessage(`Exported ${backup.records.length} learned references`);
  };

  const importBackup = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const merged = await learned.importBackup(JSON.parse(await file.text()));
      setMessage(`Imported ${merged} learned references`);
    } catch (error) {
      setMessage(`Could not import: ${error?.message || error}`);
    }
    await refresh();
  };

  const clearAll = async () => {
    if (!confirm('Delete all learned references? Scanning falls back to the official card images only.')) return;
    learned.clear();
    setMessage('Cleared all learned references');
    await refresh();
  };

  return (
    <section className="rounded-2xl bg-rift-800/60 border border-rift-600/20 p-5 space-y-4">
      <h2 className="text-sm font-semibold text-rift-100 flex items-center gap-2">
        <Brain className="w-4 h-4 text-gold-400" />
        Learned references
      </h2>
      <p className="text-xs text-rift-400 leading-relaxed">
        Artwork saved from cards you picked yourself, so the scanner recognizes your copies better. No photos are kept.
      </p>
      <div className="rounded-xl border border-rift-600/20 bg-rift-950/40 px-3 py-2 text-xs text-rift-400">
        {summary
          ? <>
            <span className="text-rift-200">{summary.references}</span> references for <span className="text-rift-200">{summary.cards}</span> cards
            {summary.unused > 0 && <> · <span className="text-rift-200">{summary.unused}</span> unused</>}
          </>
          : 'Loading…'}
      </div>
      {message && <p className="text-[11px] text-rift-300">{message}</p>}
      <div className="grid gap-2 sm:grid-cols-3">
        <button type="button" onClick={exportBackup} disabled={!summary?.references}
          className="btn-ghost w-full rounded-xl py-3 text-sm flex items-center justify-center gap-2">
          <Download className="w-4 h-4" />
          Export backup
        </button>
        <button type="button" onClick={() => fileInputRef.current?.click()}
          className="btn-ghost w-full rounded-xl py-3 text-sm flex items-center justify-center gap-2">
          <Upload className="w-4 h-4" />
          Import
        </button>
        <button type="button" onClick={clearAll} disabled={!summary?.references}
          className="btn-ghost w-full rounded-xl py-3 text-sm flex items-center justify-center gap-2 text-red-400 hover:text-red-300">
          <Trash2 className="w-4 h-4" />
          Clear all
        </button>
      </div>
      <input ref={fileInputRef} type="file" accept="application/json,.json" className="hidden" onChange={importBackup} />
    </section>
  );
}
