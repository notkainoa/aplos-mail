/**
 * Where the owner was when a thread opened, so Esc puts them back there.
 *
 * A list screen (Home, a section, the Low importance sheet, a search, the one-by-one walk) unmounts when the reader
 * opens, taking its cursor, scroll offset and sheet with it. While it is mounted it registers a source; `openThread`
 * reads every source once (`saveReturnPoints`) and Esc arms the return (`armReturn`) before the screen comes back,
 * which takes its point once (`takeReturnPoint`) and starts from it.
 *
 * A point lives only for that one return: any other way of showing a screen (the sidebar, a command) drops them.
 */
import type { Screen } from './store-route';

/** What one surface remembers of itself. */
export interface ReturnPoint {
  /** The row under the cursor (a thread id; Home's Low band has its own key). */
  readonly cursorId: string | null;
  /** The surface's row keys in order, to find a neighbour when the cursor's row has since left. */
  readonly order: readonly string[];
  /** The scroll offset of the surface's scroller. */
  readonly scrollTop: number;
  /** The cursor row's index in the whole view, for a list longer than one window (the window must reach it before the cursor can land). */
  readonly index?: number;
  /** Whatever else the surface wants back (an open sheet, a search's query). */
  readonly extra?: unknown;
}

/** The key a screen's point is stored under: a place's own name, `label:<name>` for a label screen. */
export function returnKeyOf(screen: Screen): string {
  return typeof screen === 'string' ? screen : `label:${screen.label}`;
}

/** A surface's reader; null while it has nothing to remember. */
export type ReturnReader = () => ReturnPoint | null;

const sources = new Map<symbol, { readonly key: string; readonly read: ReturnReader }>();
const points = new Map<string, ReturnPoint>();
let armed: string | null = null;

/** Registers a surface under `key` while it is mounted; returns the unregister. */
export function registerReturnSource(key: string, read: ReturnReader): () => void {
  const id = Symbol(key);
  sources.set(id, { key, read });
  return () => {
    sources.delete(id);
  };
}

/** The point with its cursor on `id` (a row of its order), its absolute index shifted by the same distance. */
function withCursor(point: ReturnPoint, id: string): ReturnPoint {
  const was = point.cursorId === null ? -1 : point.order.indexOf(point.cursorId);
  const shift = was < 0 || point.index === undefined ? 0 : point.order.indexOf(id) - was;
  const index = point.index === undefined ? undefined : point.index + shift;
  return { ...point, cursorId: id, index };
}

/** Reads every mounted surface, pointing each one that holds `opened` at it. Surfaces that are not mounted keep what they had. */
export function saveReturnPoints(opened: string): void {
  for (const { key, read } of sources.values()) {
    const point = read();
    if (point === null) continue;
    points.set(key, point.order.includes(opened) ? withCursor(point, opened) : point);
  }
}

/** The thread the reader now shows is the one to land on, in every surface whose rows include it. */
export function followReturnCursor(current: string | null): void {
  if (current === null) return;
  for (const [key, point] of points) {
    if (point.order.includes(current) && point.cursorId !== current) {
      points.set(key, withCursor(point, current));
    }
  }
}

/** The screen about to be shown is the one the reader is returning to: its points survive. */
export function armReturn(screen: Screen): void {
  armed = returnKeyOf(screen);
}

/** A screen is being shown: unless it is the armed return, the saved points are stale. */
export function settleReturn(screen: Screen): void {
  if (armed !== returnKeyOf(screen)) points.clear();
  armed = null;
}

/**
 * The point saved under `key`, once. The entry goes at the end of the tick, so a render that runs twice (a strict
 * remount) reads the same point both times.
 */
export function takeReturnPoint(key: string): ReturnPoint | null {
  const point = points.get(key) ?? null;
  if (point) {
    setTimeout(() => {
      if (points.get(key) === point) points.delete(key);
    }, 0);
  }
  return point;
}

/** Forgets the saved places, keeping the mounted surfaces registered (the account scope changed under them). */
export function dropReturnPoints(): void {
  points.clear();
}

/** Forgets everything (tests, and a lost window). */
export function resetReturnPoints(): void {
  sources.clear();
  points.clear();
  armed = null;
}

/**
 * The row to land on: the saved cursor when its row is still there, else the nearest row that is (the one that took
 * its place first, then the one above, then outwards). Null when no saved row survives.
 */
export function restoreKey(point: ReturnPoint, keys: readonly string[]): string | null {
  const live = new Set(keys);
  const at = point.cursorId === null ? -1 : point.order.indexOf(point.cursorId);
  if (point.cursorId !== null && live.has(point.cursorId)) return point.cursorId;
  if (at < 0) return null;
  for (let step = 1; step < point.order.length; step += 1) {
    const below = point.order[at + step];
    if (below !== undefined && live.has(below)) return below;
    const above = point.order[at - step];
    if (above !== undefined && live.has(above)) return above;
  }
  return null;
}
