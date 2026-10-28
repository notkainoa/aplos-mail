// `close` (DESIGN 4.8, 5 rule 7): rows below a departed row stay pinned by
// transform while the hold lasts, then FLIP up to their places when it
// releases. Positions come from fixed row heights, never from measuring, so
// virtualisation does not matter and no layout is read.
import { motionMs, motions } from '../ui/generated/motion';
import { play, type MotionPlan, type Playing } from './animate';
import type { TriageContext } from './signature';

/** The top of every row when laid out in order from `origin`. */
export function layoutTops<K>(
  rows: readonly K[],
  heightOf: (id: K) => number,
  origin = 0,
): Map<K, number> {
  const tops = new Map<K, number>();
  let y = origin;
  for (const id of rows) {
    tops.set(id, y);
    y += heightOf(id);
  }
  return tops;
}

/** For rows in both layouts, how far each moved: before minus after. Unmoved rows are left out. */
export function closeDeltas<K>(
  before: ReadonlyMap<K, number>,
  after: ReadonlyMap<K, number>,
): Map<K, number> {
  const deltas = new Map<K, number>();
  for (const [id, top] of after) {
    const old = before.get(id);
    if (old !== undefined && old !== top) deltas.set(id, old - top);
  }
  return deltas;
}

/** One row's close: from its pinned offset to its place. Null under reduced motion (0 ms). */
export function closePlan(delta: number, context: TriageContext = {}): MotionPlan | null {
  const duration = motionMs('close', 'base', context);
  if (duration <= 0 || delta === 0) return null;
  return {
    motion: 'close',
    duration,
    easing: motions.close.curve,
    keyframes: [{ transform: `translateY(${delta}px)` }, { transform: 'none' }],
  };
}

export interface CloserOptions<K> {
  readonly heightOf: (id: K) => number;
  /** The rendered row element, or null when virtualised out. */
  readonly elementOf: (id: K) => HTMLElement | null;
  readonly origin?: number;
}

export interface Closer<K> {
  /** Records the layout a hold keeps on screen. Finishes a running close first. */
  anchor(rows: readonly K[]): void;
  /** After a change during the hold: pins every surviving row at its anchored top. */
  pin(rows: readonly K[]): void;
  /** The hold released: FLIPs pinned rows to their places. Returns how many rows animate. */
  close(context?: TriageContext): number;
  readonly pinned: ReadonlyMap<K, number>;
  /** Where row `id` of `rows` (the rendered order) is drawn: its layout top plus its pin. Null when absent. */
  drawnTop(rows: readonly K[], id: K): number | null;
  /** Rows still animating their close. */
  readonly running: number;
  /** Ends running closes; rows land in place. */
  finish(): void;
}

export function createCloser<K>(options: CloserOptions<K>): Closer<K> {
  let anchorTops: Map<K, number> | null = null;
  let pinned = new Map<K, number>();
  let playing: Playing[] = [];

  const tops = (rows: readonly K[]) => layoutTops(rows, options.heightOf, options.origin);

  function finish() {
    for (const item of playing) item.stop();
    playing = [];
  }

  return {
    anchor(rows) {
      finish();
      anchorTops = tops(rows);
    },
    pin(rows) {
      if (!anchorTops) return;
      const next = closeDeltas(anchorTops, tops(rows));
      for (const id of pinned.keys()) {
        if (!next.has(id)) {
          const element = options.elementOf(id);
          if (element) element.style.transform = '';
        }
      }
      for (const [id, delta] of next) {
        const element = options.elementOf(id);
        if (element) element.style.transform = `translateY(${delta}px)`;
      }
      pinned = next;
    },
    close(context = {}) {
      finish();
      let count = 0;
      for (const [id, delta] of pinned) {
        const element = options.elementOf(id);
        if (!element) continue;
        element.style.transform = '';
        const plan = closePlan(delta, context);
        if (!plan) continue;
        const item = play(element, plan, () => {
          playing = playing.filter(p => p !== item);
        });
        playing.push(item);
        count += 1;
      }
      pinned = new Map();
      anchorTops = null;
      return count;
    },
    get pinned() {
      return pinned;
    },
    drawnTop(rows, id) {
      let y = options.origin ?? 0;
      for (const row of rows) {
        if (row === id) return y + (pinned.get(id) ?? 0);
        y += options.heightOf(row);
      }
      return null;
    },
    get running() {
      return playing.filter(p => !p.done).length;
    },
    finish,
  };
}
