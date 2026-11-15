/**
 * Card Matcher — Identifies cards using artwork color and spatial correlation.
 * Its official references are the card database's cards with their artwork
 * fingerprints prepared for comparison; they follow every card database change.
 * Used by the scan module for camera frames and uploaded photos.
 */

import { describeFeatures, compareFeatures, MIN_STRUCTURE_NORM } from './cardSimilarity.js';
import { areaColorGrid } from './cardFeatures.js';
import { describeLocalArtwork, compareLocalArtwork, compareAlignedArtwork, artworkDetailScore } from './localArtwork.js';
import { getCardDatabase, filterCardsBySet } from './cardDatabase.js';

// Artwork crop region (portrait card) — excludes frame, name bar, text/stats
const ART_TOP = 0.05;
const ART_BOTTOM = 0.55;
const ART_LEFT = 0.05;
const ART_RIGHT = 0.95;

class CardMatcher {
  /**
   * @param cardDatabase  the card database whose cards are the official references
   */
  constructor(cardDatabase) {
    this.references = [];
    this.gridSize = 8;
    this.revision = 0;
    this.ready = false;
    this._tmpCanvas = null;
    cardDatabase.subscribe((current) => this._useCards(current));
    if (cardDatabase.ready) this._useCards(cardDatabase);
  }

  // Prepares each card's fingerprint for comparison. `revision` follows the
  // card database, so a scan started before a change can tell it is stale.
  _useCards({ cards, gridSize, revision }) {
    this.revision = revision;
    this._tmpCanvas = null;
    this.gridSize = gridSize;
    this.references = cards.map((card) => ({ ...card, featureStats: describeFeatures(card.f),
      localArtwork: describeLocalArtwork(card.f, gridSize),
      broadArtwork: describeLocalArtwork(card.f, gridSize, { radius: Math.max(1, Math.round(gridSize / 4)) }) }));
    this.ready = true;
  }

  /**
   * Identify a card from a cropped canvas using the shared artwork ranking.
   *
   * @param {HTMLCanvasElement} cropCanvas - De-rotated card crop
   * @returns {{ card: object, similarity: number, secondBestSim: number } | null}
   */
  identify(cropCanvas, options = {}) {
    const ranked = this.rank(cropCanvas, { ...options, limit: 2 });
    return ranked.length ? { ...ranked[0], secondBestSim: ranked[0].secondBestSim ?? ranked[1]?.similarity ?? 0 } : null;
  }

  rank(cropCanvas, { areaSampling = false, ...options } = {}) {
    if (!this.ready || !this.references.length) return [];
    return this.rankFeatures(this.artworkFeatures(cropCanvas, { areaSampling }), options);
  }

  // The feature vector the matcher ranks for a card crop.
  artworkFeatures(cropCanvas, { areaSampling = false } = {}) {
    return this._computeColorGrid(this._cropArtwork(cropCanvas), { areaSampling });
  }

  // A card's official reference features, or null when it is not in the card database.
  officialFeatures(cardId) {
    return this.references.find((card) => card.id === cardId)?.f || null;
  }

