/**
 * CSV Exporter for Riftbound Scanner.
 *
 * Supports multiple export schemas:
 *   - CardNexus / PowerTools
 *   - Piltover Archive
 *   - riftbound.gg collection CSV
 *   - Deck list (plain text)
 */

import { fullNameOf } from './cardData.js';

export const EXPORT_FORMATS = {
  CARDNEXUS: 'cardnexus',
  PILTOVER: 'piltover',
  RIFTBOUND_GG: 'riftbound-gg',
  DECK_LIST: 'deck-list',
};

export const EXPORT_FORMAT_OPTIONS = [
  { value: EXPORT_FORMATS.CARDNEXUS, label: 'CardNexus / PowerTools' },
  { value: EXPORT_FORMATS.PILTOVER, label: 'Piltover Archive' },
  { value: EXPORT_FORMATS.RIFTBOUND_GG, label: 'riftbound.gg collection CSV' },
  { value: EXPORT_FORMATS.DECK_LIST, label: 'Deck list' },
];

const CARDNEXUS_HEADERS = [
  'Quantity',
  'Card Name',
  'Collector Number',
  'Expansion',
  'Condition',
  'Language',
  'Finish',
  'Code',
];

const PILTOVER_HEADERS = [
  'Variant Number',
  'Card Name',
  'Set',
  'Set Prefix',
  'Rarity',
  'Variant Type',
  'Variant Label',
  'Foil',
  'Quantity',
  'Language',
  'Condition',
  'Grading Company',
  'Grading Value',
  'Grading Label',
  'Notes',
  'Code',
];

const RIFTBOUND_GG_HEADERS = ['CardId', 'Normal', 'Foil', 'Name', 'Set'];

const FOIL_ONLY_RARITIES = new Set(['rare', 'epic', 'legendary', 'showcase', 'legend']);

/**
 * Escape a CSV field (handle commas, quotes, newlines)
 */
