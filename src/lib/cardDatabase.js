/**
 * The card database: every print the app knows, taken from the official card
 * gallery. Loads the imported copy or the bundled file, tops the imported copy
 * up from the bundled file, merges in-app updates, replaces itself from a
 * card-hashes.json file, keeps the local copy, and tells subscribers whenever
 * its cards change. Nothing here compares artwork: that is the matcher's job.
 */

import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { loadMatcherDatabase, saveMatcherDatabase } from './indexedDB.js';
import { isDesktopRuntime, resolveAppUrl } from './runtime.js';
import { invokeDesktopCommand } from './desktopBridge.js';
import { withFullNames } from './cardData.js';

const HASHES_URL = resolveAppUrl(`/card-hashes.json?v=${__BUILD_TIME__}`);
const DEFAULT_GRID_SIZE = 8;
const debugLog = (...args) => {
  if (import.meta.env.DEV) console.log(...args);
};

/**
 * Get the local image URL for a card by its ID.
 * @param {string} cardId - The card ID (e.g., "ogn-001-298")
 * @returns {string} - Local image path (e.g., "/cards/ogn-001-298.webp")
 */
export function getCardImageUrl(cardId) {
  return `/cards/${cardId}.webp`;
}

export function resolveCardImageSource(source, cardId = null) {
  const fallback = cardId ? getCardImageUrl(cardId) : '';
  const candidate = source || fallback;
  if (!candidate) return '';

  if (/^https?:/i.test(candidate)) {
    return fallback ? resolveAppUrl(fallback) : '';
  }

  if (/^(data:|blob:|asset:|tauri:)/i.test(candidate)) {
    return candidate;
  }

  if (candidate.startsWith('/')) {
    return resolveAppUrl(candidate);
  }

  if (isDesktopRuntime()) {
    return convertFileSrc(candidate);
  }

  return candidate;
}

export function normalizeScanSetFilter(setFilter) {
  if (!setFilter) return [];

  if (Array.isArray(setFilter)) {
    return setFilter
      .map((value) => String(value || '').trim().toUpperCase())
      .filter((value) => value && value !== 'ALL');
  }

  if (setFilter instanceof Set) {
    return [...setFilter]
      .map((value) => String(value || '').trim().toUpperCase())
      .filter((value) => value && value !== 'ALL');
  }

  const normalized = String(setFilter || '').trim().toUpperCase();
  if (!normalized || normalized === 'ALL') return [];
  return [normalized];
}

export function filterCardsBySet(cards, setFilter) {
  const selectedSets = normalizeScanSetFilter(setFilter);
  if (selectedSets.length === 0) {
    return cards;
  }

  const selectedSetLookup = new Set(selectedSets);
  return cards.filter((card) => selectedSetLookup.has(String(card.set || '').toUpperCase()));
}

// The gallery image a card record was hashed from. Desktop updates keep a local
// image path in `imageUrl` and the gallery URL in `sourceImageUrl`; bundled
// records carry the gallery URL in `imageUrl`. Empty when unknown.
export function sourceImageUrlOf(card) {
  if (card?.sourceImageUrl) return card.sourceImageUrl;
  return /^https?:/i.test(card?.imageUrl || '') ? card.imageUrl : '';
}

const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// The bundled card's metadata over the local record. The local features and
// image path stay unless the bundled card was hashed from another image.
function refreshFromBundled(local, bundled) {
  const localSource = sourceImageUrlOf(local);
  const bundledSource = sourceImageUrlOf(bundled);
  if (localSource && bundledSource && localSource !== bundledSource) return bundled;
  const refreshed = { ...local, ...bundled, f: local.f, imageUrl: local.imageUrl };
  if (local.sourceImageUrl !== undefined || bundledSource) refreshed.sourceImageUrl = localSource || bundledSource;
  const changed = Object.keys(refreshed).some((key) => key !== 'f' && !sameValue(refreshed[key], local[key]));
  return changed ? refreshed : local;
}

// Top up an imported database after an app update: refresh metadata of known
// cards, add missing ones and never delete. Different feature grids cannot be mixed.
export function supplementWithBundledCards(local, bundled) {
  if (local.gridSize !== bundled.gridSize) return local;
  const bundledById = new Map(bundled.cards.map((card) => [card.id, card]));
  let changed = false;
  const cards = local.cards.map((card) => {
    const bundledCard = bundledById.get(card.id);
    const refreshed = bundledCard ? refreshFromBundled(card, bundledCard) : card;
    if (refreshed !== card) changed = true;
    return refreshed;
  });
  const ids = new Set(local.cards.map((card) => card.id));
  const missing = bundled.cards.filter((card) => !ids.has(card.id));
  return changed || missing.length ? { ...local, cards: [...cards, ...missing] } : local;
}

// Merge an in-app update into the local card database. Re-hashed and new cards
// replace whole; metadata-only records (no features) keep the local features
// and image path. Cards missing from the update are never deleted.
export function mergeCardDatabaseUpdate(existing, update) {
  const cardsById = new Map((existing?.cards || []).map((card) => [card.id, card]));
  for (const card of update?.cards || []) {
    const local = cardsById.get(card.id);
    if (card.f) cardsById.set(card.id, card);
    else if (local) cardsById.set(card.id, { ...local, ...card });
  }
  return {
    gridSize: update?.gridSize || existing?.gridSize,
    cards: [...cardsById.values()],
  };
}

