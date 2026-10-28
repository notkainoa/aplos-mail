# Providers thread: port proposal and schema 0001 review (v2)

Written 2026-10-27 (day 1) by the Providers thread on `rv/thread/providers`, for the Engine thread to decide and freeze as F3 (ports) and F1 (status, `reconnectBy`) by day 3. It also carries the Providers review of schema 0001 (F4). This is a proposal: `eng-contract` owns `packages/engine/src/ports.ts` and `packages/contract`, and nothing here is edited there by this thread.

**v2 (same day).** An adversarial reviewer walked Gmail, Google Calendar, IMAP, JMAP, Graph and CalDAV through v1 and found 6 blockers and 21 smaller gaps. All are folded in. Section 9 lists each finding and how it was resolved, so the freeze reviewers can check them.

## In plain English

The engine needs one narrow door to talk to Gmail, and later to Outlook, iCloud and Fastmail. This document proposes the exact shape of that door.

Each mail service gets an adapter. An adapter only talks to the service. It never saves anything, never decides when a request may go out and never retries. A separate budget keeper, the governor, decides when each request may go out, so Aplos stays inside Google's 6,000-unit-a-minute limit. The governor is also the only place that ever repeats a request, and it never repeats a send. One worker per account, the account actor, runs the sync in small steps and saves each step together with its bookmark, so a crash costs one step.

This round only builds Gmail and Google Calendar. The door is still shaped so Outlook, iCloud, Fastmail and other calendars fit through it later without changing anything frozen now. Section 6 walks each of them through it.

The document also lists the account states the screens will show ("paused until 10:42", "reconnect needed") and the `reconnectBy` date, which lets Aplos warn you a day before Google's weekly sign-in expires. A pause never cancels a message that is already being sent, and mail that was due while Gmail was paused or signed out is held for you to confirm, never sent late silently.

Last, it reviews the planned database and asks for a short list of extra columns: for the weekly reconnect, the shared quota, safe clean-up after a resync, phone drafts and repeating events.

## Decisions for you

None. These are engineering choices for the Engine thread, which decides and freezes them on day 3. The owner-facing choices (weekly reconnect, Testing mode, Gmail first) were answered on 2026-10-27 and this proposal follows them.

> **What this means:** This is the plug every mail service will use. Getting it right now means round 2 only adds new services and changes nothing that already works.

## 1. Principles the types enforce

1. **Adapters never retry, never pace, never write the store** (ARCH 6.1, plan 20 3.2). Every network call, token refreshes included, goes through `ctx.governor.run`. Results come back as data; the actor commits them.
2. **Exactly one retry layer: the governor.** It re-sends only (a) `transient` failures of `read` or `idempotentWrite` calls, jittered 1, 2, 4 s, three tries (ARCH 6.3), and (b) a request that got a first 401, once, after one forced token refresh. Nothing else is ever re-sent, and a `send` never is. After the governor gives up, the actor and the op flush do not loop: they run again only on the next planned cadence tick or after the pause ends. This supersedes plan 20's "the actor backs off with jitter" sentence.
3. **Zero requests while paused or blocked.** `governor.run` throws `PausedError` before any I/O, token calls included, when the budget is in cooldown, daily stop or an auth/config block. `Sync/request` and the timer loop ask `governor.admission` first and refuse without any network call, so manual syncs cannot leak.
4. **A pause never aborts a started send or write.** A pause rejects queued requests and aborts in-flight `read` and `idempotentWrite` requests on the same budget only. A `send` or `write` whose bytes may have left always runs to its answer.
5. **One bounded step per call.** `syncStep` does one page, one history page or one folder chunk and returns everything the actor needs to commit in one `store.commit`, including every resume token it moves. A step cut short by a pause returns what it already has, marked not done, so nothing fetched is lost or re-spent.
6. **Deletion only inside a completed, bounded scope.** A removal is either stated by the server (Gmail history `messagesDeleted`, IMAP `VANISHED`, JMAP `destroyed`) or inferred by a generation sweep that removes *placements* only within the bound that round actually listed. A partial answer (`MESSAGELIMIT`, a host in limited mode, a refused batch part) never sets `scopeCovered`. Graph `@removed` in a per-folder delta is a placement removal, not a deletion.
7. **Facts, not copy.** Errors and states carry stable reason codes; the provider's own reason stays in diagnostics. The UI maps codes to DESIGN 7.15 copy.
8. **No content in logs.** Every log call goes through the frozen `Logger` (F7) with catalog ids: status, reason, method, units, wait and class only.
9. **Engine policy stays in the engine.** Which lanes run on a secondary device, when a late submission is suspended and when notifications fire are actor, outbox and store decisions; adapters supply facts and cadence hints.

## 2. Shared types

