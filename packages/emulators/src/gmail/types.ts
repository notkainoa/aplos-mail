import type { Clock } from '../kit/clock';
import type { FaultHook, RequestLogEntry } from '../kit/types';
import type { DailyLimitKind, ThrottleShape } from './errors';
import type { MinuteUnits } from './meter';
import type { Mailbox } from './mailbox';
import type { GenerateOptions } from './generate';
import type { OAuthServer, TestUser, TestUserInput } from './oauth';
import type { CalendarHelpers, GcalOptions } from '../gcal/types';

export type RetryAfterMode = 'none' | 'seconds' | 'httpDate';

export interface GmailEmulatorOptions {
  clock: Clock;
  /** Seeds ids, history steps, tokens and the batch refusal curve. Default 1. */
  seed?: number;
  /** Simulated time per request, waited with `clock.sleep`. Default 150. */
  latencyMs?: number;
  /** Per-user units in any sliding 60 s window. Default 6000. */
  unitsPerMinute?: number;
  /** Requests in flight per user before 429 "Too many concurrent requests". Default 10. */
  concurrency?: number;
  /** The "old" quota column: cheaper message and thread reads. Default false. */
  grandfathered?: boolean;
  /** Whether a refused request still counts against the window. Default false. */
  chargeRefused?: boolean;
  /** Which JSON error a per-minute refusal carries. Default 'rateLimitExceeded403'. */
  throttleShape?: ThrottleShape;
  /**
   * Whether per-minute and send-limit refusals carry Retry-After, and in which format. Default
   * 'none'. Whether Gmail sends Retry-After on a per-user 403 is unknown and must be checked on the
   * first live run; the D1 gate depends on it and pins 'none' explicitly.
   */
  retryAfter?: RetryAfterMode;
  /** OAuth project in Testing: refresh tokens die 7 days after consent. Default true. */
  testingMode?: boolean;
  /** Whether a repeat consent without prompt=consent returns a refresh token again. Default true. */
  repeatConsentIssuesRefreshToken?: boolean;
  /** Refuse authorization requests without state or an S256 challenge (stricter than Google). Default false. */
  requirePkceAndState?: boolean;
  faults?: FaultHook;
  /** How long history records stay valid. Default 7 days. */
  historyRetentionMs?: number;
  /** Sends per Pacific day before 429 "Mail sending". Default 2000. */
  sendLimitPerDay?: number;
  /**
   * What Gmail does to the identity of a draft the API saves. 'kept' (default): the Message-ID the client wrote is kept.
   * 'rewritten': like real Gmail (live finding 2026-11-04) every `drafts.create` and `drafts.update` replaces it with
   * `<hex@mail.gmail.com>`; no header the client wrote is dropped unless `dropDraftHeaders` names it.
   */
  draftIdentity?: 'kept' | 'rewritten';
  /**
   * What `messages.send` does to the Message-ID the client wrote. 'kept' (default), or 'rewritten' to `<hex@mail.gmail.com>`
   * (unmeasured on real Gmail until the live probe `gmail.send-message-id` runs).
   */
  sendIdentity?: 'kept' | 'rewritten';
  /**
   * Gmail's search index lags a send (live 2026-11-05: the sent copy showed on the 4th search, a few seconds later). A
   * message that `messages.send` just created stays out of every `messages.list` result (by `q` or by label) for this
   * many ms of the emulator's clock; `messages.get` finds it at once. Default 0 (no lag).
   */
  searchLagMs?: number;
  /** Header names (any case) Gmail drops from a draft the API saves, e.g. `['X-Aplos-Probe']`. Default none. */
  dropDraftHeaders?: readonly string[];
  /** Test users to start with. By default one user, test.user@example.test. Pass [] for none. */
  users?: TestUserInput[];
  /** Google Calendar settings (requests per minute, throttle shape, sync-token horizon, ...). */
  calendar?: GcalOptions;
}

/** Live settings; assigning to a field takes effect on the next request. */
export interface GmailSettings {
  latencyMs: number;
  unitsPerMinute: number;
  concurrency: number;
  grandfathered: boolean;
  chargeRefused: boolean;
  throttleShape: ThrottleShape;
  retryAfter: RetryAfterMode;
  historyRetentionMs: number;
  sendLimitPerDay: number;
  draftIdentity: 'kept' | 'rewritten';
  sendIdentity: 'kept' | 'rewritten';
  searchLagMs: number;
  dropDraftHeaders: readonly string[];
}

export interface MeterHelpers {
  /** Units in the last 60 s for a user (email or sub); the first user when omitted. */
  unitsInWindow(account?: string): number;
  /** Units accepted in each clock minute that saw traffic. */
  perMinuteSeries(account?: string): MinuteUnits[];
  /** The highest total the 60 s window ever held. */
  peakWindow(account?: string): number;
  /** Forgets all charges, series and peaks. */
  reset(): void;
}

export interface DailyLimitState {
  kind: DailyLimitKind;
  /** Midnight America/Los_Angeles after which calls work again. */
  resetsAt: number;
}

export interface GmailEmulator {
  /** Drop-in for global fetch. Rejects any origin the emulator does not emulate. */
  fetch: typeof fetch;
  clock: Clock;
  /** One content-free entry per request, including refusals, faults and batch parts. */
  log: RequestLogEntry[];
  /** Live, changeable settings (units per minute, latency, throttle shape, ...). */
  settings: GmailSettings;
  /** Origins that were requested and refused as external. */
  blockedOrigins: string[];

  // accounts
  addUser(input: TestUserInput): TestUser;
  users(): TestUser[];
  /** The mailbox of a user (email or sub); the first user's when omitted. */
  mailbox: Mailbox;
  mailboxFor(user?: string): Mailbox;
  /** Fills a user's mailbox with synthetic mail, returns it. */
  seedMailbox(options: GenerateOptions & { user?: string }): Mailbox;
  oauth: OAuthServer;

  /**
   * Google Calendar, served by this same instance and fetch (www.googleapis.com/calendar/v3), with
   * its own request budget, settings, anti-abuse switch and data helpers.
   */
  calendar: CalendarHelpers;
  /** Shorthand for `calendar.setAbuse`: writes answer 403 quotaExceeded until switched off. */
  setCalendarAbuse(on: boolean, options?: { forMs?: number }): void;

  // quota
  meter: MeterHelpers;
  /** Requests currently holding a slot for the user (email or sub). */
  inFlight(account?: string): number;

  // daily switches
  setDailyLimit(kind: DailyLimitKind | null): void;
  dailyLimit(): DailyLimitState | null;
  /** Sends counted today (Pacific) for the user. */
  sendsToday(account?: string): number;
  /** Pretends the user already sent this many messages today. */
  setSendsToday(count: number, account?: string): void;
}
