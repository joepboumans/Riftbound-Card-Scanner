import React from 'react';

// New-print check result: offers the normal in-app card database update. Never downloads by itself.
export default function NewPrintNotice({ count, onUpdate, onLater, disabled = false }) {
  if (!count) return null;

  return (
    <div role="status" className="fixed top-3 left-1/2 z-40 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 items-center gap-3 rounded-2xl border border-gold-400/40 bg-rift-900/95 px-4 py-2 text-sm text-rift-100 shadow-lg backdrop-blur-sm">
      <span className="flex-1">{`${count} new ${count === 1 ? 'card' : 'cards'} available`}</span>
      <button onClick={onUpdate} disabled={disabled} className="btn-primary px-3 py-1">Update</button>
      <button onClick={onLater} className="btn-ghost px-3 py-1">Later</button>
    </div>
  );
}
