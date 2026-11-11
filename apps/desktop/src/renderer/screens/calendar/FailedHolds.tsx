/**
 * Failed calendar holds surfaced through Queue/list, and the pane's quiet line for them (DESIGN
 * 7.15; review20). A held guest-notifying write whose send failed after the receipt shows an
 * in-session persistent toast — but after a reload, or once the owner left Calendar, that toast is
 * gone. The queue keeps the failure: the engine lists a hold that still needs the owner as a
 * content-free `op` item `id: 'cal:<opId>'` with the fixed label 'Calendar change' — no title, no
 * guest, no event id (listener clients read the list), so a row can never name its event.
 *
 * Retry is `Queue/retry` on the item id — the engine's own path for holds, which refuses an
 * uncertain one (`calendar.checkFirst`); never `Event/set` again (a fresh write beside the engine's
 * hold would re-notify guests). Discard is `Queue/discard` on the same id.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type RefObject,
} from 'react';
import type { QueueItem } from '@aplos/contract';
import { api, type Account } from '../../data';
import { addToast, getToasts, subscribeToasts } from '../../shell/store-toast';
import type { Announce } from '../../ui/props';
import { Button } from '../../ui/buttons-keys';
import { Popover } from '../../ui/surfaces';
import { writeFailureOf, type WriteFailure } from './writeErrors';
import { CALENDAR_ACCESS_COPY, EDITING_COPY } from './accountCalendarState';
import type { CalendarAction } from './calendar.model';

// ---------------------------------------------------------------------------
// The model: identifying holds in Queue/list and wording them
// ---------------------------------------------------------------------------

/** One failed hold the pane line and its Review list draw. */
export interface FailedHold {
  /** The Queue/list item id (`cal:<opId>`): `Queue/retry` and `Queue/discard` take it. */
  readonly id: string;
  /** The operation id the queue id wraps: the in-session failure toast owns `<opId>:failed`. */
  readonly opId: string;
  /** The plain reason sentence (writeErrors' at-operation copy, else the engine's own words). */
  readonly reason: string;
  /** The account the change is on — its name, else its address — resolved from the screen's accounts. */
  readonly account?: string;
  /** The queue item's own account id: the grant action's Sign in again / Enable editing goes to it. */
  readonly accountId?: string;
  /** A dead grant's fix (writeErrors' flags): 'reconnect' signs in again, 'enableEditing' asks for the write scope. */
  readonly recovery?: 'reconnect' | 'enableEditing';
  /**
   * A newer write on the event retired this change (effects' `staleRetries`): the row offers
   * Discard alone — a retry would re-send the older change over the newer one (review21).
   */
  readonly stale?: boolean;
  /** Its own Retry or Discard is still in flight: the buttons hold busy, a second press is ignored. */
  readonly pending?: boolean;
  /** `calendar.uncertain`: the answer was lost — the change may already be on Google (review22). */
  readonly uncertain?: boolean;
  readonly canRetry: boolean;
  readonly canDiscard: boolean;
}

/** The operation id a `cal:` queue item wraps: `id` minus the prefix (the id the hold itself keeps). */
export function opIdOf(item: Pick<QueueItem, 'id'>): string {
  return item.id.startsWith('cal:') ? item.id.slice(4) : item.id;
}

/**
 * A queue item that is a failed calendar hold: `cal:<opId>` in `failed` — the engine's own id
 * prefix, so a mail op (`op:…`), a job or a submission can never match, whatever their label. Only
 * `failed` needs the owner: a `queued` hold is still inside its undo window (the write's own Undo
 * toast covers it) and a `syncing` one is a send under way — neither "didn't send" yet. An
 * uncertain failure is `failed` too; its `canRetry` is false, so its row offers Discard only.
 */
export function isCalendarHoldItem(item: QueueItem): boolean {
  return item.id.startsWith('cal:') && item.state === 'failed';
}

/**
 * A `cal:` item the engine is still working on — queued (inside its undo window, or waiting out a
 * `notBefore` of up to 15 minutes) or syncing: it can still flip to `failed`, and nothing else
 * would fetch that (review21). Hold commits are meta-only — they never move the events window's
 * `dbEpoch:seq` — and the operation frame only reached a live `subscribeOperation` watch, which
 * died with the screen that mounted it.
 */
