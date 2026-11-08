// Image evidence stays out of serializable result objects and collection rows.
// Camera frames are immutable canvases; only live result references retain them.
const evidence = new WeakMap();

export function attachScanEvidence(result, value) {
  if (result && value) evidence.set(result, value);
  return result;
}

export function getScanEvidence(result) { return result && evidence.get(result); }

export function copyScanEvidence(source, target) {
  return attachScanEvidence(target, getScanEvidence(source));
}

// The artwork crop and its quality result, kept for learned references.
const artwork = new WeakMap();

export function attachScanArtwork(result, value) {
  if (result && value) artwork.set(result, value);
  return result;
}

export function getScanArtwork(result) { return result && artwork.get(result); }