```ts
// ---- identity, lanes, budgets ----
export type ProviderKind = 'google' | 'microsoft' | 'imap' | 'jmap'      // mail adapters; CalDAV is a CalendarAdapter on imap/jmap accounts
export type AccountId = string
export type Lane = 'interactive' | 'opFlush' | 'incremental' | 'prefetch' | 'backfill' | 'enrichment'   // ARCH 4.1, priority order
export type RequestKind = 'read' | 'write' | 'idempotentWrite' | 'send'
export type BudgetId = 'gmail' | 'gcal' | 'graph' | 'imap' | 'imapBytes' | 'jmap' | 'caldav' | 'oauth' | `ai:${string}`  // ai:* is eng-ai's, same base class
export const PROJECT = '*'   // governor_state.account_id for project-wide blocks (config, Gmail dailyLimitExceeded)

export interface Clock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }   // F3

// ---- the classified error (F1 contract type, the same record the Logger F7 carries) ----
export type ErrorClass =
  | 'auth' | 'permission' | 'throttle' | 'daily' | 'send_limit' | 'anti_abuse'
  | 'config' | 'conflict' | 'transient' | 'permanent' | 'cancelled'

export interface ClassifiedError {
  class: ErrorClass
  provider: BudgetId                    // which budget refused ('oauth' for the token endpoint)
  method: string                        // catalog method id, e.g. 'gmail.threads.get', 'oauth.token', 'imap.UID FETCH'
  reason: string                        // provider's own code verbatim: 'rateLimitExceeded', 'invalid_grant', 'AADSTS70000', 'ETHROTTLE'
  status?: number
  retryAfterMs?: number                 // from Retry-After, seconds or HTTP-date, no cap
  resumeAt?: number                     // absolute end of a daily stop (Gmail: next midnight America/Los_Angeles)
  scope?: 'account' | 'project'         // 'project' for config and Gmail dailyLimitExceeded ("your project reaches its API limit")
  concurrency?: boolean                 // a concurrency refusal: in-flight and batch size halve
  uncertain?: boolean                   // a non-send write whose outcome is unknown (sends use UncertainSendError instead)
  missingScopes?: string[]              // 'permission'
  item?: string                         // 'permanent': the remote item to quarantine in sync_failures
  providerMessage?: string              // <= 300 chars, redacted by the Logger; never shown in the UI
}
export class ProviderError extends Error { constructor(readonly error: ClassifiedError) { super(error.reason) } }
/** Thrown by governor.run before any I/O. A send that gets it was provably not sent. */
export class PausedError extends Error {
  constructor(readonly budget: BudgetId, readonly until: number | undefined, readonly cls: ErrorClass, readonly reason: string) { super('paused') }
}

// ---- facts adapters return ----
export interface MessageFacts {
  remoteId: string                       // Gmail message id; IMAP EMAILID or a stable hash; JMAP Email id; Graph immutable id
  remoteThreadId: string                 // Gmail threadId; JMAP threadId; Graph conversationId; IMAP THREADID or the header root
  internetId?: string; inReplyTo?: string; refs?: string[]
  from?: Address; to: Address[]; cc: Address[]; replyTo?: Address[]
  subject?: string; snippet?: string     // snippet entity-decoded (D22)
  date: number; internalDate: number; size?: number
  flags: { seen: boolean; flagged: boolean; answered?: boolean; draft: boolean; fromMe: boolean }
  folders: string[]                      // label/folder remote ids. Gmail: labelIds MINUS UNREAD and STARRED (those are flags); CATEGORY_* and IMPORTANT stay here
  placements?: { folder: string; uid?: number }[]   // IMAP per-folder UID (message_folders.uid)
  headers: HeaderFacts                   // ARCH 5.1's nine plus List-Unsubscribe-Post, for laneFor and unsubscribe
  partial: boolean                       // metadata only; row surfaces as partial:true (F1)
  knownCount?: number                    // messages in the thread, when the call returned it (AM-1's 60-unit open)
  attachments?: AttachmentFacts[]
}
export interface LabelDelta { remoteId: string; add: string[]; remove: string[] }       // Gmail history, zero fetch (D13)
export interface FlagDelta { remoteId?: string; folder?: string; uid?: number; seen?: boolean; flagged?: boolean; answered?: boolean }
export interface PlacementDelta { remoteId?: string; folder: string; uid?: number; present: boolean }   // IMAP/JMAP/Graph moves; Graph @removed
export interface Removal { remoteId?: string; folder?: string; uid?: number }             // server-stated deletion
export interface FolderFacts { remoteId: string; name: string; role?: FolderRole; kind: 'label' | 'folder' | 'system'; hidden?: boolean; uidValidity?: number; removed?: boolean }
export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive' | 'starred' | 'important' | 'all'
export interface RemoteDraftFact {                                                         // D9: drafts never become thread rows
  remoteDraftId: string; remoteMessageId: string; remoteThreadId?: string; changedAt: number
  removed?: boolean
  message?: MessageFacts                                                                   // metadata so a phone draft can show in Drafts; body lazy
}

// ---- scopes and state ----
export type ScopeId =
  | 'history' | 'window:inbox' | 'backfill:inbox' | 'sent:recent' | 'prefetch'
  | 'workflow' | `folder:${string}` | 'calendars' | `cal:${string}`
export interface SyncState {             // one sync_state row
  scope: ScopeId; cursor?: string; pageToken?: string; phase?: string
  oldestLoaded?: number; generation: number; updatedAt: number
  pending?: string[]                     // remote ids fetched-but-refused or still to fetch in this step, at most 500 (the per-run memo)
}
export interface PlanEnv { now: number; focused: boolean; windowVisible: boolean; onBattery: boolean }
export interface PlannedStep { scope: ScopeId; lane: Lane; notBefore?: number; reason: 'first' | 'poll' | 'push' | 'wake' | 'manual' | 'resume' | 'reset' }
export type StepOrigin = 'baseline' | 'incremental' | 'backfill' | 'resync' | 'prefetch' | 'search'

export interface StepResult {
  origin: StepOrigin                     // set by the actor from the planned step; the store notifies only for 'incremental'
  upserts: MessageFacts[]
  labelDeltas: LabelDelta[]
  flagDeltas: FlagDelta[]
  placements: PlacementDelta[]
  removals: Removal[]
  folders?: FolderFacts[]
  drafts?: RemoteDraftFact[]
  threadMerges?: { from: string[]; into: string }[]   // IMAP header threading when a bridging message arrives
  nextStates: SyncState[]                // every scope this step moves, committed in one transaction (e.g. finish window:inbox, seed backfill:inbox)
  done: boolean                          // false when cut short by a pause: partial facts are committed, `pending` holds the rest
  scopeCovered?: { scope: ScopeId; generation: number; bound: { folder: string; since?: number; uidFrom?: number; uidTo?: number } }
  reset?: 'cursorExpired' | 'uidValidityChanged' | 'syncTokenInvalid' | 'cannotCalculateChanges' | 'changeCapExceeded' | 'windowRolled'   // informational: log + reason code; plan() emits the resync steps
  baselineReached?: boolean              // newest ~50 Inbox threads committed: set baseline_done_at (AM-4)
  progress?: { read: number; total?: number; found?: number }
  memory?: Record<string, string | null> // provider_memory writes
  costUnits: number
  quarantine?: { item: string; error: ClassifiedError }[]
}
```

## 3. `ProviderAdapter`

