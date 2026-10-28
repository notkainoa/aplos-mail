# Providers thread: port proposal and schema 0001 review

Written 2026-10-27 (day 1) by the Providers thread on `rv/thread/providers`, for the Engine thread to decide and freeze as F3 (ports) and F1 (status, `reconnectBy`) by day 3. It also carries the Providers review of schema 0001 (F4). This is a proposal: `eng-contract` owns `packages/engine/src/ports.ts` and `packages/contract`, and nothing here is edited there by this thread.

## In plain English

The engine needs one narrow door to talk to Gmail, and later to Outlook, iCloud and Fastmail. This document proposes the exact shape of that door.

Each mail service gets an adapter. An adapter only talks to the service. It never saves anything, never decides when to make a request and never retries. A separate budget keeper, the governor, decides when each request may go out, so Aplos stays inside Google's 6,000-unit-a-minute limit. One worker per account, the account actor, runs the sync in small steps and saves each step together with its bookmark, so a crash costs one step.

This round only builds Gmail and Google Calendar. The door is still shaped so Outlook, iCloud, Fastmail and other calendars fit through it later without changing anything that is frozen now. Section 6 walks each of them through it on paper.

The document also lists the account states the screens will show ("paused until 10:42", "reconnect needed"), and the new `reconnectBy` date, which lets Aplos warn you a day before Google's weekly sign-in expires.

Last, it reviews the planned database layout and asks for eight small additions: a few columns for the weekly reconnect, the shared quota and repeating events.

## Decisions for you

None. These are engineering choices for the Engine thread, which decides and freezes them on day 3. The owner-facing choices (weekly reconnect, Testing mode, Gmail first) were answered on 2026-10-27 and this proposal follows them.

> **What this means:** This is the plug that every mail service will use. Getting it right now means round 2 only adds new services and changes nothing that already works.

## 1. Principles the types enforce

1. **Adapters never retry, never pace, never write the store** (ARCH 6.1, plan 20 3.2). Every network call goes through `ctx.governor.run`. Results come back as data; the actor commits them.
2. **Exactly one retry layer.** The governor is the only code that re-sends a request, and only for `transient` failures of `read` or `idempotentWrite` calls (1, 2, 4 s with jitter, three tries, ARCH 6.3). A `send` is never re-sent. Throttle, daily, auth, permission and config failures are never re-sent: the governor records the pause and rethrows. The actor never re-issues a request; it re-runs a bounded step from committed state after the pause ends.
3. **Zero requests while paused.** `governor.run` throws `PausedError` before any I/O when the budget is in cooldown or a daily stop, so no request can leak, including manual syncs (`Sync/request` asks `governor.admission` first and refuses without any network call).
4. **One bounded step per call.** `syncStep` does a bounded amount of work (one page, one history page, one folder chunk) and returns everything the actor needs to commit in one `store.commit`, including the resume token.
5. **Deletion only inside a completed scope.** A removal is either stated by the server (history `messagesDeleted`, IMAP `VANISHED`/`EXPUNGE`, JMAP `destroyed`, Graph `@removed`) or inferred by a generation sweep inside a `scopeCovered` round. A partial answer (`MESSAGELIMIT`, a capped window, a failed batch part) never sets `scopeCovered`.
6. **Facts, not copy.** Errors and states carry stable reason codes and the provider's own reason verbatim for diagnostics. The UI maps codes to DESIGN 7.15 copy; no provider string is ever shown.
7. **No content in logs.** Every log call goes through the frozen `Logger` (F7) with catalog ids; adapters log status, reason, method, units, pacer wait and pause class only.

## 2. Shared types

