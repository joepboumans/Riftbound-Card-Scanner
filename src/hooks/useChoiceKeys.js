import { useEffect, useRef } from 'react';
import { choiceKeyAction } from '../lib/userConfirmation.js';

// Choice keys for the Choice strip and Snap review while `active`:
// pick(rank), search(), dismiss().
export function useChoiceKeys(active, { count, pick, search, dismiss }) {
  const latest = useRef();
  latest.current = { count, pick, search, dismiss };
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (event) => {
      const current = latest.current;
      const action = choiceKeyAction(event, { count: current.count });
      if (!action) return;
      event.preventDefault();
      if (action.type === 'pick') current.pick(action.rank);
      else if (action.type === 'search') current.search();
      else current.dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
}
