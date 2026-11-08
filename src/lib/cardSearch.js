import { filterCardsBySet } from './cardMatcher.js';

const searchFields = (card) => [card.name, card.id, card.code, card.set, card.setName, card.collectorNumber, String(card.number || '')];

// Name or ID search used by manual add and by "Not these, search…".
// Prefix matches first, then by name and id.
export function searchCards(cards, rawQuery, setFilter = 'all') {
  const query = String(rawQuery || '').trim().toLowerCase();
  if (!cards?.length || query.length < 2) return [];
  const scoreMatch = (card) => searchFields(card).some((field) => String(field || '').toLowerCase().startsWith(query)) ? 1 : 0;
  return filterCardsBySet(cards, setFilter)
    .filter((card) => searchFields(card).some((field) => String(field || '').toLowerCase().includes(query)))
    .sort((left, right) => scoreMatch(right) - scoreMatch(left)
      || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
      || String(left.id).localeCompare(String(right.id), undefined, { numeric: true, sensitivity: 'base' }))
    .slice(0, 12);
}
