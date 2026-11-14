import { CardTextIndex } from './cardTextIdentity.js';
import { recognizeCard, buildRecognitionResult, applyTextVerification, matchFromRanking, rankForReview, reviewCandidatesFor } from './cardRecognition.js';
import { hasLocalArtworkSupport } from './localArtwork.js';
import { selectGuideDetection, mapDetectionBox } from './scanGeometry.js';
import { attachScanEvidence, attachScanArtwork } from './scanEvidence.js';
import { describeScanArtwork } from './learnedReferences.js';
import { mergeLearnedCandidates } from './learnedCandidates.js';
import { emitScanDiagnostic } from './scanDiagnostics.js';
import { isScanFrameCancelled } from './scanQuality.js';
import { hasStrongVisualProof, canReuseVisualBox } from './cardVisualProof.js';

// Lower floor used only by auto-scan temporal voting.
const CANDIDATE_SIMILARITY_FLOOR = 0.62;
const TARGET_ASPECT_RATIO = 63 / 88;
const MAX_ASPECT_DEVIATION = 0.22;

/**
 * The scan module: everything between a camera frame and what the scanner
 * makes of it. Created once with getters for its long-lived tools, each read
 * when a scan starts:
 *   getDetector, getMatcher, getVisualVerifier, getLearnedReferences
 *
 *   scanFrame(frame, settings, options) → { observation, result }
 *     settings: { setFilter, minSimilarity, minSimilarityGap, textVerifier, cropRefiner }
 *     options:  includeCandidate  also return a likely candidate the scanner has not accepted
 *               includeReview     return an outlined card for Snap review, even one that
 *                                 failed the quality check (ranked for review only)
 *               offerCandidates   the frame's candidates are offered on the Choice strip
 *               retainEvidence    keep the frame and top scores for debug capture
 *     observation: what the scanner saw, for display; null when the frame was cancelled
 *     result:      the outcome to act on, or null
 *   reset()  cancels scans in flight and forgets the card being followed
 *
 * The acceptance decision is built from official references only and is
 * complete before learned references are merged into the shown candidates.
 */
