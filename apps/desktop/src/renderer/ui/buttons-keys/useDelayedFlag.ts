import { useEffect, useState } from 'react';

/** True once `active` has been true for `delayMs`; false again the moment it ends. Spinners use it so none shows under 150 ms (DESIGN §5 rule 12). */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!active) {
      setReady(false);
      return;
    }
    const timer = setTimeout(() => setReady(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return active && ready;
}
