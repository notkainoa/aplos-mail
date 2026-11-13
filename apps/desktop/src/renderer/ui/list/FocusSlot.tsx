// FocusSlot (DESIGN §4.4, §4.8 `deal`, §5 rule 7, §6). Mockups: home.html.
// The fixed-height Home slot for the focus letter: 196 / 180 / 164 px by density. It never animates height;
// With no summary coming (owner decision 2026-11-13) the slot fits its content instead, so no blank gap shows.
// ui-shell plays `deal` inside it and clones it for the flight ghost through `ref`.

import type { Ref } from 'react';
import type { FocusSlotProps } from '../props';

/** The fixed-height slot that holds the FocusLetter option. */
export function FocusSlot({ density, fit = 'fixed', children, ref }: FocusSlotProps) {
  return (
    <div
      ref={ref as Ref<HTMLDivElement>}
      className="ui-focus-slot"
      data-density={density}
      data-fit={fit === 'content' ? 'content' : undefined}
      role="presentation"
    >
      {children}
    </div>
  );
}
