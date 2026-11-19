// The sealed frame's `message` listener, with its costs in the right order: the host reads layout (style and width)
// only for a report that already passed every check that needs none, and not at all once the growth fence froze.

import { createGrowthFence } from './growth';
import { acceptReport, frameContentWidth, type SizeReport } from './protocol';

/** The frame element as the listener reads it. */
export interface ReportFrame {
  readonly contentWindow: unknown;
  readonly clientWidth: number;
}

export interface ReportListenerOptions {
  frame: () => ReportFrame | null;
  token: string;
  /** Applies the fenced height. */
  setHeight: (height: number) => void;
  /** The first accepted report, once. */
  onFirst: (report: SizeReport) => void;
  /** Computed style of the frame; the browser's by default. Injectable so a test can count layout reads. */
  style?: (frame: ReportFrame) => { paddingLeft: string; paddingRight: string };
}

function browserStyle(frame: ReportFrame) {
  return getComputedStyle(frame as unknown as Element);
}

/** A listener for one frame instance's reports. */
export function createReportListener(options: ReportListenerOptions) {
  const { frame, token, setHeight, onFirst, style = browserStyle } = options;
  const fence = createGrowthFence();
  let reported = false;
  return (event: { source: unknown; origin: string; data: unknown }): void => {
    // Frozen: nothing a report says changes the height or fires onFirst again, so skip it without any read.
    if (fence.frozen()) return;
    const target = frame();
    const report = acceptReport(event, {
      source: target?.contentWindow ?? null,
      origins: ['null'],
      token,
      width: () => (target ? frameContentWidth(target, style(target)) : undefined),
    });
    if (!report) return;
    setHeight(fence.next(report.height));
    if (reported) return;
    reported = true;
    onFirst(report);
  };
}