  rankFeatures(features, { setFilter, limit = 3, localStructure = false, alignLocal = true, requiredIds = null } = {}) {
    if (!this.ready) return [];
    const featureStats = describeFeatures(features);
    if (!featureStats || featureStats.structureNorm < MIN_STRUCTURE_NORM) return [];
    let ranked = [];
    const required = requiredIds && new Set(requiredIds), requested = [];
    const local = localStructure ? describeLocalArtwork(features, this.gridSize) : null;
    const broad = local ? describeLocalArtwork(features,this.gridSize,{radius:Math.max(1,Math.round(this.gridSize/4))}) : null;
    const broadRanked=[],poolLimit=Math.max(32,limit);
    const insert=(list,entry,score,maximum)=>{
      const index=list.findIndex(candidate=>score(candidate)<score(entry));
      if(index>=0)list.splice(index,0,entry);else if(list.length<maximum)list.push(entry);
      if(list.length>maximum)list.length=maximum;
    };
    let bestLegacy = null, secondLegacy = 0;
    for (const card of filterCardsBySet(this.references, setFilter)) {
      if (!card.featureStats || card.f.length !== features.length) continue;
      const scores = compareFeatures(features, card.f, featureStats, card.featureStats);
      const entry = { card, ...scores };
      if (required?.has(card.id)) requested.push(entry);
      if (local) {
        entry.localStructureSimilarity = compareLocalArtwork(local, card.localArtwork);
        entry.broadStructureSimilarity = compareLocalArtwork(broad,card.broadArtwork);
      }
      if (!bestLegacy || scores.similarity > bestLegacy.similarity) { secondLegacy = bestLegacy?.similarity ?? 0; bestLegacy = entry; }
      else secondLegacy = Math.max(secondLegacy, scores.similarity);
      insert(ranked,entry,candidate=>local?candidate.localStructureSimilarity:candidate.similarity,local?poolLimit:limit);
      if(local)insert(broadRanked,entry,candidate=>candidate.broadStructureSimilarity,poolLimit);
    }
    if (required) return requested.map(entry => ({ ...entry, secondBestSim: entry.card.id === bestLegacy?.card.id ? secondLegacy : bestLegacy?.similarity || 0 }));
    if (local) {
      ranked=[...new Set([...ranked,...broadRanked])];
      for(const entry of ranked){
        const alignment=alignLocal ? compareAlignedArtwork(local,entry.card.localArtwork,broad,entry.card.broadArtwork,this.gridSize) : null;
        if(alignment){entry.alignedArtworkSimilarity=alignment.similarity;entry.artworkAlignment={dx:alignment.dx,dy:alignment.dy,overlap:alignment.overlap};}
        entry.secondBestSim=entry.card.id===bestLegacy.card.id?secondLegacy:bestLegacy.similarity;
      }
      const rankScore = entry => alignLocal ? artworkDetailScore(entry) : Math.max(entry.localStructureSimilarity, entry.broadStructureSimilarity);
      ranked.sort((a,b)=>rankScore(b)-rankScore(a));ranked.length=Math.min(limit,ranked.length);
    }
    return ranked;
  }

  _cropArtwork(canvas) {
    const w = canvas.width, h = canvas.height;
    const sx = Math.round(w * ART_LEFT);
    const sy = Math.round(h * ART_TOP);
    const sw = Math.round(w * (ART_RIGHT - ART_LEFT));
    const sh = Math.round(h * (ART_BOTTOM - ART_TOP));
    const c = document.createElement('canvas');
    c.width = sw;
    c.height = sh;
    c.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    return c;
  }

  _equalizeHistogram(data) {
    for (let ch = 0; ch < 3; ch++) {
      const hist = new Uint32Array(256);
      for (let i = ch; i < data.length; i += 4) hist[data[i]]++;
      const cdf = new Uint32Array(256);
      cdf[0] = hist[0];
      for (let i = 1; i < 256; i++) cdf[i] = cdf[i - 1] + hist[i];
      let cdfMin = 0;
      for (let i = 0; i < 256; i++) {
        if (cdf[i] > 0) { cdfMin = cdf[i]; break; }
      }
      const totalPixels = data.length / 4;
      const denom = totalPixels - cdfMin;
      if (denom > 0) {
        for (let i = ch; i < data.length; i += 4) {
          data[i] = ((cdf[data[i]] - cdfMin) * 255 / denom + 0.5) | 0;
        }
      }
    }
  }

  _computeColorGrid(canvas, { areaSampling = false } = {}) {
    const w = canvas.width, h = canvas.height;
    if (!this._eqCanvas) this._eqCanvas = document.createElement('canvas');
    this._eqCanvas.width = w;
    this._eqCanvas.height = h;
    const eqCtx = this._eqCanvas.getContext('2d');
    eqCtx.drawImage(canvas, 0, 0);
    const fullData = eqCtx.getImageData(0, 0, w, h);
    this._equalizeHistogram(fullData.data);
    if (areaSampling) return areaColorGrid(fullData, this.gridSize);
    eqCtx.putImageData(fullData, 0, 0);

    if (!this._tmpCanvas) {
      this._tmpCanvas = document.createElement('canvas');
      this._tmpCanvas.width = this.gridSize;
      this._tmpCanvas.height = this.gridSize;
    }
    const ctx = this._tmpCanvas.getContext('2d');
    ctx.drawImage(this._eqCanvas, 0, 0, this.gridSize, this.gridSize);
    const data = ctx.getImageData(0, 0, this.gridSize, this.gridSize).data;
    const features = new Float32Array(this.gridSize * this.gridSize * 3);
    for (let i = 0, j = 0; i < data.length; i += 4) {
      features[j++] = data[i] / 255;
      features[j++] = data[i + 1] / 255;
      features[j++] = data[i + 2] / 255;
    }
    return features;
  }

}

let matcherInstance = null;

export function getMatcher() {
  if (!matcherInstance) {
    matcherInstance = new CardMatcher(getCardDatabase());
  }
  return matcherInstance;
}


export default CardMatcher;
