import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCSV, generateDeckList, exportFile, exportFileType, exportNotice, copyDeckList, EXPORT_FORMATS, EXPORT_FORMAT_OPTIONS } from '../src/lib/csvExporter.js';

const entry = (cardData, extra = {}) => ({ cardData, quantity: 1, foil: false, ...extra });
const origins = { set: 'OGN', setName: 'Origins' };

const cardIds = (cards) => generateCSV(cards, EXPORT_FORMATS.RIFTBOUND_GG)
  .split('\r\n').slice(1).map((line) => line.split(',')[0]);

test('riftbound.gg CardId is the code without its set total', () => {
  assert.deepEqual(cardIds([
    entry({ name: 'Falling Star', code: 'OGN-030/298', collectorNumber: '030', ...origins }),
  ]), ['OGN-030']);
});

test('riftbound.gg CardId keeps alt-art letters, SP numbers, runes and tokens, and spells a signed print -STAR', () => {
  assert.deepEqual(cardIds([
    entry({ name: 'Jinx', subtitle: 'Loose Cannon', code: 'OGN-039a/298', collectorNumber: '039a', ...origins }),
    entry({ name: "Kai'Sa", subtitle: 'Rebel', code: 'RAD-SP4/005', collectorNumber: 'SP4', set: 'RAD', setName: 'Radiance' }),
    entry({ name: 'Daughter of the Void', code: 'OGN-299*/298', collectorNumber: '299*', ...origins }),
    entry({ name: 'Chaos Rune', type: 'rune', code: 'RAD-R05', collectorNumber: 'R05', set: 'RAD', setName: 'Radiance' }),
    entry({ name: 'Buff', code: 'UNL-T04', collectorNumber: 'T04', set: 'UNL', setName: 'Unleashed' }),
  ]), ['OGN-039a', 'RAD-SP4', 'OGN-299-STAR', 'RAD-R05', 'UNL-T04']);
});

const evelynn = { name: 'Evelynn', subtitle: "Agony's Embrace", fullName: "Evelynn, Agony's Embrace", code: 'OGN-180/298', collectorNumber: '180', ...origins };

test('riftbound.gg CSV gives each print one row with normal and foil counts, merging conditions and languages', () => {
  assert.equal(generateCSV([
    entry(evelynn, { quantity: 2, condition: 'Near Mint', language: 'English' }),
    entry(evelynn, { quantity: 1, foil: true }),
    entry(evelynn, { quantity: 1, condition: 'Played', language: 'French' }),
    entry(evelynn, { quantity: 3, foil: true, condition: 'Lightly Played' }),
  ], EXPORT_FORMATS.RIFTBOUND_GG), [
    'CardId,Normal,Foil,Name,Set',
    "OGN-180,3,4,Evelynn - Agony's Embrace,Origins",
  ].join('\r\n'));
});

test('riftbound.gg CSV exports promo rows as their normal print and says how many', () => {
  const cards = [
    entry(evelynn, { quantity: 2 }),
    entry(evelynn, { promo: true }),
    entry(evelynn, { promo: true, foil: true }),
  ];
  assert.equal(generateCSV(cards, EXPORT_FORMATS.RIFTBOUND_GG).split('\r\n')[1], "OGN-180,3,1,Evelynn - Agony's Embrace,Origins");
  assert.equal(exportNotice(cards, EXPORT_FORMATS.RIFTBOUND_GG), '2 promo rows exported as their normal print');
  assert.equal(exportNotice([entry(evelynn, { promo: true })], EXPORT_FORMATS.RIFTBOUND_GG), '1 promo row exported as its normal print');
});

test('riftbound.gg CSV has no notice without promo rows, and other formats keep promos', () => {
  assert.equal(exportNotice([entry(evelynn)], EXPORT_FORMATS.RIFTBOUND_GG), null);
  assert.equal(exportNotice([entry(evelynn, { promo: true })], EXPORT_FORMATS.CARDNEXUS), null);
});

const card = (name, type, subtitle = '', fullName = subtitle ? `${name}, ${subtitle}` : name) =>
  ({ name, subtitle, fullName, type, code: `OGN-${name}/298`, ...origins });
const kaisaLegend = card('Daughter of the Void', 'legend', '', "Kai'Sa, Daughter of the Void");
const jinxLegend = card('Loose Cannon', 'legend', '', 'Jinx, Loose Cannon');
const kaisaRebel = card("Kai'Sa", 'unit', 'Rebel');
const kaisaSurvivor = card("Kai'Sa", 'unit', 'Survivor');
const jinxRebel = card('Jinx', 'unit', 'Rebel');
const fallingStar = card('Falling Star', 'spell');
const longSword = card('Long Sword', 'gear');
const zaun = card('Zaun Warrens', 'battlefield');
const bodyRune = card('Body Rune', 'rune');
const buff = { name: 'Buff', type: '', code: 'UNL-T04', set: 'UNL' };