```ts
export interface AdapterContext {
  account: { id: AccountId; provider: ProviderKind; address?: string; grantedScopes: string[]; capabilities: Capabilities }
  governor: BoundGovernor                // the only way to reach the network
  clock: Clock
  log: Logger                            // F7 catalog ids only
  signal: AbortSignal                    // close() and stop() only; pauses use the per-request signal from the governor
  lookup: KnownLookup                    // read-only store view
  memory: ReadonlyMap<string, string>
}
export interface ConnectContext { clock: Clock; log: Logger; signal: AbortSignal; governor: BoundGovernor; auth: AuthFlow }   // AuthFlow: host/providers/oauth (loopback + PKCE)

export interface KnownLookup {
  knownThreads(remoteThreadIds: string[]): Promise<Set<string>>                 // INBOX-gain rule (D3)
  knownMessages(remoteIds: string[]): Promise<Set<string>>
  trackedDraftIds(remoteDraftIds: string[]): Promise<Set<string>>               // D9: drafts are recognised by draft id, not message id
  threadMessages(remoteThreadId: string): Promise<{ remoteId: string; placements: { folder: string; uid?: number }[] }[]>
  folderUids(folder: string, uidFrom: number, uidTo: number): Promise<number[]> // IMAP bounded expunge check
  eventEtags(calendarRemoteId: string, remoteIds: string[]): Promise<Map<string, string>>   // CalDAV resync keeping ETags
}

export interface ProviderAdapter {
  readonly kind: ProviderKind
  /** Budgets for this account; static for Gmail, from the session or host table for JMAP and IMAP. */
  budgets(account: AdapterContext['account'], memory: ReadonlyMap<string, string>): BudgetSpec[]

  connect(req: ConnectRequest, ctx: ConnectContext): Promise<ConnectResult>
  /** Pure: steps to run now, from committed state, trigger and environment. Gmail P0-P5 and resyncs, IMAP rotation, Graph delta, cadence via notBefore. */
  plan(states: SyncState[], trigger: PlannedStep['reason'], env: PlanEnv, ctx: AdapterContext): PlannedStep[]
  syncStep(scope: ScopeId, state: SyncState, lane: Lane, ctx: AdapterContext): Promise<StepResult>

  /** ProviderPort.openThread (F3, AM-1). */
  openThread(ref: ThreadOpenRef, lane: 'interactive' | 'prefetch', ctx: AdapterContext): Promise<OpenedThread>
  fetchAttachment(ref: AttachmentRef, ctx: AdapterContext): Promise<AsyncIterable<Uint8Array>>

  /** Pure: merge pending ops into provider calls (Gmail: identical add/remove sets -> one batchModify per 1,000 ids). */
  coalesce(ops: PendingOp[]): CoalescedOp[]
  apply(op: CoalescedOp, ctx: AdapterContext): Promise<OpOutcome[]>   // one outcome per op id; idempotent writes only

  saveDraft?(draft: DraftUpload, ctx: AdapterContext): Promise<DraftReceipt>
  deleteDraft?(remoteDraftId: string, ctx: AdapterContext): Promise<void>
  /** Never retried. Throws NotSentError (provably not sent, including PausedError before I/O) or UncertainSendError. */
  send(sub: SubmissionPayload, ctx: AdapterContext): Promise<SendReceipt>
  findSent(internetId: string, ctx: AdapterContext): Promise<FindSentResult>

  search?(query: ServerSearch, ctx: AdapterContext): Promise<SearchResult>      // on Enter only
  watch?(ctx: AdapterContext): AsyncIterable<Hint>                              // data-free: IDLE, EventSource; Gmail none
  workflow?: WorkflowChannel                                                    // Done/Later sync and the lease (D17, D18, ARCH 6.5)
  rules?: RulesAdapter
  calendar?: CalendarAdapter
  close(): Promise<void>
}

export interface BudgetSpec {
  id: BudgetId
  unit: 'units' | 'requests' | 'commands' | 'bytes'
  windowMs: number                      // gmail 60_000 sliding; graph 600_000; gcal 60_000; imapBytes 86_400_000
  ceiling: number                       // the provider's hard number: 6,000; 10,000; 600
  targets: Record<'primary' | 'secondary', number>   // gmail 4,500 / 1,500 (ARCH 6.2)
  floor: number                         // AIMD floor: gmail 1,000
  laneShare: Partial<Record<Lane, number>>           // gmail: interactive 1, opFlush 1, incremental .9, prefetch .2, backfill .75
  inFlight: number; reservedInteractive: number      // gmail 3 / 1; graph 4 / 0 with priority admission (a $batch takes 4 slots); gcal 2; caldav 2
  batch?: { start: number; min: number; max: number; growBy: number }   // gmail HTTP batch: 10, 1, 25, 5 (ARCH 6.2)
}

export interface ConnectRequest {
  mode: 'new' | 'reconnect' | 'grantPermissions'
  loginHint?: string                    // reconnect: preselect the same account
  expectedSubject?: string              // reconnect: a different `sub` is refused ('wrongAccount')
  preset?: 'gmail' | 'outlook' | 'icloud' | 'fastmail' | 'yahoo' | 'generic'
  server?: { imap?: HostPort; smtp?: HostPort; jmapSession?: string; caldav?: string }
  secretRef?: string                    // vault reference for app passwords and API tokens; never the secret
}
export interface ConnectResult {
  identity: { subject: string; address: string; displayName?: string }   // from the id_token (openid), so connect makes no Gmail call
  grantedScopes: string[]               // the token response's `scope` (D5)
  capabilities: Capabilities
  grantedAt: number                     // -> accounts.token_granted_at
  refreshExpiresAt?: number             // response time + refresh_token_expires_in, when sent
  oauthClient?: string                  // client id fingerprint; says whether the project is in Testing mode
  tokenRef: string                      // vault reference of the bundle (refresh token + client id, D21)
  budgets?: Partial<BudgetSpec>[]       // per-account limits learned at connect (JMAP session, IMAP host table)
}
// connect refuses with ProviderError {class:'permission', reason:'missingRequiredScope', missingScopes:['gmail.modify']} or {class:'auth', reason:'wrongAccount'}

export interface Capabilities {
  labels: boolean; folders: boolean; drafts: boolean; serverSearch: boolean; calendar: boolean
  filters: boolean; push: boolean; sendAs: boolean; unsubscribeHeaders: boolean
  threading: 'native' | 'headers'
  partialView?: boolean                 // host shows partial folders (Yahoo limited mode): the actor ignores scopeCovered there
}

export interface ThreadOpenRef {
  remoteThreadId: string
  knownCount?: number                   // AM-1: messages.get full (60) only when exactly 1 is known, else threads.get full (120)
  knownMessages?: { remoteId: string; placements: { folder: string; uid?: number }[] }[]
}
export interface OpenedThread { messages: (MessageFacts & { body: ProviderBody })[]; labelDeltas?: LabelDelta[]; removed?: string[]; costUnits: number }
export interface ProviderBody { text?: string; html?: string; cidMap: Record<string, string>; attachments: AttachmentFacts[] }   // ARCH 3.3, unsanitized

export interface PendingOp { opId: string; seq: number; kind: 'labels' | 'move' | 'flags' | 'trash' | 'untrash'; target: string; payload: unknown; base?: unknown }
export interface CoalescedOp { opIds: string[]; call: string; cost: number; body: unknown }
export interface OpOutcome {
  opId: string; result: 'applied' | 'notFound' | 'failed'     // notFound drops the op (ARCH 4.3)
  error?: ClassifiedError
  placements?: PlacementDelta[]                              // IMAP UID MOVE / COPYUID: the new UIDs
}

export interface SubmissionPayload { id: string; internetId: string; mime: Uint8Array; envelope: { from: string; rcpt: string[] }; remoteThreadId?: string; remoteDraftId?: string }
export interface SendReceipt { remoteMessageId?: string; remoteThreadId?: string; acceptedAt: number; draftConsumed?: boolean }   // drafts.send removed the remote draft
export class NotSentError extends Error { constructor(readonly error: ClassifiedError, readonly deferUntil?: number) { super(error.reason) } }
export class UncertainSendError extends Error { constructor(readonly error: ClassifiedError) { super(error.reason) } }
export type FindSentResult = { found: { remoteMessageId: string; remoteThreadId?: string } } | { absent: true; checkedAt: number }   // engine re-checks once after 60 s (search lag)
export interface DraftUpload { localId: string; revision: number; fingerprint: string; mime: Uint8Array; remoteDraftId?: string; remoteThreadId?: string }
export interface DraftReceipt { remoteDraftId: string; remoteMessageId: string; revision: number }

export type Hint = { kind: 'changed'; scope?: ScopeId } | { kind: 'alive' }   // never data (ARCH 4.2 rule 8)
export interface ServerSearch { text: string; folder?: string; limit: number; pageToken?: string }
export interface SearchResult { upserts: MessageFacts[]; threadIds: string[]; nextPageToken?: string; costUnits: number }   // ranked; rows stored with origin='search'

export interface WorkflowChannel {
  /** One gated round: history on the app label (2 units) first; reads only copies not seen before; paginates past 50. */
  round(state: SyncState, ctx: AdapterContext): Promise<{ copies: WorkflowCopy[]; nextState: SyncState; costUnits: number }>
  /** Writes one encrypted copy (kind 'write'; checks for its own copy first, ARCH 6.3). Carries the lease record. */
  put(copy: WorkflowCopy, ctx: AdapterContext): Promise<string>
  /** Moves superseded copies to Trash (gmail.modify cannot delete). */
  compact(remoteIds: string[], ctx: AdapterContext): Promise<void>
}
export interface RulesAdapter {
  list(ctx: AdapterContext): Promise<RemoteRule[]>
  create(rule: SenderRule, ctx: AdapterContext): Promise<string>     // -> sender_rules.remote_filter_id
  delete(remoteId: string, ctx: AdapterContext): Promise<void>        // edits are delete-and-recreate
}
```

