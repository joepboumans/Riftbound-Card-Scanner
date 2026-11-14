import { useCallback, useEffect, useState } from 'react';
import { getUserSettings } from '../lib/userSettings.js';

// One saved user setting: [value, change]. Re-renders when it changes,
// wherever the change came from.
export function useSetting(name) {
  const settings = getUserSettings();
  const [, setVersion] = useState(0);
  useEffect(() => settings.subscribe((changed) => {
    if (changed === name) setVersion((version) => version + 1);
  }), [settings, name]);
  const change = useCallback((next) => settings.change(name, next), [settings, name]);
  return [settings.read(name), change];
}
