import { isDesktopRuntime } from './runtime.js';
import { invokeDesktopCommand } from './desktopBridge.js';

export const NEW_PRINT_CHECK_STORAGE_KEY = 'riftbound_new_print_check';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function loadState(storage) {
  try {
    const state = JSON.parse(storage.getItem(NEW_PRINT_CHECK_STORAGE_KEY) || 'null');
    return state && typeof state === 'object' ? state : {};
  } catch {
    return {};
  }
}

function saveState(storage, state) {
  try {
    storage.setItem(NEW_PRINT_CHECK_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage is a convenience here; the next start simply checks again.
  }
}

// New-print check: on desktop, at most once a day, compares the gallery's ids with the
// local card database. Between checks the last result is reused. Returns how many new
// cards the notice should show (0 = no notice).
export async function runNewPrintCheck({
  desktop = isDesktopRuntime(),
  knownIds = [],
  checkNewPrints = (ids) => invokeDesktopCommand('check_new_prints', { knownIds: ids }),
  storage = globalThis.localStorage,
  now = Date.now(),
} = {}) {
  if (!desktop) return 0;

  let state = loadState(storage);
  const checkedAt = Number(state.checkedAt);
  if (!Number.isFinite(checkedAt) || now - checkedAt >= CHECK_INTERVAL_MS) {
    // The attempt counts even if it fails, so an offline start does not retry all day.
    state = { ...state, checkedAt: now };
    saveState(storage, state);
    try {
      state = { ...state, newIds: await checkNewPrints(knownIds) };
      saveState(storage, state);
    } catch (error) {
      console.info('[NewPrintCheck] Skipped:', error?.message || error);
    }
  }

  const local = new Set(knownIds);
  const count = Array.isArray(state.newIds) ? state.newIds.filter((id) => !local.has(id)).length : 0;
  return count === state.dismissedCount ? 0 : count;
}

// "Later": hides the notice until the number of new cards differs from `count`.
export function dismissNewPrintNotice(count, storage = globalThis.localStorage) {
  saveState(storage, { ...loadState(storage), dismissedCount: count });
}
