/**
 * Whether a key has been pressed since `active` last turned on. Home's cleared state keeps the keyboard cursor
 * off the Low band until then, so the bar does not sit there looking like a text caret.
 */
import { useEffect, useState } from 'react';

export function useKeyPressed(active: boolean): boolean {
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    if (!active) {
      setPressed(false);
      return;
    }
    const press = () => setPressed(true);
    window.addEventListener('keydown', press, { once: true });
    return () => window.removeEventListener('keydown', press);
  }, [active]);
  return pressed;
}
