import { EXPORT_FORMATS } from './csvExporter.js';
import { normalizePriceCurrency } from './priceFormat.js';
import { SCAN_SOUND_STORAGE_KEY, normalizeScanSound } from './scanSound.js';
import { SCAN_MATCHING_STORAGE_KEY, normalizeScanMatching } from './scanMatching.js';
import { SCANNER_DEBUG_KEY, SCANNER_OVERLAY_KEY, SCANNER_DIAGNOSTICS_AVAILABLE } from './scannerExperiments.js';

const keep = (value) => value;
const onlyTrue = (value) => value === true;

function normalizeSetFilter(value) {
  const codes = Array.isArray(value) ? value : [value];
  return codes.map((code) => String(code || '').trim().toUpperCase()).filter((code) => code && code !== 'ALL');
}

// Every saved user setting, declared once: its localStorage key (unchanged
// from earlier versions), its default and how a stored value is cleaned up.
// `diagnostics: true` settings exist only in development builds.
const SETTINGS = {
  batchDefaults: { key: 'riftbound_batch_defaults', defaultValue: { condition: 'Near Mint', language: 'English', foil: false }, normalize: keep },
  // Which detector weights to load: 'normal' or 'quantized'.
  detectorWeights: { key: 'riftbound_model_preference', defaultValue: 'quantized', normalize: keep },
  exportFormat: { key: 'riftbound_export_format', defaultValue: EXPORT_FORMATS.CARDNEXUS, normalize: keep },
  scanSetFilter: { key: 'riftbound_scan_set_filter', defaultValue: [], normalize: normalizeSetFilter },
  priceCurrency: { key: 'riftbound_price_currency', defaultValue: 'EUR', normalize: normalizePriceCurrency },
  cameraDeviceId: { key: 'riftbound_camera_device_id', defaultValue: '', normalize: keep },
  cameraProfiles: { key: 'riftbound_camera_profiles', defaultValue: {}, normalize: keep },
  scanSound: { key: SCAN_SOUND_STORAGE_KEY, defaultValue: null, normalize: normalizeScanSound },
  scannerDebug: { key: SCANNER_DEBUG_KEY, defaultValue: false, normalize: onlyTrue, diagnostics: true },
  scanOverlay: { key: SCANNER_OVERLAY_KEY, defaultValue: true, normalize: onlyTrue },
  scanMatching: { key: SCAN_MATCHING_STORAGE_KEY, defaultValue: null, normalize: normalizeScanMatching },
};

function load(storage, { key, defaultValue }) {
  try {
    const stored = storage.getItem(key);
    return stored ? JSON.parse(stored) : defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * The user's saved settings: loaded once, saved on every change.
 *
 *   read(name)             the current value
 *   change(name, next)     `next` is the new value or a function of the
 *                          current one; the result is cleaned up and saved.
 *                          Setting the very same value again does nothing
 *   subscribe(listener)    listener(name, value) after each change; returns
 *                          a function that stops listening
 *   snapshot()             { storageKey: value } for every setting, for the
 *                          flush before an app update installs
 *
 * A storage failure keeps the change for this session only.
 */
export function createUserSettings({ storage = globalThis.localStorage, diagnostics = SCANNER_DIAGNOSTICS_AVAILABLE } = {}) {
  const values = new Map();
  const listeners = new Set();
  const available = (definition) => !definition.diagnostics || diagnostics;
  const save = (definition, value) => {
    if (!available(definition)) return;
    try {
      storage.setItem(definition.key, JSON.stringify(value));
    } catch (error) {
      console.warn('[Storage] Failed to save:', error);
    }
  };
  const definitionOf = (name) => {
    const definition = SETTINGS[name];
    if (!definition) throw new Error(`Unknown setting: ${name}`);
    return definition;
  };

  for (const [name, definition] of Object.entries(SETTINGS)) {
    const value = available(definition) ? definition.normalize(load(storage, definition)) : definition.normalize(definition.defaultValue);
    values.set(name, value);
    // Write the cleaned-up value back, so older formats are replaced.
    save(definition, value);
  }

  return {
    read: (name) => (definitionOf(name), values.get(name)),
    change(name, next) {
      const definition = definitionOf(name);
      if (!available(definition)) return;
      const value = definition.normalize(typeof next === 'function' ? next(values.get(name)) : next);
      if (Object.is(value, values.get(name))) return;
      values.set(name, value);
      save(definition, value);
      for (const listener of listeners) listener(name, value);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => Object.fromEntries(Object.entries(SETTINGS).map(([name, { key }]) => [key, values.get(name)])),
  };
}

let userSettings = null;

export function getUserSettings() {
  if (!userSettings) userSettings = createUserSettings();
  return userSettings;
}

// For change(): merges `patch` into an object setting such as scanSound.
export const withPatch = (patch) => (previous) => ({ ...previous, ...patch });
