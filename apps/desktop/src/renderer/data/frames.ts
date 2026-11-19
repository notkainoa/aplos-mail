/**
 * The streams `useFrames` serves: `progress`, `connect` and the host `clock` event. The data layer pushes frames in
 * its once-per-animation-frame flush, so a burst of Ask deltas re-renders once per frame (DESIGN 5 rule 13). Frames of
 * a live run or connect flow are kept from its start, so a screen that mounts late still sees the whole run.
 */
import type { Frame } from './contract-shapes';
import type { FrameFilter, FramesView } from './index';
import type { StreamFrameMap, StreamKind } from './ui-types';

type AnyStreamFrame = StreamFrameMap[StreamKind];

/** Runs and flows remembered for late subscribers. */
const RUN_LIMIT = 32;
/** Frames kept per remembered run. */
const RUN_FRAMES = 1_000;
const DEFAULT_MAX = 200;

/** The stream frame inside an engine frame, if it is one. */
export function streamFrame(frame: Frame): { kind: StreamKind; frame: AnyStreamFrame } | null {
  if (frame.frame === 'progress') return { kind: 'progress', frame };
  if (frame.frame === 'connect') return { kind: 'connect', frame };
  if (frame.frame === 'host' && frame.event.type === 'clock')
    return { kind: 'clock', frame: frame.event };
  return null;
}

function runKey(kind: StreamKind, frame: AnyStreamFrame): string | null {
  if (kind === 'progress') return `progress:${(frame as StreamFrameMap['progress']).runId}`;
  if (kind === 'connect') return `connect:${(frame as StreamFrameMap['connect']).connectId}`;
  return null;
}

function matches(frame: AnyStreamFrame, filter: Readonly<Record<string, unknown>>): boolean {
  for (const [field, value] of Object.entries(filter))
    if (value !== undefined && (frame as unknown as Record<string, unknown>)[field] !== value)
      return false;
  return true;
}

/** One subscription's buffer, read through `useSyncExternalStore`. */
export interface FramesSource<F> {
  getSnapshot(): FramesView<F>;
  subscribe(listener: () => void): () => void;
}

interface Subscription {
  readonly kind: StreamKind;
  readonly filter: Readonly<Record<string, unknown>>;
  readonly max: number;
  view: FramesView<AnyStreamFrame>;
  listener: (() => void) | null;
}

export class FrameBus {
  private readonly runs = new Map<string, AnyStreamFrame[]>();
  private readonly subscriptions = new Set<Subscription>();

  push(kind: StreamKind, frame: AnyStreamFrame): void {
    const key = runKey(kind, frame);
    if (key) {
      let log = this.runs.get(key);
      if (!log) {
        this.runs.set(key, (log = []));
        while (this.runs.size > RUN_LIMIT) this.runs.delete(this.runs.keys().next().value!);
      }
      log.push(frame);
      if (log.length > RUN_FRAMES) log.shift();
    }
    for (const sub of this.subscriptions) {
      if (sub.kind !== kind || !matches(frame, sub.filter)) continue;
      const frames = [...sub.view.frames, frame].slice(-sub.max);
      sub.view = { frames, last: frame };
      sub.listener?.();
    }
  }

  open<K extends StreamKind>(
    kind: K,
    filter: FrameFilter<K> | undefined,
    max = DEFAULT_MAX,
  ): FramesSource<StreamFrameMap[K]> {
    const fields = (filter ?? {}) as Readonly<Record<string, unknown>>;
    const runId =
      kind === 'progress' ? fields.runId : kind === 'connect' ? fields.connectId : undefined;
    const seed =
      typeof runId === 'string'
        ? (this.runs.get(`${kind}:${runId}`) ?? []).filter(f => matches(f, fields)).slice(-max)
        : [];
    const sub: Subscription = {
      kind,
      filter: fields,
      max,
      view: { frames: seed, last: seed.at(-1) },
      listener: null,
    };
    return {
      getSnapshot: () => sub.view as FramesView<StreamFrameMap[K]>,
      subscribe: listener => {
        sub.listener = listener;
        this.subscriptions.add(sub);
        return () => {
          sub.listener = null;
          this.subscriptions.delete(sub);
        };
      },
    };
  }
}
