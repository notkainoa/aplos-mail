// The double buffer (DESIGN 5 rule 10, plan 30 section 4.4 host duties). The shown letter stays until the pending one
// has been laid out at the final width and reported; then the pending slot becomes the shown one in place (same React
// key, so a frame is never reloaded). While a letter is awaited past 1.5 s, the 12 px loading line shows under the
// previous letter. The paper is never empty once a letter has been shown.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ErrorLine } from '../ui/list';
import { LoadingLine } from '../ui/reader';
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
  /** Set when the body or frame failed: "Couldn't load this email." with Try again. */
  failed?: { retry: () => void } | null;
  onReady: (ready: MailFrameReady) => void;
  onKey: (key: MailFrameKey) => boolean | void;
  /** A shown letter was replaced or unmounted (release its frame token). */
  onRetire?: (source: FrameSource) => void;
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
  failed,
  onReady,
  onKey,
  onRetire,
}: MailFrameViewProps) {
  const [shown, setShown] = useState<FrameSource | null>(null);
  const latest = useRef({ source, onReady });
  latest.current = { source, onReady };
  const shownRef = useRef(shown);
  const pending = source && source.key !== shown?.key ? source : null;
  const slow = useSlow(!failed && (source === null || pending !== null));

  const onMeasured = useCallback((measured: FrameSource, ready: MailFrameReady) => {
    const previous = shownRef.current;
    // Ignore a report from a letter that is no longer the one asked for, or one already shown.
    if (latest.current.source?.key !== measured.key || previous?.key === measured.key) return;
    shownRef.current = measured;
    setShown(measured);
    latest.current.onReady(ready);
  }, []);

  useRetire(shown, pending, onRetire);

  const common = { findQuery, onMeasured, onKey };
  return (
    <div
      className="aplos-mailframe"
      style={{ position: 'relative' }}
      data-waiting={pending ? '' : undefined}
    >
      {failed ? (
        <ErrorLine kind="bodyFailed" placement="column" onAction={() => failed.retry()} />
      ) : null}
      {!failed && slow ? <LoadingLine label={LOADING_LABEL} /> : null}
      {!failed && shown ? slot(shown, { ...common, hidden: false }) : null}
      {!failed && pending ? slot(pending, { ...common, hidden: true }) : null}
    </div>
  );
}
