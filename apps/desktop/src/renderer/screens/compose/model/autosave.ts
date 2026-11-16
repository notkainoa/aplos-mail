/**
 * Autosave as pure functions of time (DESIGN 7.6 Draft state; ARCH 7.4 compare-and-set). Every edit bumps `editSeq`;
 * a save carries the seq it wrote, and the draft is clean once `savedSeq` reaches `editSeq`. The first keystroke creates
 * the draft at once; after that a save is due after a quiet spell, or at most `maxWaitMs` after the first unsaved edit
 * while typing goes on; one save is in flight at a time; a failed save retries on a backoff and shows "Couldn’t save ·
 * Retry". A save the engine refused as stale waits for the newer row (`waitingForRemote`) instead of retrying blind.
 */
import type { DraftStateKind } from '../../../ui/props';

export const AUTOSAVE = {
  /** Save after this long without an edit. */
  quietMs: 700,
  /** Never let an edit go unsaved longer than this while typing continues. */
  maxWaitMs: 2_000,
  /** Retry delays after consecutive failures; the last repeats. */
  retryMs: [2_000, 5_000, 15_000, 30_000],
} as const;

/** The save bookkeeping a composer keeps. */
export interface SaveClock {
  /** The engine's draft id once the first save landed; null before the first keystroke is saved. */
  readonly draftId: string | null;
  /** `Draft.revision` of the last save (the next save's `baseRevision`). */
  readonly revision: number | null;
  /** `Draft.rev` of the row last seen (part of the send's idempotency key). */
  readonly rowRev: number | null;
  /** Bumped on every edit. */
  readonly editSeq: number;
  /** The edit seq the engine has confirmed. */
  readonly savedSeq: number;
  /** The seq the save in flight writes, or null. */
  readonly flightSeq: number | null;
  readonly lastEditAt: number | null;
  readonly firstDirtyAt: number | null;
  /** Consecutive failures; 0 after a success. */
  readonly failures: number;
  readonly lastFailAt: number | null;
  /** The engine refused the save's base revision: no blind retry until the newer row is seen (or Retry). */
  readonly waitingForRemote: boolean;
}

export const FRESH_SAVE: SaveClock = {
  draftId: null,
  revision: null,
  rowRev: null,
  editSeq: 0,
  savedSeq: 0,
  flightSeq: null,
  lastEditAt: null,
  firstDirtyAt: null,
  failures: 0,
  lastFailAt: null,
  waitingForRemote: false,
};

/** True while an edit has not been confirmed by the engine. */
export function isDirty(save: SaveClock): boolean {
  return save.savedSeq < save.editSeq;
}

/** Records an edit at `now`. */
export function noteEdit(save: SaveClock, now: number): SaveClock {
  return {
    ...save,
    editSeq: save.editSeq + 1,
    lastEditAt: now,
    firstDirtyAt: save.firstDirtyAt ?? now,
  };
}

function retryDelay(failures: number): number {
  const index = Math.min(Math.max(failures, 1), AUTOSAVE.retryMs.length) - 1;
  return AUTOSAVE.retryMs[index]!;
}

/** When the next save should start, or null when none is needed (clean, or one is in flight). */
export function saveDueAt(save: SaveClock): number | null {
  if (save.flightSeq !== null || save.waitingForRemote || !isDirty(save)) return null;
  if (save.failures > 0 && save.lastFailAt !== null)
    return save.lastFailAt + retryDelay(save.failures);
  // The first keystroke creates the draft at once, so even a reload a moment later finds it.
  if (save.draftId === null) return save.firstDirtyAt ?? 0;
  const quiet = (save.lastEditAt ?? 0) + AUTOSAVE.quietMs;
  const cap = (save.firstDirtyAt ?? 0) + AUTOSAVE.maxWaitMs;
  return Math.min(quiet, cap);
}

/** The longest autosave ever waits on purpose: the quiet spell, the typing cap and the last retry delay. */
const LONGEST_WAIT_MS = Math.max(AUTOSAVE.quietMs, AUTOSAVE.maxWaitMs, ...AUTOSAVE.retryMs);

/**
 * How long the autosave timer waits for a save due at `due`. Never longer than autosave's longest delay: `due` was read
 * off the wall clock, and one stepped back (a time sync, a changed clock) must not hold the text unsaved for that long.
 */
export function timerWait(due: number, now: number): number {
  return Math.min(Math.max(0, due - now), LONGEST_WAIT_MS);
}

/** True when a save should start at `now`. */
export function saveIsDue(save: SaveClock, now: number): boolean {
  const due = saveDueAt(save);
  return due !== null && due <= now;
}

/** A save of the current edits has left. */
export function startSave(save: SaveClock): SaveClock {
  return { ...save, flightSeq: save.editSeq };
}

/** The engine confirmed the save of `seq` with this draft row. */
export function finishSave(
  save: SaveClock,
  seq: number,
  draft: { readonly id: string; readonly revision: number; readonly rev: number },
): SaveClock {
  const savedSeq = Math.max(save.savedSeq, seq);
  return {
    ...save,
    draftId: draft.id,
    revision: draft.revision,
    rowRev: draft.rev,
    savedSeq,
    flightSeq: null,
    failures: 0,
    lastFailAt: null,
    firstDirtyAt: savedSeq < save.editSeq ? save.firstDirtyAt : null,
  };
}

/** The save of the flight failed at `now`. */
export function failSave(save: SaveClock, now: number): SaveClock {
  return { ...save, flightSeq: null, failures: save.failures + 1, lastFailAt: now };
}

/** Retry now ("Couldn't save · Retry"): the backoff is skipped. */
export function retryNow(save: SaveClock, now: number): SaveClock {
  return {
    ...save,
    failures: 0,
    lastFailAt: null,
    waitingForRemote: false,
    lastEditAt: now - AUTOSAVE.quietMs,
  };
}

/**
 * The one draft line: "Couldn’t save" after a failure, "Saving…" while edits are unconfirmed, "Draft saved" once the
 * engine holds a draft, and nothing for an untouched new message (no draft exists, so nothing was saved).
 */
export function draftStateOf(save: SaveClock): DraftStateKind {
  if (save.failures > 0 && save.flightSeq === null) return 'failed';
  if (isDirty(save) || save.flightSeq !== null) return 'saving';
  return save.draftId === null ? 'none' : 'saved';
}
