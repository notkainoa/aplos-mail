import type { AccountHealth, ReasonCode } from '@aplos/contract';
import type { Logger } from '../diag/log';
import type { StorePort } from '../store/port';
import type { AccountId, Admission, DeviceId, ProviderKind } from './base';
import type { CalendarWriteResult, EditScope, EventChange, EventRef } from './calendar';
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
  RemoteRule,
  ScopeId,
  SenderRule,
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
  ): Promise<{ remoteThreadIds: string[]; nextPageToken?: string; partial?: boolean }>;
  /**
   * Fetches one page of a folder's listing into the store, for a `lazy` folder opened in the UI (ARCH `sync_scope`).
   * The account's `folder:<remoteId>` sync_state row throttles re-opens and carries the page token: an open within a
   * minute of the last fetch resolves having changed nothing, a completed walk re-reads the head page. Rows commit
   * as `origin='sync'` (their placements count, unlike `search`'s). Optional and additive: an adapter without it
   * resolves having fetched nothing.
   */
  listFolder?(account: AccountId, remoteFolderId: string): Promise<void>;
  attachment(account: AccountId, ref: AttachmentRef): Promise<AsyncIterable<Uint8Array>>;
  /**
   * The message's raw RFC822 for "Show original" and `.eml` export (`Message/original`, plans/engine/blob-area.md
   * decision 13), fetched live and never cached: Gmail `messages.get format=raw`, priced as `full`, base64url decoded
   * in the adapter. The caller caps it at 25 MB. Optional and additive: until `prov-gov` routes it to an adapter that has
   * it, `Message/original` answers `unavailable`. `options.signal` aborts the read itself (the lane's
   * stop or the fetch's 120 s deadline, whichever is first) — an adapter should stop the HTTP read,
   * not just resolve late.
   */
  original?(
    account: AccountId,
    remoteMessageId: string,
    options?: { signal?: AbortSignal },
  ): Promise<AsyncIterable<Uint8Array>>;
}

