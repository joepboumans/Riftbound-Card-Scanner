import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, componentProps, button } from './helpers/runtime.mjs';
import { dismissNewPrintNotice, runNewPrintCheck } from '../src/lib/newPrintCheck.js';

const DAY = 24 * 60 * 60 * 1000;
const settle = () => new Promise((resolve) => setImmediate(resolve));

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
}

function galleryWith(galleryIds) {
  const calls = [];
  const checkNewPrints = async (knownIds) => { calls.push(knownIds); return galleryIds.filter((id) => !knownIds.includes(id)); };
  return { calls, checkNewPrints };
}

test('the new-print check never runs outside the desktop app', async () => {
  const gallery = galleryWith(['rad-sp4-005']);
  const count = await runNewPrintCheck({ desktop: false, knownIds: [], storage: memoryStorage(), now: 0, checkNewPrints: gallery.checkNewPrints });
  assert.equal(count, 0);
  assert.equal(gallery.calls.length, 0);
});

test('the check counts gallery ids missing from the local card database', async () => {
  const gallery = galleryWith(['ogn-001', 'rad-sp4-005', 'unl-t04']);
  const count = await runNewPrintCheck({ desktop: true, knownIds: ['ogn-001'], storage: memoryStorage(), now: 0, checkNewPrints: gallery.checkNewPrints });
  assert.equal(count, 2);
  assert.deepEqual(gallery.calls, [['ogn-001']]);
});

test('the gallery is fetched at most once a day', async () => {
  const storage = memoryStorage();
  const gallery = galleryWith(['ogn-001', 'rad-sp4-005']);
  const run = (now) => runNewPrintCheck({ desktop: true, knownIds: ['ogn-001'], storage, now, checkNewPrints: gallery.checkNewPrints });
  assert.equal(await run(1000), 1);
  assert.equal(await run(1000 + DAY - 1), 1, 'a restart the same day still shows the last result');
  assert.equal(gallery.calls.length, 1);
  await run(1000 + DAY);
  assert.equal(gallery.calls.length, 2);
});

test('cards added by an update stop counting before the next daily check', async () => {
  const storage = memoryStorage();
  const gallery = galleryWith(['ogn-001', 'rad-sp4-005', 'unl-t04']);
  const run = (knownIds, now) => runNewPrintCheck({ desktop: true, knownIds, storage, now, checkNewPrints: gallery.checkNewPrints });
  assert.equal(await run(['ogn-001'], 0), 2);
  assert.equal(await run(['ogn-001', 'rad-sp4-005', 'unl-t04'], 60_000), 0);
  assert.equal(gallery.calls.length, 1);
});

test('the check is silent when offline and does not retry the same day', async () => {
  const storage = memoryStorage();
  let attempts = 0;
  const offline = async () => { attempts += 1; throw new Error('Failed to download Riot card gallery: dns error'); };
  const run = (now) => runNewPrintCheck({ desktop: true, knownIds: ['ogn-001'], storage, now, checkNewPrints: offline });
  assert.equal(await run(0), 0);
  assert.equal(await run(60_000), 0);
  assert.equal(attempts, 1);
});

test('"Later" hides the notice until the number of new cards changes', async () => {
  const storage = memoryStorage();
  const galleryIds = ['ogn-001', 'rad-sp4-005', 'unl-t04'];
  const gallery = galleryWith(galleryIds);
  const run = (now) => runNewPrintCheck({ desktop: true, knownIds: ['ogn-001'], storage, now, checkNewPrints: gallery.checkNewPrints });
  assert.equal(await run(0), 2);
  dismissNewPrintNotice(2, storage);
  assert.equal(await run(60_000), 0);
  assert.equal(await run(DAY), 0, 'same count on the next daily check stays hidden');
  galleryIds.push('sfd-001');
  assert.equal(await run(2 * DAY), 3);
});

function desktopRuntime(galleryIds, invoked = []) {
  return createRuntime({ globals: { __TAURI_INTERNALS__: {} }, mocks: { '@tauri-apps/api/core': {
    invoke: async (command, payload) => {
      invoked.push(command);
      if (command !== 'check_new_prints') throw new Error(`unexpected command ${command}`);
      return galleryIds.filter((id) => !payload.knownIds.includes(id));
    },
  } } });
}

test('once the app is ready the desktop app asks the gallery for new prints and "Later" hides the notice', async () => {
  const invoked = [];
  const runtime = desktopRuntime(['ogn-001', 'rad-sp4-005', 'unl-t04'], invoked);
  const view = runtime.mount(runtime.load('src/hooks/useNewPrintCheck.js').useNewPrintCheck);
  const props = { ready: false, getKnownIds: () => ['ogn-001'] };
  view.render(props);
  view.runEffects(); await settle();
  assert.deepEqual(invoked, [], 'nothing runs while the app is loading');
  view.render({ ...props, ready: true });
  view.runEffects(); await settle();
  assert.equal(view.render({ ...props, ready: true }).count, 2);
  view.render({ ...props, ready: true }).later();
  assert.equal(view.render({ ...props, ready: true }).count, 0);
  view.runEffects(); await settle();
  assert.deepEqual(invoked, ['check_new_prints']);
});

test('the notice shows the count and offers Update and Later', () => {
  const runtime = createRuntime();
  const NewPrintNotice = runtime.load('src/components/NewPrintNotice.jsx').default;
  assert.equal(NewPrintNotice({ count: 0, onUpdate() {}, onLater() {} }), null);
  const calls = [];
  const tree = NewPrintNotice({ count: 3, onUpdate: () => calls.push('update'), onLater: () => calls.push('later') });
  assert.match(JSON.stringify(tree), /3 new cards available/);
  button(tree, 'Update').onClick();
  button(tree, 'Later').onClick();
  assert.deepEqual(calls, ['update', 'later']);
  assert.match(JSON.stringify(NewPrintNotice({ count: 1, onUpdate() {}, onLater() {} })), /1 new card available/);
});

test('Update on the notice runs the normal in-app card database update', async () => {
  const invoked = [];
  const runtime = createRuntime({ globals: { __TAURI_INTERNALS__: {} }, mocks: {
    'src/hooks/useNewPrintCheck.js': { useNewPrintCheck: () => ({ count: 2, later() {}, refresh: async () => {} }) },
    '@tauri-apps/api/event': { listen: async () => () => {} },
    '@tauri-apps/api/core': { invoke: async (command) => { invoked.push(command); throw new Error('offline'); } },
  } });
  const app = runtime.mount(runtime.load('src/App.jsx').default, [false]);
  await componentProps(app.render(), 'NewPrintNotice').onUpdate();
  assert.deepEqual(invoked, ['update_card_database']);
});

test('unreadable stored check state is ignored', async () => {
  const storage = memoryStorage();
  storage.setItem('riftbound_new_print_check', '{not json');
  const gallery = galleryWith(['rad-sp4-005']);
  assert.equal(await runNewPrintCheck({ desktop: true, knownIds: [], storage, now: 0, checkNewPrints: gallery.checkNewPrints }), 1);
});
