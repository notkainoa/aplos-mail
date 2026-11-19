import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export const cx = (...parts: (string | false | null | undefined | 0)[]) =>
  parts.filter(Boolean).join(' ');
export const reducedMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Durations in ms; keep in sync with the --dur-* tokens in ui.css. */
export const duration = { instant: 60, fast: 120, base: 160, slow: 200 };

/**
 * Keeps an element mounted for `exitMs` after `open` turns false so CSS can play an exit.
 * Enter animations run from CSS on mount; `closing` drives the exit keyframes.
 */
export function usePresence(open: boolean, exitMs: number = duration.fast) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    if (reducedMotion()) {
      setMounted(false);
      return;
    }
    const timer = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(timer);
  }, [open]);
  return { mounted: mounted || open, closing: !open && mounted };
}

/**
 * Returns an object with the same functions that never changes identity but always calls the latest
 * version, so memoized children are not re-rendered just because a parent recreated its handlers.
 * The set of keys must stay the same between renders.
 */
export function useHandlers<T extends Record<string, (...args: any[]) => any>>(handlers: T): T {
  const latest = useRef(handlers);
  latest.current = handlers;
  const [stable] = useState(() => {
    const out: Record<string, (...args: unknown[]) => unknown> = {};
    for (const key of Object.keys(handlers)) out[key] = (...args) => latest.current[key](...args);
    return out as T;
  });
  return stable;
}

/** Remembers the last non-empty value so exiting content can keep rendering what it showed. */
export function useLatest<T>(value: T | undefined | null) {
  const last = useRef(value);
  if (value !== undefined && value !== null) last.current = value;
  return last.current ?? undefined;
}

export type ListPhase = 'enter' | 'exit' | undefined;
const exitHints = new Map<string, string>();
/** Tell list presence which way an item should leave (e.g. after triage). */
export function hintExit(id: string, direction: 'left' | 'right' | 'down') {
  exitHints.set(id, direction);
  setTimeout(() => {
    if (exitHints.get(id) === direction) exitHints.delete(id);
  }, 1500);
}

/**
 * Animates items that leave or join a list. Only items with an exit hint animate out, so
 * view switches and search results swap instantly; a handful of new items animate in.
 */
export function useListPresence<T>(items: T[], key: (item: T) => string, exitMs = duration.slow) {
  const known = useRef<Set<string> | null>(null);
  const previous = useRef<T[]>(items);
  const born = useRef(Date.now());
  const [exiting, setExiting] = useState<
    { item: T; index: number; direction: string; id: string }[]
  >([]);
  const [entering, setEntering] = useState<Set<string>>(new Set());
  useLayoutEffect(() => {
    const ids = new Set(items.map(key));
    if (!known.current) {
      known.current = ids;
      previous.current = items;
      return;
    }
    const removed = previous.current
      .map((item, index) => ({ item, index, id: key(item) }))
      .filter(entry => !ids.has(entry.id) && exitHints.has(entry.id));
    const added = items.map(key).filter(id => !known.current!.has(id));
    known.current = ids;
    previous.current = items;
    if (reducedMotion()) return;
    if (removed.length)
      setExiting(list => [
        ...list.filter(entry => !ids.has(entry.id)),
        ...removed.map(entry => ({ ...entry, direction: exitHints.get(entry.id)! })),
      ]);
    else
      setExiting(list =>
        list.some(entry => ids.has(entry.id)) ? list.filter(entry => !ids.has(entry.id)) : list,
      );
    if (added.length && added.length <= 3 && Date.now() - born.current > 400)
      setEntering(new Set(added));
  }, [items]);
  useEffect(() => {
    if (!exiting.length) return;
    const timer = setTimeout(() => setExiting([]), exitMs);
    return () => clearTimeout(timer);
  }, [exiting]);
  useEffect(() => {
    if (!entering.size) return;
    const timer = setTimeout(() => setEntering(new Set()), exitMs + 80);
    return () => clearTimeout(timer);
  }, [entering]);
  const merged: { item: T; phase: ListPhase; direction?: string }[] = items.map(item => ({
    item,
    phase: entering.has(key(item)) ? 'enter' : undefined,
  }));
  for (const entry of [...exiting].sort((a, b) => a.index - b.index))
    merged.splice(Math.min(entry.index, merged.length), 0, {
      item: entry.item,
      phase: 'exit',
      direction: entry.direction,
    });
  return merged;
}
