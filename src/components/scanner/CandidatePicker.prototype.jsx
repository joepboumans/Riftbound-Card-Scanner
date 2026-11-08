// PROTOTYPE ONLY (throwaway branch prototype/overlay-candidate-picker). Never merge.
// Question: how should the live overlay let you pick a candidate the scanner won't accept?
// Three variants of the picker on the real scan screen, switchable via ?variant=A|B|C.
// Add &stub=1 to use fake candidates (three real Kai'Sa prints) without holding a card.
// Accepting is stubbed: it only records what *would* be added.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CardImage from '../CardImage.jsx';
import { resolveCardImageSource } from '../../lib/cardMatcher.js';
import PrototypeSwitcher, { getPrototypeParam, usePrototypeVariant } from '../PrototypeSwitcher.jsx';

const HOLD_MS = 3000;
const TRAY_MS = 30000;
const VARIANTS = [
  { key: 'A', name: 'Expanded preview' },
  { key: 'B', name: 'Choice strip' },
  { key: 'C', name: 'Unconfirmed tray' },
];

const STUB_SETS = [
  [{ id: 'rad-sp4-005', name: "Kai'Sa", code: 'RAD-SP4/005', similarity: 0.81 },
    { id: 'ogn-039a-298', name: "Kai'Sa", code: 'OGN-039a/298', similarity: 0.78 },
    { id: 'ogn-039-298', name: "Kai'Sa", code: 'OGN-039/298', similarity: 0.74 }],
  [{ id: 'ogn-039a-298', name: "Kai'Sa", code: 'OGN-039a/298', similarity: 0.8 },
    { id: 'rad-sp4-005', name: "Kai'Sa", code: 'RAD-SP4/005', similarity: 0.79 },
    { id: 'ogn-039-298', name: "Kai'Sa", code: 'OGN-039/298', similarity: 0.72 }],
];

const pct = (c) => `${Math.round((c.similarity ?? 0) * 100)}%`;
const img = (c) => resolveCardImageSource(c.imageUrl, c.id);

function liveCandidates(detection) {
  if (!detection?.box || detection.matched || !detection.prototypeTop3?.length) return null;
  return detection.prototypeTop3.slice(0, 3);
}

// Keeps the last candidate set on screen for HOLD_MS after the card leaves the frame,
// and freezes it while the pointer is over the picker.
function useHeldCandidates(live, locked, skipTopId) {
  const [held, setHeld] = useState(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 100); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (live && live[0].id !== skipTopId) {
      if (!locked) setHeld({ candidates: live, seenAt: Date.now() });
      else setHeld(h => h && { ...h, seenAt: Date.now() });
    }
  }, [live, locked, skipTopId]);
  // Restart the hold countdown when the pointer leaves the picker.
  useEffect(() => { if (!locked) setHeld(h => h && { ...h, seenAt: Date.now() }); }, [locked]);
  const liveNow = Boolean(live && live[0].id !== skipTopId);
  const expired = held && !liveNow && !locked && now - held.seenAt > HOLD_MS;
  useEffect(() => { if (expired) setHeld(null); }, [expired]);
  const current = expired ? null : held;
  return {
    candidates: current?.candidates ?? null,
    phase: !current ? 'none' : liveNow ? 'live' : locked ? 'locked' : 'held',
    remainingMs: current && !liveNow ? Math.max(0, HOLD_MS - (now - current.seenAt)) : null,
    clear: () => setHeld(null),
  };
}

function HoldBar({ remainingMs }) {
  if (remainingMs == null) return null;
  return <div className="mt-2 h-1 overflow-hidden rounded bg-white/10"><div className="h-full bg-gold-400" style={{ width: `${(remainingMs / HOLD_MS) * 100}%` }} /></div>;
}

function Key({ children }) {
  return <kbd className="rounded border border-white/30 bg-white/10 px-1 text-[10px] font-semibold text-white/80">{children}</kbd>;
}