export function holdsNeedWatch(items: readonly QueueItem[]): boolean {
  return items.some(
    item => item.id.startsWith('cal:') && (item.state === 'queued' || item.state === 'syncing'),
  );
}

/**
 * The writeErrors' failure for a queue item's `problem`: the at-operation table where a reasonCode
 * exists (a held write was accepted — only its send is owed), else a bare sentence in the engine's
 * own words, which a content-free item carries for exactly this.
 */
function holdFailure(item: Pick<QueueItem, 'problem'>): WriteFailure {
  const fallback = item.problem?.message || "This change wasn't sent.";
  const reasonCode = item.problem?.reasonCode;
  if (!reasonCode) return { message: fallback, retry: 'operation' };
  return writeFailureOf(
    { error: { type: 'unavailable', message: fallback, reasonCode } },
    fallback,
    false,
    true,
  );
}

/** The sentence a failed hold reads. */
export function holdSentence(item: Pick<QueueItem, 'problem'>): string {
  return holdFailure(item).message;
}

/** The quiet line's text (DESIGN 10: plain words, no blame). */
export function failedHoldLine(count: number): string {
  return count === 1 ? "1 change didn't send" : `${count} changes didn't send`;
}

/** The account label a hold's row carries: the account's name, else its address. */
export function holdAccount(
  accounts: readonly Account[],
  accountId: string | undefined,
): string | undefined {
  const account = accountId === undefined ? undefined : accounts.find(a => a.id === accountId);
  return account ? account.name || account.address : undefined;
}

/** How `failedHoldsOf` narrows the queue's `cal:` items to what this pane may act on (review21). */
export interface FailedHoldFilter {
  /**
   * The pane's account scope: only items the engine attributed to it count — a failed hold on
   * another account must never draw this pane's line. An item the engine left unattributed matches
   * no scoped pane; the all-accounts pane still lists it.
   */
  readonly accountId?: string;
  /** Op ids a newer write on the same event already retired (effects' `staleRetries`). */
  readonly stale?: (opId: string) => boolean;
  /** Queue item ids with a Retry or Discard still in flight (holdEffects' `pendingHolds`). */
  readonly pending?: (id: string) => boolean;
}

/**
 * The queue items that are failed holds, minus any an in-session persistent op-failure toast already
 * owns (`<opId>:failed`): while that toast lives the owner sees the failure once, not twice.
 */