function escapeCSV(value) {
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function normalizeExportFormat(format) {
  return Object.values(EXPORT_FORMATS).includes(format) ? format : EXPORT_FORMATS.CARDNEXUS;
}

function getCardDisplaySet(cardData) {
  return cardData?.setName || cardData?.set || '';
}

function getPromoVariantLabel(cardData) {
  const displaySet = getCardDisplaySet(cardData);
  const baseSet = displaySet.replace(/\s+Set$/i, '').trim();
  return baseSet ? `${baseSet} Promo` : 'Promo';
}

function getCardPrefix(cardData) {
  if (cardData?.set) return cardData.set;
  const code = cardData?.code || '';
  const codePrefix = code.split('-')[0];
  return codePrefix || '';
}

function getCardVariantNumber(cardData) {
  const codePart = (cardData?.code || '').split('/')[0].trim();
  if (codePart) return codePart;

  const prefix = getCardPrefix(cardData);
  const collectorNumber = String(cardData?.collectorNumber || '').replace(/\*/g, '').trim();
  if (prefix && collectorNumber) return `${prefix}-${collectorNumber}`;
  return collectorNumber || prefix || '';
}

function isOvernumbered(cardData) {
  const codePart = (cardData?.code || '').split('/');
  if (codePart.length !== 2) return false;

  const collectorNumber = parseInt(String(cardData?.collectorNumber || '').replace(/\D/g, ''), 10) || 0;
  const total = parseInt(codePart[1], 10) || 0;
  return collectorNumber > 0 && total > 0 && collectorNumber > total;
}

function isRuneVariant(cardData) {
  const codePart = String(cardData?.code || '').split('/')[0];
  return /-R\d+[a-z]?$/i.test(codePart);
}

function getVariantType(card) {
  const rarity = String(card?.cardData?.rarity || '').toLowerCase();
  if (card?.promo) return 'Promo';
  if (isOvernumbered(card?.cardData)) return 'Overnumbered';
  if (rarity === 'showcase') return 'Showcase';
  return 'Standard';
}

function getVariantLabel(card) {
  const cardData = card?.cardData || {};
  const rarity = String(cardData.rarity || '').toLowerCase();

  if (card?.promo) {
    return getPromoVariantLabel(cardData);
  }

  if (isOvernumbered(cardData)) {
    return 'Overnumbered';
  }

  if (isRuneVariant(cardData)) {
    return `${getCardPrefix(cardData)} Foil`;
  }

  const code = String(cardData.code || '');
  const isAltArt = code.includes('*') || /[a-z]$/i.test(code.split('/')[0]) || rarity === 'showcase';

  if (isAltArt) {
    return 'Alt Art';
  }

  if (card?.foil) {
    return FOIL_ONLY_RARITIES.has(rarity) ? 'Standard' : 'Foil';
  }

  return 'Standard';
}

function buildCardNexusRow(card) {
  const exportName = fullNameOf(card.cardData);
  const exportCollector = (card.cardData.collectorNumber || '').replace(/\*/g, '');
  const exportSet = card.promo ? 'OGNX' : (card.cardData.set || 'OGN');

  return [
    card.quantity || 1,
    escapeCSV(exportName),
    escapeCSV(exportCollector),
    escapeCSV(exportSet),
    escapeCSV(card.condition || 'Near Mint'),
    escapeCSV(card.language || 'English'),
    card.foil ? 'Foil' : 'Standard',
    escapeCSV(card.cardData.code || ''),
  ];
}

function buildPiltoverRow(card) {
  const cardData = card.cardData || {};
  let variantNumber = getCardVariantNumber(cardData);
  const variantType = getVariantType(card);
  const variantLabel = getVariantLabel(card);

  const displaySet = getCardDisplaySet(cardData);
  const setPrefix = getCardPrefix(cardData);

  return [
    escapeCSV(variantNumber),
    escapeCSV(fullNameOf(cardData)),
    escapeCSV(displaySet),
    escapeCSV(setPrefix),
    escapeCSV(cardData.rarity ? String(cardData.rarity).replace(/\b\w/g, (m) => m.toUpperCase()) : ''),
    escapeCSV(variantType),
    escapeCSV(variantLabel),
    card.foil ? 'true' : 'false',
    card.quantity || 1,
    escapeCSV(card.language || 'English'),
    escapeCSV(card.condition || 'Near Mint'),
    '',
    '',
    '',
    '',
    escapeCSV(cardData.code || ''),
  ];
}

// riftbound.gg's CardId is the code without its set total; a signed `*` is spelled `-STAR`.
function riftboundGgCardId(cardData) {
  return String(cardData?.code || '').split('/')[0].trim().replace(/\*/g, '-STAR');
}

// riftbound.gg's name fallback matches its own catalog exactly, which joins name and title with ` - `.
function riftboundGgName(cardData) {
  const fullName = fullNameOf(cardData);
  return fullName === cardData?.name ? fullName : fullName.replace(', ', ' - ');
}

// One row per CardId: the format has no column for condition or language, so those merge.
function buildRiftboundGgRows(cards) {
  const rows = new Map();
  for (const card of cards) {
    const cardId = riftboundGgCardId(card.cardData);
    const row = rows.get(cardId) || { cardId, normal: 0, foil: 0, cardData: card.cardData };
    row[card.foil ? 'foil' : 'normal'] += card.quantity || 1;
    rows.set(cardId, row);
  }

  const lines = [RIFTBOUND_GG_HEADERS.join(',')];
  for (const row of rows.values()) {
    lines.push([
      escapeCSV(row.cardId),
      row.normal,
      row.foil,
      escapeCSV(riftboundGgName(row.cardData)),
      escapeCSV(getCardDisplaySet(row.cardData)),
    ].join(','));
  }
  return lines.join('\r\n');
}

function buildRows(cards, format) {
  const normalizedFormat = normalizeExportFormat(format);
  if (normalizedFormat === EXPORT_FORMATS.RIFTBOUND_GG) return buildRiftboundGgRows(cards);
  if (normalizedFormat === EXPORT_FORMATS.DECK_LIST) return generateDeckList(cards);
  const headers = normalizedFormat === EXPORT_FORMATS.PILTOVER ? PILTOVER_HEADERS : CARDNEXUS_HEADERS;
  const lines = [headers.join(',')];

  for (const card of cards) {
    const row = normalizedFormat === EXPORT_FORMATS.PILTOVER
      ? buildPiltoverRow(card)
      : buildCardNexusRow(card);
    lines.push(row.join(','));
  }

  return lines.join('\r\n');
}

const DECK_SECTIONS = [
  { header: 'Legend:', types: ['legend'] },
  { header: 'Champion:', types: [] },
  { header: 'MainDeck:', types: ['unit', 'spell', 'gear'] },
  { header: 'Battlefields:', types: ['battlefield'] },
  { header: 'Runes:', types: ['rune'] },
];

// The card database keeps no supertype, but every token's code numbers it `T<n>` (`UNL-T04`).
function isToken(cardData) {
  return /-T\d+[a-z]?$/i.test(String(cardData?.code || '').split('/')[0].trim());
}

function deckSectionOf(cardData) {
  if (isToken(cardData)) return undefined;
  return DECK_SECTIONS.find((section) => section.types.includes(cardData?.type));
}

function addToDeckSection(section, fullName, quantity) {
  section.set(fullName, (section.get(fullName) || 0) + quantity);
}

/**
 * Plain-text deck list for deck builders: `N Full name` under section headers.
 * Names cards, not prints, so quantities sum across prints, foil, condition and language.
 * Tokens (and any card without a deck section) are left out.
 */
export function generateDeckList(cards) {
  const sections = new Map(DECK_SECTIONS.map(({ header }) => [header, new Map()]));
  const unitNames = new Map();
  for (const card of cards || []) {
    const section = deckSectionOf(card.cardData);
    if (!section) continue;
    const fullName = fullNameOf(card.cardData);
    addToDeckSection(sections.get(section.header), fullName, card.quantity || 1);
    if (card.cardData.type === 'unit') unitNames.set(fullName, card.cardData.name);
  }

  // With exactly one legend, one copy of a unit of its champion is the chosen champion.
  const legends = [...sections.get('Legend:').keys()];
  const legendChampion = legends.length === 1 ? legends[0].split(', ')[0] : null;
  const mainDeck = sections.get('MainDeck:');
  const chosen = [...mainDeck.keys()].sort((a, b) => a.localeCompare(b))
    .find((fullName) => legendChampion && fullName !== legendChampion && unitNames.get(fullName) === legendChampion);
  if (chosen) {
    sections.get('Champion:').set(chosen, 1);
    if (mainDeck.get(chosen) === 1) mainDeck.delete(chosen);
    else mainDeck.set(chosen, mainDeck.get(chosen) - 1);
  }

  return [...sections]
    .filter(([, entries]) => entries.size > 0)
    .map(([header, entries]) => [
      header,
      ...[...entries]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([fullName, quantity]) => `${quantity} ${fullName}`),
    ].join('\n'))
    .join('\n\n');
}

