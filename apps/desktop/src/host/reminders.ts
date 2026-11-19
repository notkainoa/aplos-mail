import type { Frame, NotificationItem } from '@aplos/contract';

/** The part of an engine session this module needs; no electron or engine import, so tests drive it with a fake. */
export interface ReminderSession {
  call(method: string, args: unknown): Promise<unknown>;
  subscribe(listener: (frame: Frame) => void): () => void;
}

/** A fired reminder is "late" (it carries `wasDueAt`) from this long after its time, like the engine's own notice. */
const LATE_AFTER_MS = 120_000;

/** One `Reminder/list` item, as the contract defines it (`api/mail.ts`). */
interface ListedReminder {
  threadId: string;
  at: number;
  firedAt: number;
  title: string;
}

/** The id the engine gives the live `reminder` event of this reminder (`clock/sources/notice.ts`), so the two dedupe. */
const idOf = (r: ListedReminder) => `reminder:${r.threadId}:${r.at}`;

/** "Was due Sun, Nov 1, 9:00 AM", like the engine's own late notice, in `zone` (default: this Mac's). */
function wasDueText(at: number, zone?: string): string {
  const when = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(zone ? { timeZone: zone } : {}),
  }).format(at);
  return `Was due ${when}`;
}

function itemOf(r: ListedReminder, zone?: string): NotificationItem {
  const late = r.firedAt - r.at >= LATE_AFTER_MS;
  return {
    id: idOf(r),
    kind: 'reminder',
    threadId: r.threadId,
    title: r.title,
    at: r.firedAt,
    ...(late ? { wasDueAt: r.at, body: wasDueText(r.at, zone) } : {}),
  };
}

function missedOf(output: unknown): ListedReminder[] {
  const items = (output as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (item): item is ListedReminder =>
      typeof item?.threadId === 'string' &&
      typeof item.at === 'number' &&
      typeof item.firedAt === 'number' &&
      typeof item.title === 'string',
  );
}

/**
 * Notifies for every reminder the host could not have heard. The engine's timer loop starts inside `createEngine`, before
 * the host connects, so a reminder due at launch is marked fired and its live `reminder` host event reaches nobody; it
 * stays in `Reminder/list` until acked. This subscribes first, so nothing between the subscription and the list is lost,
 * then calls `Reminder/list` once and notifies each fired reminder not yet announced. Live `reminder` events are
 * forwarded to `notify` too, and every notification id is remembered, so a reminder that arrives live and in the list
 * (or twice live) notifies once. A failing list call is swallowed: the reminder stays listed for the next launch.
 * Returns the unsubscribe function; after it, nothing more is notified, including a list still in flight.
 *
 * The host must notify for `reminder` events ONLY through this module (it forwards the live ones): a second live
 * handler of its own would notify twice.
 *
 * Not wired into `src/main` yet: main still runs the legacy engine. The new engine's host calls this once, right after
 * `engine.connect()`, with the host session and its notification function.
 */
export function announceMissedReminders(
  session: ReminderSession,
  notify: (item: NotificationItem) => void,
  options: { zone?: string } = {},
): () => void {
  // A notification is the reminder's id plus its fire time (`item.at`): the owner re-setting the same time after a
  // fire is a new fire with a new `at`, so it notifies again, while the same fire seen live and in the list does not.
  const announced = new Set<string>();
  let active = true;
  const announce = (item: NotificationItem) => {
    const key = `${item.id}|${item.at}`;
    if (!active || announced.has(key)) return;
    announced.add(key);
    try {
      notify(item);
    } catch {
      // A failing notification must not stop the others or reach the engine's frame fan-out.
    }
  };
  const unsubscribe = session.subscribe(frame => {
    if (frame.frame === 'host' && frame.event.type === 'reminder') announce(frame.event.item);
  });
  const list = async () => {
    try {
      for (const r of missedOf(await session.call('Reminder/list', {})))
        announce(itemOf(r, options.zone));
    } catch {
      // Nothing safe to log here; the fired reminders stay in `Reminder/list` until acked.
    }
  };
  void list();
  return () => {
    active = false;
    unsubscribe();
  };
}