export function failedHoldsOf(
  items: readonly QueueItem[],
  toastIds: ReadonlySet<string>,
  accounts: readonly Account[],
  filter: FailedHoldFilter = {},
): FailedHold[] {
  const out: FailedHold[] = [];
  for (const item of items) {
    if (!isCalendarHoldItem(item)) continue;
    if (filter.accountId !== undefined && item.accountId !== filter.accountId) continue;
    const opId = opIdOf(item);
    if (toastIds.has(`${opId}:failed`)) continue;
    const account = holdAccount(accounts, item.accountId);
    const failure = holdFailure(item);
    const recovery =
      failure.reconnect === true && item.accountId !== undefined
        ? ('reconnect' as const)
        : failure.enableEditing === true && item.accountId !== undefined
          ? ('enableEditing' as const)
          : undefined;
    out.push({
      id: item.id,
      opId,
      reason: failure.message,
      ...(account !== undefined ? { account } : {}),
      ...(item.accountId !== undefined ? { accountId: item.accountId } : {}),
      ...(recovery !== undefined ? { recovery } : {}),
      ...(item.problem?.reasonCode === 'calendar.uncertain' ? { uncertain: true as const } : {}),
      ...(filter.stale?.(opId) === true ? { stale: true as const } : {}),
      ...(filter.pending?.(item.id) === true ? { pending: true as const } : {}),
      canRetry: item.canRetry,
      canDiscard: item.canDiscard,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The queue-changed signal: effects emit it after a retry or discard settles so
// the pane's list refetches — Queue/list has no push of its own.
// ---------------------------------------------------------------------------

const holdListeners = new Set<() => void>();

export function subscribeHoldsRefresh(listener: () => void): () => void {
  holdListeners.add(listener);
  return () => {
    holdListeners.delete(listener);
  };
}

export function emitHoldsRefresh(): void {
  for (const listener of holdListeners) listener();
}

// ---------------------------------------------------------------------------
// The Retry settle watch: `Queue/retry` resolves even when the resend fails
// again, so a settled Retry's verdict comes from the refreshed Queue/list
// (review22).
// ---------------------------------------------------------------------------

/** Item ids whose `Queue/retry` resolved; the refreshed list's verdict is still owed. */
const retriedHolds = new Set<string>();

/** A row's Retry settled: the next `Queue/list` says whether the send went through. */
export function noteHoldRetried(id: string): void {
  retriedHolds.add(id);
  emitHoldsRefresh();
}

/** The screen unmounting releases the marks, like `releasePendingHolds` does for its own. */
export function releaseRetriedHolds(): void {
  retriedHolds.clear();
}

/**
 * The refreshed list's verdict on settled retries. An item still `failed` — the resend failed
 * again — gets one quiet notice under the op's `<opId>:failed` id (it owns the row while it lives,
 * like the in-session failure toast does). An item that left the queue sent fine: nothing to say.
 * A queued or syncing one is still sending — the watch's next list decides.
 */
function checkRetriedHolds(items: readonly QueueItem[]): void {
  if (retriedHolds.size === 0) return;
  for (const id of [...retriedHolds]) {
    const item = items.find(i => i.id === id);
    if (item !== undefined && (item.state === 'queued' || item.state === 'syncing')) continue;
    retriedHolds.delete(id);
    if (item?.state !== 'failed') continue;
    addToast({
      id: `${opIdOf(item)}:failed`,
      kind: 'info',
      message: "Still didn't send.",
      actions: [{ id: 'dismiss', label: 'Dismiss' }],
      undoable: false,
      persistent: true,
    });
  }
}

// ---------------------------------------------------------------------------
// The hook the container calls and the surface the pane draws
// ---------------------------------------------------------------------------

/** How often the watched queue is re-listed while a `cal:` item is still queued or syncing. */
const HOLD_WATCH_MS = 5_000;

/** How many times a rejected `Queue/list` may retry on the same bound before resting (review22). */
const LIST_RETRY_CAP = 5;

/** What `useFailedHolds` needs beyond the model: injectable in tests. */
export interface FailedHoldsDeps {
  /** The list call; `Queue/list {kinds: ['op']}` in the app. */
  readonly list?: () => Promise<readonly QueueItem[]>;
  /** The watch interval while a `cal:` item is queued or syncing; `HOLD_WATCH_MS` in the app. */
  readonly watchMs?: number;
}

/**
 * The failed holds the pane knows: `Queue/list` `cal:` items in `failed`, deduped against the live
 * toasts, their accounts resolved from the ones the screen already has, narrowed to the pane's
 * account scope. `refreshKey` bumps on window frames and a retry or discard settling emits
 * `emitHoldsRefresh`. A hold the engine is still working on would surface in neither — its
 * meta-only commits never move the events window — so while the last list holds a queued or
 * syncing `cal:` item the queue is re-listed on a bounded timer, and the list is re-fetched when
 * the window regains focus or visibility (review21). It never retries on its own.
 */
export function useFailedHolds(
  refreshKey: string,
  accounts: readonly Account[],
  filter: FailedHoldFilter = {},
  deps: FailedHoldsDeps = {},
): {
  holds: readonly FailedHold[];
  refresh: () => void;
} {
  const [items, setItems] = useState<readonly QueueItem[]>([]);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(t => t + 1), []);
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  const listDeps = deps.list;
  const watchMs = deps.watchMs ?? HOLD_WATCH_MS;

  useEffect(() => subscribeHoldsRefresh(refresh), [refresh]);
  // A settle the queue alone can see: the window coming back to the front re-lists too.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
    const refetch = () => {
      if (document.visibilityState !== 'hidden') refresh();
    };
    window.addEventListener('focus', refetch);
    document.addEventListener('visibilitychange', refetch);
    return () => {
      window.removeEventListener('focus', refetch);
      document.removeEventListener('visibilitychange', refetch);
    };
  }, [refresh]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A rejected list's retry count for this run — reset by the first success, and a fresh
    // effect run (a tick, a focus or a mount) starts it again (review22).
    let misses = 0;
    const run = (): void => {
      const call = listDeps ?? (() => api.queue.list({ kinds: ['op'] }).then(r => r.list));
      void call().then(
        result => {
          if (!live) return;
          misses = 0;
          setItems(result);
          checkRetriedHolds(result);
          // A queued or syncing hold can still fail — re-list on a bound until none remain.
          if (holdsNeedWatch(result)) timer = setTimeout(run, watchMs);
        },
        () => {
          if (!live) return;
          // A rejected list keeps the last good items and retries on the same bound — the
          // engine being briefly unreachable must not kill the watch or the first list
          // after a reload (review22). After the cap it rests until the next tick or focus.
          misses += 1;
          if (misses <= LIST_RETRY_CAP) timer = setTimeout(run, watchMs);
        },
      );
    };
    run();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
    // `toasts` stays out of the deps: every app toast would re-list the queue — the dedupe set is
    // computed at render from the live store anyway (review21).
  }, [refreshKey, tick, listDeps, watchMs]);

  const holds = failedHoldsOf(items, new Set(toasts.map(t => t.id)), accounts, filter);
  return { holds, refresh };
}

