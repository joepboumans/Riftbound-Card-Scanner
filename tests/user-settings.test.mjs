import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserSettings, cameraProfileOf, withCameraProfile } from '../src/lib/userSettings.js';
import { DEFAULT_SCAN_MATCHING } from '../src/lib/scanMatching.js';

// An in-memory stand-in for localStorage. `raw` holds text stored as is.
function memoryStorage(initial = {}, raw = {}) {
  const values = new Map([...Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]), ...Object.entries(raw)]);
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
}
const stored = (storage, key) => JSON.parse(storage.values.get(key));

test('a fresh install gets the default for every setting', () => {
  const settings = createUserSettings({ storage: memoryStorage(), diagnostics: true });
  assert.deepEqual(settings.read('batchDefaults'), { condition: 'Near Mint', language: 'English', foil: false });
  assert.equal(settings.read('modelPreference'), 'quantized');
  assert.equal(settings.read('exportFormat'), 'cardnexus');
  assert.deepEqual(settings.read('scanSetFilter'), []);
  assert.equal(settings.read('priceCurrency'), 'EUR');
  assert.equal(settings.read('cameraDeviceId'), '');
  assert.deepEqual(settings.read('cameraProfiles'), {});
  assert.deepEqual(settings.read('scanSound'), { enabled: true, volume: 0.35 });
  assert.equal(settings.read('scannerDebug'), false);
  assert.equal(settings.read('scanOverlay'), true);
  assert.deepEqual(settings.read('scanMatching'), DEFAULT_SCAN_MATCHING);
});

test('settings saved by an earlier version load with identical values under the same keys', () => {
  const storage = memoryStorage({
    riftbound_batch_defaults: { condition: 'Damaged', language: 'Chinese', foil: true },
    riftbound_model_preference: 'normal',
    riftbound_export_format: 'piltover',
    riftbound_scan_set_filter: ['OGN', 'RAD'],
    riftbound_price_currency: 'USD',
    riftbound_camera_device_id: 'cameraA',
    riftbound_camera_profiles: { cameraA: 'balanced' },
    riftbound_scan_sound: { enabled: false, volume: 0.5 },
    riftbound_scanner_debug_overlay_enabled: true,
    riftbound_scanner_overlay_enabled: false,
    riftbound_scan_matching: { minSimilarity: 0.9, minSimilarityGap: 0.07 },
  });
  const settings = createUserSettings({ storage, diagnostics: true });
  assert.deepEqual(settings.read('batchDefaults'), { condition: 'Damaged', language: 'Chinese', foil: true });
  assert.equal(settings.read('modelPreference'), 'normal');
  assert.equal(settings.read('exportFormat'), 'piltover');
  assert.deepEqual(settings.read('scanSetFilter'), ['OGN', 'RAD']);
  assert.equal(settings.read('priceCurrency'), 'USD');
  assert.equal(settings.read('cameraDeviceId'), 'cameraA');
  assert.deepEqual(settings.read('cameraProfiles'), { cameraA: 'balanced' });
  assert.deepEqual(settings.read('scanSound'), { enabled: false, volume: 0.5 });
  assert.equal(settings.read('scannerDebug'), true);
  assert.equal(settings.read('scanOverlay'), false);
  assert.deepEqual(settings.read('scanMatching'), { minSimilarity: 0.9, minSimilarityGap: 0.07 });
});

test('stored values are cleaned up on load and written back cleaned', () => {
  const storage = memoryStorage({
    riftbound_scan_set_filter: 'ogn',
    riftbound_price_currency: 'xyz',
    riftbound_scan_matching: { minSimilarity: 2 },
    riftbound_scan_sound: { enabled: true, volume: 7 },
    riftbound_scanner_overlay_enabled: 'yes',
  });
  const settings = createUserSettings({ storage, diagnostics: true });
  assert.deepEqual(settings.read('scanSetFilter'), ['OGN']);
  assert.equal(settings.read('priceCurrency'), 'EUR');
  assert.equal(settings.read('scanMatching').minSimilarity, 0.98);
  assert.equal(settings.read('scanSound').volume, 1);
  assert.equal(settings.read('scanOverlay'), false, 'only a stored true turns the overlay on');
  assert.deepEqual(stored(storage, 'riftbound_scan_set_filter'), ['OGN']);
  assert.equal(stored(storage, 'riftbound_price_currency'), 'EUR');
  assert.deepEqual(createUserSettings({ storage: memoryStorage({ riftbound_scan_set_filter: ['all', ' rad '] }) }).read('scanSetFilter'), ['RAD']);
});