export function createCardScan({ getDetector, getMatcher, getVisualVerifier = () => null, getLearnedReferences }) {
  let epoch = 0;
  // The last card proven by its artwork geometry: the next frame may reuse its box.
  let visualFollowup = null;
  // Card text lookup, rebuilt when the card database or the set filter changes
  // (not by reset: it describes the database, not the card in front of the camera).
  let textIndex = null;

  function reset() {
    epoch++;
    visualFollowup = null;
  }

  async function scanFrame(frame, settings = {}, options = {}) {
    const { setFilter, minSimilarity, minSimilarityGap, textVerifier = null, cropRefiner = null } = settings;
    const detector = getDetector(), matcher = getMatcher(), visualVerifier = getVisualVerifier();
    const observedAt = Date.now();
    const scanEpoch = epoch;
    const matcherRevision = matcher.revision;
    const frameInfo = { observedAt, frameId: frame.frameId, capturedAt: frame.capturedAt ?? observedAt,
      detectorModel: detector.modelPreference, matcherRevision };
    const cancelled = () => isScanFrameCancelled(frame) || scanEpoch !== epoch || matcher.revision !== matcherRevision;
    // What the scanner saw, to show; the scan returns it with its result.
    let observation = null;
    const observe = (seen) => { observation = seen; emitScanDiagnostic('observation', { result: seen }); };
    const scanned = (result) => ({ observation, result });
    emitScanDiagnostic('processing-start', frameInfo);
    try {
      if (frame.scanMoving || ['too-dark', 'too-bright'].includes(frame.scanQuality?.issue)) {
        visualFollowup = null;
        textVerifier?.reset();
        observe({ ...frameInfo, matched: false, reason: frame.scanMoving ? 'moving' : frame.scanQuality.issue });
        return scanned(null);
      }
      const recognize = (detection, visualOnly = false) => recognizeCard({ source: frame, detection, matcher,
        setFilter, minSimilarity,
        textCorroboration: textVerifier?.getGeometryHint?.({ frame, context: `${scanEpoch}:${matcherRevision || 0}`, capturedAt: frameInfo.capturedAt }),
        cropRefiner, candidates: Boolean(textVerifier), visualOnly,
        visualVerifier: cropRefiner || textVerifier ? visualVerifier : null });
      let recognition, bestDetection, detectorReused = false, detectedAt = observedAt, detectorMs = 0, followupMissMs = 0;
      const anchor = visualFollowup; visualFollowup = null;
      if (canReuseVisualBox(anchor, frame, { epoch: scanEpoch, revision: matcherRevision, now: observedAt })) {
        const quick = await recognize(anchor.detection, true);
        if (quick?.visualVerification?.status === 'verified' && quick.visualVerification.cardId === anchor.cardId) {
          recognition = quick; bestDetection = anchor.detection; detectorReused = true;
        }
        else followupMissMs = Date.now() - observedAt;
      }
      if (!bestDetection) {
        const detectorStart = Date.now();
        const detections = await detector.detect(frame, { allowProposals: Boolean(visualVerifier && (cropRefiner || textVerifier)) });
        detectedAt = Date.now();
        detectorMs = detectedAt - detectorStart;
        emitScanDiagnostic('detector-result', { frameId: frame.frameId, count: detections.length, detectorMs });
        bestDetection = selectGuideDetection(detections, frame.scanRegion?.guide);
      } else emitScanDiagnostic('detector-followup', { frameId: frame.frameId, anchorFrameId: anchor.frameId });
      if (cancelled()) return scanned(null);
      if (!bestDetection) {
        textVerifier?.reset();
        observe({ ...frameInfo, matched: false, reason: 'outside-guide' });
        return scanned(null);
      }
      const box = mapDetectionBox(bestDetection.box, frame.scanRegion);
      const base = { ...frameInfo, box, confidence: bestDetection.confidence, matched: false,
        ...(bestDetection.detectorProposal ? { detectorProposal: true } : {}) };
      const boxRatio = bestDetection.box.w / Math.max(1, bestDetection.box.h);
      const normalizedRatio = Math.min(boxRatio, 1 / boxRatio);
      if (Math.abs(normalizedRatio - TARGET_ASPECT_RATIO) > MAX_ASPECT_DEVIATION) {
        observe({ ...base, reason: 'outside-guide' });
        return scanned(null);
      }
      recognition ||= await recognize(bestDetection);
      const recognizedAt = Date.now();
      if (cancelled()) return scanned(null);
      const quality = recognition.quality;
      if (frame.scanMoving) { quality.acceptable = false; quality.issue = 'moving'; }
      // The candidates shown to the user (Choice strip, Snap review), with
      // learned references merged in when this frame offers candidates. Set
      // after acceptance, which never sees them.
      const showCandidates = (result, officialCandidates) => {
        const artwork = describeScanArtwork({ crop: recognition.crop, quality, matcher,
          outlined: !bestDetection.detectorProposal, areaSampling: recognition.artworkSampling === 'area' });
        result.reviewCandidates = options.offerCandidates || options.includeReview
          ? mergeLearnedCandidates(officialCandidates, { artwork, matcher,
            references: getLearnedReferences().references(), setFilter })
          : officialCandidates;
        attachScanArtwork(result, artwork);
      };
      // Snap review still gets an outlined card that failed quality or matched
      // nothing; its candidates are ranked for review, never for acceptance.
      const withReviewCandidates = (result, rankCandidates) => {
        if (!options.includeReview) return null;
        showCandidates(result, rankCandidates());
        return result;
      };
      if (!quality.acceptable) {
        textVerifier?.reset();
        const failed = { ...base, quality, reason: quality.issue };
        const reviewed = withReviewCandidates(failed, () => rankForReview(recognition.crop, matcher, { setFilter }));
        observe(failed);
        return scanned(reviewed);
      }
      const matchResult = recognition.match;
      if (!matchResult?.card) {
        textVerifier?.reset();
        const unmatched = { ...base, quality, reason: 'low-similarity' };
        observe(unmatched);
        return scanned(withReviewCandidates(unmatched, () => []));
      }
      let result = buildRecognitionResult(matchResult, quality, minSimilarity, { ...base,
        visualVerification: recognition.visualVerification,
        requiresTextConfirmation: recognition.requiresTextConfirmation,
        cropMethod: recognition.cropMethod, artworkSampling: recognition.artworkSampling, geometryConflict: recognition.geometryConflict, trackingFingerprint: recognition.trackingFingerprint,
        quad: recognition.refinement?.quad?.map((p) => ({ x: p.x + (frame.scanRegion?.x || 0), y: p.y + (frame.scanRegion?.y || 0) })),
        rectificationStatus: recognition.refinement?.status || 'disabled', rectificationReason: recognition.refinement?.reason },
        { minSimilarityGap });
      if (textVerifier) {
        const filterKey = JSON.stringify(setFilter);
        if (textIndex?.cards !== matcher.cards || textIndex?.filterKey !== filterKey) {
          textVerifier.reset();
          // Read identity against the full database: a set filter must not hide
          // clear text evidence that the physical card belongs to another set.
          textIndex = { cards: matcher.cards, filterKey, index: new CardTextIndex(matcher.cards) };
        }
        const context = `${scanEpoch}:${matcher.revision || 0}`;
        const visualReady = hasStrongVisualProof(result);
        const observedText = textVerifier.observe(result, recognition.textCrop, { frame, context, index: textIndex.index,
          skipRead: visualReady,
          alternativeCrops: recognition.alternateTextCrops,
          candidates: matchResult.candidates, minSimilarity });
        const verification = visualReady && observedText.status === 'pending'
          ? { ...observedText, status: 'not-required', reason: 'verified-artwork-geometry' } : observedText;
        result = applyTextVerification(result, matchResult, verification);
        result.recognitionEpoch = `${context}:${verification.trackId || 0}`;
      }
      else result.recognitionEpoch = `${scanEpoch}:${matcherRevision}:${frame.scanMotionEpoch ?? 0}`;
      if (!detectorReused && result.matched && hasStrongVisualProof(result)) visualFollowup = {
        epoch: scanEpoch, revision: matcherRevision, motionContext: frame.scanMotionContext, motionEpoch: frame.scanMotionEpoch,
        frameId: frame.frameId, capturedAt: frame.capturedAt, cardId: result.cardData.id,
        detection: { box: { ...bestDetection.box }, confidence: bestDetection.confidence, detectorProposal: bestDetection.detectorProposal } };
      result.timings = { detectorReused, detectorMs, followupMissMs, artworkMs: recognizedAt - detectedAt + followupMissMs,
        frameMs: Date.now() - observedAt, sourceAgeMs: Date.now() - frameInfo.capturedAt };
      if (options.retainEvidence) attachScanEvidence(result, { frame,
        candidates: (matchResult.candidates || [matchResult]).slice(0, 5).map(entry => ({
          id: entry.card.id, name: entry.card.name, code: entry.card.code, similarity: entry.similarity,
          colorSimilarity: entry.colorSimilarity, structureSimilarity: entry.structureSimilarity,
          localStructureSimilarity: entry.localStructureSimilarity, alignedArtworkSimilarity: entry.alignedArtworkSimilarity,
          artworkAlignment: entry.artworkAlignment, similarityGap: entry.similarity - (entry.secondBestSim ?? 0),
        })) });
      showCandidates(result, reviewCandidatesFor(matchResult));
      observe(result);
      if (result.matched || options.includeReview || (options.includeCandidate && (matchResult.similarity >= CANDIDATE_SIMILARITY_FLOOR || hasLocalArtworkSupport(matchResult)))) return scanned(result);
      return scanned(null);
    } catch (error) {
      console.error('[Detection] Frame processing error:', error);
      observe({ ...frameInfo, matched: false, reason: 'low-similarity' });
      emitScanDiagnostic('processing-error', { frameId: frame.frameId, error: String(error?.message || error) });
      return scanned(null);
    }
  }

  return { scanFrame, reset };
}

