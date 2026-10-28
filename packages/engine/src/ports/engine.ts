import type { AccountHealth, ReasonCode } from '@aplos/contract';
import type { Logger } from '../diag/log';
import type { StorePort } from '../store/port';
import type { AccountId, Admission, DeviceId, ProviderKind } from './base';
import type { GovernorPort, RequestIo } from './governor';
import type {
  AttachmentRef,
  Capabilities,
  ConnectRequest,
  ConnectResult,
  DraftSaveResult,
  DraftUpload,
  FindSentResult,
  OpenedThread,
  PlanEnv,
  ProviderFactory,
  ScopeId,
  SendReceipt,
  ServerSearch,
  SubmissionPayload,
} from './provider';
import type { Clock, DeadlineRegistry } from './time';

// Engine-facing ports: what engine modules (methods, outbox, views) call to reach a provider. All are implemented by
// `prov-gov` in `packages/engine/src/sync/`, which routes each call to the account's actor, governor and adapter, and
// commits provider facts itself. Callers never see an adapter, a budget id or a provider reason string.

/**
 * Account-addressed provider reads. Implemented by the actor host (`prov-gov`); called by `methods/thread.ts` and
 * `MessageBody/get` (`eng-views`), body prefetch, `Mail/frame` (`eng-html`) and the attachment blob route.
 */
export interface ProviderPort {
  /**
   * Opens one thread on the interactive (or prefetch) lane, commits it (bodies stored, `threads.complete=1`, `laneFor`
   * re-run) and resolves with the committed facts so the caller need not re-read. The adapter picks the call (AM-1).
   * `knownCount` is the server-reported size (`threads.remote_count`, from `MessageFacts.threadSize`), never the local
   * `msg_count`: a 5-message thread with 1 message stored must not be opened with the 1-message call.
   */
  openThread(
    account: AccountId,
    remoteThreadId: string,
    opts?: { knownCount?: number; lane?: 'interactive' | 'prefetch' },
  ): Promise<OpenedThread>;
  /** Server search on Enter; rows are committed with `origin='search'` and the ranked thread ids returned. */
  search(
    account: AccountId,
    query: ServerSearch,
  ): Promise<{ remoteThreadIds: string[]; nextPageToken?: string }>;
  attachment(account: AccountId, ref: AttachmentRef): Promise<AsyncIterable<Uint8Array>>;
}

/** Engine-side facts per account, beyond the F1 wire `AccountHealth`; `Setup/status` and `Account/*` read from here. */
export interface AccountRuntime extends AccountHealth {
  grantedScopes: string[];
  capabilities: Capabilities;
  /** Feature-level gaps (calendar, filters) that do not make the whole account `needsPermission`. */
  missingPermissions?: { capability: keyof Capabilities; missingScopes: string[] }[];
  sendBlockedUntil?: number;
  /** The first window's progress (AM-4); complete once `baselineDoneAt` is set. `found` only when the provider estimates it. */
  firstWindow: { read: number; total: number; found?: number };
  baselineDoneAt?: number;
  /** "Background work runs on: <Mac>" (ARCH 6.5). */
  lease?: { role: 'primary' | 'secondary'; holder?: DeviceId; until?: number };
  /** Calendar pauses show per calendar, never as the mail status (D12). */
  calendars?: {
    remoteId: string;
    state: 'ok' | 'paused' | 'error';
    until?: number;
    reason?: string;
    reasonCode?: ReasonCode;
  }[];
}

/**
 * The account actors' supervisor. Implemented by `prov-gov` (`sync/host.ts`); called by `methods/{account,sync}.ts`,
 * the engine runtime (start, quit, wake from `eng-host`), `eng-views` after `Thread/act` (`opsChanged`) and the
 * heartbeat supervisor (plan 10 E1 item 4), which restarts a silent actor alone.
 */