**Partial steps.** When `governor.run` throws `PausedError` in the middle of a step (another request on the budget was refused, or a refusal arrived inside a batch reply and was passed to `observe`), the adapter returns a `StepResult` with what it already has, `done: false`, no `scopeCovered`, and the unfetched remote ids in `nextStates[...].pending`. The actor commits it and re-plans after the pause. `observe` never aborts the caller's own step. This is how a refused Graph sub-request or a refused Gmail batch part is retried alone, and how plan 20's per-run memo works without re-spending the window.

**First-window cost is the adapter's choice.** P1 may use `threads.get?format=metadata` (40 per thread, returns `knownCount` and every message's labels, so D8/D9 roll up correctly) and P2 may use `messages.get?format=metadata` on the newest message (20, ARCH 5.1). The port carries both. `prov-gmail` settles it against the emulator and the "500 threads in about 3 minutes" target.

### 3.1 `CalendarAdapter`

```ts
export interface CalendarAdapter {
  readonly budget: BudgetId                                            // 'gcal' | 'graph' | 'caldav'
  listCalendars(state: SyncState | undefined, ctx: AdapterContext): Promise<{ calendars: CalendarFacts[]; removed: string[]; nextState: SyncState; costUnits: number }>
  syncStep(calendarRemoteId: string, state: SyncState, lane: Lane, ctx: AdapterContext): Promise<CalendarStepResult>
  /** Only changed fields (D11), If-Match etag. An occurrence edit creates an override; 'following' splits the series. */
  put(change: EventChange, ctx: AdapterContext): Promise<{ upserts: EventFacts[]; removals: string[] }>
  remove(ref: EventRef & { scope: EditScope }, ctx: AdapterContext): Promise<{ upserts: EventFacts[]; removals: string[] }>
  rsvp(ref: EventRef & { scope: EditScope }, response: 'accepted' | 'declined' | 'tentative', opts: { notify: boolean }, ctx: AdapterContext): Promise<{ upserts: EventFacts[] }>
}
export type EditScope = 'occurrence' | 'series' | 'following'           // F1 Event/set; 'following' behind plan 20 Decision 6
export interface EventRef { calendarRemoteId: string; remoteId: string; recurrenceId?: string; etag?: string }
export interface EventChange extends Partial<EventRef> { calendarRemoteId: string; scope: EditScope; fields: Partial<EventFields> }   // no remoteId = create
export interface EventFields {
  summary: string; location: string; description: string
  start: EventTime; end: EventTime; allDay: boolean
  attendees: { email: string; name?: string; response: 'needsAction' | 'accepted' | 'declined' | 'tentative'; organizer: boolean; self: boolean }[]
}
export type EventTime = { utc: number } | { date: string } | { local: string; tzid?: string }   // instant, all-day, floating or zoned
export interface CalendarFacts { remoteId: string; name: string; color?: string; primary?: boolean; hidden: boolean; selected: boolean; readOnly: boolean; timeZone?: string; changeTag?: string }   // D24; CalDAV ctag
export interface EventFacts extends EventFields {
  remoteId: string; etag?: string; calendarRemoteId: string
  masterRemoteId?: string               // set on an override; resolved to events.master_id lazily
  recurrenceId?: string                 // ORIGINAL start of an overridden or cancelled occurrence
  rrule?: string[]; rdate?: string[]; exdate?: string[]   // master only; expansion is client-side (ADR-20)
  status: 'confirmed' | 'tentative' | 'cancelled'
  organizerIsSelf: boolean; canEditShared: boolean      // forbiddenForNonOrganizer
  conference?: { url?: string; provider?: string }      // never rewritten by Aplos (D11)
  data: unknown                                         // provider-original JSON or ICS, round-tripped on write
}
export interface CalendarStepResult {
  upserts: EventFacts[]; removals: string[]; nextState: SyncState; done: boolean
  scopeCovered?: { scope: ScopeId; generation: number }
  reset?: 'syncTokenInvalid' | 'windowRolled'
  quarantine?: { item: string; error: ClassifiedError }[]
  costUnits: number
}
// A 412 is ProviderError {class:'conflict', reason:'conditionNotMet'}: the engine raises an edit conflict, never quarantines.
```

