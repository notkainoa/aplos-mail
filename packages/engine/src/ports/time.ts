// Time: the injected clock and the one engine timer loop's deadline-source registry (ARCH 7.5, plan 10 E6 item 5).

/** A one-shot timer from `Clock.timer`; `cancel` is idempotent. */
export interface Timer {
  cancel(): void;
}

/**
 * The only source of time in the neutral engine, so every timed rule runs on a fake clock in tests.
 * Implemented by `eng-time` (`clock/system.ts`, over `Date.now` and `setTimeout`) and by `prov-emu`'s fake clock;
 * injected into every module that waits, schedules or stamps a time.
 */
export interface Clock {
  /** Epoch ms. */
  now(): number;
  /** Resolves after `ms`; rejects with `signal.reason` when aborted. The governor waits for budget with it. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /**
   * Calls `fire` once at or after the absolute epoch-ms `at`. The real clock re-checks `now()` when its timeout fires and
   * re-arms if early, so long timeouts and drift are safe; a wall-clock jump is the host's `wake()`, not the timer's job.
   * Only the timer loop calls it; everything else registers a `DeadlineSource`.
   */
  timer(at: number, fire: () => void): Timer;
}

/** Known deadline sources; open so a later module registers its own without a port change. */
export type DeadlineSourceId =
  | 'outbox' // submissions.not_before of every waiting row, `queued` and `scheduled` (eng-time)
  | 'reminders' // thread_workflow.reminder_at (eng-time)
  | 'later' // thread_workflow.later_until, Later and snooze returns (eng-time)
  | 'drafts' // the next draft upload: 5 s idle, or a paused upload's retry (eng-time)
  | 'dueBand' // the next local midnight, when due_band is refreshed (eng-ai)
  | 'jobs' // jobs.next_at (eng-ai)
  | 'ops' // ops.next_at, the op-flush retry time (prov-gov)
  | 'governor' // the earliest cooldown_until or daily_block_until (prov-gov)
  | `sync:${string}` // one account actor's next planned step (`PlannedStep.notBefore`) (prov-gov)
  | (string & {});

/**
 * One module's deadlines, registered with the timer loop. The loop sleeps until the earliest `next()` across all
 * sources and calls that source's `fire`. Sources hold no timers of their own.
 */
export interface DeadlineSource {
  readonly id: DeadlineSourceId;
  /** Earliest pending deadline in epoch ms, or undefined for none. Cheap: an indexed MIN or an in-memory value. */
  next(): Promise<number | undefined>;
  /**
   * Handles everything due at or before `now`, idempotently (a crash re-fires it). It must move `next()` past `now`,
   * or the loop backs off 1 s and logs, so a stuck source cannot spin. Lateness is the source's own arithmetic:
   * a reminder computes "was due 9:00" and the outbox its overdue grace from `now` minus its deadline.
   */
  fire(now: number): Promise<void>;
}

/**
 * The one timer loop's registration side. Implemented by `eng-time` (`clock/loop.ts`); called by every module that owns
 * a deadline. The loop recomputes at launch, on `wake()` and after `changed`.
 */
export interface DeadlineRegistry {
  /** Returns an unregister function. Registering an id twice replaces the first source. */
  register(source: DeadlineSource): () => void;
  /** A commit or in-memory change moved this source's deadline; call it after the commit, never inside it. */
  changed(id: DeadlineSourceId): void;
}