/** Engine-side facts per account, beyond the F1 wire `AccountHealth`; `Setup/status` and `Account/*` read from here. */
export interface AccountRuntime extends AccountHealth {
  grantedScopes: string[];
  capabilities: Capabilities;
  /**
   * Feature-level gaps (calendar, filters) that do not make the whole account `needsPermission`. Same shape as the F1
   * `Account.missingPermissions` row, so `Account/get` copies it: `reasonCode` is the copy key (`permission.calendar` for the calendar half).
   */
  missingPermissions?: {
    /** `calendarWrite` is the opt-in editing gap (read access is fine); the rest are `Capabilities` keys. */
    capability: keyof Capabilities | 'calendarWrite';
    reasonCode: ReasonCode;
    missingScopes: string[];
  }[];
  sendBlockedUntil?: number;
  /** The first window's progress (AM-4); complete once `baselineDoneAt` is set. `found` only when the provider estimates it. */
  firstWindow: { read: number; total: number; found?: number };
  baselineDoneAt?: number;
  /** "Background work runs on: <Mac>" (ARCH 6.5). */
  lease?: {
    role: 'primary' | 'secondary';
    holder?: DeviceId;
    until?: number;
    /** "Use this Mac" is on for this device (`claimLease`), until `releaseLease`; F1 `Lease.pinned`. */
    pinned?: boolean;
  };
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
   * cooldowns, daily stops and `config` blocks. `req.signal` aborts the host's browser or loopback flow
   * (`Account/cancelConnect`); the abort reaches the provider as `ConnectContext.signal`.
   */
  connect(account: AccountId, kind: ProviderKind, req: ConnectRequest): Promise<ConnectResult>;
  /**
   * Deletes a credential `connect` already stored when the engine refuses the result (wrong account, duplicate, or a
   * late answer after `Account/cancelConnect`). `ref` is `ConnectResult.credentialRef` (or `ConnectRequest.secretRef`).
   * `kind` is explicit because a first-time connect has no committed row to find the provider from.
   *
   * Ownership rule: the engine never discards for an account that already has a committed row, because the store keeps
   * no credential ref to compare against and a reconnect may have stored under the account's own ref (Google does,
   * `refFor(accountId)`). Such a call resolves without discarding and logs `kept`; it never deletes a live
   * credential. So a reconnect must stage under a FRESH ref, or the engine keeps a verified late result; the host removes
   * a superseded ref itself once the engine commits the new one. A ref that is not stored is not an error. Otherwise
   * it forwards to `ProviderFactory.discardCredential` for `kind`, and rejects (`unavailable`) when that factory has
   * none, so a credential is never silently kept.
   */
  discardCredential?(account: AccountId, kind: ProviderKind, ref: string): Promise<void>;
  /**
   * After `Account/disconnect` committed: forwards to `ProviderFactory.forgetAccount` for `kind`. Never for an account
   * that still has a row (resolves without forgetting), so a removal that was refused cannot sign the account out.
   */
  forgetAccount?(account: AccountId, kind: ProviderKind): Promise<void>;
  /**
   * Restores governor state, then plans from committed cursors. The outbox start rules are `SendPort`'s: a `sending` row
   * becomes `uncertain` and is settled by `findSent` before anything else; `queued` and `scheduled` rows (every row
   * waiting on `not_before`, `WAITING_SUBMISSION_STATES`) obey the overdue rule.
   */
  start(account: AccountId): Promise<void>;
  stop(account: AccountId, why: 'disconnect' | 'quit' | 'restart'): Promise<void>;
  /**
   * A successful reconnect: stores the new grant and credential, `clear(auth)`, and resumes from the stored cursors with
   * no resync (a cursor Google already expired takes D10's bounded resync). Queued ops and drafts are kept and flush.
   */
  reconnected(account: AccountId, result: ConnectResult): Promise<void>;
  /**
   * `Sync/request`: asks the governor's admission first, so a manual sync while paused makes no network call.
   * `force` is DESIGN 7.1's "Retry now": during a `throttle` cooldown it plans one step through
   * `GovernorPort.retryNow`, which admits a single call once per pause and keeps the escalation step; any other refusal
   * (daily, auth, config, send_limit, anti_abuse, or a second force in the same pause) answers as without `force`.
   */
  request(
    account: AccountId,
    req: { scope?: ScopeId; manual: boolean; force?: boolean },
  ): Admission;
  requestAll(req: { manual: boolean }): Record<AccountId, Admission>;
  wake(reason: 'wake' | 'network' | 'focus' | 'push', account?: AccountId): void;
  /** New or changed `ops` rows: flush on the `opFlush` lane. */
  opsChanged(account: AccountId): void;
  /** "Use this Mac" (`Account/lease` `pin: true`): writes a pinned copy naming this device and keeps claiming while awake. */
  claimLease(account: AccountId): Promise<void>;
  /**
   * Back to automatic (`Account/lease` `pin: false`): drops this device's pin; the lease then follows the normal renewal
   * and the lower-`DeviceId` tie rule, so this device may stay primary. A no-op when nothing is pinned here.
   */
  releaseLease(account: AccountId): Promise<void>;
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
 * Overdue rule (ARCH 7.3, extended to pauses and reconnects): applies to every row waiting on `not_before`, which is
 * `queued` (the undo window) and `scheduled` (send later) alike (`WAITING_SUBMISSION_STATES`); never to `sending`. A
 * waiting submission that would go out more than `OVERDUE_GRACE_MS` past `not_before`, for any reason (Mac asleep or
 * off, paused, signed out), becomes `suspended` instead: "Send now or Reschedule". The `outbox` deadline source and the
 * store's due index cover both states (`store/due.ts`: `nextDueAt`, `dueSubmissions`), so a send-later row is found when it
 * falls due.
 *
 * Pinned revision rule (ARCH 7.1, FR-7): the bytes that leave are the submission's pinned revision (`Submission.revision`
 * and its `mime`), never whatever a provider draft holds at send time. The outbox sets
 * `SubmissionPayload.baseRemoteMessageId` (and `baseChangeKey`) from the draft's synced copy only when that copy is the
 * pinned revision (`drafts.synced_revision` equals `Submission.revision`); otherwise it leaves them unset. The adapter
 * sends the remote draft only when `sendsRemoteDraft` holds, else the pinned `mime`, so a phone edit during the undo
 * window or a send-later hold never leaves. After a `mime` send the remote copy is left in place (no `draftConsumed`).
 */
export interface SendPort {
  /** No I/O: is the account's mail budget open for a send now (auth, pause, send-limit blocks)? */
  admission(account: AccountId): Admission;
  send(account: AccountId, submission: SubmissionPayload): Promise<SendReceipt>;
  /** `since`: the attempt marker's time, so IMAP can bound its SEARCH. */
  findSent(account: AccountId, internetId: string, since: number): Promise<FindSentResult>;
}