export interface AccountActorHost extends ProviderPort {
  /**
   * Runs `connect` under the governor with an engine-assigned account id; `Account/connect|reconnect|grantPermissions`.
   * Its `ConnectContext.governor` ignores the account's `auth` block (the reconnect is what lifts it) but honours
   * cooldowns, daily stops and `config` blocks.
   */
  connect(account: AccountId, kind: ProviderKind, req: ConnectRequest): Promise<ConnectResult>;
  /**
   * Restores governor state, then plans from committed cursors. The outbox start rules are `SendPort`'s: a `sending` row
   * becomes `uncertain` and is settled by `findSent` before anything else; only `queued` rows obey the overdue rule.
   */
  start(account: AccountId): Promise<void>;
  stop(account: AccountId, why: 'disconnect' | 'quit' | 'restart'): Promise<void>;
  /**
   * A successful reconnect: stores the new grant and credential, `clear(auth)`, and resumes from the stored cursors with
   * no resync (a cursor Google already expired takes D10's bounded resync). Queued ops and drafts are kept and flush.
   */
  reconnected(account: AccountId, result: ConnectResult): Promise<void>;
  /** `Sync/request`: asks the governor's admission first, so a manual sync while paused makes no network call. */
  request(account: AccountId, req: { scope?: ScopeId; manual: boolean }): Admission;
  requestAll(req: { manual: boolean }): Record<AccountId, Admission>;
  wake(reason: 'wake' | 'network' | 'focus' | 'push', account?: AccountId): void;
  /** New or changed `ops` rows: flush on the `opFlush` lane. */
  opsChanged(account: AccountId): void;
  /** "Use this Mac" (`Account/lease`). */
  claimLease(account: AccountId): Promise<void>;
  status(account: AccountId): AccountRuntime | undefined;
  lastHeartbeat(account: AccountId): number | undefined;
  subscribe(listener: (account: AccountId, status: AccountRuntime) => void): () => void;
}

/**
 * Access tokens. Implemented by the host (`host/providers/oauth/`, `prov-gov`) over the vault; called only by the governor,
 * which serializes refreshes per account (D21) and runs each refresh as a governed `oauth` request, so no token call
 * goes out while the account is blocked.
 */
export interface TokenSource {
  /** A still-valid cached access token, or undefined. No I/O. */
  cached(account: AccountId): { token: string; expiresAt: number } | undefined;
  /** One token-endpoint call inside `governor.run`. `invalid_grant` throws `ProviderError` class `auth`; network failure keeps the refresh token. */
  refresh(account: AccountId, io: RequestIo): Promise<{ token: string; expiresAt: number }>;
}

/**
 * Sending. Implemented by `prov-gov` (routes to `ProviderAdapter.send`/`findSent` on the interactive lane); called by
 * `eng-time`'s outbox, which commits the `sending` marker (state and `attempt_at`) after `admission` and before `send`.
 * Outcomes:
 * resolves → `sent`. `NotSentError` → `failed` with Retry (class `send_limit`: "until" `resumeAt`, never auto-retried, D7).
 * `PausedError` → stays `queued` until `until` (auth: until reconnect), except `cls: 'send_limit'`, which is `failed` as above.
 * Anything else → `uncertain`, never replayed: `findSent`, once more after 60 s, then ask the user.
 * The governor turns anything thrown before the request is written (token refresh, a block) into `PausedError` or
 * `NotSentError`, so "anything else" means the bytes may have left.
 *
 * Start rule (never re-send): when the outbox starts or wakes, every `sending` row it finds is a send whose outcome was
 * lost (the app died after the marker). It becomes `uncertain` at once and runs `findSent(internetId, attempt_at)`
 * before any other submission of that account goes out; it is never `suspended`, re-queued or re-sent, however late.
 *
 * Overdue rule (ARCH 7.3, extended to pauses and reconnects): applies to `queued` rows only. A `queued` submission
 * that would go out more than 5 minutes past `not_before`, for any reason, becomes `suspended` instead.
 */
export interface SendPort {
  /** No I/O: is the account's mail budget open for a send now (auth, pause, send-limit blocks)? */
  admission(account: AccountId): Admission;
  send(account: AccountId, submission: SubmissionPayload): Promise<SendReceipt>;
  /** `since`: the attempt marker's time, so IMAP can bound its SEARCH. */
  findSent(account: AccountId, internetId: string, since: number): Promise<FindSentResult>;
}

/**
 * Remote draft copies. Implemented by `prov-gov` (routes to `saveDraft`/`deleteDraft` on the `opFlush` lane); called by
 * `eng-time`'s draft scheduler, which owns timing (5 s idle, on close), the fingerprint skip, per-draft serialization and
 * the "keep mine, take theirs, or keep both" state. `PausedError` reschedules through the `drafts` deadline.
 */
export interface DraftSyncPort {
  save(account: AccountId, draft: DraftUpload): Promise<DraftSaveResult>;
  remove(account: AccountId, remoteDraftId: string): Promise<void>;
}

/** What the engine runtime (`eng-contract`) injects when it builds `prov-gov`'s actor host. */
export interface AccountActorDeps {
  store: StorePort;
  governor: GovernorPort;
  providers: ProviderFactory[];
  tokens: TokenSource;
  clock: Clock;
  log: Logger;
  deadlines: DeadlineRegistry;
  deviceId: DeviceId;
  /** Focus, visible window and battery, from `eng-host`'s power and window signals. */
  env: () => PlanEnv;
}
