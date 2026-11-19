import type { NotificationItem } from '@aplos/contract';
import type { LogRecord } from '@aplos/contract/log/events';
import { createTimerLoop, fakeClock, type FakeClock } from '../../src/clock/module';
import { createLater } from '../../src/clock/sources/later';
import { createReminders } from '../../src/clock/sources/reminders';
import { createLogger } from '../../src/diag/log';
import type { FrameBus } from '../../src/runtime/frames';
import { openStore, type StorePort } from '../../src/store';
import { ACCOUNT, accountWrite, folderWrites, msg, tempDb } from '../store/helpers';

export const LA = 'America/Los_Angeles';
export const LONDON = 'Europe/London';
export const SEC = 1_000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const utc = (iso: string) => Date.parse(iso);
export const threadId = (n: number) => `${ACCOUNT}:t${n}`;

/** One engine instance over `store`: the timer loop and both sources, announcing into `events`. */
function boot(store: StorePort, clock: FakeClock, zone: string, events: NotificationItem[]) {
  const records: LogRecord[] = [];
  const log = createLogger({ sink: { write: r => records.push(r) }, salt: 's', clock });
  const loop = createTimerLoop({ clock, log });
  const frames: Pick<FrameBus, 'emit'> = {
    emit(frame) {
      if (frame.frame === 'host' && frame.event.type === 'reminder') events.push(frame.event.item);
    },
  };
  const deps = { store, clock, frames, zone: () => zone };
  const reminders = createReminders(deps);
  const later = createLater(deps);
  loop.register(reminders.source);
  loop.register(later.source);
  later.start();
  loop.start();
  return {
    loop,
    reminders,
    later,
    stuck: () => records.filter(r => r.event === 'engine.watchdog').length,
    stop: () => loop.stop(),
  };
}

/** A temp `mail.db` with threads t1..tN, a fake clock and any number of engine instances ("restarts") on it. */
export function world(start: string, zone = LA, threads = 3) {
  const file = tempDb();
  const clock = fakeClock(utc(start));
  const open = () => openStore(file.open(), { now: () => clock.now() });
  const store = open();
  store.commit({
    opId: 'seed',
    origin: 'import',
    writes: [
      accountWrite,
      ...folderWrites,
      ...Array.from({ length: threads }, (_, i) => msg(`m${i + 1}`, `t${i + 1}`, i)),
    ],
  });
  const events: NotificationItem[] = [];
  const open_ = new Set<StorePort>([store]);
  let ops = 0;
  /** The workflow write `Thread/act` makes, so the tests set deadlines the way the views lane does. */
  const patch = (s: StorePort, n: number, fields: Record<string, unknown>) =>
    s.commit({
      opId: `edit-${ops++}`,
      origin: 'local',
      writes: [
        {
          kind: 'workflow',
          accountId: ACCOUNT,
          remoteThreadId: `t${n}`,
          patch: { ...fields, editedAt: clock.now() },
        },
      ],
    });
  return {
    clock,
    store,
    events,
    patch: (n: number, fields: Record<string, unknown>) => patch(store, n, fields),
    remind: (n: number, at: number) => patch(store, n, { reminderAt: at, reminderFiredAt: null }),
    snooze: (n: number, until: number | null) =>
      patch(store, n, { status: 'later', laterUntil: until, hiddenFromHome: false }),
    boot: (s: StorePort = store) => boot(s, clock, zone, events),
    /** A second connection to the same file: another engine process (or a restart's new store). */
    reopen() {
      const s = open();
      open_.add(s);
      return s;
    },
    row: (n: number) =>
      store.read(q =>
        q.get<{
          status: string;
          later_until: number | null;
          reminder_at: number | null;
          reminder_fired_at: number | null;
        }>(
          `SELECT w.status, w.later_until, w.reminder_at, w.reminder_fired_at FROM thread_workflow w
           JOIN threads t ON t.id = w.thread_id WHERE t.remote_id = ?`,
          `t${n}`,
        ),
      )!,
    done() {
      for (const s of open_) s.close();
      file.cleanup();
    },
  };
}

export type World = ReturnType<typeof world>;
export const idsOf = (w: World) => w.events.map(e => e.threadId);
