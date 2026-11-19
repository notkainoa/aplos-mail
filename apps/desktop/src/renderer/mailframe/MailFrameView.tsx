// The double buffer (DESIGN 5 rule 10, plan 30 section 4.4 host duties). The shown letter stays until the pending one
// has been laid out at the final width and reported; then the pending slot becomes the shown one in place (same React
// key, so a frame is never reloaded). While a letter is awaited past 1.5 s, the 12 px loading line shows under the
// previous letter. The paper is never empty once a letter has been shown. A frame that has not reported within the
// deadline (deadline.ts, 10 s) shows the failed state instead, and its late report is refused.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ErrorLine } from '../ui/list';
import { LoadingLine } from '../ui/reader';
import { createFrameDeadline, FRAME_TIMEOUT_MS, type FrameDeadline } from './deadline';
import { createMeasuredHandler } from './measured';
import { SrcdocSlot, TextSlot, UrlSlot, type SlotProps } from './slots';
import type { FrameSource, MailFrameKey, MailFrameReady } from './types';

/** When the loading line appears (DESIGN 5 rule 10; the data layer's BODY_SLOW_MS). */
export const SLOW_MS = 1_500;
/** The loading line's words. */
export const LOADING_LABEL = 'Loading this email…';

/** Props of the presentational host; MailFrame feeds it from the data layer. */
export interface MailFrameViewProps {
  /** The letter for the current request, or null while it is still being fetched. */
  source: FrameSource | null;
  /** Find query for plain text (HTML sources carry their own). */
  findQuery?: string;
  /** Plain text: draw its quoted history. */
  showQuoted?: boolean;
  /** The loading line's words; default `LOADING_LABEL`. */
  label?: string;
  /** Set when the body or frame failed: "Couldn't load this email." with Try again. */
  failed?: { retry: () => void } | null;
  onReady: (ready: MailFrameReady) => void;
  onKey: (key: MailFrameKey) => boolean | void;
  /** A shown letter was replaced or unmounted (release its frame token). */
  onRetire?: (source: FrameSource) => void;
  /** How long a frame may take to report before the failed state shows; default `FRAME_TIMEOUT_MS` (10 s). */
  timeoutMs?: number;
  /** Try again after a frame timed out: ask the data layer for the letter again. Default: remount the same frame. */
  reload?: () => void;
}

/** The deadline state for the pending frame: which key has timed out, and how to try again. */
interface Deadline {
  deadline: FrameDeadline;
  expiredKey: string | null;
  tryAgain: () => void;
}

/** Watch the pending frame (not plain text, which measures synchronously) until it reports or times out. */
function useDeadline(pending: FrameSource | null, timeoutMs: number): Deadline {
  const [expiredKey, setExpiredKey] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const deadline = useMemo(() => createFrameDeadline(setExpiredKey, timeoutMs), [timeoutMs]);
  const key = pending && pending.kind !== 'text' ? pending.key : null;
  useEffect(() => {
    if (key) deadline.watch(key);
    return () => deadline.cancel();
  }, [deadline, key, round]);
  const tryAgain = useCallback(() => {
    setExpiredKey(null);
    setRound(n => n + 1);
  }, []);
  return { deadline, expiredKey, tryAgain };
}

function useSlow(waiting: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [waiting]);
  return slow;
}

/**
 * Retire (release) every letter that is neither shown nor pending, exactly once. Unmount retires the rest a microtask
 * later unless the component mounted again (StrictMode's dev double mount must not release a live frame).
 */
function useRetire(
  shown: FrameSource | null,
  pending: FrameSource | null,
  onRetire: ((source: FrameSource) => void) | undefined,
) {
  const live = useRef(new Map<string, FrameSource>());
  const retire = useRef(onRetire);
  const mounted = useRef(false);
  useEffect(() => {
    retire.current = onRetire;
  });
  useEffect(() => {
    for (const s of [shown, pending]) if (s) live.current.set(s.key, s);
    for (const [key, s] of live.current) {
      if (key === shown?.key || key === pending?.key) continue;
      live.current.delete(key);
      retire.current?.(s);
    }
  }, [shown, pending]);
  useEffect(() => {
    const letters = live.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (mounted.current) return;
        for (const s of letters.values()) retire.current?.(s);
        letters.clear();
      });
    };
  }, []);
}

function slot(source: FrameSource, props: Omit<SlotProps<FrameSource>, 'source'>): ReactNode {
  if (source.kind === 'srcdoc') return <SrcdocSlot key={source.key} source={source} {...props} />;
  if (source.kind === 'url') return <UrlSlot key={source.key} source={source} {...props} />;
  return <TextSlot key={source.key} source={source} {...props} />;
}

/** Shows `shown`, buffers `source` until it reports, then swaps. */
export function MailFrameView({
  source,
  findQuery,
  showQuoted,
  label,
  failed,
  onReady,
  onKey,
  onRetire,
  timeoutMs = FRAME_TIMEOUT_MS,
  reload,
}: MailFrameViewProps) {
  const [shown, setShown] = useState<FrameSource | null>(null);
  const latest = useRef({ source, onReady });
  latest.current = { source, onReady };
  const shownRef = useRef(shown);
  const pending = source && source.key !== shown?.key ? source : null;
  const { deadline, expiredKey, tryAgain } = useDeadline(pending, timeoutMs);
  const timedOut = pending !== null && pending.key === expiredKey;
  const retryTimedOut = () => {
    tryAgain();
    reload?.();
  };
  const failure = failed ?? (timedOut ? { retry: retryTimedOut } : null);
  const slow = useSlow(!failure && (source === null || pending !== null));

  const onMeasured = useMemo(
    () =>
      createMeasuredHandler({
        deadline,
        latest: () => latest.current,
        shownKey: () => shownRef.current?.key ?? null,
        show: measured => {
          shownRef.current = measured;
          setShown(measured);
        },
      }),
    [deadline],
  );

  useRetire(shown, pending, onRetire);

  const common = { findQuery, showQuoted, onMeasured, onKey };
  return (
    <div
      className="aplos-mailframe"
      style={{ position: 'relative' }}
      data-waiting={pending ? '' : undefined}
    >
      {failure ? (
        <ErrorLine kind="bodyFailed" placement="column" onAction={() => failure.retry()} />
      ) : null}
      {!failure && slow ? <LoadingLine label={label ?? LOADING_LABEL} /> : null}
      {!failure && shown ? slot(shown, { ...common, hidden: false }) : null}
      {!failure && pending ? slot(pending, { ...common, hidden: true }) : null}
    </div>
  );
}