> **What this means:** Every service plugs into the same calls: connect, plan and run one sync step, open a conversation, apply your changes, send, sync Done and Later between Macs, and the calendar calls. Nothing provider-specific leaks into the engine, and the engine's own rules never leak into an adapter.

## 4. `GovernorPort` and `AccountActorHost`

```ts
export interface GovernedRequest {
  budget: BudgetId; lane: Lane
  costs?: Partial<Record<BudgetId, number>>   // when one call spends two budgets (IMAP: 1 command; bytes charged after via charge())
  cost: number                                // on `budget`
  slots?: number                              // in-flight weight: Graph $batch = 4 (must be <= inFlight - reservedInteractive outside interactive)
  kind: RequestKind
  method: string
  auth?: boolean                              // default true: the governor supplies an access token and owns the one forced refresh
}
export interface RequestIo { signal: AbortSignal; accessToken?: string }   // signal: per-budget, aborted by a pause only for read/idempotentWrite

export interface GovernorPort {
  /** Waits (never sends) until budget and a slot allow. The only code that re-sends (principle 2). */
  run<T>(account: AccountId, req: GovernedRequest, fn: (io: RequestIo) => Promise<T>): Promise<T>
  /** A refusal found inside a successful reply (a 429 part of a 200 batch). Same state change as a thrown one; never aborts the caller. */
  observe(account: AccountId, budget: BudgetId, error: ClassifiedError): void
  /** Post-hoc charge, e.g. IMAP bytes known only after the reply. */
  charge(account: AccountId, budget: BudgetId, amount: number): void
  /** No I/O. Sync/request, the timer loop and SendPort ask this first. */
  admission(account: AccountId, budget: BudgetId, lane: Lane, kind?: RequestKind): { ok: true } | { ok: false; until?: number; cls: ErrorClass; reason: string }
  batchSize(account: AccountId, budget: BudgetId): number   // AIMD batch size (10, halved on refusal, +5 to 25)
  setRole(account: AccountId, role: 'primary' | 'secondary'): void
  /** After a successful reconnect or a config fix. The only way out of an auth or config block. */
  clear(account: AccountId | typeof PROJECT, cls: 'auth' | 'config'): void
  snapshot(account: AccountId | typeof PROJECT): GovernorSnapshot[]
  restore(account: AccountId | typeof PROJECT, snapshots: GovernorSnapshot[]): void
  onChange(listener: (account: AccountId | typeof PROJECT, snap: GovernorSnapshot) => void): () => void   // persisted to governor_state by the actor
}
export interface BoundGovernor {
  run<T>(req: GovernedRequest, fn: (io: RequestIo) => Promise<T>): Promise<T>
  observe(budget: BudgetId, error: ClassifiedError): void
  charge(budget: BudgetId, amount: number): void
  batchSize(budget: BudgetId): number
}
export interface GovernorSnapshot {
  budget: BudgetId; target: number; inFlightLimit: number; batchSize: number
  windowSpent: number; windowAt: number          // persisted, so a restart cannot re-spend the same minute (PV2 "does not hammer")
  inFlight: number
  cooldownUntil?: number; cooldownStep: number
  dailyBlockUntil?: number
  sendBlockedUntil?: number                      // send_limit blocks sends only; sync continues
  blocked?: { cls: 'auth' | 'config'; since: number }   // until clear()
  reason?: string; cls?: ErrorClass; lastRefusalAt?: number; quietSince?: number
}
```

**Action per class** (the governor's whole policy; ARCH 6.3 with the review's corrections):

| Class | Governor action | Re-sent? | Account status |
|---|---|---|---|
| `throttle` | cooldown for max(`retryAfterMs`, escalation 60 s -> 5 min -> 15 min -> 1 h), reset after 10 quiet minutes; target halves (floor), regrows 250/min after 10 quiet minutes; `concurrency` halves in-flight and batch size | no | `paused(until, cls:'throttle')` for mail budgets; per calendar for `gcal` |
| `daily` | stop the budget until `resumeAt`; `scope:'project'` stops every account on `PROJECT` | never | `paused(until, cls:'daily')` |
| `send_limit` | `sendBlockedUntil`; `admission(..., 'send')` refuses until then; sync unaffected | never | unchanged; the submission is `failed` "until HH:MM" |
| `anti_abuse` | cooldown of hours on that budget (`gcal`) | never | per calendar, never the mail status (D12) |
| `auth` | first 401: one forced refresh and one re-send. Otherwise `blocked` until `clear`; no token calls while blocked | once, after refresh | `needsReauth` |
| `permission` | none on the budget; capability recorded | never | `missingPermissions` fact; `needsPermission` only for a missing `gmail.modify` |
| `config` | `blocked` on `PROJECT` | never | `misconfigured` on every account of the provider |
| `conflict`, `permanent` | none | never | item-level (edit conflict, quarantine) |
| `transient` | read / idempotentWrite: 1, 2, 4 s jitter, three tries, each re-admitted; write: `uncertain`; send: `UncertainSendError` | reads only | `offline` when the network is down |

**A pause.** Rejects every queued request of that account and budget with `PausedError`, aborts in-flight `read` and `idempotentWrite` requests on that budget through the per-request signal, and never aborts an in-flight `send` or `write`.

