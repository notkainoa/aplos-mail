import type { CSSProperties } from 'react';
import type { LevelMeterProps } from '../props';

const BARS = [0, 1, 2, 3, 4] as const;

/**
 * A small `--stamp` bar meter for dictation; the breathing ring is gone (DESIGN §6 LevelMeter, §7.6).
 * The level reaches the bars as one CSS custom property, `--level` (0 to 1), so the voice hook can write it per frame
 * through `ref` without a React render (DESIGN §5 rule 3). The bars themselves are drawn by `compose.css`.
 */
export function LevelMeter({ level, label, ref }: LevelMeterProps) {
  const value = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  return (
    <span
      ref={ref}
      className="ui-level-meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={value}
      data-state={value > 0 ? 'active' : 'idle'}
      style={{ '--level': value } as CSSProperties}
    >
      {BARS.map(bar => (
        <i key={bar} aria-hidden="true" />
      ))}
    </span>
  );
}