// The waiting states and the grace are defined once in the contract (FR-2) and re-exported so lanes import them from the ports.
export {
  WAITING_SUBMISSION_STATES,
  OVERDUE_GRACE_MS,
  type WaitingSubmissionState,
} from '@aplos/contract/rules';

/**
 * Remote draft copies. Implemented by `prov-gov` (routes to `saveDraft`/`deleteDraft` on the `opFlush` lane); called by
 * `eng-time`'s draft scheduler, which owns timing (5 s idle, on close), the fingerprint skip, per-draft serialization and
 * the "keep mine, take theirs, or keep both" state. `PausedError` reschedules through the `drafts` deadline. The
 * scheduler passes the last synced copy as `DraftUpload.baseRemoteMessageId`; a `conflict` result (the copy changed
 * elsewhere since) raises the same choice, and nothing is overwritten.
 *
 * `remove` deletes the provider's copy. The engine passes `expectedMessageId`, the remote message id of the copy it last
 * wrote or adopted (`drafts.remote_message_id`), whenever it knows one, and omits it when it does not. The provider
 * deletes ONLY IF the draft still holds that message id; if it holds another (the draft was edited or replaced on
 * another device since, or it became a sent message) it does nothing and resolves, so a discard here never destroys a
 * newer version made elsewhere or a sent mail. A draft that is already gone is success. Without `expectedMessageId`
 * (the engine knows none) the call is the old two-argument one and cannot be guarded; an adapter may then leave the copy
 * alone rather than delete blind (Gmail does: the copy stays and history reports it as another device's draft, an
 * orphan and never a loss). Optional and additive: an adapter that ignores the parameter keeps working, only without
 * the guard.
 */
export interface DraftSyncPort {
  save(account: AccountId, draft: DraftUpload): Promise<DraftSaveResult>;
  remove(account: AccountId, remoteDraftId: string, expectedMessageId?: string): Promise<void>;
}

/**
 * Calendar writes, account-addressed. Implemented by `prov-gov` (routes to the account adapter's `calendar` on the
 * interactive lane, under the calendar's own budget, and commits `saved` facts itself); called by `methods/event.ts`
 * (`Event/set`, `Event/rsvp`, `Plan/confirm`, accepted `addEvent` proposals). `notify` (on `EventChange` and on
 * `remove`'s ref) is the method's resolved choice: absent or false never emails guests, so a guest-free or triage path
 * cannot send an invitation by default.
 */
export interface CalendarPort {
  put(account: AccountId, change: EventChange): Promise<CalendarWriteResult>;
  remove(
    account: AccountId,
    ref: EventRef & { scope: EditScope; notify?: boolean },
  ): Promise<CalendarWriteResult>;
  rsvp(
    account: AccountId,
    ref: EventRef & { scope: EditScope },
    response: 'accepted' | 'declined' | 'tentative',
    opts: { notify: boolean },
  ): Promise<CalendarWriteResult>;
}

/**
 * Provider filters for block and skip-Inbox, account-addressed. Implemented by `prov-gov` (routes to the adapter's
 * `rules` on `opFlush`); called by `methods/sender.ts` (`SenderRule/*`). An account whose adapter has no `rules` (or
 * lacks the filters permission) answers `list` with `[]` and `create` with `undefined`: the rule stays local only.
 */
export interface RulesPort {
  list(account: AccountId): Promise<RemoteRule[]>;
  /** The provider's rule id, or undefined when the account cannot hold provider rules. */
  create(account: AccountId, rule: SenderRule): Promise<string | undefined>;
  /** Idempotent: an absent rule is success. */
  delete(account: AccountId, remoteId: string): Promise<void>;
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

/**
 * Where a newly granted client's token lands (`Clients/grant`, host-5): the host writes the one-time
 * plaintext to a file only that tool can read (0600 under the run directory) and answers the path the
 * `Client.tokenPath` field reports. The engine keeps only the token's SHA-256; the plaintext never
 * crosses the contract. Implemented by `eng-host` (`host/transports/auth.ts`); absent, `Clients/grant`
 * is `unavailable` — a grant without its token file would be a row no tool could use.
 */
export interface ClientTokens {
  issue(clientId: string, token: string): Promise<{ path: string }>;
  /** Removes a client's token file (revoke, or cleaning up a grant whose commit failed). Missing is fine. */
  remove(clientId: string): Promise<void>;
  /** The absolute path a client's token file lives at, written or not — for `tokenPath` on a deduped grant. */
  pathOf(clientId: string): string;
  /** Whether the client's token file exists now — a deduped grant without its file gets a fresh grant. */
  has(clientId: string): Promise<boolean>;
}
