import { useState, useRef, useCallback, useEffect } from 'react';
import { isReliableScanResult } from '../lib/scanQuality.js';
import { copyScanEvidence } from '../lib/scanEvidence.js';
import { emitScanDiagnostic } from '../lib/scanDiagnostics.js';
import { SCANNER_DIAGNOSTICS_AVAILABLE } from '../lib/scannerExperiments.js';
import { createAutoScanSession } from '../lib/autoScanSession.js';

const SCAN_INTERVAL_MS = 50;

export function useAutoScan({ cameraIsActive, isProcessing, detectSingleFrame, captureFrame, onCardDetected,
  validateResult = isReliableScanResult, resetRecognition, onFakeScanAccepted, recognitionContext = '',
  debugEnabled: requestedDebug = false, onDebugAccepted }) {
  const debugEnabled=SCANNER_DIAGNOSTICS_AVAILABLE && requestedDebug;
  const [enabled, setEnabled] = useState(false);
  const [debugPreview, setDebugPreview] = useState(null);
  const [fakeEnabled, setFakeEnabled] = useState(false);
  const [fakeResult, setFakeResult] = useState(null);
  const mode = debugEnabled ? 'auto' : fakeEnabled ? 'fake' : enabled ? 'auto' : 'off';
  const modeRef = useRef(mode);
  const generationRef = useRef(0);
  const fakeResultRef = useRef(null);
  const contextRef = useRef(recognitionContext);
  const previousContextRef = useRef(recognitionContext);
  modeRef.current = mode;
  contextRef.current = recognitionContext;
  // Decides when a card has been seen often enough; this hook acts on it.
  const sessionRef = useRef(null);
  if (!sessionRef.current) sessionRef.current = createAutoScanSession();
  const session = sessionRef.current;
  const latestRef = useRef({ isProcessing, detectSingleFrame, captureFrame, onCardDetected, validateResult, resetRecognition, onFakeScanAccepted, onDebugAccepted });
  useEffect(() => {
    latestRef.current = { isProcessing, detectSingleFrame, captureFrame, onCardDetected, validateResult, resetRecognition, onFakeScanAccepted, onDebugAccepted };
  }, [isProcessing, detectSingleFrame, captureFrame, onCardDetected, validateResult, resetRecognition, onFakeScanAccepted, onDebugAccepted]);

  const resetProgress = useCallback(() => {
    generationRef.current++;
    fakeResultRef.current = null;
    setFakeResult(null);
    session.reset();
    setDebugPreview(null);
    latestRef.current.resetRecognition?.();
  }, [session]);

  useEffect(() => {
    if (previousContextRef.current !== recognitionContext) {
      previousContextRef.current = recognitionContext;
      resetProgress();
    }
  }, [recognitionContext, resetProgress]);

  useEffect(() => {
    if (mode === 'off' || !cameraIsActive) return undefined;
    let cancelled = false, processing = false;
    const timer = setInterval(async () => {
      if (processing || latestRef.current.isProcessing || modeRef.current !== mode ||
        contextRef.current !== recognitionContext || (mode === 'fake' && fakeResultRef.current)) return;
      processing = true;
      const generation = generationRef.current;
      try {
        const result = await latestRef.current.detectSingleFrame(latestRef.current.captureFrame, { includeCandidate: true, retainEvidence: debugEnabled,
          // Only real auto scan shows the Choice strip.
          offerCandidates: mode === 'auto' && !debugEnabled });
        if (cancelled || generation !== generationRef.current || modeRef.current !== mode || contextRef.current !== recognitionContext) return;
        const now = Date.now();
        const decision = session.observe(result, now, { validate: latestRef.current.validateResult, locking: mode === 'auto' });
        if (decision.best !== undefined) setDebugPreview(decision.best);
        if (decision.type !== 'accept') { emitScanDiagnostic('auto-decision', decision.diagnostic); return; }
        const cardId = decision.cardId;
        const accepted = copyScanEvidence(result, { ...result, timestamp: now, acceptedByAutoScan: mode === 'auto',
          ...(mode === 'fake' ? { acceptedByFakeScan: true } : {}),
          acceptanceDecision: { ...result.acceptanceDecision, phase: 'accepted', eligible: true, visualFrames: decision.visualFrames, sourceFrameId: result.frameId },
          autoScanConsensus: decision.consensus });
        if (mode === 'fake') {
          // The real acceptance rules have passed. Hold a diagnostic snapshot;
          // the collection-writing callback is never invoked by this mode.
          fakeResultRef.current = accepted;
          setFakeResult(accepted);
          setDebugPreview(accepted);
          latestRef.current.onFakeScanAccepted?.(accepted);
          return;
        }
        if (latestRef.current.onCardDetected(accepted) !== true) {
          emitScanDiagnostic('auto-decision',{frameId:result.frameId,cardId,reason:'queue-rejected'});return;
        }
        emitScanDiagnostic('accepted',{result:accepted});
        session.lock(cardId, now);
        setDebugPreview(accepted);
        if (debugEnabled) Promise.resolve(latestRef.current.onDebugAccepted?.(accepted)).catch(error => console.error('[Debug capture]', error));
      } finally {
        processing = false;
      }
    }, SCAN_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [mode, cameraIsActive, session, recognitionContext, debugEnabled]);

  useEffect(() => {
    if (!cameraIsActive) {
      modeRef.current = 'off'; setEnabled(false); setFakeEnabled(false); resetProgress();
    }
  }, [cameraIsActive, resetProgress]);

  const toggleAutoScan = useCallback(() => {
    if (debugEnabled) return;
    const next = modeRef.current !== 'auto';
    modeRef.current = next ? 'auto' : 'off';
    setEnabled(next);
    setFakeEnabled(false);
    session.unlock();
    resetProgress();
  }, [resetProgress, debugEnabled]);

  const toggleFakeScan = useCallback(() => {
    if (!SCANNER_DIAGNOSTICS_AVAILABLE || debugEnabled) return;
    const next = modeRef.current !== 'fake';
    modeRef.current = next ? 'fake' : 'off';
    setEnabled(false);
    setFakeEnabled(next);
    resetProgress();
  }, [resetProgress, debugEnabled]);

  const stopFakeScan = useCallback(() => {
    if (modeRef.current !== 'fake') return;
    modeRef.current = 'off';
    setFakeEnabled(false);
    resetProgress();
  }, [resetProgress]);

  const nextFakeScan = useCallback(() => {
    if (modeRef.current === 'fake') resetProgress();
  }, [resetProgress]);

  const setLastCardId = useCallback((cardId) => {
    session.lock(cardId, Date.now());
  }, [session]);

  return { autoScanEnabled: enabled || debugEnabled, toggleAutoScan, setLastCardId, debugPreview,
    fakeScanEnabled: fakeEnabled, fakeScanResult: fakeEnabled && previousContextRef.current === recognitionContext ? fakeResult : null,
    toggleFakeScan, stopFakeScan, nextFakeScan };
}