/**
 * A row button's accessible name: with two holds there are two 'Retry' buttons, so the name says
 * which account's change it acts on (review21). The visible word stays part of the name — Button's
 * `nameContainsVisibleText` rule.
 */
function holdActionName(verb: string, hold: FailedHold): string {
  return hold.account !== undefined
    ? `${verb} the change for ${hold.account}`
    : `${verb} the change`;
}

/**
 * One Review row: 'A calendar change' (the items are content-free — none can name its event), the
 * account when the engine names one, the reason sentence, then the row's actions. Retry shows only
 * while the engine allows it: an uncertain hold offers Discard alone — a blind second send could
 * tell the guests twice.
 */
function HoldRow({
  hold,
  dispatch,
}: {
  hold: FailedHold;
  dispatch: (action: CalendarAction) => void;
}) {
  const grantAction =
    hold.recovery !== undefined && hold.accountId !== undefined
      ? { accountId: hold.accountId, recovery: hold.recovery }
      : undefined;
  return (
    <li className="cal-hold">
      <div className="cal-hold__title">
        A calendar change
        {hold.account !== undefined ? (
          <span className="cal-hold__account"> · {hold.account}</span>
        ) : null}
      </div>
      <div className="cal-hold__reason">
        {hold.stale === true
          ? 'You changed this event again. This older change can be discarded.'
          : hold.reason}
      </div>
      {hold.uncertain === true ? (
        <div className="cal-hold__note">
          Discarding does not undo anything already on your Google calendar.
        </div>
      ) : null}
      <div className="cal-hold__actions">
        {grantAction !== undefined ? (
          <Button
            variant="text"
            size="sm"
            label={
              grantAction.recovery === 'reconnect'
                ? CALENDAR_ACCESS_COPY.signIn
                : EDITING_COPY.action
            }
            ariaLabel={
              grantAction.recovery === 'reconnect'
                ? `${CALENDAR_ACCESS_COPY.signIn} for ${hold.account ?? 'this account'}`
                : `${EDITING_COPY.action} for ${hold.account ?? 'this account'}`
            }
            onPress={() =>
              dispatch(
                grantAction.recovery === 'reconnect'
                  ? { type: 'holdReconnect', accountId: grantAction.accountId }
                  : { type: 'holdEnableEditing', accountId: grantAction.accountId },
              )
            }
          />
        ) : null}
        {hold.canRetry && hold.stale !== true ? (
          <Button
            variant="text"
            size="sm"
            label="Retry"
            ariaLabel={holdActionName('Retry', hold)}
            busy={hold.pending === true}
            onPress={() => dispatch({ type: 'holdRetry', id: hold.id, opId: hold.opId })}
          />
        ) : null}
        {hold.canDiscard ? (
          <Button
            variant="text"
            size="sm"
            label="Discard"
            ariaLabel={holdActionName('Discard', hold)}
            busy={hold.pending === true}
            onPress={() => dispatch({ type: 'holdDiscard', id: hold.id })}
          />
        ) : null}
      </div>
    </li>
  );
}

/** The Review list's popover, found from the box the rows live in. */
function popoverOf(box: HTMLElement | null): HTMLElement | null {
  return box === null ? null : box.closest<HTMLElement>('[role="dialog"]');
}

