/**
 * Spinner: a quiet indicator that appears only after 150 ms, never for local reads (DESIGN 5 rule 12, 6).
 * 12 px ('sm') beside 12 px lines and chips, 16 px elsewhere. The space is held while it waits, so nothing moves.
 */
import { useEffect, useState } from 'react';
import { timing } from '../generated/motion';
import type { ComponentPropsMap } from '../props';

/** The arc itself, shared with the first-sync checklist marker (which needs no delay). */
export function SpinnerGlyph() {
  return (
    <svg className="ui-spinner__glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle className="ui-spinner__track" cx="12" cy="12" r="8.5" />
      <circle
        className="ui-spinner__arc"
        cx="12"
        cy="12"
        r="8.5"
        pathLength="100"
        strokeDasharray="26 74"
      />
    </svg>
  );
}

export function Spinner({ label, size = 'md' }: ComponentPropsMap['Spinner']) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), timing.spinnerDelay);
    return () => clearTimeout(t);
  }, []);
  return (
    <span
      className="ui-spinner"
      data-size={size}
      data-state={shown ? 'shown' : 'waiting'}
      role="img"
      aria-label={label}
      aria-hidden={shown ? undefined : true}
    >
      <SpinnerGlyph />
    </span>
  );
}