```ts
// ---- identity and lanes ----
export type ProviderKind = 'google' | 'microsoft' | 'imap' | 'jmap'      // mail adapters; CalDAV rides 'imap'/'jmap' accounts as a calendar adapter
export type AccountId = string
export type Lane = 'interactive' | 'opFlush' | 'incremental' | 'prefetch' | 'backfill' | 'enrichment'   // ARCH 4.1, priority order
export type RequestKind = 'read' | 'write' | 'idempotentWrite' | 'send'
export type BudgetId = 'gmail' | 'gcal' | 'graph' | 'imap' | 'jmap' | 'caldav'   // 'ai:*' budgets are eng-ai's, same base class

export interface Clock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }   // F3; the emulator kit implements it

// ---- the classified error (F1 contract type, same record the Logger F7 carries) ----
export type ErrorClass =
  | 'auth'          // invalid_grant, admin_policy_enforced, 401 after one forced refresh, AADSTS interaction_required, IMAP AUTHENTICATIONFAILED
  | 'permission'    // insufficientPermissions / missing scope
  | 'throttle'      // per-minute or concurrency refusal; Retry-After honoured
  | 'daily'         // dailyLimitExceeded, Gmail quotaExceeded, bandwidth caps: stop until reset, never retried
  | 'send_limit'    // Gmail "Mail sending": the submission fails "until HH:MM"; never retried
  | 'anti_abuse'    // Google Calendar quotaExceeded: hours
  | 'config'        // accessNotConfigured, SERVICE_DISABLED: every account of that provider is misconfigured
  | 'transient'     // 5xx, timeout, reset, DNS
  | 'permanent'     // 400, one-item 404: quarantine the item
  | 'cancelled'     // our own abort (close, pause of a sibling): never logged as a provider error

export interface ClassifiedError {
  class: ErrorClass
  provider: ProviderKind | 'gcal' | 'oauth' | 'caldav'
  method: string                // catalog method id, e.g. 'gmail.threads.get', 'oauth.token', 'imap.UID FETCH'
  reason: string                // provider's own code verbatim: 'rateLimitExceeded', 'invalid_grant', 'AADSTS70000', 'ETHROTTLE', 'notFound'
  status?: number               // HTTP status, when HTTP
  retryAfterMs?: number         // parsed from Retry-After (seconds or HTTP-date), no cap
  resumeAt?: number             // absolute end of a daily stop (Gmail: next midnight America/Los_Angeles)
  concurrency?: boolean         // the refusal was a concurrency cap: in-flight drops to 1
  uncertain?: boolean           // a write whose outcome is unknown (timeout after the request was written)
  missingScopes?: string[]      // for 'permission'
  item?: string                 // for 'permanent': the remote item to quarantine in sync_failures
  providerMessage?: string      // <= 300 chars, redacted by the Logger; never shown in the UI
}
export class ProviderError extends Error { constructor(readonly error: ClassifiedError) { super(error.reason) } }
export class PausedError extends Error { constructor(readonly budget: BudgetId, readonly until: number, readonly cls: ErrorClass, readonly reason: string) { super('paused') } }

// ---- facts adapters return (provider-neutral) ----
export interface MessageFacts {
  remoteId: string                       // Gmail message id; IMAP EMAILID (OBJECTID) or a stable hash of Message-ID+date+size; JMAP Email id; Graph immutable id
  remoteThreadId: string                 // Gmail threadId; JMAP threadId; Graph conversationId; IMAP THREADID or the header-derived root
  internetId?: string; inReplyTo?: string; refs?: string[]
  from?: Address; to: Address[]; cc: Address[]; replyTo?: Address[]
  subject?: string; snippet?: string     // snippet already entity-decoded (D22)
  date: number; internalDate: number; size?: number
  flags: { seen: boolean; flagged: boolean; answered?: boolean; draft: boolean; fromMe: boolean }
  folders: string[]                      // full set of label/folder remote ids this message is in (Gmail labelIds; JMAP mailboxIds; Graph parentFolderId)
  placements?: { folder: string; uid?: number }[]   // IMAP: per-folder UID (feeds message_folders.uid)
  headers: HeaderFacts                   // the nine of ARCH 5.1, for laneFor: List-Unsubscribe(+Post), Precedence, Auto-Submitted, ...
  categories?: string[]                  // Gmail CATEGORY_* and IMPORTANT; empty elsewhere
  partial: boolean                       // metadata only: no body yet (row surfaces as partial:true, F1)
  attachments?: AttachmentFacts[]        // listed when known; bytes are lazy
}
export interface LabelDelta { remoteId: string; add: string[]; remove: string[] }                 // Gmail history: applied at zero fetch (D13)
export interface PlacementDelta { remoteId?: string; folder: string; uid?: number; present: boolean } // IMAP/JMAP/Graph moves; uid-only for VANISHED
export interface Removal { remoteId?: string; folder?: string; uid?: number }                       // server-stated deletion
export interface FolderFacts { remoteId: string; name: string; role?: FolderRole; kind: 'label' | 'folder' | 'system'; hidden?: boolean; uidValidity?: number; removed?: boolean }
export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive' | 'starred' | 'important' | 'all'
export interface RemoteDraftFact { remoteDraftId: string; remoteMessageId: string; remoteThreadId?: string; changedAt: number; removed?: boolean } // D9: drafts never become thread rows

// ---- sync scopes and state ----
export type ScopeId =
  | 'history'            // Gmail history cursor; JMAP account-wide /changes state
  | 'window:inbox'       // first window (P1), the baseline
  | 'backfill:inbox'     // P2 and P5
  | 'sent:recent'        // P3
  | 'prefetch'           // P4 bodies
  | `folder:${string}`   // IMAP folder, Graph per-folder delta, lazily-opened Gmail user label
  | 'calendars'          // calendar list
  | `cal:${string}`      // one calendar's sync token / CalDAV collection
export interface SyncState {             // one sync_state row, opaque to the engine except the named columns
  scope: ScopeId; cursor?: string; pageToken?: string; phase?: string
  oldestLoaded?: number; generation: number; updatedAt: number
}
export interface PlannedStep { scope: ScopeId; lane: Lane; notBefore?: number; reason: 'first' | 'poll' | 'push' | 'wake' | 'manual' | 'resume' | 'reset' }

export interface StepResult {
  upserts: MessageFacts[]
  labelDeltas: LabelDelta[]
  placements: PlacementDelta[]
  removals: Removal[]
  folders?: FolderFacts[]
  drafts?: RemoteDraftFact[]
  nextState: SyncState                   // committed in the same transaction as the facts
  done: boolean                          // this scope has nothing more to do until the next trigger
  scopeCovered?: { scope: ScopeId; generation: number }   // round completed: the actor may sweep items of this scope not seen in this generation
  reset?: 'cursorExpired' | 'uidValidityChanged' | 'syncTokenInvalid' | 'cannotCalculateChanges'   // actor starts a bounded resync of this scope (D10), never a full one
  baselineReached?: boolean              // the first window (newest ~50 Inbox threads) is now committed: set accounts.baseline_done_at (AM-4)
  progress?: { read: number; total?: number; found?: number }   // Setup/status firstWindow / backfilling(n of m)
  memory?: Record<string, string | null> // provider_memory writes (label ids, app-label id, send-as cache)
  costUnits: number                      // units (or requests) this step spent, for diagnostics and the cost audit
  quarantine?: { item: string; error: ClassifiedError }[]   // poison items -> sync_failures
}
```