```ts
export interface AccountActorHost {
  start(account: AccountId): Promise<void>        // runs the overdue-submission rule (below) before flushing anything
  stop(account: AccountId, why: 'disconnect' | 'quit' | 'needsReauth' | 'disabled'): Promise<void>
  request(account: AccountId, req: { scope?: ScopeId; manual: boolean }): { accepted: true } | { accepted: false; until?: number; reasonCode: ReasonCode }
  requestAll(req: { manual: boolean }): Record<AccountId, { accepted: true } | { accepted: false; until?: number; reasonCode: ReasonCode }>
  wake(reason: 'wake' | 'network' | 'focus' | 'push', account?: AccountId): void
  opsChanged(account: AccountId): void
  openThread(account: AccountId, threadId: string): Promise<void>       // thread.open for a partial row; interactive lane
  search(account: AccountId, q: ServerSearch): Promise<{ threadIds: string[]; nextPageToken?: string }>
  attachment(account: AccountId, ref: AttachmentRef): Promise<AsyncIterable<Uint8Array>>
  reconnected(account: AccountId, result: ConnectResult): Promise<void> // clear(auth), store the bundle, resume from stored cursors, no resync
  status(account: AccountId): AccountRuntime
  lastHeartbeat(account: AccountId): number | undefined
  subscribe(listener: (account: AccountId, status: AccountRuntime) => void): () => void
}
export interface AccountActorDeps {
  store: SyncStorePort; governor: GovernorPort; adapters: (kind: ProviderKind) => ProviderAdapter
  tokens: TokenSource; clock: Clock; log: Logger; deadlines: DeadlineRegistry; lease: LeasePort; env: () => PlanEnv
}
export interface TokenSource {                                         // host/providers/oauth; called only by the governor
  access(account: AccountId, opts?: { forceRefresh?: boolean }): Promise<string>   // serialized per account (D21); the refresh itself is a governed 'oauth' request
  grant(account: AccountId): { grantedAt: number; refreshExpiresAt?: number; scopes: string[] } | undefined
}
export interface LeasePort {
  readonly selfDeviceId: string
  current(account: AccountId): { deviceId: string; until: number } | undefined
  renew(account: AccountId): Promise<void>                              // rides WorkflowChannel.put
  claim(account: AccountId): Promise<void>                              // "Use this Mac" (Account/lease)
}
```

**Role policy is the actor's.** On a secondary device the actor drops `backfill`, `prefetch` and `enrichment` steps from `plan()`'s output and calls `setRole('secondary')`. Adapters never see the role.

**Sends and pauses (SendPort, `eng-time`).** `SendPort` asks `admission(account, budget, 'interactive', 'send')` before committing the `sending` marker. A `PausedError` or `NotSentError` with `deferUntil` puts the submission back to `queued` with that time, never `failed` or `uncertain`. When an account resumes (pause end, reconnect, launch, wake), any submission more than the 5-minute grace past `not_before` becomes `suspended` (ARCH 7.3, ADR-16): mail is never sent days late without the user saying so. The same applies to the outbox flush after a reconnect.

`SyncStorePort` is the slice of `StorePort` (F4) the actor uses; every write is inside `store.commit` with replay and the mutation fence (ARCH 4.3):

| Method | Purpose |
|---|---|
| `syncStates(account)` | read `sync_state` rows |
| `commitStep(account, result, {fenceSeq})` | all facts and every `nextStates` row in one transaction; stamps `message_folders.seen_gen` for listed placements; writes `baseline_done_at`; notifications only for `origin:'incremental'` after the baseline; one coarse `*` change per backfill page; runs `laneFor` on new rows |
| `sweep(account, scope, generation, bound)` | removes placements in `bound.folder` within the bound whose `seen_gen` is older than `generation`; never deletes messages; orphan messages are collected separately |
| `commitOpened(account, OpenedThread, {fenceSeq})` | replaces a thread's messages, keeps workflow, sets `threads.complete=1`, re-runs `laneFor` |
| `commitSearch(account, SearchResult)` | rows with `origin='search'` (garbage-collected after 7 days unopened) |
| `pendingOps(account)` / `settleOps(outcomes)` | op flush |
| `saveGovernor(account, snapshot)` / `loadGovernor(account)` | `governor_state`, including `PROJECT` rows |
| `setStatus(account, AccountRuntime)` | `accounts.status*`, `resume_at` |
| `knownLookup(account)` | `KnownLookup` |

## 5. Status vocabulary and account facts (F1)

```ts
export type AccountState =
  | { state: 'starting' }
  | { state: 'ok' }
  | { state: 'syncing' }
  | { state: 'backfilling'; read: number; target: number }
  | { state: 'paused'; until: number; cls: 'throttle' | 'daily'; reasonCode: ReasonCode }   // mail budgets only
  | { state: 'needsReauth'; reasonCode: ReasonCode }       // a REAL refusal only, never an approaching reconnectBy
  | { state: 'needsPermission'; reasonCode: ReasonCode }   // only when gmail.modify (or a provider's core mail scope) is missing
  | { state: 'needsAdmin'; reasonCode: ReasonCode }
  | { state: 'misconfigured'; reasonCode: ReasonCode }
  | { state: 'offline' }
  | { state: 'error'; reasonCode: ReasonCode }
// Only 'offline' and 'paused' resume by themselves (ARCH 6.4).

export interface AccountRuntime {
  status: AccountState
  reconnectBy?: number
  grantedScopes: string[]; capabilities: Capabilities
  missingPermissions?: { capability: keyof Capabilities; reasonCode: ReasonCode }[]   // feature-level, e.g. calendar or filters
  sendBlockedUntil?: number
  firstWindow: { found?: number; read: number; total: number }   // complete when baselineDoneAt is set (AM-4)
  baselineDoneAt?: number
  backfill?: { read: number; target: number }
  lease?: { role: 'primary' | 'secondary'; holderDeviceId?: string; until?: number }
  calendars?: { remoteId: string; state: 'ok' | 'paused' | 'error'; until?: number; reasonCode?: ReasonCode }[]   // D12
}

/** Stable keys mapped to DESIGN 7.15 copy. Additive-only after the freeze; round-2 codes are listed now. */
export type ReasonCode =
  | 'rate.minute' | 'rate.concurrency' | 'quota.daily' | 'quota.project' | 'quota.sendLimit' | 'quota.calendarAbuse' | 'quota.bandwidth'
  | 'auth.expired' | 'auth.revoked' | 'auth.adminPolicy' | 'auth.adminConsent' | 'auth.wrongAccount' | 'auth.testingModeExpiry'
  | 'permission.mailModify' | 'permission.filters' | 'permission.calendar' | 'permission.settings'
  | 'config.apiDisabled' | 'config.clientMissing'
  | 'net.offline' | 'server.unavailable' | 'server.connectionLimit' | 'server.limitedMode'
  | 'cursor.expired' | 'unknown'
```