/**
 * The desktop app's update source: asks the Riot gallery, through the desktop
 * shell, for new and changed cards. Progress arrives as
 * { percent: 0..1, message }.
 */
export const desktopUpdateSource = {
  async fetch({ knownCards, gridSize, onProgress = () => {} }) {
    const unlisten = await listen('card-database-progress', (event) => onProgress(event.payload || {}));
    try {
      return JSON.parse(await invokeDesktopCommand('update_card_database', { knownCards, gridSize }));
    } finally {
      unlisten();
    }
  },
};

/**
 * Creates a card database.
 *   storage  { load(), save(database) }: the local copy (default IndexedDB)
 *
 * Read: cards, gridSize, revision (bumped on every change), ready,
 *       source ('bundled' | 'local'), updatedAt (of the local copy)
 *
 *   load()                   the local copy topped up from the bundled file,
 *                            or the bundled file alone
 *   replace(database)        saves and uses `database` ({ gridSize, cards })
 *   replaceFromFile(text)    the same, from a card-hashes.json file's text;
 *                            returns the number of cards
 *   update(source, { onProgress, onMerged })
 *                            asks `source` (an update source: { fetch({ knownCards,
 *                            gridSize, onProgress }) }) for new and changed cards,
 *                            merges them in and saves; never deletes a card.
 *                            Returns { count, skippedCards }
 *   subscribe(listener)      listener(cardDatabase) after every change; returns
 *                            a function that stops listening
 */
export function createCardDatabase({ storage = { load: loadMatcherDatabase, save: saveMatcherDatabase } } = {}) {
  const listeners = new Set();
  const database = {
    cards: [],
    gridSize: DEFAULT_GRID_SIZE,
    revision: 0,
    ready: false,
    source: 'bundled',
    updatedAt: null,
    load,
    replace,
    replaceFromFile,
    update,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Uses `next` without saving it. For loading and for tests.
    _apply: apply,
  };

  function apply(next) {
    database.revision += 1;
    database.gridSize = next.gridSize;
    // Copies saved by earlier versions also hold the matcher's prepared
    // fingerprints; the matcher rebuilds those itself.
    database.cards = withFullNames(next.cards || []).map(({ featureStats, localArtwork, broadArtwork, ...card }) =>
      card.f instanceof Float32Array ? card : { ...card, f: new Float32Array(card.f) });
    database.ready = true;
    for (const listener of listeners) listener(database);
  }

  async function load() {
    database.ready = false;
    database.cards = [];
    database.source = 'bundled';
    database.updatedAt = null;

    let local = null;
    try {
      local = await storage.load();
      if (local) {
        apply(local.database);
        database.source = 'local';
        database.updatedAt = local.updatedAt || null;
        debugLog(`[CardDatabase] Loaded ${database.cards.length} cards from the local copy (${database.gridSize}x${database.gridSize} grid)`);
      }
    } catch (error) {
      local = null;
      console.warn('[CardDatabase] Could not load the local copy, falling back to the bundled file:', error);
    }

    try {
      const response = await fetch(HASHES_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bundled = await response.json();
      if (local) {
        const supplemented = supplementWithBundledCards(local.database, bundled);
        if (supplemented !== local.database) {
          apply(supplemented);
          const saved = await storage.save(supplemented);
          database.updatedAt = saved.updatedAt || database.updatedAt;
        }
      } else {
        apply(bundled);
        debugLog(`[CardDatabase] Loaded ${database.cards.length} cards from the bundled file (${database.gridSize}x${database.gridSize} grid)`);
      }
    } catch (error) {
      // Offline/missing bundles or a full local store must not hide a usable
      // imported database (including additions already loaded in memory).
      if (database.ready) {
        console.warn('[CardDatabase] Could not synchronize bundled cards:', error);
        return;
      }
      throw new Error('Missing card hash database at /card-hashes.json. Use the Update Card Database button to import a generated card-hashes.json file from this PC.');
    }
  }

  async function replace(next) {
    const normalized = { gridSize: next.gridSize || database.gridSize, cards: next.cards || [] };
    const saved = await storage.save(normalized);
    apply(normalized);
    database.source = 'local';
    database.updatedAt = saved.updatedAt || null;
    debugLog(`[CardDatabase] Replaced locally (${database.cards.length} cards)`);
  }

  async function replaceFromFile(text) {
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.cards) || parsed.cards.length === 0) {
      throw new Error('The selected file does not look like a valid card-hashes.json database.');
    }
    await replace(parsed);
    return parsed.cards.length;
  }

  async function update(source, { onProgress, onMerged = () => {} } = {}) {
    const knownCards = database.cards
      .map((card) => ({ id: String(card.id || '').trim(), sourceImageUrl: sourceImageUrlOf(card) }))
      .filter((card) => card.id);
    const changes = await source.fetch({ knownCards, gridSize: database.gridSize, onProgress });
    const merged = mergeCardDatabaseUpdate({ gridSize: database.gridSize, cards: database.cards }, changes);
    onMerged();
    await replace(merged);
    return { count: merged.cards.length, skippedCards: changes.skippedCards || 0 };
  }

  return database;
}

let cardDatabase = null;

export function getCardDatabase() {
  if (!cardDatabase) cardDatabase = createCardDatabase();
  return cardDatabase;
}