## 3. `ProviderAdapter`

```ts
export interface AdapterContext {
  account: { id: AccountId; provider: ProviderKind; address?: string; grantedScopes: string[]; capabilities: Capabilities }
  governor: BoundGovernor                // governor.run bound to this account
  tokens: TokenSource                    // host/providers/oauth: access token, one forced refresh on 401
  clock: Clock
  log: Logger                            // F7, catalog ids only
  signal: AbortSignal                    // aborted on close(), stop, or a sibling's pause (D23)
  lookup: KnownLookup                    // read-only store view
  memory: ReadonlyMap<string, string>    // provider_memory for this account
  role: 'primary' | 'secondary'          // from the lease (ARCH 6.5)
}
export interface KnownLookup {
  knownThreads(remoteThreadIds: string[]): Promise<Set<string>>      // the INBOX-gain rule (D3) needs "is this thread known?"
  knownMessages(remoteIds: string[]): Promise<Set<string>>
  trackedDrafts(remoteMessageIds: string[]): Promise<Set<string>>    // D9: skip untracked DRAFT records
  threadMessages(remoteThreadId: string): Promise<{ remoteId: string; placements: { folder: string; uid?: number }[] }[]>  // IMAP open
}

export interface ProviderAdapter {
  readonly kind: ProviderKind
  readonly budgets: BudgetSpec[]                                     // what the governor must meter for this provider

  connect(req: ConnectRequest, ctx: ConnectContext): Promise<ConnectResult>
  /** Pure: which steps to run now, from committed state and the trigger. Gmail P0-P5, IMAP folder rotation, Graph per-folder delta. */
  plan(states: SyncState[], trigger: PlannedStep['reason'], ctx: AdapterContext): PlannedStep[]
  syncStep(scope: ScopeId, state: SyncState, lane: Lane, ctx: AdapterContext): Promise<StepResult>

  /** ProviderPort.openThread (F3, AM-1): all messages of a thread with bodies, interactive or prefetch lane. */
  openThread(ref: ThreadOpenRef, lane: 'interactive' | 'prefetch', ctx: AdapterContext): Promise<OpenedThread>
  fetchAttachment(ref: AttachmentRef, ctx: AdapterContext): Promise<AsyncIterable<Uint8Array>>

  /** Pure: merge pending ops into provider calls (Gmail: same add/remove set -> one batchModify per 1,000; IMAP: per folder UID sets). */
  coalesce(ops: PendingOp[]): CoalescedOp[]
  apply(op: CoalescedOp, ctx: AdapterContext): Promise<OpOutcome[]>   // one outcome per op id; idempotent writes only

  saveDraft?(draft: DraftUpload, ctx: AdapterContext): Promise<DraftReceipt>
  deleteDraft?(remoteDraftId: string, ctx: AdapterContext): Promise<void>
  send(sub: SubmissionPayload, ctx: AdapterContext): Promise<SendReceipt>   // throws NotSentError | UncertainSendError; never retried
  findSent(internetId: string, ctx: AdapterContext): Promise<SentRef | undefined>   // settles 'uncertain' (rfc822msgid:, HEADER Message-ID, internetMessageId, Email/query)

  search?(query: ServerSearch, ctx: AdapterContext): Promise<{ upserts: MessageFacts[]; costUnits: number }>   // on Enter only; rows origin='search'
  watch?(ctx: AdapterContext): AsyncIterable<Hint>                     // data-free: IDLE, EventSource; Gmail has none
  rules?: RulesAdapter                                                 // Gmail filters, Graph messageRules (round 2), Sieve later
  calendar?: CalendarAdapter
  close(): Promise<void>                                               // aborts in-flight requests and sockets
}

export interface BudgetSpec {
  id: BudgetId
  unit: 'units' | 'requests' | 'commands' | 'bytes'
  windowMs: number                      // Gmail 60_000 sliding; Graph 600_000; gcal 60_000; IMAP bytes/day 86_400_000
  ceiling: number                       // provider's hard number: 6,000; 10,000; 600
  targets: Record<'primary' | 'secondary', number>   // AIMD start: Gmail 4,500 / 1,500 (ARCH 6.2)
  floor: number                         // AIMD floor: Gmail 1,000
  laneShare: Partial<Record<Lane, number>>   // Gmail: interactive 1, opFlush 1, incremental .9, prefetch .2, backfill .75
  inFlight: number; reservedInteractive: number   // Gmail 3 with 1 reserved; Graph 4; gcal 2; caldav 2; imap 1 command per connection
}

export interface ConnectRequest {
  mode: 'new' | 'reconnect' | 'grantPermissions'
  loginHint?: string                    // reconnect: the stored address, so the same account is preselected
  expectedSubject?: string              // reconnect: a different `sub` is refused ('wrongAccount')
  preset?: 'gmail' | 'outlook' | 'icloud' | 'fastmail' | 'yahoo' | 'generic'
  server?: { imap?: HostPort; smtp?: HostPort; jmapSession?: string; caldav?: string }
  secretRef?: string                    // vault reference for app passwords and API tokens; never the secret itself
}
export interface ConnectResult {
  identity: { subject: string; address: string; displayName?: string }
  grantedScopes: string[]               // from the token response's `scope` (D5)
  capabilities: Capabilities
  grantedAt: number                     // token grant time -> accounts.token_granted_at
  refreshExpiresAt?: number             // from refresh_token_expires_in, when the provider says
  tokenRef: string                      // vault reference of the stored bundle (refresh token + client id, D21)
}
// connect refuses with ProviderError{class:'permission', reason:'missingRequiredScope', missingScopes:['gmail.modify']} or {class:'auth', reason:'wrongAccount'}

export interface Capabilities {
  labels: boolean; folders: boolean; drafts: boolean; serverSearch: boolean; calendar: boolean
  filters: boolean; push: boolean; sendAs: boolean; unsubscribeHeaders: boolean
  threading: 'native' | 'headers'
}

export interface ThreadOpenRef {
  remoteThreadId: string
  knownCount?: number                   // AM-1: messages.get full (60) only when exactly 1 is known; else threads.get full (120)
  knownMessages?: { remoteId: string; placements: { folder: string; uid?: number }[] }[]   // IMAP fetches by UID, Graph by id
}
export interface OpenedThread { messages: (MessageFacts & { body: ProviderBody })[]; labelDeltas?: LabelDelta[]; removed?: string[]; costUnits: number }
export interface ProviderBody { text?: string; html?: string; cidMap: Record<string, string>; attachments: AttachmentFacts[] }   // ARCH 3.3 record, unsanitized

export interface PendingOp { opId: string; seq: number; kind: 'labels' | 'move' | 'flags' | 'trash' | 'untrash'; targets: string[]; payload: unknown; base?: unknown }
export interface CoalescedOp { opIds: string[]; call: string; units: number; body: unknown }
export interface OpOutcome { opId: string; result: 'applied' | 'notFound' | 'failed'; error?: ClassifiedError }   // notFound drops the op (ARCH 4.3)

export interface SubmissionPayload { id: string; internetId: string; mime: Uint8Array; envelope: { from: string; rcpt: string[] }; remoteThreadId?: string; remoteDraftId?: string }
export interface SendReceipt { remoteMessageId?: string; remoteThreadId?: string; acceptedAt: number }
export class NotSentError extends Error { constructor(readonly error: ClassifiedError) { super(error.reason) } }    // provably not sent -> failed, Retry offered
export class UncertainSendError extends Error { constructor(readonly error: ClassifiedError) { super(error.reason) } } // -> uncertain, findSent settles
export interface DraftUpload { localId: string; revision: number; fingerprint: string; mime: Uint8Array; remoteDraftId?: string; remoteThreadId?: string }
export interface DraftReceipt { remoteDraftId: string; remoteMessageId: string; revision: number }

export type Hint = { kind: 'changed'; scope?: ScopeId } | { kind: 'alive' }     // never data (ARCH 4.2 rule 8)
export interface ServerSearch { text: string; folder?: string; limit: number }   // Gmail: messages.list q= then metadata, ~210 units for 10
export interface RulesAdapter {
  list(ctx: AdapterContext): Promise<RemoteRule[]>
  create(rule: SenderRule, ctx: AdapterContext): Promise<string>     // remote id -> sender_rules.remote_filter_id
  delete(remoteId: string, ctx: AdapterContext): Promise<void>        // edits are delete-and-recreate
}
```

