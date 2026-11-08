// PROTOTYPE ONLY: floating variant switcher for throwaway UI prototypes. Never merge.
import React, { useEffect } from 'react';

export function getPrototypeParam(name) {
  if (typeof window === 'undefined' || typeof URLSearchParams === 'undefined' || !window.location?.search) return null;
  return new URLSearchParams(window.location.search).get(name);
}

function setVariant(key) {
  const url = new URL(window.location.href);
  url.searchParams.set('variant', key);
  window.history.replaceState(null, '', url);
  window.dispatchEvent(new Event('prototype-variant'));
}

export function usePrototypeVariant(fallback = null) {
  const [variant, setState] = React.useState(() => getPrototypeParam('variant') ?? fallback);
  useEffect(() => {
    const update = () => setState(getPrototypeParam('variant') ?? fallback);
    window.addEventListener('prototype-variant', update);
    window.addEventListener('popstate', update);
    return () => { window.removeEventListener('prototype-variant', update); window.removeEventListener('popstate', update); };
  }, [fallback]);
  return variant;
}

export default function PrototypeSwitcher({ variants, current }) {
  const index = Math.max(0, variants.findIndex(v => v.key === current));
  const go = (step) => setVariant(variants[(index + step + variants.length) % variants.length].key);

  useEffect(() => {
    const onKey = (event) => {
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (event.key === 'ArrowLeft') go(-1);
      if (event.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!import.meta.env?.DEV) return null;
  const active = variants[index];
  return (
    <div className="fixed bottom-4 left-1/2 z-[200] flex -translate-x-1/2 items-center gap-2 rounded-full border-2 border-fuchsia-400 bg-fuchsia-950 px-2 py-1 text-sm font-semibold text-fuchsia-50 shadow-2xl">
      <button type="button" onClick={() => go(-1)} className="rounded-full px-2 hover:bg-fuchsia-800" aria-label="Previous variant">←</button>
      <span className="min-w-[12rem] text-center">PROTOTYPE {active.key} ({active.name})</span>
      <button type="button" onClick={() => go(1)} className="rounded-full px-2 hover:bg-fuchsia-800" aria-label="Next variant">→</button>
    </div>
  );
}
