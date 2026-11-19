# F3 paper walk: every provider through `ports.ts`

Written 2026-10-27 (day 1) by the Engine thread's F3 task, on `rv/eng-contract/f3-ports`. It walks the five provider families through the frozen ports on paper, so round 2 adds code and changes no frozen type. Names in `code` are from `packages/engine/src/ports/*.ts`.

## In plain English

Before freezing the ports, we pretended to connect Gmail, Google Calendar, Outlook, iCloud and generic mail, and Fastmail, and to do the everyday things with each: the first download, keeping up, moving mail, sending (including a send whose answer never came back), editing a draft, Google's weekly sign-in and choosing which Mac does the heavy work. Each step had to fit the ports as written. Where one did not, we changed the port now, while it is cheap. Those changes are listed at the end.

## The common path (all providers)

The actor (`prov-gov`) asks the adapter's pure `plan()` for steps, registers the earliest `notBefore` as its `sync:<account>` deadline, and runs each `syncStep` with an `AdapterContext` whose only network door is `BoundGovernor`. It commits each `StepResult` (facts plus every `nextStates` row) in one store transaction; when `scopeCovered` is set and `Capabilities.partialView` is not, the same transaction carries a store `sweep` write. Generations come from one source: a step that starts a round writes `AdapterContext.generation` (the store `seq()` when it started) into its `SyncState`, so a later round of any scope is always higher than anything an earlier round stamped. The sweep removes only placements with `seen_gen IS NOT NULL AND seen_gen < generation` strictly inside the bound (`since`, `until`, UIDs); a NULL stamp (history, open, search) is kept, and a stamp only rises. `PausedError` mid-step gives a partial result with `pending`; the actor commits it and re-plans with trigger `resume` when the `governor` deadline fires. Engine modules never call adapters: they call `ProviderPort`, `SendPort`, `DraftSyncPort`, `CalendarPort`, `RulesPort` and `AccountActorHost`, which every handler reaches through `MethodContext.services`.