### 3.1 `CalendarAdapter`

```ts
export interface CalendarAdapter {
  readonly budget: BudgetId                                            // 'gcal' | 'graph' | 'caldav'
  listCalendars(state: SyncState | undefined, ctx: AdapterContext): Promise<{ calendars: CalendarFacts[]; removed: string[]; nextState: SyncState; costUnits: number }>
  syncStep(calendarRemoteId: string, state: SyncState, lane: Lane, ctx: AdapterContext): Promise<CalendarStepResult>
  put(change: EventChange, ctx: AdapterContext): Promise<EventFacts>   // only changed fields (D11); If-Match etag; 412 -> ProviderError{reason:'conditionNotMet'} -> edit conflict
  remove(ref: EventRef & { scope: EditScope }, ctx: AdapterContext): Promise<void>
  rsvp(ref: EventRef, response: 'accepted' | 'declined' | 'tentative', opts: { notify: boolean }, ctx: AdapterContext): Promise<EventFacts>
}
export type EditScope = 'occurrence' | 'series' | 'following'           // F1 Event/set; 'following' behind plan 20 Decision 6
export interface CalendarFacts { remoteId: string; name: string; color?: string; primary?: boolean; hidden: boolean; selected: boolean; readOnly: boolean; timeZone?: string }   // D24
export interface EventFacts {
  remoteId: string; etag?: string; calendarRemoteId: string
  masterRemoteId?: string               // set on an override
  recurrenceId?: string                 // the ORIGINAL start of an overridden/cancelled occurrence (RECURRENCE-ID / originalStartTime)
  rrule?: string[]; rdate?: string[]; exdate?: string[]   // master only; expansion is client-side (ADR-20)
  start: EventTime; end: EventTime; allDay: boolean
  status: 'confirmed' | 'tentative' | 'cancelled'
  selfResponse?: 'needsAction' | 'accepted' | 'declined' | 'tentative'
  organizerIsSelf: boolean; canEditShared: boolean      // forbiddenForNonOrganizer
  conference?: { url?: string; provider?: string }      // never rewritten by Aplos (D11)
  data: unknown                                         // provider-original JSON or ICS, round-tripped on write
}
export interface CalendarStepResult { upserts: EventFacts[]; removals: string[]; nextState: SyncState; done: boolean; scopeCovered?: { scope: ScopeId; generation: number }; reset?: 'syncTokenInvalid'; costUnits: number }
```

