// The one seam where learned references reach the matcher's output. They are
// ranked in their own pass and merged, per card, into the candidates shown to
// the user (Choice strip, Snap review) only. `visualCandidates`, `similarity`,
// `similarityGap` and everything `assessScanAcceptance` reads stay
// official-only, so learned references can put a card in the top 3 but never
// get it accepted.
import { resolveCardData } from './cardData.js';
import { compareFeatures } from './cardSimilarity.js';
import { filterCardsBySet } from './cardMatcher.js';

export const SHOWN_CANDIDATES = 3;

// Each card's best learned score for this scan's artwork. A reference whose
// card is not in the card database, or whose grid size differs from the
// matcher's, is kept but unused until its card returns.
function rankLearnedReferences(features, references, cardsById, gridSize) {
  const best = new Map();
  for (const reference of references) {
    const card = cardsById.get(reference.cardId);
    if (!card || reference.gridSize !== gridSize || reference.features?.length !== features.length) continue;
    const { similarity } = compareFeatures(features, reference.features);
    if (!(best.get(card.id)?.similarity >= similarity)) best.set(card.id, { card, similarity });
  }
  return best;
}

/**
 * The candidates to show for a scan: the official shown candidates, with each
 * card taking its best score from either source. A candidate whose score came
 * from a learned reference is marked `fromLearnedReference`.
 *
 * @param {object[]} candidates - official shown candidates, best first
 * @param {{ artwork: { features(): ArrayLike<number> }, references: object[],
 *   matcher: { cards: object[], gridSize: number }, setFilter?: string|string[] }} options
 */
export function showLearnedCandidates(candidates = [], { artwork, references = [], matcher, setFilter } = {}) {
  if (!references.length || !artwork || !matcher?.cards?.length) return candidates;
  const cardsById = new Map(filterCardsBySet(matcher.cards, setFilter).map((card) => [card.id, card]));
  const learned = rankLearnedReferences(Float32Array.from(artwork.features() || []), references, cardsById, matcher.gridSize);
  const lifted = [...learned.values()]
    .filter(({ card, similarity }) => !(candidates.find((candidate) => candidate.id === card.id)?.similarity >= similarity))
    .sort((a, b) => b.similarity - a.similarity);
  if (!lifted.length) return candidates;
  const liftedIds = new Set(lifted.map(({ card }) => card.id));
  // Official candidates keep their order; a lifted card goes before the first
  // one it outscores.
  const shown = candidates.filter((candidate) => !liftedIds.has(candidate.id));
  for (const { card, similarity } of lifted) {
    const entry = { ...resolveCardData(card), similarity, sim: (similarity * 100).toFixed(1), fromLearnedReference: true };
    const index = shown.findIndex((candidate) => (candidate.similarity ?? 0) < similarity);
    shown.splice(index < 0 ? shown.length : index, 0, entry);
  }
  return shown.slice(0, SHOWN_CANDIDATES);
}