**`reconnectBy` (roadmap N3, ARCH 6.4, 12.5).** Present only for a Google account whose OAuth client is in Testing mode: `reconnectBy = min(token_granted_at + 7 days, refresh_expires_at)`, where `refresh_expires_at` is the response time plus `refresh_token_expires_in` when Google sends it. It is a fact, never a state: the account stays `ok` and syncs until Google refuses. Then `invalid_grant` gives `needsReauth` with `auth.testingModeExpiry` when `now >= reconnectBy`, else `auth.revoked`. A failed reconnect does not change it; only a successful grant moves it. `Account/reconnect` passes `login_hint` and `expectedSubject`; identity comes from the `id_token`, so a reconnect works even during a Gmail daily stop. On success `reconnected()` clears the auth block and resumes from the stored cursors with no resync (a cursor Google already expired takes the bounded resync of D10). Queued ops and drafts flush; outbox items obey the overdue rule in section 4. `Setup/status` carries the same field.

> **What this means:** The screens get a short, fixed list of account states plus a few facts: when to reconnect, which features lack permission and when sending is allowed again. They never see Google's raw wording, and an account is only marked "reconnect needed" when Google has actually said no.

## 6. The other providers through the port (round 2, on paper)

| Provider | How it fits |
|---|---|
| Gmail (round 1) | `plan` emits P0-P5, `history`, `workflow` and resyncs with cadence from `PlanEnv` (15 s focused, 60 s no window, 5 min on battery, +/-25%). The window sets `baselineReached` after ~50. History returns `labelDeltas` and `flagDeltas` (UNREAD, STARRED) at zero fetch; an unknown thread is fetched only on INBOX gain (`knownThreads`); more than 150 fetches gives `reset:'changeCapExceeded'` and the fresh-window steps. A 404 gives `reset:'cursorExpired'`; `plan` then re-captures the history id, re-seeds `window:inbox` with a new generation and sweeps with a bound of the window it listed. Batch parts refused inside a 200 go to `observe`; the step returns partial with `pending`. Phone drafts arrive as `RemoteDraftFact` with metadata. |
| Google Calendar (round 1) | own `gcal` budget (600 req/min, 50%, 2 in flight); `listCalendars` with its sync token; per-calendar `syncToken`, `singleEvents=false`; 410 -> `reset:'syncTokenInvalid'` for that calendar; `put` patches changed fields with `If-Match`; 412 -> `conflict`; RSVP patches the self attendee with the whole attendee list; pauses show per calendar |
| IMAP (iCloud, Yahoo, generic) | scopes `folder:<id>`, cursor `uidvalidity:modseq:uidnext`; budgets `imap` (commands) and `imapBytes` (1,000 MB/day, charged after each FETCH); per-account limits from the host table via `ConnectResult.budgets`; `MESSAGELIMIT` and `partialView` never set `scopeCovered`; `VANISHED` -> `Removal{folder,uid}`; CONDSTORE-only expunge check diffs `UID SEARCH` against `folderUids`; `UIDVALIDITY` change -> `reset`; `UID MOVE` returns new placements in `OpOutcome`; header threading merges via `threadMerges`; flags-only changes via `flagDeltas`; Yahoo's periodic resync despite IDLE via `plan` cadence; `watch` yields IDLE hints |
| JMAP (Fastmail) | scope `history` holds `Email/changes` state; `cannotCalculateChanges` -> `reset`; `mailboxIds` -> folders and placements; keywords -> `flagDeltas`; session limits -> `ConnectResult.budgets`; `rateLimit` SetErrors -> `observe`; `watch` yields EventSource hints |
| Graph (Outlook) | scopes `folder:<id>` per-folder delta, `nextLink` in `pageToken`, `deltaLink` in `cursor`; `@removed` -> `PlacementDelta{present:false}` (a message is gone only when it has no placements left and every role folder is covered); `$batch` of 20 takes 4 slots with `reservedInteractive: 0`; sub-response 429 -> `observe`, refused ids in `pending`; 410 -> `reset`; calendar `calendarView/delta` with `reset:'windowRolled'` monthly |
| CalDAV (iCloud, Fastmail) | `cal:<href>` scopes, cursor = sync-token, `pageToken` for 507 paging, `changeTag` to skip unchanged collections; invalid token -> `reset:'syncTokenInvalid'`, resync reuses `eventEtags`; RSVP edits own `PARTSTAT`; budget `caldav`, 2 in flight; redirect policy in `host/providers/shared` |

Nothing above needs a port change after the freeze.

## 7. Schema 0001 review (F4), against ARCH 3.2

| # | Table | Proposed change | Why |
|---|---|---|---|
| S1 | `accounts` | `token_granted_at INTEGER`, `refresh_expires_at INTEGER` | `reconnectBy` (PV5, N3) |
| S2 | `accounts` | `remote_subject TEXT` | reconnect refuses a different `sub` (D25, PV5) |
| S3 | `accounts` | `primary_lease_device TEXT` | "Background work runs on: <Mac>" and tie-breaks (ARCH 6.5) |
| S4 | `accounts` | `oauth_client TEXT` (client id fingerprint, never the secret) | Testing mode is per OAuth client; a source build on its own project may be in Production |
| S5 | `events` | `recurrence_id TEXT NOT NULL DEFAULT ''` (original start of an override; '' for masters and single events), `master_remote_id TEXT`, `status TEXT NOT NULL DEFAULT 'confirmed'`; replace `UNIQUE(calendar_id, remote_id)` with `UNIQUE(calendar_id, remote_id, recurrence_id)` | overrides and cancelled occurrences; NOT NULL because SQLite treats NULLs as distinct in UNIQUE, which would allow duplicate masters; an override page can arrive before its master |
| S6 | `calendars` | `selected INTEGER NOT NULL DEFAULT 1`, `time_zone TEXT`, `change_tag TEXT` | D24; floating-time expansion; CalDAV ctag skip |
| S7 | `message_folders` | `seen_gen INTEGER`; make `mf_folder` `UNIQUE(folder_id, uid) WHERE uid IS NOT NULL` | bounded generation sweep (D10, I5); IMAP lookups by UID (I4) |
| S8 | `governor_state` | `cooldown_step INTEGER NOT NULL DEFAULT 0`, `last_refusal_at INTEGER`, `cls TEXT`, `in_flight_limit INTEGER`, `batch_size INTEGER`, `window_spent INTEGER`, `window_at INTEGER`, `send_blocked_until INTEGER`, `blocked_cls TEXT`; `account_id = '*'` allowed for project-wide rows | escalation, AIMD batch and concurrency state, the spent minute and auth/config blocks all survive a restart |
| S9 | `sync_state` | `pending TEXT` (JSON array, at most 500 remote ids) | partial steps and the per-run memo |
| S10 | `drafts` | `origin TEXT NOT NULL DEFAULT 'local'` (`local` or `remote`) | phone drafts shown in Drafts (D9) |
| S11 | `submissions` | `remote_message_id TEXT`, `remote_thread_id TEXT` | settled sends and threading of the local copy |

