/**
 * The one-by-one walk (DESIGN 7.2's "Go one by one", key S): the Do-now ids snapshotted when the walk starts,
 * and where the walk stands in them. One thread shows at a time; E, L and Space commit it (R and Return open it in the reader) and the walk
 * moves on, J/K move, Esc exits. The queue is fixed — mail arriving during a walk never joins it — while
 * `live` is Do now as it stands, so a thread acted elsewhere is simply skipped. Pure: no React, no engine.
 */

/** A walk in progress. */
export interface Walk {
  /** The Do-now ids as they were when the walk started; fixed for the walk's life. */
  readonly queue: readonly string[];
  /** Where the walk stands in `queue`; `queue.length` once it is over. */
  readonly index: number;
}

/** A new walk at the first Do-now id. */
export function startWalk(ids: readonly string[]): Walk {
  return { queue: ids, index: 0 };
}

/**
 * The thread to show: the queue id at `index` when it is still live, else the next live id after it — one a
 * commit or another screen just removed is skipped. Null once nothing live is left at or after `index`.
 */
export function currentId(walk: Walk, live: ReadonlySet<string>): string | null {
  for (let at = walk.index; at < walk.queue.length; at += 1) {
    const id = walk.queue[at];
    if (live.has(id)) return id;
  }
  return null;
}

/**
 * J (+1) and K (−1): to the nearest live id that way from the one showing. None that way leaves the walk
 * untouched — the same object, so a bump at the end costs no render.
 */
export function stepWalk(walk: Walk, live: ReadonlySet<string>, delta: 1 | -1): Walk {
  const current = currentId(walk, live);
  if (current === null) return walk;
  const at = walk.queue.indexOf(current, walk.index);
  for (let i = at + delta; i >= 0 && i < walk.queue.length; i += delta) {
    if (live.has(walk.queue[i])) return { ...walk, index: i };
  }
  return walk;
}

/**
 * E, L or Space just committed the thread showing: it probably left `live`, so take the next live id after
 * it. At the tail, go back to the live id before it; with none left, the walk is over (`index = queue.length`).
 */
export function afterCommit(walk: Walk, live: ReadonlySet<string>): Walk {
  for (let at = walk.index + 1; at < walk.queue.length; at += 1) {
    if (live.has(walk.queue[at])) return { ...walk, index: at };
  }
  for (let at = walk.index - 1; at >= 0; at -= 1) {
    if (live.has(walk.queue[at])) return { ...walk, index: at };
  }
  return { ...walk, index: walk.queue.length };
}

/** The walk is over once no queue id at or after it is still live. */
export function isFinished(walk: Walk, live: ReadonlySet<string>): boolean {
  return currentId(walk, live) === null;
}

/**
 * The pane crumb's "n of m": `of` counts the queue ids still live plus those already walked past (their slots
 * are before the current one), `index` is the 1-based place of the current id among them. Null once finished.
 */
export function progress(
  walk: Walk,
  live: ReadonlySet<string>,
): { readonly index: number; readonly of: number } | null {
  const current = currentId(walk, live);
  if (current === null) return null;
  const at = walk.queue.indexOf(current, walk.index);
  let of = 0;
  for (let i = 0; i < walk.queue.length; i += 1) {
    if (i < at || live.has(walk.queue[i])) of += 1;
  }
  return { index: at + 1, of };
}