> **What this means:** Every service plugs into the same set of calls: connect, sync one step, open a conversation, apply your changes, send, and the calendar calls. Nothing provider-specific leaks into the engine.

## 4. `GovernorPort` and `AccountActorHost`

```ts
export interface GovernedRequest {
  budget: BudgetId; lane: Lane; cost: number
  slots?: number                        // in-flight weight: Graph $batch = 4; a Gmail HTTP batch = 1 slot, cost = sum of parts
  kind: RequestKind
  method: string                        // catalog id for the log line
  signal?: AbortSignal
}
export interface GovernorPort {
  /** Waits (never sends) until budget and a slot allow; classifies failures; the only code that re-sends (transient + read/idempotentWrite only). */
  run<T>(account: AccountId, req: GovernedRequest, fn: (signal: AbortSignal) => Promise<T>): Promise<T>
  /** A refusal found inside a successful reply (a 429 part of a 200 batch, a Graph sub-response): same pause and AIMD as a thrown one. */
  observe(account: AccountId, budget: BudgetId, error: ClassifiedError): void
  /** No I/O: may this lane run now? Sync/request and the timer loop ask this, so a manual sync during a pause makes zero requests. */
  admission(account: AccountId, budget: BudgetId, lane: Lane): { ok: true } | { ok: false; until: number; cls: ErrorClass; reason: string }
  setRole(account: AccountId, role: 'primary' | 'secondary'): void
  snapshot(account: AccountId): GovernorSnapshot[]                     // diagnostics bundle and status
  onChange(listener: (account: AccountId, snap: GovernorSnapshot) => void): () => void   // persisted to governor_state by the actor
}
export interface BoundGovernor { run<T>(req: GovernedRequest, fn: (signal: AbortSignal) => Promise<T>): Promise<T>; observe(budget: BudgetId, error: ClassifiedError): void }
export interface GovernorSnapshot {
  budget: BudgetId; target: number; usedInWindow: number; inFlight: number
  cooldownUntil?: number; cooldownStep: number; dailyBlockUntil?: number
  reason?: string; cls?: ErrorClass; lastRefusalAt?: number; quietSince?: number
}

export interface AccountActorHost {
  start(account: AccountId): Promise<void>
  stop(account: AccountId, why: 'disconnect' | 'quit' | 'needsReauth' | 'disabled'): Promise<void>   // aborts in-flight, waits for the current commit
  /** Sync/request: refused without any network call while paused, stopped or needsReauth. */
  request(account: AccountId | 'all', req: { scope?: ScopeId; manual: boolean }): { accepted: true } | { accepted: false; until?: number; reasonCode: ReasonCode }
  wake(reason: 'wake' | 'network' | 'focus' | 'push', account?: AccountId): void   // interrupts sleeps, jittered reconnect
  opsChanged(account: AccountId): void                                 // op flush trigger after Thread/act
  status(account: AccountId): AccountRuntime
  lastHeartbeat(account: AccountId): number | undefined                // supervisor restarts an actor silent for 2 minutes (eng-host)
  subscribe(listener: (account: AccountId, status: AccountRuntime) => void): () => void
}
export interface AccountActorDeps {                                     // what prov-gov's actor needs from the engine
  store: SyncStorePort; governor: GovernorPort; adapters: (kind: ProviderKind) => ProviderAdapter
  tokens: TokenSource; clock: Clock; log: Logger; deadlines: DeadlineRegistry; lease: LeasePort; laneFor: LaneFor
}
export interface TokenSource {
  access(account: AccountId, opts?: { forceRefresh?: boolean }): Promise<string>  // serialized refreshes per account (D21)
  grant(account: AccountId): { grantedAt: number; refreshExpiresAt?: number; scopes: string[] } | undefined
}
export interface LeasePort { current(account: AccountId): { deviceId: string; until: number } | undefined; renew(account: AccountId): Promise<void> }
```