Checked and fine as written: `sync_failures`, `provider_memory`, `accounts.status*` and `resume_at`, `granted_scopes`, `baseline_done_at`, `messages.origin`, `drafts.remote_draft_id`, `submissions.internet_id`, `sender_rules.remote_filter_id`, `threads.complete`.

> **What this means:** The planned database is close. These extra columns make the weekly reconnect, the shared quota, safe clean-up after a resync, phone drafts and repeating events work, and adding them now is much cheaper than after the freeze.

## 8. What the Providers thread builds against these, and when

- `prov-emu`: the `Clock` and fault kit already follow these shapes (`packages/emulators/src/kit`); the Gmail emulator by day 4.
- `prov-gov`: `GovernorPort` with the class table above, `AccountActorHost`, `TokenSource`, the classifier base and the shared no-retry HTTP client, days 4-9 (pure parts started on day 1 on new files).
- `prov-gmail`: `ProviderAdapter` for Google, on a pass-through governor stub until day 7.
- `prov-cal`: `CalendarAdapter` for Google Calendar and the recurrence module, days 5-13.

## 9. v1 review findings and their resolution

| # | Sev | Finding (short) | Resolution |
|---|---|---|---|
| 1 | blocker | Unbounded generation sweep after a bounded resync would drop INBOX from older threads; no place to record "seen" | `scopeCovered.bound`, `sweep(..., bound)` removes placements only; S7 `seen_gen` |
| 2 | blocker | One account-wide abort signal: a backfill throttle would abort an in-flight send or calendar write | per-request budget-scoped signal; pauses never abort `send`/`write`; `ctx.signal` is close/stop only |
| 3 | blocker | `PausedError` on send unspecified; reconnect would flush a days-late outbox silently | admission before the marker; `NotSentError.deferUntil` back to `queued`; overdue rule on every resume |
| 4 | blocker | Partial batch refusals lost fetched facts and re-sent every sub-request | partial `StepResult`, `SyncState.pending`, S9; `observe` never aborts the caller |
| 5 | blocker | No workflow channel, so the lease had no governed path; no `claim` | `WorkflowChannel`; `LeasePort.selfDeviceId` and `claim` |
| 6 | should | Nobody owned "one forced refresh"; token calls bypassed the governor | governor supplies the token and owns the single refresh; refresh is a governed `oauth` request; none while blocked |
| 7 | should | One action for every class; no auth block or clear; project-wide limits; calendar abuse in mail status | class table; `blocked`, `sendBlockedUntil`, `clear`, `PROJECT`; calendar pauses per calendar |
| 8 | should | Batch size and in-flight limit not carried or persisted | `batchSize()`, snapshot and S8 columns |
| 9 | should | No host or store path for open, search, attachments | `AccountActorHost.openThread/search/attachment`, `commitOpened`, `commitSearch`, ranked `SearchResult` with paging |
| 10 | should | Store could not tell baseline, backfill and resync apart for notifications | `StepResult.origin` |
| 11 | should | Provider resync logic in the actor; one `nextState`; no cap reason | `nextStates[]`, informational `reset`, `changeCapExceeded`, `windowRolled` |
| 12 | should | Role policy in the adapter; no cadence inputs | `PlanEnv`; role removed from the adapter; actor drops lanes |
| 13 | should | No flag deltas; Gmail UNREAD/STARRED leaked label semantics | `FlagDelta`; Gmail emits them as flags |
| 14 | should | Static budgets; IMAP bytes; no ai budget id | `budgets(account)`, `ConnectResult.budgets`, `costs`, `charge`, `ai:*` |
| 15 | should | Phone drafts not showable; tracked by message id | `RemoteDraftFact.message`, `trackedDraftIds`, S10 |
| 16 | should | Graph `@removed` treated as deletion | placement removal; principle 6 |
| 17 | should | IMAP gaps: UID sets, move UIDs, thread merges, limited mode | `folderUids`, `OpOutcome.placements`, `threadMerges`, `partialView` |
| 18 | should | Event types undefined; RSVP scope; override results; 412 class | `EventRef`, `EventChange`, `EventFields`, multi-row `put`, `rsvp` scope, `conflict` class, `changeTag`, `eventEtags` |
| 19 | should | Nullable `recurrence_id` breaks uniqueness | S5 NOT NULL '' plus `master_remote_id`, `status` |
| 20 | should | A missing calendar scope marked the whole account | `missingPermissions` fact |
| 21 | should | Spent window lost on restart | `windowSpent`, `windowAt`, S8 |
| 22 | should | Graph batch of 4 slots could deadlock | `reservedInteractive: 0` with priority admission; documented limit |
| 23 | nit | `reconnectBy` arithmetic; identity during a daily stop; `ConnectContext` | min(grant + 7 d, response + expires_in); identity from `id_token`; `ConnectContext` defined |
| 24 | nit | `findSent` "absent" vs "not indexed yet"; draft consumed; remote ids | `FindSentResult`, re-check after 60 s, `draftConsumed`, S11; `uncertain` kept for non-send writes only |
| 25 | nit | Retry layers outside the governor | principle 2: actor and op flush only re-run on cadence |
| 26 | nit | P1 cost 40 vs 20 | adapter choice, both expressible; `prov-gmail` settles it on the emulator |
| 27 | nit | Closed `ReasonCode`, index signature, `targets[]`, `request('all')`, mixed provider field | additive union with round-2 codes; no index signature; `target`; `requestAll`; `provider: BudgetId` |