/**
 * The Review list's open/emptied/row-left focus lifecycle (review22), run by `FailedHolds` from the
 * box its rows live in:
 *
 * - `holdsEmptied` when the list empties under the open popover — the stale `holdsReview` flag
 *   resets and focus lands on the grid, so the next failed hold can never pop the list open by
 *   itself. It only fires now that the surface stays mounted to see the count reach zero.
 * - On open, focus lands on the dialog container: `Popover` auto-focuses the first focusable,
 *   which can be a destructive Discard on an uncertain or stale first row — Return on Review
 *   then Return again would drop a change. Its own effect runs first, this lands after it.
 * - A non-last row leaving under the open popover (its own Retry or Discard settled, or a toast
 *   took it over) hands focus to the next row's first button — the previous row's when the last
 *   left — never to body, where Esc would miss the popover's own handler.
 */
export function useReviewLifecycle(
  box: RefObject<HTMLElement | null>,
  holds: readonly FailedHold[],
  open: boolean,
  dispatch: (action: CalendarAction) => void,
): void {
  const prevIds = useRef<readonly string[]>([]);
  const wasShown = useRef(false);
  const shown = open && holds.length > 0;
  useEffect(() => {
    const before = prevIds.current;
    prevIds.current = holds.map(h => h.id);
    if (holds.length === 0) {
      wasShown.current = false;
      // An empty list leaves no popover: the last row's own action emptied it. `holdsEmptied`
      // closes AND lands focus on the grid — the focused button just unmounted, so focus would
      // otherwise drop to body and a stale `holdsReview` would pop the next hold's list open.
      if (open) dispatch({ type: 'holdsEmptied' });
      return;
    }
    const pop = popoverOf(box.current);
    if (shown && !wasShown.current) {
      pop?.focus({ preventScroll: true });
    } else if (shown) {
      const removed = before.findIndex(id => !holds.some(h => h.id === id));
      const active = typeof document === 'undefined' ? null : document.activeElement;
      const inside = active !== null && pop !== null && pop.contains(active);
      if (removed >= 0 && !inside) {
        const rows = box.current?.querySelectorAll<HTMLElement>('.cal-hold');
        const row = rows ? rows[Math.min(removed, holds.length - 1)] : undefined;
        row?.querySelector<HTMLElement>('button:not([disabled])')?.focus({ preventScroll: true });
      }
    }
    wasShown.current = shown;
  }, [box, holds, open, shown, dispatch]);
}

/**
 * The line and its Review popover. Review is a plain text button — Tab reaches it, Return opens the
 * list, and the Popover's Esc puts focus back on it (role 'dialog'). The first appearance is
 * announced once; the list updates in place as retries and discards settle.
 */
export function FailedHolds({
  holds,
  open,
  dispatch,
  announce,
}: {
  holds: readonly FailedHold[];
  open: boolean;
  dispatch: (action: CalendarAction) => void;
  announce?: Announce;
}): JSX.Element | null {
  const reviewRef = useRef<HTMLButtonElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const announced = useRef(false);
  const count = holds.length;

  useReviewLifecycle(boxRef, holds, open, dispatch);
  useEffect(() => {
    if (count === 0) {
      announced.current = false;
      return;
    }
    if (!announced.current) {
      announced.current = true;
      announce?.(failedHoldLine(count));
    }
  }, [count, announce]);

  if (count === 0) return null;
  return (
    <>
      <div className="cal-failed-holds">
        <span className="cal-failed-holds__line">{failedHoldLine(count)}</span>
        <Button
          variant="text"
          size="sm"
          label="Review"
          ariaLabel={`Review ${failedHoldLine(count).toLowerCase()}`}
          popup={{ kind: 'dialog', expanded: open, controls: 'cal-holds-list' }}
          ref={reviewRef}
          onPress={() => dispatch({ type: 'holdsReview', open: !open })}
        />
      </div>
      <Popover
        open={open}
        role="dialog"
        label="Changes that didn't send"
        anchor={reviewRef.current}
        onClose={() => dispatch({ type: 'holdsReview', open: false })}
      >
        <div ref={boxRef}>
          <ul className="cal-holds" id="cal-holds-list">
            {holds.map(hold => (
              <HoldRow key={hold.id} hold={hold} dispatch={dispatch} />
            ))}
          </ul>
          <p className="cal-holds__note">Discarding means this change is never sent.</p>
        </div>
      </Popover>
    </>
  );
}