`SyncStorePort` is the slice of `StorePort` (F4) the actor uses. Proposed names, all inside `store.commit` so a page and its resume token commit together with replay and the mutation fence (ARCH 4.3):

| Method | Purpose |
|---|---|
| `syncStates(account)` | read `sync_state` rows |
| `commitStep(account, result, {fenceSeq})` | upserts, label and placement deltas, removals, folders, drafts, `nextState`, memory, quarantine, `baseline_done_at`, one coarse `*` change per backfill page; runs `laneFor` on new rows |
| `sweep(account, scope, generation)` | generation sweep inside a covered scope |
| `pendingOps(account)` / `settleOps(outcomes)` | op flush |
| `saveGovernor(account, snapshot)` / `loadGovernor(account)` | `governor_state` persistence |
| `setStatus(account, AccountRuntime)` | `accounts.status*`, `resume_at` |
| `knownLookup(account)` | the read-only `KnownLookup` above |

## 5. Status vocabulary and account facts (F1)

```ts
export type AccountState =
  | { state: 'starting' }
  | { state: 'ok' }
  | { state: 'syncing' }
  | { state: 'backfilling'; read: number; target: number }
  | { state: 'paused'; until: number; cls: 'throttle' | 'daily' | 'anti_abuse'; reasonCode: ReasonCode }
  | { state: 'needsReauth'; reasonCode: ReasonCode }      // a REAL refusal only, never an approaching reconnectBy
  | { state: 'needsPermission'; missing: (keyof Capabilities)[]; reasonCode: ReasonCode }
  | { state: 'needsAdmin'; reasonCode: ReasonCode }
  | { state: 'misconfigured'; reasonCode: ReasonCode }
  | { state: 'offline' }
  | { state: 'error'; reasonCode: ReasonCode }
// Only 'offline' and 'paused' resume by themselves (ARCH 6.4).

export interface AccountRuntime extends Record<string, unknown> {
  status: AccountState
  reconnectBy?: number          // see below
  grantedScopes: string[]; capabilities: Capabilities
  firstWindow: { found?: number; read: number; total: number }   // complete when baselineDoneAt is set (AM-4)
  baselineDoneAt?: number
  backfill?: { read: number; target: number }
  lease?: { role: 'primary' | 'secondary'; holderDeviceId?: string; until?: number }   // "Background work runs on"
  calendars?: { remoteId: string; state: 'ok' | 'paused' | 'error'; until?: number; reasonCode?: ReasonCode }[]   // D12: per calendar
}

export type ReasonCode =       // stable keys mapped to DESIGN 7.15 copy; raw provider reasons stay in diagnostics
  | 'rate.minute' | 'rate.concurrency' | 'quota.daily' | 'quota.sendLimit' | 'quota.calendarAbuse'
  | 'auth.expired' | 'auth.revoked' | 'auth.adminPolicy' | 'auth.wrongAccount' | 'auth.testingModeExpiry'
  | 'permission.mailModify' | 'permission.filters' | 'permission.calendar'
  | 'config.apiDisabled' | 'config.clientMissing'
  | 'net.offline' | 'server.unavailable' | 'cursor.expired' | 'unknown'
```

