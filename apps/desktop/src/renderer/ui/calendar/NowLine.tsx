import type { CSSProperties } from 'react';
import type { NowLineProps } from '../props';
import { hoursOf, timeOf } from './dates';

/**
 * The now-line: 1 px `--stamp` with a 5 px cap. In the grid it crosses today's column and may cross event text,
 * because hiding it behind events made it nearly invisible (DESIGN 7.8). In the Today agenda it is a row with the
 * time label (DESIGN 7.7). The grid sets `--grid-first` (the first hour shown) on its root.
 */
export function NowLine({ now, variant }: NowLineProps) {
  const time = timeOf(now);
  if (variant === 'agenda') {
    return (
      <div
        className="ui-now-line"
        data-variant="agenda"
        role="separator"
        aria-label={`Now, ${time}`}
      >
        <span className="ui-now-line__time">{time}</span>
        <span className="ui-now-line__rule" aria-hidden="true" />
      </div>
    );
  }
  return (
    <span
      className="ui-now-line"
      data-variant="grid"
      aria-hidden="true"
      style={{ '--now': hoursOf(now) } as CSSProperties}
    />
  );
}
