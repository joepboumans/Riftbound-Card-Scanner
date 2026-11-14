import { useCallback, useEffect, useRef } from 'react';
import { ScanSoundPlayer } from '../lib/scanSound.js';
import { getUserSettings } from '../lib/userSettings.js';
import { useSetting } from './useSetting.js';

const currentSettings = () => getUserSettings().read('scanSound');

export function useScanSound() {
  const [settings, changeSettings] = useSetting('scanSound');
  const playerRef = useRef(null);
  if (!playerRef.current) playerRef.current = new ScanSoundPlayer();

  // A change that leaves the sound on comes from a user gesture, here or in
  // Settings: use it to unlock audio so the next accepted scan can ring.
  useEffect(() => getUserSettings().subscribe((name, next) => {
    if (name === 'scanSound' && next.enabled && next.volume > 0) void playerRef.current.unlock();
  }), []);

  useEffect(() => {
    if (!settings.enabled || settings.volume <= 0) return undefined;
    const unlock = () => { void playerRef.current.unlock(); };
    document.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    document.addEventListener('keydown', unlock, true);
    return () => {
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
    };
  }, [settings.enabled, settings.volume]);

  useEffect(() => () => playerRef.current.dispose(), []);

  const updateSettings = useCallback((patch) => {
    changeSettings((previous) => ({ ...previous, ...patch }));
  }, [changeSettings]);

  const playScanAccepted = useCallback(() => {
    const { enabled, volume } = currentSettings();
    return enabled && playerRef.current.play(volume);
  }, []);

  const testSound = useCallback(async () => {
    if (currentSettings().volume <= 0 || !await playerRef.current.unlock()) return false;
    return playerRef.current.play(currentSettings().volume);
  }, []);

  return { settings, updateSettings, playScanAccepted, testSound };
}