**`reconnectBy` (roadmap N3, ARCH 6.4, 12.5).** For a Google account whose resolved OAuth client says its project is in Testing mode: `reconnectBy = min(token_granted_at + 7 days, token_granted_at + refresh_token_expires_in)`. Absent for every other account. Rules: it is a fact, never a state. The account stays `ok` and syncs until Google actually refuses (`invalid_grant` -> `needsReauth` with `auth.testingModeExpiry` when `now >= reconnectBy`, else `auth.revoked`). A failed reconnect attempt does not change it; only a successful grant moves it. `Account/reconnect` passes `login_hint` and `expectedSubject`; on success the actor resumes from the stored cursors with no resync and flushes queued ops, drafts and the outbox. `Setup/status` carries the same field.

> **What this means:** The screens get a short, fixed list of account states and a reconnect date. They never see Google's raw wording, and an account is only marked "reconnect needed" when Google has actually said no.

## 6. Walking the other providers through the port (round 2, on paper)

| Provider | How it fits | Port features it needs |
|---|---|---|
| Gmail (round 1) | `plan` emits P0-P5 and `history`; `syncStep('window:inbox')` lists and fetches metadata (40 per thread with `fields`), sets `baselineReached` after ~50; history steps return `labelDeltas` at zero fetch and fetch an unknown thread only on INBOX gain via `lookup.knownThreads`; 404 -> `reset:'cursorExpired'` | `costUnits`, `observe` for batch parts, `KnownLookup`, `trackedDrafts`, `memory` (app-label id) |
| Google Calendar (round 1) | `listCalendars` with its own sync token; per-calendar `syncStep` with `syncToken`, `singleEvents=false`; 410 -> `reset:'syncTokenInvalid'` for that calendar only; `put` patches changed fields with `If-Match` | separate `gcal` budget (600 req/min, 50%, 2 in flight), per-calendar status |
| IMAP (iCloud, Yahoo, generic) | scopes are `folder:<id>` with `cursor` = `uidvalidity:modseq:uidnext`; two connections held inside the adapter, commands metered as `commands` on budget `imap`; `MESSAGELIMIT` partial answers never set `scopeCovered`; `VANISHED` -> `Removal{folder, uid}`; `UIDVALIDITY` change -> `reset:'uidValidityChanged'`; `watch` yields IDLE hints; Sent copy appended inside `send` | `placements` with `uid`, `Removal` by uid, `budgets` in commands and bytes/day, `watch` |
| JMAP (Fastmail) | scope `history` holds `Email/changes` state; `cannotCalculateChanges` -> `reset`; `mailboxIds` -> `folders`; `watch` yields EventSource hints; session limits feed `BudgetSpec.inFlight` at connect | `capabilities.push`, `observe` for `rateLimit` SetErrors |
| Graph (Outlook) | scopes `folder:<id>` per-folder delta, `nextLink` in `pageToken`, `deltaLink` in `cursor`; `$batch` of 20 = `slots: 4`; per-sub-response 429 -> `observe` and the refused items stay in `nextState`, so the actor re-runs the step after the pause (no adapter retry); 410 `syncStateNotFound` -> `reset` | `slots`, `observe`, `windowMs` 600,000 |
| CalDAV (iCloud, Fastmail) | `CalendarAdapter` with `cal:<href>` scopes; cursor = sync-token, `pageToken` for 507 paging; invalid token -> `reset:'syncTokenInvalid'` keeping ETags; RSVP edits own `PARTSTAT` | budget `caldav` (2 in flight), redirect policy in `host/providers/shared` |