// A: the existing tracked-card preview grows an "Add this card" button and a fold-out for #2/#3.
function VariantA({ candidates, remainingMs, onAccept, onSearch, hoverProps }) {
  const [open, setOpen] = useState(false);
  const [top, ...rest] = candidates;
  return (
    <div {...hoverProps} className="absolute bottom-3 left-3 z-40 w-[18rem] rounded-xl border border-amber-400/40 bg-black/80 p-3 text-white shadow-lg backdrop-blur-sm">
      <div className="text-[10px] font-semibold text-amber-300">Not sure about this card</div>
      <div className="mt-2 flex gap-3">
        <CardImage src={img(top)} alt={top.name} className="h-24 w-16 shrink-0 rounded-md object-contain" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{top.name}</div>
          <div className="text-[10px] text-rift-300">{top.code} · {pct(top)} match</div>
          <button type="button" onClick={() => onAccept(top, 1)} className="mt-2 w-full rounded-lg bg-gold-500 px-2 py-1.5 text-xs font-bold text-rift-900 hover:bg-gold-400">Add this card <Key>Enter</Key></button>
        </div>
      </div>
      <button type="button" onClick={() => setOpen(o => !o)} className="mt-2 text-[11px] text-rift-200 underline">{open ? 'Hide' : 'Show'} other matches ({rest.length})</button>
      {open && (
        <div className="mt-2 space-y-1">
          {rest.map((c, i) => (
            <button key={c.id} type="button" onClick={() => onAccept(c, i + 2)} className="flex w-full items-center gap-2 rounded-lg border border-white/10 p-1 text-left hover:border-gold-400">
              <CardImage src={img(c)} alt={c.name} className="h-10 w-7 rounded object-contain" />
              <span className="flex-1 text-xs">{c.name} <span className="text-rift-300">{c.code}</span></span>
              <span className="text-[10px] text-rift-300">{pct(c)}</span><Key>{i + 2}</Key>
            </button>
          ))}
          <button type="button" onClick={onSearch} className="w-full rounded-lg border border-dashed border-white/20 p-1 text-xs text-rift-200 hover:border-gold-400">Not these, search… <Key>S</Key></button>
        </div>
      )}
      <HoldBar remainingMs={remainingMs} />
    </div>
  );
}

// B: all three candidates side by side at equal weight, centred over the video.
function VariantB({ candidates, remainingMs, onAccept, onSearch, hoverProps }) {
  return (
    <div {...hoverProps} className="absolute bottom-16 left-1/2 z-40 -translate-x-1/2 rounded-2xl border border-amber-400/40 bg-black/80 p-3 text-white shadow-xl backdrop-blur-sm">
      <div className="mb-2 text-center text-xs font-semibold text-amber-300">Which card is this?</div>
      <div className="flex gap-2">
        {candidates.map((c, i) => (
          <button key={c.id} type="button" onClick={() => onAccept(c, i + 1)} className={`relative w-28 rounded-xl border p-2 text-left hover:border-gold-400 ${i === 0 ? 'border-gold-400/70 bg-gold-500/10' : 'border-white/15'}`}>
            <span className="absolute right-1 top-1"><Key>{i === 0 ? '1 / Enter' : i + 1}</Key></span>
            <CardImage src={img(c)} alt={c.name} className="mx-auto h-32 rounded-md object-contain" />
            <div className="mt-1 truncate text-xs font-semibold">{c.name}</div>
            <div className="truncate text-[10px] text-rift-300">{c.code}</div>
            <div className="mt-1 h-1 rounded bg-white/10"><div className="h-full rounded bg-gold-400" style={{ width: pct(c) }} /></div>
            <div className="text-[10px] text-rift-300">{pct(c)}</div>
          </button>
        ))}
        <button type="button" onClick={onSearch} className="w-20 rounded-xl border border-dashed border-white/20 p-2 text-xs text-rift-200 hover:border-gold-400">Not these, search… <Key>S</Key></button>
      </div>
      <HoldBar remainingMs={remainingMs} />
    </div>
  );
}