const SNAP_WINDOW_MS = 2000;
const SNAP_RETRY_MS = 125;

/**
 * Snap: scans frames for up to two seconds until the scanner accepts the card
 * or, with text verification on, the card text has been read. Returns the last
 * result and the card to show in Snap review: the latest outlined card,
 * preferring one with acceptable quality.
 *   scanOnce()        scans one fresh frame with Snap review candidates
 *   accepts(result)   whether the scanner accepts that result (the user's threshold)
 */
export async function snapScan(scanOnce, { accepts, textVerifier = null, now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  textVerifier?.reset();
  let result, review = null;
  const deadline = now() + SNAP_WINDOW_MS;
  do {
    result = await scanOnce();
    const outlined = Boolean(result?.box || result?.reviewCandidates?.length);
    if (outlined && (result.quality?.acceptable || !review?.quality?.acceptable)) review = result;
    if (accepts(result) || !textVerifier ||
      (result?.quality?.acceptable && result.textVerification?.status !== 'pending')) break;
    if (now() < deadline) await wait(SNAP_RETRY_MS);
  } while (now() < deadline);
  return { result, review };
}

/**
 * Scans an uploaded photo for every card in it.
 *   image     the photo as shown (possibly resized), used to find the cards
 *   original  the full-resolution photo, used to crop each card
 *   isCurrent() false once the user picked another photo: the scan stops
 *   photoId   names this photo in text verification frame ids
 * Returns null when cancelled, otherwise { status, cards }:
 *   status 'detector-not-ready' | 'no-cards' | 'scanned'
 *   cards  one entry per card worth listing, with its box in `image`
 *          coordinates, crop, match, text verification and recognition result
 * Photos use a quarter-turn retry and accept a single frame of text; learned
 * references are not used.
 */
export async function scanPhoto(image, { original = image, detector, matcher, settings = {}, isCurrent = () => true, photoId = 'photo' }) {
  const { setFilter, minSimilarity, minSimilarityGap, textVerifier = null, cropRefiner = null } = settings;
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext('2d').drawImage(image, 0, 0);
  if (detector.state !== 'ready') return { status: 'detector-not-ready', cards: [] };
  const rawDetections = await detector.detect(canvas);
  if (!isCurrent()) return null;
  if (!rawDetections || rawDetections.length === 0) return { status: 'no-cards', cards: [] };

  // Crop from the original full-resolution photo for better matching quality.
  const cropScale = (original.naturalWidth || original.width) / (image.naturalWidth || image.width);
  const results = [];
  for (const det of rawDetections) {
    const recognition = await recognizeCard({ source: original,
      detection: { box: { ...det.box, cx: det.box.cx * cropScale, cy: det.box.cy * cropScale,
        w: det.box.w * cropScale, h: det.box.h * cropScale } },
      matcher, setFilter, photo: true, cropRefiner, candidates: Boolean(textVerifier) });
    if (!isCurrent()) return null;
    let matchResult = recognition.match;
    let textVerification = null;
    let recognitionResult = buildRecognitionResult(matchResult, recognition.quality, minSimilarity,
      { geometryConflict: recognition.geometryConflict }, { minSimilarityGap });
    if (textVerifier && matchResult?.card) {
      textVerification = await textVerifier.verifyPhoto(recognition.textCrop, { hint: matchResult.card,
        alternativeCrops: recognition.alternateTextCrops,
        index: new CardTextIndex(matcher.cards), frameId: `${photoId}-${results.length}` });
      if (!isCurrent()) return null;
      const result = applyTextVerification(recognitionResult, matchResult, textVerification, { photo: true });
      recognitionResult = result;
      textVerification = result.textVerification;
      // Text that names another candidate puts that candidate first.
      const confirmed = matchResult.candidates?.find((entry) => entry.card.id === result.cardData?.id);
      if (result.confirmationMethod === 'text' && confirmed) {
        matchResult = { ...matchFromRanking([confirmed, ...matchResult.candidates.filter((entry) => entry.card.id !== confirmed.card.id)]), textVerification };
      } else matchResult = { ...matchResult, textVerification };
    }
    results.push({
      cx: det.box.cx, cy: det.box.cy, w: det.box.w, h: det.box.h,
      angle: det.box.angle, confidence: det.confidence, cropCanvas: recognition.crop, matchResult,
      geometryConflict: recognition.geometryConflict, cropMethod: recognition.cropMethod, textVerification, recognitionResult,
    });
  }

  // A card is listed when it matched, is close to the threshold, or needs the user to look.
  const cards = matcher.ready
    ? results.filter(r => r.matchResult && (r.recognitionResult.matched || r.matchResult.similarity >= minSimilarity || r.geometryConflict || r.textVerification?.status === 'conflict'))
    : results;
  return { status: 'scanned', cards };
}
