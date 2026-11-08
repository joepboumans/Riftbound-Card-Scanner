import test from 'node:test';
import assert from 'node:assert/strict';
import { withFullNames } from '../src/lib/cardData.js';
import { restoreCardEntries } from '../src/lib/collection.js';
import { createRuntime } from './helpers/runtime.mjs';

const kaisaUnit = { id: 'rad-sp4-005', name: "Kai'Sa", subtitle: 'Rebel', code: 'RAD-SP4/005', type: 'unit', tags: ["Kai'Sa", 'The Void'] };
const ziggsUnit = { id: 'ogn-ziggs', name: 'Ziggs', code: 'OGN-100/298', type: 'unit', tags: ['Ziggs', 'Yordle'] };
const kaisaLegend = { id: 'ogn-247-298', name: 'Daughter of the Void', code: 'OGN-247/298', type: 'legend', tags: ["Kai'Sa"] };
const ziggsLegend = { id: 'ogn-ziggs-legend', name: 'Hexplosives Expert', code: 'OGN-260/298', type: 'legend', tags: ['Yordle', 'Ziggs'] };
const starterLegend = { id: 'ogs-starter', name: 'Daughter of the Void', subtitle: 'Starter', code: 'OGS-017/024', type: 'legend', tags: ["Kai'Sa"] };
const plainSpell = { id: 'ogn-spell', name: 'Falling Star', code: 'OGN-030/298', type: 'spell', tags: [] };
const cardDatabase = [kaisaUnit, ziggsUnit, kaisaLegend, ziggsLegend, starterLegend, plainSpell];
const fullNameOf = (id) => withFullNames(cardDatabase).find((card) => card.id === id).fullName;

test('a legend full name is its champion plus its title', () => {
  assert.equal(fullNameOf('ogn-247-298'), "Kai'Sa, Daughter of the Void");
});

test('a legend champion is the tag naming a champion unit, not the first tag', () => {
  assert.equal(fullNameOf('ogn-ziggs-legend'), 'Ziggs, Hexplosives Expert');
});

test('a starter legend ignores its Starter subtitle', () => {
  assert.equal(fullNameOf('ogs-starter'), "Kai'Sa, Daughter of the Void");
});

test('a champion unit full name is its name plus its subtitle', () => {
  assert.equal(fullNameOf('rad-sp4-005'), "Kai'Sa, Rebel");
});

test('a card without a subtitle keeps its printed name', () => {
  assert.equal(fullNameOf('ogn-spell'), 'Falling Star');
  assert.equal(fullNameOf('ogn-ziggs'), 'Ziggs');
});

test('an old saved entry with only a name comes back with its full name from the card database', () => {
  const saved = [{ cardData: { id: 'rad-sp4-005', name: "Kai'Sa" }, quantity: 2, foil: true }];
  const [restored] = restoreCardEntries(saved, withFullNames(cardDatabase));
  assert.equal(restored.cardData.fullName, "Kai'Sa, Rebel");
  assert.equal(restored.cardData.subtitle, 'Rebel');
  assert.equal(restored.cardData.code, 'RAD-SP4/005');
  assert.equal(restored.quantity, 2);
  assert.equal(restored.foil, true);
});

test('a saved entry whose id is not in the card database keeps its stored copy', () => {
  const stored = { id: 'custom-promo', name: 'My Promo', code: 'PROMO-1' };
  const [restored] = restoreCardEntries([{ cardData: stored }], withFullNames(cardDatabase));
  assert.deepEqual(restored.cardData, stored);
});

test('search over the loaded card database finds a card by full name, printed name and code', () => {
  const runtime = createRuntime();
  const matcher = runtime.load('src/lib/cardMatcher.js').getMatcher();
  matcher._applyDatabase({ gridSize: 2, cards: cardDatabase.map((card) => ({ ...card, f: [0, 0, 0] })) });
  const { searchCards } = runtime.load('src/lib/cardSearch.js');
  const ids = (query) => searchCards(matcher.cards, query).map((card) => card.id);
  assert.ok(ids("Kai'Sa, Daughter").includes('ogn-247-298'));
  assert.ok(ids('Daughter of the Void').includes('ogn-247-298'));
  assert.ok(ids('OGN-247').includes('ogn-247-298'));
  assert.deepEqual(ids('Sa, Rebel'), ['rad-sp4-005']);
});