test('an unreadable stored value falls back to the default', () => {
  const settings = createUserSettings({ storage: memoryStorage({}, { riftbound_model_preference: '{not json' }) });
  assert.equal(settings.read('modelPreference'), 'quantized');
});

test('a change is normalized, saved straight away and announced', () => {
  const storage = memoryStorage();
  const settings = createUserSettings({ storage });
  const heard = [];
  const stop = settings.subscribe((name, value) => heard.push([name, value]));
  settings.change('priceCurrency', 'usd');
  assert.equal(settings.read('priceCurrency'), 'USD');
  assert.equal(stored(storage, 'riftbound_price_currency'), 'USD');
  settings.change('scanMatching', (previous) => ({ ...previous, minSimilarity: 0.5 }));
  assert.deepEqual(settings.read('scanMatching'), { ...DEFAULT_SCAN_MATCHING, minSimilarity: 0.68 });
  stop();
  settings.change('exportFormat', 'piltover');
  assert.deepEqual(heard, [['priceCurrency', 'USD'], ['scanMatching', { ...DEFAULT_SCAN_MATCHING, minSimilarity: 0.68 }]]);
});

test('a storage failure keeps the change for this session', (t) => {
  t.mock.method(console, 'warn', () => {});
  const storage = { getItem: () => null, setItem() { throw new Error('Quota'); } };
  const settings = createUserSettings({ storage });
  settings.change('modelPreference', 'normal');
  assert.equal(settings.read('modelPreference'), 'normal');
});

test('outside development the scanner debug setting is always off and never saved', () => {
  const storage = memoryStorage({ riftbound_scanner_debug_overlay_enabled: true });
  const settings = createUserSettings({ storage, diagnostics: false });
  assert.equal(settings.read('scannerDebug'), false);
  storage.values.set('riftbound_scanner_debug_overlay_enabled', 'true');
  settings.change('scannerDebug', true);
  assert.equal(settings.read('scannerDebug'), false);
  assert.equal(storage.values.get('riftbound_scanner_debug_overlay_enabled'), 'true', 'left as it was');
});

test('the snapshot holds every setting under its storage key', () => {
  const settings = createUserSettings({ storage: memoryStorage(), diagnostics: true });
  settings.change('scanOverlay', false);
  const snapshot = settings.snapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), ['riftbound_batch_defaults', 'riftbound_camera_device_id', 'riftbound_camera_profiles',
    'riftbound_export_format', 'riftbound_model_preference', 'riftbound_price_currency', 'riftbound_scan_matching',
    'riftbound_scan_set_filter', 'riftbound_scan_sound', 'riftbound_scanner_debug_overlay_enabled', 'riftbound_scanner_overlay_enabled']);
  assert.equal(snapshot.riftbound_scanner_overlay_enabled, false);
});

test('the capture profile is kept separately for each selected camera', () => {
  const settings = createUserSettings({ storage: memoryStorage({ riftbound_camera_profiles: { cameraA: 'balanced' } }) });
  const profile = () => cameraProfileOf(settings.read('cameraProfiles'), settings.read('cameraDeviceId'));
  const setProfile = (value) => settings.change('cameraProfiles', (profiles) => withCameraProfile(profiles, settings.read('cameraDeviceId'), value));
  assert.equal(profile(), 'auto', 'the default camera has no profile yet');
  settings.change('cameraDeviceId', 'cameraA');
  assert.equal(profile(), 'balanced');
  settings.change('cameraDeviceId', 'cameraB');
  assert.equal(profile(), 'auto');
  setProfile('low-light');
  assert.equal(profile(), 'low-light');
  setProfile('not-a-profile');
  assert.equal(profile(), 'auto');
  settings.change('cameraDeviceId', 'cameraA');
  assert.equal(profile(), 'balanced');
});