// C: unconfirmed candidates pile up in a side tray; scanning carries on and you confirm later.
function VariantC({ tray, onAccept, onSearch, onDismiss, hoverProps }) {
  const [openId, setOpenId] = useState(null);
  return (
    <div {...hoverProps} className="absolute right-3 top-3 bottom-16 z-40 flex w-[17rem] flex-col rounded-xl border border-amber-400/40 bg-black/80 p-2 text-white shadow-xl backdrop-blur-sm">
      <div className="px-1 text-xs font-semibold text-amber-300">Unconfirmed ({tray.length})</div>
      <div className="mt-2 flex-1 space-y-2 overflow-y-auto">
        {tray.length === 0 && <div className="px-1 text-[11px] text-rift-300">Cards the scanner can't confirm will wait here for 30 s.</div>}
        {tray.map((item, idx) => {
          const [top, ...rest] = item.candidates;
          return (
            <div key={item.key} className="rounded-lg border border-white/10 p-2">
              <div className="flex items-center gap-2">
                <CardImage src={img(top)} alt={top.name} className="h-14 w-10 rounded object-contain" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-semibold">{top.name}</div>
                  <div className="text-[10px] text-rift-300">{top.code} · {pct(top)}</div>
                  <div className="text-[10px] text-rift-400">{Math.round((Date.now() - item.at) / 1000)} s ago</div>
                </div>
                <div className="flex flex-col gap-1">
                  <button type="button" onClick={() => onAccept(top, 1, item.key)} className="rounded bg-gold-500 px-2 py-0.5 text-[11px] font-bold text-rift-900">Add{idx === 0 && <> <Key>Enter</Key></>}</button>
                  <button type="button" onClick={() => onDismiss(item.key)} className="text-[10px] text-rift-300 underline">Skip</button>
                </div>
              </div>
              <button type="button" onClick={() => setOpenId(openId === item.key ? null : item.key)} className="mt-1 text-[10px] text-rift-200 underline">{openId === item.key ? 'Hide' : 'Other matches'}</button>
              {openId === item.key && (
                <div className="mt-1 space-y-1">
                  {rest.map((c, i) => (
                    <button key={c.id} type="button" onClick={() => onAccept(c, i + 2, item.key)} className="flex w-full items-center gap-2 rounded border border-white/10 p-1 text-left text-[11px] hover:border-gold-400">
                      <CardImage src={img(c)} alt={c.name} className="h-8 w-6 rounded object-contain" />
                      <span className="flex-1 truncate">{c.code}</span><span className="text-rift-300">{pct(c)}</span>
                    </button>
                  ))}
                  <button type="button" onClick={() => onSearch(item.key)} className="w-full rounded border border-dashed border-white/20 p-1 text-[11px] text-rift-200">Not these, search…</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function CandidatePickerPrototype({ lastDetection }) {
  const variant = usePrototypeVariant('A');
  const stub = getPrototypeParam('stub') === '1';
  const [stubInFrame, setStubInFrame] = useState(true);
  const [stubSet, setStubSet] = useState(0);
  const [hovering, setHovering] = useState(false);
  const [lastAction, setLastAction] = useState('none');
  const [addedId, setAddedId] = useState(null); // mirrors the duplicate lock after adding
  const [tray, setTray] = useState([]);

  const live = useMemo(() => (stub ? (stubInFrame ? STUB_SETS[stubSet] : null) : liveCandidates(lastDetection)),
    [stub, stubInFrame, stubSet, lastDetection]);
  // Duplicate lock releases once that card leaves the frame.
  useEffect(() => { if (!live && addedId) setAddedId(null); }, [live, addedId]);
  const held = useHeldCandidates(live, hovering, addedId);

  // Variant C: collect unconfirmed sets into the tray, one entry per top candidate.
  useEffect(() => {
    if (variant !== 'C' || !live || live[0].id === addedId) return;
    setTray(t => [{ key: live[0].id, candidates: live, at: Date.now() }, ...t.filter(i => i.key !== live[0].id)].slice(0, 5));
  }, [variant, live, addedId]);
  useEffect(() => {
    const t = setInterval(() => setTray(items => items.filter(i => Date.now() - i.at < TRAY_MS)), 1000);
    return () => clearInterval(t);
  }, []);

  const accept = useCallback((card, rank, trayKey) => {
    setLastAction(`Would add ${card.name} ${card.code} as user-confirmed (rank ${rank}, ${pct(card)})`);
    setAddedId(live?.[0]?.id ?? card.id);
    held.clear();
    if (trayKey) setTray(t => t.filter(i => i.key !== trayKey));
  }, [live, held]);
  const search = useCallback((trayKey) => {
    setLastAction('Would open manual search for this card');
    if (typeof trayKey === 'string') setTray(t => t.filter(i => i.key !== trayKey));
  }, []);

  const keyRef = useRef();
  keyRef.current = { variant, held, tray, accept, search };
  useEffect(() => {
    const onKey = (event) => {
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const { variant: v, held: h, tray: tr, accept: acc, search: srch } = keyRef.current;
      const set = v === 'C' ? tr[0]?.candidates : h.candidates;
      if (!set) return;
      const trayKey = v === 'C' ? tr[0].key : undefined;
      if (event.key === 'Enter') { event.preventDefault(); acc(set[0], 1, trayKey); }
      if (['1', '2', '3'].includes(event.key) && set[Number(event.key) - 1]) acc(set[Number(event.key) - 1], Number(event.key), trayKey);
      if (event.key.toLowerCase() === 's') srch(trayKey);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const hoverProps = { onPointerEnter: () => setHovering(true), onPointerLeave: () => setHovering(false), onClick: e => e.stopPropagation() };
  const shared = { candidates: held.candidates, remainingMs: held.remainingMs, onAccept: accept, onSearch: search, hoverProps };

  return (
    <>
      {variant === 'A' && held.candidates && <VariantA {...shared} />}
      {variant === 'B' && held.candidates && <VariantB {...shared} />}
      {variant === 'C' && <VariantC tray={tray} onAccept={accept} onSearch={search} onDismiss={k => setTray(t => t.filter(i => i.key !== k))} hoverProps={hoverProps} />}

      {/* State panel: prototype-only, shows what the picker is doing */}
      <div onClick={e => e.stopPropagation()} className={`absolute top-3 z-50 w-[16rem] rounded-lg border-2 border-fuchsia-400 bg-fuchsia-950/90 p-2 font-mono text-[10px] text-fuchsia-50 ${variant === 'C' ? 'left-3' : 'right-3'}`}>
        <div className="font-bold">PROTOTYPE STATE</div>
        <div>source: {stub ? 'stub' : 'live matcher'}</div>
        <div>live candidate: {live ? `${live[0].code} ${pct(live[0])}` : 'none'}{!stub && lastDetection?.matched ? ' (accepted by scanner)' : ''}</div>
        <div>picker: {variant === 'C' ? `tray ${tray.length}` : held.phase}{held.remainingMs != null && variant !== 'C' ? ` · hides in ${(held.remainingMs / 1000).toFixed(1)} s` : ''}</div>
        <div>pointer over picker: {hovering ? 'yes (frozen)' : 'no'}</div>
        <div>duplicate lock: {addedId || 'none'}</div>
        <div className="mt-1 break-words">last action: {lastAction}</div>
        {stub && (
          <div className="mt-2 flex flex-wrap gap-1">
            <button type="button" onClick={() => setStubInFrame(v => !v)} className="rounded bg-fuchsia-700 px-1.5 py-0.5">{stubInFrame ? 'Card leaves frame' : 'Card enters frame'}</button>
            <button type="button" onClick={() => setStubSet(s => (s + 1) % STUB_SETS.length)} className="rounded bg-fuchsia-700 px-1.5 py-0.5">Swap top match</button>
          </div>
        )}
      </div>
      <PrototypeSwitcher variants={VARIANTS} current={variant} />
    </>
  );
}
