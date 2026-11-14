import { useState, useRef, useCallback, useEffect } from 'react';
import { getDetector, DetectorState } from '../lib/yoloDetector.js';
import { getMatcher } from '../lib/cardMatcher.js';
import { getLearnedReferences } from '../lib/learnedReferences.js';
import { CardVisualVerifier } from '../lib/cardVisualVerifier.js';
import { createCardScan } from '../lib/cardScan.js';

/**
 * React side of camera scanning: loads the detector, keeps the busy flag and
 * the last thing the scanner saw. Everything between a frame and its result
 * is the scan module (lib/cardScan.js).
 */
export function useCardDetection({ scanSetFilter = 'all', minSimilarity = 0.90, minSimilarityGap = 0.05, cropRefiner = null, textVerifier = null, recognitionContext = '', cameraIsActive = true } = {}) {
  const [detectorState, setDetectorState] = useState(DetectorState.UNLOADED);
  const [detectorMode, setDetectorMode] = useState('unloaded');
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastDetection, setLastDetection] = useState(null);

  const detectorRef = useRef(null);
  const busyRef = useRef(false);
  const visualVerifierRef = useRef(null);
  // The settings each scan uses, kept current between renders.
  const settingsRef = useRef({ setFilter: scanSetFilter, minSimilarity, minSimilarityGap, cropRefiner, textVerifier });
  const scanRef = useRef(null);
  if (!scanRef.current) scanRef.current = createCardScan({ getDetector: () => detectorRef.current, getMatcher,
    getVisualVerifier: () => visualVerifierRef.current, getLearnedReferences });
  const scan = scanRef.current;
  // Counts resets, so a scan that finishes after one does not show what it saw.
  const resetsRef = useRef(0);
  const resetScan = useCallback(() => {
    resetsRef.current++;
    scan.reset();
    settingsRef.current.textVerifier?.reset();
  }, [scan]);

  const resetRecognition = useCallback(() => {
    resetScan();
    setLastDetection(null);
  }, [resetScan]);

  useEffect(() => {
    resetScan();
    settingsRef.current = { setFilter: scanSetFilter, minSimilarity, minSimilarityGap, cropRefiner, textVerifier };
  }, [resetScan, scanSetFilter, minSimilarity, minSimilarityGap, cropRefiner, textVerifier, recognitionContext, cameraIsActive]);
  useEffect(() => () => { resetScan(); visualVerifierRef.current?.dispose(); visualVerifierRef.current = null; }, [resetScan]);

  /**
   * Initialize the YOLO detector
   */
  const initDetector = useCallback(async (modelPreference = 'normal') => {
    resetsRef.current++;
    scan.reset();
    try {
      const detector = getDetector();
      detectorRef.current = detector;
      setDetectorState(DetectorState.LOADING);
      setDetectorMode('loading');

      if (typeof Worker !== 'undefined') {
        visualVerifierRef.current ||= new CardVisualVerifier();
        void visualVerifierRef.current.ensureReady();
      }

      await detector.initialize(modelPreference);
      setDetectorState(detector.state);
      setDetectorMode(detector.modelFormat || 'ready');
    } catch (error) {
      console.error('[Detection] Init failed:', error);
      setDetectorState(DetectorState.ERROR);
      setDetectorMode('error');
      throw error;
    }
  }, [scan]);

  /**
   * Scans one captured frame. Returns the result to act on, null, or
   * { skipped: true } when there was no fresh frame. Options: see scanFrame.
   */
  const detectSingleFrame = useCallback(async (captureFrame, options = {}) => {
    if (busyRef.current || !detectorRef.current || detectorRef.current.state !== DetectorState.READY) return null;
    if (!getMatcher().ready) return null;
    const frame = captureFrame?.();
    if (!frame) return { skipped: true };
    busyRef.current = true;
    setIsProcessing(true);
    const resets = resetsRef.current;
    try {
      const { observation, result } = await scan.scanFrame(frame, settingsRef.current, options);
      if (observation && resets === resetsRef.current) setLastDetection(observation);
      return result;
    } finally {
      busyRef.current = false;
      setIsProcessing(false);
    }
  }, [scan]);

  return {
    detectorState,
    detectorMode,
    isProcessing,
    lastDetection,
    initDetector,
    detectSingleFrame,
    resetRecognition,
  };
}
