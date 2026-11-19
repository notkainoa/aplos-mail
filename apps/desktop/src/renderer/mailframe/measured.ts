// What the double buffer does with a slot's first report (MailFrameView). Pure, so the refusals are unit-tested
// without a DOM, including a report that arrives after the deadline while the slot is still mounted (React unmounts
// it a render later).

import type { FrameDeadline } from './deadline';
import type { FrameSource, MailFrameReady } from './types';

export interface MeasuredState {
  deadline: FrameDeadline;
  /** The letter asked for and the callback to tell, read when a report arrives. */
  latest: () => { source: FrameSource | null; onReady: (ready: MailFrameReady) => void };
  /** The shown letter's key, or null. */
  shownKey: () => string | null;
  /** Make `measured` the shown letter. */
  show: (measured: FrameSource) => void;
}

/** The handler for a slot's `onMeasured`. */
export function createMeasuredHandler(state: MeasuredState) {
  return (measured: FrameSource, ready: MailFrameReady): void => {
    // Ignore a report from a letter that is no longer the one asked for, or one already shown.
    const { source, onReady } = state.latest();
    if (source?.key !== measured.key || state.shownKey() === measured.key) return;
    // A report after the deadline is refused: the failed state stays until Try again.
    if (!state.deadline.settle(measured.key)) return;
    state.show(measured);
    onReady(ready);
  };
}