/**
 * A message to show after exporting, or null when there is nothing to say.
 * riftbound.gg has no promo prints, so promo rows go out as their normal print.
 */
export function exportNotice(cards, format) {
  if (normalizeExportFormat(format) !== EXPORT_FORMATS.RIFTBOUND_GG) return null;
  const promoRows = (cards || []).filter((card) => card.promo).length;
  if (promoRows === 0) return null;
  return promoRows === 1
    ? '1 promo row exported as its normal print'
    : `${promoRows} promo rows exported as their normal print`;
}

/**
 * Generate CSV content from scanned cards
 *
 * @param {Array<ScannedCard>} cards - Array of scanned cards with metadata
 * @returns {string} CSV content as string
 *
 * ScannedCard shape:
 * {
 *   cardData: { name, collectorNumber, set, setName },
 *   quantity: number,
 *   condition: string,
 *   language: string,
 *   foil: boolean,
 * }
 */
export function generateCSV(cards, format = EXPORT_FORMATS.CARDNEXUS) {
  return buildRows(cards, format);
}

const CSV_FILE = { extension: 'csv', mimeType: 'text/csv;charset=utf-8;', bom: '\uFEFF' };

const EXPORT_FILES = {
  [EXPORT_FORMATS.CARDNEXUS]: { ...CSV_FILE, prefix: 'riftbound-scan', label: 'CardNexus/PowerTools' },
  [EXPORT_FORMATS.PILTOVER]: { ...CSV_FILE, prefix: 'riftbound-piltover', label: 'Piltover Archive' },
  [EXPORT_FORMATS.RIFTBOUND_GG]: { ...CSV_FILE, prefix: 'riftbound-gg', label: 'riftbound.gg' },
  [EXPORT_FORMATS.DECK_LIST]: { extension: 'txt', mimeType: 'text/plain;charset=utf-8;', bom: '', prefix: 'riftbound-deck', label: 'Deck list' },
};