test('deck list puts cards under section headers in deck order and leaves out empty sections', () => {
  assert.equal(generateDeckList([
    entry(bodyRune, { quantity: 6 }),
    entry(zaun),
    entry(fallingStar, { quantity: 2 }),
    entry(longSword),
  ]), [
    'MainDeck:',
    '2 Falling Star',
    '1 Long Sword',
    '',
    'Battlefields:',
    '1 Zaun Warrens',
    '',
    'Runes:',
    '6 Body Rune',
  ].join('\n'));
});

test('deck list with one legend puts one copy of its matching champion under Champion', () => {
  assert.equal(generateDeckList([
    entry(kaisaRebel, { quantity: 3 }),
    entry(jinxRebel, { quantity: 2 }),
    entry(kaisaLegend),
  ]), [
    'Legend:',
    "1 Kai'Sa, Daughter of the Void",
    '',
    'Champion:',
    "1 Kai'Sa, Rebel",
    '',
    'MainDeck:',
    '2 Jinx, Rebel',
    "2 Kai'Sa, Rebel",
  ].join('\n'));
});

test('deck list sums a card across prints, foil, condition and language and leaves out tokens', () => {
  const altArt = { ...fallingStar, code: 'OGN-030a/298' };
  const unitToken = { name: 'Sprite', type: 'unit', code: 'OGN-T01', set: 'OGN' };
  assert.equal(generateDeckList([
    entry(fallingStar, { quantity: 1 }),
    entry(altArt, { quantity: 1, foil: true }),
    entry(fallingStar, { quantity: 1, condition: 'Played', language: 'French' }),
    entry(buff, { quantity: 4 }),
    entry(unitToken, { quantity: 2 }),
  ]), 'MainDeck:\n3 Falling Star');
});

test('the new exports download as riftbound-gg-<date>.csv and riftbound-deck-<date>.txt', () => {
  const date = new Date('2026-11-08T12:00:00Z');
  const cards = [entry(fallingStar, { quantity: 2 })];
  const csv = exportFile(cards, EXPORT_FORMATS.RIFTBOUND_GG, date);
  assert.equal(csv.filename, 'riftbound-gg-2026-11-08.csv');
  assert.equal(csv.content, 'CardId,Normal,Foil,Name,Set\r\nOGN-Falling Star,2,0,Falling Star,Origins');
  const deck = exportFile(cards, EXPORT_FORMATS.DECK_LIST, date);
  assert.equal(deck.filename, 'riftbound-deck-2026-11-08.txt');
  assert.equal(deck.content, 'MainDeck:\n2 Falling Star\n');
  assert.match(deck.mimeType, /^text\/plain/);
  assert.ok(EXPORT_FORMAT_OPTIONS.some((option) => option.value === EXPORT_FORMATS.DECK_LIST));
  assert.ok(EXPORT_FORMAT_OPTIONS.some((option) => option.value === EXPORT_FORMATS.RIFTBOUND_GG));
});

test('deck list with two legends keeps every champion in MainDeck', () => {
  assert.equal(generateDeckList([
    entry(kaisaRebel),
    entry(jinxLegend),
    entry(kaisaLegend),
  ]), [
    'Legend:',
    '1 Jinx, Loose Cannon',
    "1 Kai'Sa, Daughter of the Void",
    '',
    'MainDeck:',
    "1 Kai'Sa, Rebel",
  ].join('\n'));
});

test('riftbound.gg CSV and deck list files have no BOM; CardNexus and Piltover Archive CSVs keep theirs', () => {
  const cards = [entry(fallingStar)];
  assert.ok(!exportFile(cards, EXPORT_FORMATS.RIFTBOUND_GG).content.startsWith('﻿'));
  assert.ok(!exportFile(cards, EXPORT_FORMATS.DECK_LIST).content.startsWith('﻿'));
  assert.ok(exportFile(cards, EXPORT_FORMATS.CARDNEXUS).content.startsWith('﻿'));
  assert.ok(exportFile(cards, EXPORT_FORMATS.PILTOVER).content.startsWith('﻿'));
});

test('each export format names its file type', () => {
  assert.equal(exportFileType(EXPORT_FORMATS.CARDNEXUS), 'CSV');
  assert.equal(exportFileType(EXPORT_FORMATS.PILTOVER), 'CSV');
  assert.equal(exportFileType(EXPORT_FORMATS.RIFTBOUND_GG), 'CSV');
  assert.equal(exportFileType(EXPORT_FORMATS.DECK_LIST), 'TXT');
});

const withClipboard = async (writeText, run) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText } }, configurable: true });
  try {
    return await run();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  }
};

test('copying the deck list puts it on the clipboard and says so', async () => {
  let copied = null;
  const result = await withClipboard(async (text) => { copied = text; }, () => copyDeckList([entry(fallingStar, { quantity: 2 })]));
  assert.equal(copied, 'MainDeck:\n2 Falling Star');
  assert.deepEqual(result, { success: true, message: 'Deck list copied' });
});

test('a failed deck list copy says the deck list could not be copied', async () => {
  const result = await withClipboard(async () => { throw new Error('denied'); }, () => copyDeckList([entry(fallingStar)]));
  assert.deepEqual(result, { success: false, message: 'Could not copy the deck list' });
});