**Send, for every provider.** `eng-time` asks `SendPort.admission`, commits the `sending` marker, then calls `SendPort.send`. A receipt settles `sent`. `NotSentError` (or `PausedError` with `cls: 'send_limit'`) settles `failed`; another `PausedError` leaves it `queued` until `until`. Anything thrown before the request is written (a token refresh failing, a block) reaches `send`'s caller as `PausedError` or `NotSentError`, never as uncertain. Anything else is uncertain: no replay, `SendPort.findSent(account, internetId, since)` now and once more 60 s later, then "We could not confirm this was sent." At start or wake, a `sending` row means the app died after the marker: it becomes `uncertain` and runs `findSent(internetId, attempt_at)` before anything else, however late, and is never suspended or re-sent. Every submission waiting on `not_before`, `queued` (undo window) and `scheduled` (send later) alike, that would go out more than 5 minutes past it for any reason (Mac asleep, paused, signed out) becomes `suspended`; a `sending` row never does (`WAITING_SUBMISSION_STATES` and `OVERDUE_GRACE_MS`, defined once in `@aplos/contract/rules`). What leaves is always the pinned revision (`Submission.revision` and its `mime`): the outbox puts `baseRemoteMessageId` (and Graph's `baseChangeKey`) on the `SubmissionPayload` only when the synced remote draft is that revision (`synced_revision` equals the submission's), and an adapter sends a remote draft only when `sendsRemoteDraft` holds for the copy it just read; otherwise it sends `mime`.

**Lease, for every provider with a `WorkflowChannel`.** The lease record rides the workflow copy: each `workflow` step (`enrichment` lane) reads copies with `round` and renews with `put`. The actor derives the role, calls `GovernorPort.setRole`, and on a secondary device drops `backfill`, `prefetch` and `enrichment` steps except the workflow round itself (every device reads Done and Later; only the primary compacts). `AccountActorHost.claimLease` ("Use this Mac") writes a copy naming this device; `AccountRuntime.lease` shows the holder. Ties go to the lower `DeviceId`. Until its first workflow round completes, a device runs as secondary (ARCH 6.5), so two fresh installs never both run as primary. Providers without a channel (generic IMAP with no app storage) treat every device as primary, and AIMD absorbs the overlap.

## Gmail (round 1)

**First sync.** `plan()` with no states emits P0 (`history` with origin `baseline`: `getProfile` for the history id first, `labels.list` → `folders`), then `window:inbox` (`baseline`). Each window step lists, dedupes by thread and fetches metadata through `governor.run` (`read`, 20 or 40 units, batched by `batchSize('gmail')`); refused batch parts go to `observe` and their ids to `pending`. The step that commits the 50th thread sets `baselineReached` and seeds `backfill:inbox` and `sent:recent` in the same `nextStates`. A window step that sets `scopeCovered` also returns `PlacementDelta { remoteId, folder: 'INBOX', present: true }` for every id `messages.list` gave, fetched or not, so the older Inbox messages of a thread whose newest message alone was fetched are stamped and not swept. Rows carry `partial: true`; `ProviderPort.openThread` later uses `threads.get` full unless `knownCount === 1` (AM-1).

**Incremental.** `history` steps (`incremental`, cadence from `PlanEnv`) return `labelDeltas` and `flagDeltas` (UNREAD, STARRED) at zero fetch, `removals` from `messagesDeleted`, and upserts only for threads that gained INBOX and are not in `lookup.knownThreads` (D3). Over 150 fetches: `reset: 'changeCapExceeded'`. A 404 cursor: `reset: 'cursorExpired'`; that step clears the history cursor in its `nextStates`, so the next `plan()` (pure) emits P0 again and a `window:inbox` step with origin `resync`. That window's first page (no `pageToken`) writes its own state at `ctx.generation`, and its `scopeCovered.bound` (`since` the oldest listed, no `until`) limits the sweep to the Inbox range it listed. A DRAFT history record gives only a message id: `lookup.draftsByMessageId` says whether Aplos wrote it; one it did not write becomes a `RemoteDraftFact` (an untracked draft, or an edit elsewhere of a tracked one, checked with `trackedDraftIds`).

**Label change.** Archive in Aplos writes per-message `PendingOp { change: { kind: 'folders', remove: ['INBOX'] } }`; `coalesce` merges identical sets into one `batchModify` per 1,000 ids; `apply` runs it as `idempotentWrite` on `opFlush`. A 404 is `notFound` and drops the op. A change made in Gmail web arrives as a `LabelDelta`.

**Send.** `send` reads the synced draft (`drafts.get`) and uses `drafts.send` (`draftConsumed: true`) only when `sendsRemoteDraft` holds: the payload carries `remoteDraftId` and `baseRemoteMessageId`, and the draft still has that message id. Otherwise, including a phone edit during the undo window or a send-later hold, it posts the pinned `mime` as `message/rfc822` (upload, resumable above 5 MB) and leaves the changed draft in place. A timeout after the body was written surfaces as a `ProviderError` with `uncertain: true` → uncertain → `findSent` searches `rfc822msgid:` in Sent after `since`. "Mail sending" 429 is `send_limit`: the governor sets `sendBlockedUntil`, the submission is `failed` "until HH:MM", sync continues.

**Draft edit.** `eng-time` calls `DraftSyncPort.save` 5 s after the last keystroke if the fingerprint changed. The upload carries `baseRemoteMessageId`, the copy this device last synced. The adapter's `saveDraft` checks it (`drafts.get`), then creates (`write`) or updates by id (`idempotentWrite`) and returns `saved`; a different current message id returns `conflict` and nothing is written, and a 404 on update returns `gone` (deleted or sent on the phone); either way the engine asks rather than overwriting or recreating. A phone edit that history reports first arrives as a `RemoteDraftFact` with a message id Aplos did not write: the engine raises "keep mine, take theirs, or keep both".

**Weekly reconnect.** `ConnectResult.grant.refreshExpiresAt` (the host's OAuth config folds in grant + 7 days for a Testing-mode client) becomes `reconnectBy`; the account stays `ok` until Google refuses. `invalid_grant` is a `ProviderError` class `auth`: the governor blocks every budget of the account (gmail, gcal, oauth) with no `until`, so `PausedError` stops every request including token calls, and status is `needsReauth`. `AccountActorHost.connect(account, 'google', { mode: 'reconnect', loginHint, expectedSubject })` runs with a `ConnectContext.governor` that ignores the auth block (still honouring cooldowns, daily stops and `config`), so the code exchange on `oauth` goes out; it identifies from the `id_token` (works during a Gmail daily stop; a different `sub` is refused with reason `wrongAccount`), then `reconnected()` stores the grant and credential, calls `clear(account, 'auth')` and resumes from stored cursors with no resync. Queued `ops` and drafts were never dropped and flush; overdue submissions suspend.

**Lease.** The workflow channel is a hidden label with `messages.insert` copies (`put`, `write`, checks for its own copy first); `round` reads label history (2 units) before any copy. See the common path.

## Google Calendar (round 1, the `calendar` of the google adapter)

**First sync.** `CalendarAdapter.plan` emits `calendars` then one `cal:<id>` step per selected calendar. `listCalendars` returns `CalendarFacts` (hidden, selected, time zone; D24). Each `syncStep` pages `events.list` with `singleEvents=false` on the `gcal` budget and returns masters and overrides (`recurrenceId`, `masterRemoteId`) with `raw` JSON; expansion is client-side.

**Incremental.** Per-calendar sync token in `SyncState.cursor`; primary every 2-5 min, others 15-30. A 410 is `reset: 'syncTokenInvalid'` for that calendar alone. A `gcal` throttle pauses only calendars: `AccountRuntime.calendars[]` shows it, the mail status does not change (D12). `quotaExceeded` is `anti_abuse` (hours).

**A change (the calendar's "label change").** `Event/set` → `CalendarPort.put(account, EventChange)` → the adapter's `put` sends only changed fields with `If-Match` (Meet links untouched, D11) and `sendUpdates=all` only when `change.notify` (absent means `none`); an occurrence edit returns the new override in `saved.upserts`. Overrides carry `recurrenceId` in the canonical form (`RECURRENCE_ID_FORMAT`: the original start in UTC, or the date for all-day), so the instance id for an occurrence RSVP is `<recurringEventId>_<recurrenceId>`. A 412 returns `{ kind: 'conflict', current }`, never an error class. RSVP patches the self attendee (`rsvp`, `notify`).

**Send, draft.** Not applicable; invitations, updates and cancellations go out from Google only when `notify` is set on `put`, `remove` or `rsvp`.

**Reconnect, lease.** Shares the Google grant and the mail actor's reconnect. Sync-token steps run in `incremental` on the separate `gcal` budget, so every device keeps its calendars current; a secondary device drops only `backfill` pages of a first sync and `enrichment` polish.

## Microsoft Graph, mail and calendar (round 2)

**First sync.** `plan()` emits a light `window:inbox` list (`$select`, interactive-fast) with origin `baseline`, then one `folder:<id>` per role folder running an unfiltered delta in `backfill`, `nextLink` in `pageToken`, `deltaLink` in `cursor`. Requests carry `slots: 4` for a `$batch` of 20 (`reservedInteractive: 0`, priority admission). A 429 sub-response goes to `observe`, its ids to `pending`.

**Incremental.** Delta per folder every 30-60 s focused; upserts carry the one folder's placement with `placementsComplete: false`, so a message in two folders keeps the other; `@removed` becomes `PlacementDelta { present: false }` (not a `Removal`). A message is collected only when it has no placements left after covered sweeps. 410 is `reset`.

**Folder change.** Archive is `folders: add Archive, remove Inbox`; `apply` issues `move` (the immutable id survives) and returns `OpOutcome.placements`. A `/move` timeout is `OpOutcome` `failed` with `error.uncertain` (a `write`, not re-sent); the op is held until the next delta shows whether it landed.

**Send.** `/me/sendMail` with MIME to keep `internetMessageId`. Over about 3 MB: `NotSentError` (`permanent`, `tooLarge`) before any I/O. Uncertain → `findSent` filters Sent Items by `internetMessageId`.

**Draft edit.** Native drafts: `saveDraft` creates (`write`) or PATCHes (`idempotentWrite`) with `baseChangeKey` as the precondition (a mismatch is `conflict`); 404 is `gone`. Remote edits arrive as `RemoteDraftFact` from the Drafts folder delta.

**Calendar.** `calendarView/delta` per calendar with `reset: 'windowRolled'` monthly; it returns instances without masters, marked `EventFacts.instance` (`occurrence` or `exception`) with `masterRemoteId` = `seriesMasterId`. `put` with `If-Match`, 412 is `conflict`; `remove` with `notify` cancels (guests told) rather than deletes. `interaction_required` at the token endpoint is `auth` → `needsReauth`; there is no weekly expiry, so no `refreshExpiresAt` and no `reconnectBy`.

**Lease.** A hidden-folder (or app-data) `WorkflowChannel`; otherwise as the common path.

## IMAP and SMTP, with CalDAV (iCloud, generic hosts; round 2)

**First sync.** `ProviderFactory.connect` logs in with the vault `secretRef`, reads CAPABILITY and the host table into `ConnectResult.memory`; `budgets()` derives `imap` (commands) and `imapBytes` (1,000 MB/day) from it. `open(account)` gives one adapter per account owning its connections, opened lazily: the command connection on the first step, the IDLE connection only while `watch()` is iterated. The actor iterates `watch()` only on the primary device, so a secondary device holds one connection without the adapter ever seeing the role. `folder:INBOX` steps fetch the newest envelopes in chunks below `MESSAGELIMIT`, cursor `uidvalidity:modseq:uidnext`; upserts carry `placementsComplete: false` (one folder per step); bytes are charged after each FETCH with `charge('imapBytes', n)`.

**Incremental.** `watch()` yields IDLE hints; steps use QRESYNC where allowed, else CONDSTORE `CHANGEDSINCE` plus a bounded expunge check (`lookup.folderUids` against `UID SEARCH`). Flag changes come as `FlagDelta { folder, uid }`; `VANISHED` as `PlacementDelta { folder, uid, present: false }`. A changed `UIDVALIDITY` is `reset: 'uidValidityChanged'`. A `MESSAGELIMIT` or limited-mode answer never sets `scopeCovered`. Header threading merges threads via `threadMerges`.

**Folder change.** `folders: add Archive, remove INBOX` → `apply` reads the source UID with `lookup.placements`, sends `UID MOVE`, and returns the COPYUID placements.

**Send.** SMTP: a connect, DNS or pre-DATA refusal is `NotSentError`; a drop after DATA is uncertain. iCloud needs our own Sent copy (`APPEND`, part of `send`). `findSent` runs `UID SEARCH HEADER Message-ID` in Sent `SINCE` the attempt date (`since`).

**Draft edit.** `saveDraft` `APPEND`s the new revision with its per-revision `DraftUpload.internetId`, then deletes the previous copy by APPENDUID, or by that Message-ID without UIDPLUS. `remoteDraftId` is the folder UID, so an update is really a replace: a create plus destroy, run as `write` and never re-sent (an uncertain one is recognised by its `internetId`); the engine still sees `saved`.

**CalDAV.** The adapter's `calendar` uses the same app password. `listCalendars` is one `PROPFIND` (ctag in `changeTag` skips unchanged collections); `syncStep` runs `sync-collection` then `calendar-multiget` 50 at a time on `caldav`, 2 in flight; 507 pages through `pageToken`; an invalid token is `reset: 'syncTokenInvalid'` and the resync keeps ETags via `lookup.eventEtags`. `remoteId` is the resource href, shared by the master and its overrides (so `masterRemoteId` is absent and the master is the row with no `recurrenceId`); the iCalendar UID is `EventFacts.uid`. `RECURRENCE-ID;TZID=` values are stored in UTC, floating ones as wall-clock time without `Z`. `put` uses `If-Match`; 412 is `conflict`; RSVP edits our own PARTSTAT; `notify: false` writes `SCHEDULE-AGENT=CLIENT` so the server sends no iTIP mail.

**Reconnect, lease.** An app-password refusal is `auth` → `needsReauth` with no `reconnectBy`; reconnect is `connect({ mode: 'reconnect', secretRef })` with the new app password's vault reference, then `reconnected()`, so queued changes are kept. The lease rides a hidden mailbox `WorkflowChannel` when the host allows one.

## JMAP (Fastmail; round 2)

**First sync.** `connect` fetches the session; `maxConcurrentRequests` and `maxObjectsInGet` go into `ConnectResult.memory` and `budgets()` reads them. `window:inbox` uses `Email/query` + `Email/get` with `preview`; the `history` scope holds the `Email/changes` state captured first.

**Incremental.** `watch()` yields EventSource hints; `/changes` every 60 s as a floor. `mailboxIds` changes become `PlacementDelta`; keywords become `FlagDelta`; `destroyed` becomes `Removal`. `cannotCalculateChanges` is `reset`. `rateLimit` SetErrors go to `observe`.

**Folder change.** `Email/set` patching `mailboxIds` (`idempotentWrite`: setting the same patch twice is harmless).

**Send.** One request with `Email/set` and `EmailSubmission/set`. A timeout is uncertain; `findSent` is `Email/query` on `header: Message-ID` in Sent.

**Draft edit.** `Email/set` with `$draft`; the new id is the `remoteDraftId` (JMAP emails are immutable, so each revision is a create + destroy in one request, run as `write` and reported as `saved`; `baseRemoteMessageId` is checked in the same request, a mismatch is `conflict`).

**Calendar, reconnect, lease.** CalDAV as above until JMAP Calendars is chosen, with its own app password in `ConnectRequest.calendarSecretRef` (Fastmail's API token covers JMAP only); an API-token refusal is `auth`; the lease rides a hidden mailbox like IMAP.

## Port changes the walk forced (against the Providers proposal v2)

1. **`ProviderFactory` with `open(account)`** (IMAP): an adapter instance per account owns that account's connections and `close()` releases exactly those; `connect` and `budgets` live on the factory because no account exists at connect.
2. **`Removal` is a server-stated deletion only** (IMAP, Graph): `VANISHED` and `@removed` are placement removals (`PlacementDelta { present: false }`), since a moved message reappears elsewhere.
3. **One `placements: Placement[]` field** replaces `folders` + `placements` on `MessageFacts` (IMAP UIDs and Gmail labels in one shape).
4. **`KnownLookup.placements`** (IMAP `UID MOVE` needs the current source UID at flush time, not the one at enqueue).
5. **Edit conflicts are results** (`CalendarWriteResult.conflict`, `DraftSaveResult.gone`), not a `conflict` error class (Google, CalDAV and Graph 412s): the F1 seed's `ErrorClass` needs no new member and the engine never parses provider reasons.
6. **`findSent(internetId, since, ctx)`** (IMAP `SEARCH SINCE` bounds the cost).
7. **`DraftUpload.internetId`** (IMAP deletes the previous copy by it without UIDPLUS; an uncertain create is recognisable by it).
8. **`CalendarAdapter.plan`** (calendar cadence is `prov-cal`'s, not the mail adapter's).
9. **`PlannedStep.origin`** instead of `StepResult.origin` (the adapter's plan knows baseline from backfill; the actor no longer overwrites a field the adapter returned).
10. **`ConnectContext.accountId`**, no `auth` in it (connect-time calls are governed; the OAuth loopback is closed over by the host factory, never passed through the engine).
11. **`TokenSource` split into `cached` and `refresh(account, io)`** (the governor runs the refresh as a governed `oauth` request, so a blocked account makes no token call and there is no governor-to-token-to-governor cycle).
12. **`ConnectResult.memory`** replaces `ConnectResult.budgets` (JMAP and IMAP limits go through `provider_memory`, one path for `budgets()`).
13. **`category.*` folder roles** (`laneFor` reads Gmail tabs from stored roles, provider-neutral).

## Changes from the Providers review of these ports (2026-10-27)

Answered one by one in `ports.review-answers.md`. In short: connect ignores the auth block it exists to lift; generations come from the store `seq()` and the sweep has an upper bound, a NULL-keeps rule and its own store write; a `sending` row found at start is uncertain, never suspended; errors before a send's request become `PausedError` or `NotSentError`; the in-flight reserve shrinks with the limit; `observe` carries scope; `category.*` roles, `placementsComplete`, `events.seen_gen` and a calendar sweep bound.

## Changes from the freeze review (2026-10-27)

Answered in `ports.review-answers.md`, section "Freeze review". In short: the overdue rule covers `scheduled` rows; `CalendarPort`, `RulesPort` and `MethodContext.services`; the governor's class table in `governor.ts`; `notify` on calendar writes; one recurrence id form and CalDAV identity by href; "Retry now" and "back to automatic" routes; a second secret for Fastmail; draft preconditions and conflicts; the `ImageProxy` port; ports aligned with the wire types.

## Changes from freeze review round 2 (2026-10-28)

Answered in `ports.review-answers.md`, section "Freeze round 2". In short: `SubmissionPayload.baseRemoteMessageId` and `baseChangeKey` and the `sendsRemoteDraft` rule, so the pinned revision is what leaves; the waiting states and the overdue grace come from `@aplos/contract/rules`.