Nothing above needs a port change after the freeze.

## 7. Schema 0001 review (F4), against ARCH 3.2

| # | Table | Finding | Proposed change | Why |
|---|---|---|---|---|
| S1 | `accounts` | No token grant time and no hard refresh expiry | `token_granted_at INTEGER`, `refresh_expires_at INTEGER` | `reconnectBy` (PV5, N3) |
| S2 | `accounts` | No stored OAuth subject | `remote_subject TEXT` | reconnect refuses a different `sub` (D25, PV5) |
| S3 | `accounts` | Lease has `primary_lease_until` but no holder | `primary_lease_device TEXT` | "Background work runs on: <Mac>" and tie-breaks (ARCH 6.5) |
| S4 | `accounts` | Testing-mode flag must be per OAuth client, not global | `oauth_client TEXT` (client id fingerprint, not secret) | a source build on its own project may be in Production; `reconnectBy` only for Testing clients |
| S5 | `events` | No original start for overrides | `recurrence_id TEXT` (RECURRENCE-ID / `originalStartTime`, UTC or floating), plus `UNIQUE(calendar_id, remote_id, recurrence_id)` or remote ids made unique per override | overrides and cancelled occurrences (PV8, plan 20 F4 review item) |
| S6 | `calendars` | No `selected` flag | `selected INTEGER NOT NULL DEFAULT 1`, `time_zone TEXT` | D24; floating-time expansion |
| S7 | `message_folders` | Keyed `(message_id, folder_id)`; IMAP lookups go by `(folder_id, uid)` from `VANISHED`/`EXPUNGE` | make `mf_folder` `UNIQUE(folder_id, uid) WHERE uid IS NOT NULL` | fast, unambiguous placement removal (I4, I5) |
| S8 | `governor_state` | Escalation step and quiet time are not stored | `cooldown_step INTEGER NOT NULL DEFAULT 0`, `last_refusal_at INTEGER`, `cls TEXT` | escalation 60 s -> 5 min -> 1 h survives a restart; regrow after 10 quiet minutes |

Checked and fine as written: `sync_state` (scope strings above fit every provider; `generation` drives the sweep), `sync_failures`, `provider_memory`, `accounts.status*`/`resume_at`, `granted_scopes`, `baseline_done_at` (set by `baselineReached`, AM-4), `messages.origin` (search rows), `drafts.remote_draft_id`, `submissions.internet_id`, `sender_rules.remote_filter_id`, `threads.complete` (surfaces as `partial`).

> **What this means:** The planned database is close. Eight small columns or keys are missing for the weekly reconnect, the shared quota and repeating events, and adding them now is far cheaper than after the freeze.

## 8. What the Providers thread builds against these, and when

- `prov-emu`: `Clock` and the fault kit already follow these shapes (`packages/emulators/src/kit`); the Gmail emulator by day 4.
- `prov-gov`: `GovernorPort`, `AccountActorHost`, `TokenSource`, the classifier base and the shared no-retry HTTP client, days 4-9.
- `prov-gmail`: `ProviderAdapter` for Google with a pass-through governor stub until day 7.
- `prov-cal`: `CalendarAdapter` for Google Calendar and the recurrence module, days 5-13.