/**
 * The file an export downloads as: name, content and media type.
 */
export function exportFile(cards, format = EXPORT_FORMATS.CARDNEXUS, date = new Date()) {
  const normalizedFormat = normalizeExportFormat(format);
  const file = EXPORT_FILES[normalizedFormat];
  const body = generateCSV(cards, normalizedFormat);
  return {
    filename: `${file.prefix}-${date.toISOString().slice(0, 10)}.${file.extension}`,
    content: file.bom + body + (normalizedFormat === EXPORT_FORMATS.DECK_LIST ? '\n' : ''),
    mimeType: file.mimeType,
    label: file.label,
  };
}

/**
 * Trigger an export download in the browser
 *
 * @param {Array<ScannedCard>} cards
 * @param {string} filename
 * @returns {{ success: boolean, filename: string, format: string, notice: string|null }} Download result with metadata
 */
export function downloadCSV(cards, filename = null, format = EXPORT_FORMATS.CARDNEXUS) {
  if (!cards || cards.length === 0) {
    console.warn('[CSV] No cards to export');
    return { success: false, filename: null, format: null, notice: null };
  }

  const file = exportFile(cards, format);
  const finalFilename = filename || file.filename;
  const blob = new Blob([file.content], { type: file.mimeType });

  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = finalFilename;
  link.style.display = 'none';

  document.body.appendChild(link);
  link.click();

  setTimeout(() => {
    URL.revokeObjectURL(link.href);
    document.body.removeChild(link);
  }, 100);

  return { success: true, filename: finalFilename, format: file.label, notice: exportNotice(cards, format) };
}

/**
 * Copy the deck list to the clipboard, for pasting straight into a deck builder.
 */
export async function copyDeckList(cards) {
  await navigator.clipboard.writeText(generateDeckList(cards));
}

/**
 * Generate a preview of the CSV content (first N rows)
 */
export function previewCSV(cards, maxRows = 5, format = EXPORT_FORMATS.CARDNEXUS) {
  const preview = cards.slice(0, maxRows);
  return generateCSV(preview, format);
}

/**
 * Validate that all required fields are present
 */
export function validateForExport(cards, format = EXPORT_FORMATS.CARDNEXUS) {
  const errors = [];
  const normalizedFormat = normalizeExportFormat(format);

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (!card.cardData?.name) {
      errors.push(`Row ${i + 1}: Missing card name`);
    }
    if (!card.cardData?.collectorNumber) {
      errors.push(`Row ${i + 1}: Missing collector number`);
    }
    if (!card.quantity || card.quantity < 1) {
      errors.push(`Row ${i + 1}: Invalid quantity`);
    }

    if (normalizedFormat === EXPORT_FORMATS.PILTOVER && !getCardVariantNumber(card.cardData)) {
      errors.push(`Row ${i + 1}: Missing Piltover variant number`);
    }
  }

  return { valid: errors.length === 0, errors };
}
