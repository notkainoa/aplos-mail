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
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react';
import type { QueueItem } from '@aplos/contract';
import { api, type Account } from '../../data';
import { getToasts, subscribeToasts } from '../../shell/store-toast';
import type { Announce } from '../../ui/props';
import { Button } from '../../ui/buttons-keys';
import { Popover } from '../../ui/surfaces';
import { writeFailureOf } from './writeErrors';
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
 * The sentence a failed hold reads: writeErrors' at-operation table where a reasonCode exists,
 * else the engine's own words (a content-free item carries its plain sentence for exactly this).
 */
export function holdSentence(item: Pick<QueueItem, 'problem'>): string {
  const fallback = item.problem?.message || "This change wasn't sent.";
  const reasonCode = item.problem?.reasonCode;
  if (!reasonCode) return fallback;
  return writeFailureOf(
    { error: { type: 'unavailable', message: fallback, reasonCode } },
    fallback,
    false,
    true,
  ).message;
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
    out.push({
      id: item.id,
      opId,
      reason: holdSentence(item),
      ...(account !== undefined ? { account } : {}),
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
// The hook the container calls and the surface the pane draws
// ---------------------------------------------------------------------------

/** How often the watched queue is re-listed while a `cal:` item is still queued or syncing. */
const HOLD_WATCH_MS = 5_000;

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
    const run = (): void => {
      const call = listDeps ?? (() => api.queue.list({ kinds: ['op'] }).then(r => r.list));
      void call().then(
        result => {
          if (!live) return;
          setItems(result);
          // A queued or syncing hold can still fail — re-list on a bound until none remain.
          if (holdsNeedWatch(result)) timer = setTimeout(run, watchMs);
        },
        // The list failing is a quiet empty — the pane's own error line covers load failures.
        () => undefined,
      );
    };
    run();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [refreshKey, tick, toasts, listDeps, watchMs]);

  const holds = failedHoldsOf(items, new Set(toasts.map(t => t.id)), accounts, filter);
  return { holds, refresh };
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
  return (
    <li className="cal-hold">
      <div className="cal-hold__title">
        A calendar change
        {hold.account !== undefined ? (
          <span className="cal-hold__account"> · {hold.account}</span>
        ) : null}
      </div>
      <div className="cal-hold__reason">{hold.reason}</div>
      <div className="cal-hold__actions">
        {hold.canRetry ? (
          <Button
            variant="text"
            size="sm"
            label="Retry"
            onPress={() => dispatch({ type: 'holdRetry', id: hold.id, opId: hold.opId })}
          />
        ) : null}
        {hold.canDiscard ? (
          <Button
            variant="text"
            size="sm"
            label="Discard"
            onPress={() => dispatch({ type: 'holdDiscard', id: hold.id })}
          />
        ) : null}
      </div>
    </li>
  );
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
  const announced = useRef(false);
  const count = holds.length;

  useEffect(() => {
    if (count === 0) {
      announced.current = false;
      // An empty list leaves no popover: the last row's own action emptied it.
      if (open) dispatch({ type: 'holdsReview', open: false });
      return;
    }
    if (!announced.current) {
      announced.current = true;
      announce?.(failedHoldLine(count));
    }
  }, [count, open, announce, dispatch]);

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
        <ul className="cal-holds">
          {holds.map(hold => (
            <HoldRow key={hold.id} hold={hold} dispatch={dispatch} />
          ))}
        </ul>
      </Popover>
    </>
  );
}
