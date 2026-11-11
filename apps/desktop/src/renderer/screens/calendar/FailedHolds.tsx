/**
 * Failed calendar holds surfaced through Queue/list, and the pane's quiet line for them (DESIGN
 * 7.15; review19). A held guest-notifying write whose provider refused it after the receipt shows an
 * in-session persistent toast — but after a reload, or once the owner left Calendar, the screen has
 * no operation id and the toast is gone. The queue keeps the failure: an engine `op` item is
 * `id: 'op:<opId>'` with a `<method> <count>` label, so a hold is the item whose label names
 * `Event/set` or `Event/rsvp` (mail ops name `Thread/…` etc.). The stand-in's own queue writes
 * `<verb> N item(s)` labels, so the fixture shape `set|rsvp|hide|extract N item(s)` under the `send`
 * scope counts too.
 *
 * Retry is `Operation/retry` on the same op id — never `Event/set` again (a fresh write beside the
 * engine's hold would re-notify guests). Discard is `Queue/discard` on the item id.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react';
import type { QueueItem } from '@aplos/contract';
import { api, useRow, type Event, type Operation } from '../../data';
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
  /** The Queue/list item id (`op:<opId>` on the real engine): `Queue/discard` takes it. */
  readonly id: string;
  /** The operation id: `Operation/retry` takes it — the id the hold itself keeps. */
  readonly opId: string;
  /** The plain reason sentence (writeErrors' at-operation copy). */
  readonly reason: string;
  readonly canRetry: boolean;
  readonly canDiscard: boolean;
  /**
   * The held change's event, when already known. `QueueItem` is deliberately content-free, so the
   * queue names no event: the row resolves the op's target through `Operation/get` when this is unset
   * (the harness states set it directly — they run no data layer).
   */
  readonly eventId?: string;
}

/** The operation id a queue `op` item wraps: `id` minus the `op:` prefix (the fixture has none). */
export function opIdOf(item: Pick<QueueItem, 'id'>): string {
  return item.id.startsWith('op:') ? item.id.slice(3) : item.id;
}

const EVENT_METHOD_LABEL = /^Event\//;
const FIXTURE_EVENT_VERB = /^(set|rsvp|hide|extract) \d+ items?$/;

/**
 * A queue item that is a failed calendar hold: an `op` in `failed` or `conflict` whose label names a
 * calendar method. Mail operations name theirs (`Thread/…`), so they never match; submissions and AI
 * jobs are other `kind`s. For the stand-in's verb-only labels the `send` scope keeps `Draft/set`
 * (scope `draft`) and the settings writes (`admin`) out.
 */
export function isCalendarHoldItem(item: QueueItem): boolean {
  if (item.kind !== 'op') return false;
  if (item.state !== 'failed' && item.state !== 'conflict') return false;
  if (EVENT_METHOD_LABEL.test(item.label)) return true;
  return item.scope === 'send' && FIXTURE_EVENT_VERB.test(item.label);
}

/**
 * The resolved op's own verdict, once `Operation/get` answers: a hold is an `Event/*` operation.
 * `undefined` (unanswered or gone) keeps the label's verdict — a hold may outlive the ops row.
 */
export function isCalendarHoldOp(op: Operation | undefined): boolean | undefined {
  if (!op) return undefined;
  return op.kind === 'Event/set' || op.kind === 'Event/rsvp' || op.kind === 'Event/hide';
}

/** The sentence a failed hold reads: writeErrors' at-operation table; unknown codes get the plain fallback. */
export function holdSentence(reasonCode: string | undefined): string {
  const fallback = "This change wasn't sent.";
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

/**
 * The queue items that are failed holds, minus any an in-session persistent op-failure toast already
 * owns (`<opId>:failed`): while that toast lives the owner sees the failure once, not twice.
 */
export function failedHoldsOf(
  items: readonly QueueItem[],
  toastIds: ReadonlySet<string>,
): FailedHold[] {
  const out: FailedHold[] = [];
  for (const item of items) {
    if (!isCalendarHoldItem(item)) continue;
    const opId = opIdOf(item);
    if (toastIds.has(`${opId}:failed`)) continue;
    out.push({
      id: item.id,
      opId,
      reason: holdSentence(item.problem?.reasonCode),
      canRetry: item.canRetry,
      canDiscard: item.canDiscard,
    });
  }
  return out;
}

/** The event title the hold's change was for: the resolved op's first target, else the quiet fallback. */
export function holdTitle(op: Operation | undefined, events: ReadonlyMap<string, Event>): string {
  const eventId = op?.targets?.[0];
  return (eventId ? events.get(eventId)?.title : undefined) ?? 'An event';
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

/**
 * The failed holds the pane knows: `Queue/list` op items that are calendar holds, deduped against
 * the live toasts. `refreshKey` bumps on every operation frame the screen already receives, so a
 * provider-side settle (or a new failure) lands without polling; a retry or discard settling emits
 * `emitHoldsRefresh`. Never on a timer, and it never retries on its own.
 */
export function useFailedHolds(refreshKey: string): {
  holds: readonly FailedHold[];
  refresh: () => void;
} {
  const [items, setItems] = useState<readonly QueueItem[]>([]);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(t => t + 1), []);
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);

  useEffect(() => subscribeHoldsRefresh(refresh), [refresh]);
  useEffect(() => {
    let live = true;
    void api.queue.list({ kinds: ['op'] }).then(
      result => {
        if (live) setItems(result.list);
      },
      // The list failing is a quiet empty — the pane's own error line covers load failures.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [refreshKey, tick, toasts]);

  const holds = failedHoldsOf(items, new Set(toasts.map(t => t.id)));
  return { holds, refresh };
}

/** One Review row's title and actions (a resolved event id needs no data layer — the harness sets it). */
function HoldRowView({
  hold,
  title,
  dispatch,
}: {
  hold: FailedHold;
  title: string;
  dispatch: (action: CalendarAction) => void;
}) {
  return (
    <li className="cal-hold">
      <div className="cal-hold__title">{title}</div>
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

/** The row that resolves its op for the title: a non-Event kind was a label false positive. */
function HoldRowResolved(props: {
  hold: FailedHold;
  events: ReadonlyMap<string, Event>;
  dispatch: (action: CalendarAction) => void;
}) {
  const op = useRow('Operation', props.hold.opId);
  if (isCalendarHoldOp(op) === false) return null;
  return (
    <HoldRowView hold={props.hold} title={holdTitle(op, props.events)} dispatch={props.dispatch} />
  );
}

/** One Review row: the event's title (resolved through the op's target), the reason, the actions. */
function HoldRow({
  hold,
  events,
  dispatch,
}: {
  hold: FailedHold;
  events: ReadonlyMap<string, Event>;
  dispatch: (action: CalendarAction) => void;
}) {
  if (hold.eventId !== undefined)
    return (
      <HoldRowView
        hold={hold}
        title={events.get(hold.eventId)?.title ?? 'An event'}
        dispatch={dispatch}
      />
    );
  return <HoldRowResolved hold={hold} events={events} dispatch={dispatch} />;
}

/**
 * The line and its Review popover. Review is a plain text button — Tab reaches it, Return opens the
 * list, and the Popover's Esc puts focus back on it (role 'dialog'). The first appearance is
 * announced once; the list updates in place as retries and discards settle.
 */
export function FailedHolds({
  holds,
  events,
  open,
  dispatch,
  announce,
}: {
  holds: readonly FailedHold[];
  events: ReadonlyMap<string, Event>;
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
            <HoldRow key={hold.id} hold={hold} events={events} dispatch={dispatch} />
          ))}
        </ul>
      </Popover>
    </>
  );
}
