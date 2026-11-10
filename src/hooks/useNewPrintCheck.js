import { useCallback, useEffect, useRef, useState } from 'react';
import { dismissNewPrintNotice, runNewPrintCheck } from '../lib/newPrintCheck.js';

// Runs the new-print check once the app is ready. `count` is how many new cards the
// notice shows; `later` hides it until that number changes; `refresh` recounts against
// the local card database (e.g. after an update) without fetching the gallery again.
export function useNewPrintCheck({ ready, getKnownIds }) {
  const [count, setCount] = useState(0);
  const started = useRef(false);

  const refresh = useCallback(async () => {
    setCount(await runNewPrintCheck({ knownIds: getKnownIds() }));
  }, [getKnownIds]);

  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    refresh();
  }, [ready, refresh]);

  const later = useCallback(() => {
    dismissNewPrintNotice(count);
    setCount(0);
  }, [count]);

  return { count, later, refresh };
}
