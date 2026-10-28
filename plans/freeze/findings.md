# Freeze review findings (2026-10-27)

Three fresh Claude Opus reviewers (UI, Providers, security and platform) reviewed the freeze candidate: PR #28 at 214f052 plus UI-core's F9 draft at `rv/ui-foundation/f9` 98dfc61, without the authors' write-ups. A consolidation agent merged duplicates, confirmed every blocker and gap in the code, and only then compared them with `GAPS.md`, `ports.review-answers.md` and the platform thread's early security review (column "Earlier answer"). F2's host wiring and F8 were not in the candidate and are re-checked when they land. Process and exit rules: [../FREEZE.md](../FREEZE.md).

## In plain English

The reviewers found 36 problems. Nine must be fixed before the rules freeze: one in the screens' data layer, one in scheduled sending, and seven where a tool or a low-permission action could do more than it should. The other 27 are additions that can still be made safely, but most should land now so lanes don't start on a gap. Nothing here needs the owner.

## Summary

The three reviews consolidate into 36 findings: 9 blockers, 25 gaps and 2 nits. I checked every blocker and gap against the cited files myself, confirmed all of them, and dropped none. The blockers are: the F9 shadow types (FR-1); 'scheduled' send-later rows exempt from the overdue rule (FR-2); undo, retry and queue retry ignoring the originating method's scope (FR-3); triage-scope methods sending calendar invitations (FR-4); listener clients granting AI consent and redirecting AI traffic (FR-5); blob ids not bound to their caller (FR-6); and Draft/set rewriting a held send with no recorded revision (FR-7). I also raised three findings to blocker: the per-account AI toggle bypass (FR-8) and Draft/destroy exposed to MCP (FR-9), plus FR-7. FR-5, FR-6 and FR-9 were raised earlier in the platform security review, and FR-3, FR-4 and FR-7 repeat its S4, S1/S3 and S6; none of these has a recorded author answer and the evidence still holds, while the authors' GAPS.md answers (an adapter for F9, 'later' for Clear from Home, fixture knobs forwarded to F6) leave FR-1, FR-28 and FR-17 open. The contract can freeze once the blockers are fixed: most fixes are frozen doc rules, the non-additive edits are F9's types, Consent/grant uiOnly, the Plan/confirm and Ask/decide scope and Draft/destroy leaving MCP, and the store write-kind names (FR-10) plus the doc pins in FR-14, FR-22 and FR-20 should land in the same pass.

## Routing

Each finding goes to the lane that owns its artifact. Answer every one in the fix PR as **fixed** (commit) or **decided** (a DECIDED line in STATUS.md with the reason). Blockers cannot be decided away without the integrator's agreement. The integrator re-checks the blockers on the fixed candidate before tagging `contract-v1`.

| ID | Severity | Artifact | Owner | Title |
|---|---|---|---|---|
| FR-1 | blocker | F9 | ui-core (ui-foundation) | F9 data surface is frozen additive-only on provisional shadow types that cannot hold F1 values |
| FR-2 | blocker | F1, F3, F4, F6 | engine (eng-contract) | Send-later rows stored as 'scheduled' are exempt from the overdue rule and the due index, so they can go out days late |
| FR-3 | blocker | F1 | engine (eng-contract) | Operation/undo, Operation/retry and Queue/retry/discard act on any operation without the originating method's scope |
| FR-4 | blocker | F1 | engine (eng-contract) | Plan/confirm and Ask/decide (triage, no audit) create provider events with guests, so invitations go out |
| FR-5 | blocker | F1 | engine (eng-contract) | Listener clients can grant AI consent and redirect where mail goes (provider address, Gemini paid mark, aiAllowed) |
| FR-6 | blocker | F1 | engine (eng-contract) | Blob ids and frame tokens are not bound to their caller, so read-scoped Blob/get bypasses Data/export's uiOnly flag |
| FR-7 | blocker | F1, F6 | engine (eng-contract) | Draft/set can rewrite a queued or scheduled send, and Submission records no revision, so the bytes that leave are undefined |
| FR-8 | blocker | F1, F6 | engine (eng-contract) | Ask/run scope.accountIds overrides an account's 'Use this account's mail for AI' toggle |
| FR-9 | blocker | F2 | engine (eng-contract) | MCP exposes Draft/destroy, a destructive action, without a confirmation |
| FR-10 | gap | F4 | engine (eng-store) | StoreWrite has no kinds for most tables provider and engine lanes write from day 4, and pending-op replay is absent |
| FR-11 | gap | F5 | engine (eng-contract) | dispatch does not deny by default on scope, uiOnly, secret or host |
| FR-12 | gap | F3, F5 | engine (eng-contract) | No engine-side port for calendar writes, RSVP or provider filters, and handlers have no way to reach any port |
| FR-13 | gap | F1, F6 | engine (eng-contract) | Failed, uncertain and suspended sends are a dead end: no cancel or dismiss, and Draft/destroy leaves an orphan submission |
| FR-14 | gap | F1, F6 | engine (eng-contract) | The undo-send receipt contradicts itself: undoable:false with undoUntil set |
| FR-15 | gap | F4 | engine (eng-store) | The change log misses derived changes, so snapshot(seq0)+changes != snapshot(seqN) |
| FR-16 | gap | F1 | engine (eng-contract) | Hello has no token field, there is no hello reply, and the HTTP trust rules are not in the contract |
| FR-17 | gap | F6 | engine (eng-contract) | Fixture/control has no knobs for the failure screens the UI must show |
| FR-18 | gap | F3 | engine (eng-contract) | The governor's class-by-class policy lives only in an untracked input document |
| FR-19 | gap | F3 | engine (eng-contract) | Event/set notify cannot reach the adapter: CalendarAdapter.put and remove take no notify option |
| FR-20 | gap | F1, F3, F4 | engine (eng-contract) | Recurrence identity has no canonical form, and CalDAV href versus UID is inconsistent |
| FR-21 | gap | F9, F1 | engine (eng-contract) + ui-core | Calendar components cannot carry repeat scope, and F1 has no per-event hide |
| FR-22 | gap | F1, F6 | engine (eng-contract) | events.includePlans has no defined meaning, and the plans view has no range |
| FR-23 | gap | F1, F6 | engine (eng-contract) | Reconnect connect frames omit accountId, and a cancelled reconnect reports mode 'new' |
| FR-24 | gap | F3 | engine (eng-contract) | Sync/request force ('Retry now') and Account/lease pin:false have no F3 route |
| FR-25 | gap | F1, F3 | engine (eng-contract) | App-password and API-token accounts cannot reconnect, and Fastmail needs two secrets |
| FR-26 | gap | F3 | engine (eng-contract) | Drafts edited elsewhere: no precondition on save, no lookup to recognise Aplos's own draft writes, and a wrong idempotency claim |
| FR-27 | gap | F1 | engine (eng-contract) | No view returns Low-importance threads grouped by sender, which the Low sheet needs |
| FR-28 | gap | F1 | engine (eng-contract) | Thread/act cannot clear a reminder, and 'Clear from Home' on Back from Later discards Later dates |
| FR-29 | gap | F1 | engine (eng-contract) | No method for recipient type-ahead |
| FR-30 | gap | F1 | engine (eng-contract) | Ask answers carry no citation anchors; chip placement relies on an undocumented '[n]' text convention |
| FR-31 | gap | F4 | engine (eng-store) | An IMAP UIDVALIDITY change makes the next placement commit throw on the unique mf_uid index |
| FR-32 | gap | F1 | engine (eng-contract) | The diagnostics bundle is content-free only in dev builds |
| FR-33 | gap | F1 | engine (eng-contract) | Free-text AI test messages can return the tail of a key |
| FR-34 | gap | F1, F3, F6 | engine (eng-contract) | Nothing enforces the stand-in-only srcdoc path, the stand-in's srcdoc has no inner CSP, and F3 has no ImageProxy port |
| FR-35 | nit | F1, F3, F4 | engine (eng-contract) | Type drift between ports, store and wire |
| FR-36 | nit | F1, F4 | engine (eng-contract) | HttpAddress allows a query string, and the budget test's title overstates what it measures |

## Findings in full

### FR-1: F9 data surface is frozen additive-only on provisional shadow types that cannot hold F1 values

- **Severity:** blocker · **Artifact:** F9 · **Owner:** ui-core (ui-foundation) · **Reviewers:** UI-1 · **Evidence checked:** confirmed
- **Problem:** contract-shapes.ts says every type is 'replaced by import from @aplos/contract at the freeze', but index.ts freezes the surface as additive-only ('nothing is renamed or removed'), so the swap can never happen and a hand-kept adapter must turn F1 into F9 for good. Several F9 types are narrower than F1, so no adapter can fix them: SubmissionState has no 'scheduled' (F1 and the stand-in store every send-later row as 'scheduled'); backfilling requires m while F1 'of' is optional (AM-4); dailyTokenCap: number cannot say dailyCap.enabled=false; setup.begin()/end() take no origin, setupId or reason, so Skip setup cannot write Session.setup.skippedAt; ContractErrorType lists invalidArguments, tooManyChanges, authRequired and quotaPaused, which F1 never sends (F1 uses validation, paused, needsReauth); ViewSpec 'home.low' has no F1 kind; ProviderId uses 'opencode' where F1 uses 'opencode-go'. CONTRACT_METHODS maps to names F1 lacks (Thread/followup, Mail/frame.release, Mail/allowImagesFrom, Consent/set, Event/query, and Draft/set for destroy and resolve), and nothing checks it against MethodName. Related: FR-2, which is about the same 'scheduled' state on the engine side.
- **Evidence:** apps/desktop/src/renderer/data/contract-shapes.ts:9-12 (swap rule), :28 (StateToken string), :69-78 (error list), :351 (home.low), :597 (appliedSeq required), :687 (backfilling n,m required), :896 (SubmissionState without scheduled), :1144-1149 (nullable AiFeatureChoice), :1189 (dailyTokenCap number); data/index.ts:4-5 (additive only), :843-845 (begin()/end() without args), :914-956 (CONTRACT_METHODS satisfies Record<ApiMethodName,...>, not MethodName; :917, :927-928, :932-933, :952, :973 point at missing methods); ui/props.ts:2063 ('opencode'). F1: packages/contract/src/schemas/compose.ts:68-77 (scheduled), status.ts:14-18 (of optional), errors.ts:88-107, schemas/ai.ts:17 ('opencode-go'); generated/methods.generated.ts has no Consent/set, Thread/followup, Event/query, Mail/allowImagesFrom.
- **Suggested fix:** Non-additive F9 edit before the freeze: make contract-shapes.ts re-export the @aplos/contract types, or keep screen-facing names but add compile-time `satisfies` checks against F1 for each mirrored type, and type CONTRACT_METHODS[*].method as MethodName. At minimum: add 'scheduled', make backfilling m/of optional, give setup begin/end/status their setupId, origin and reason, replace the error list with F1's errorTypes, drop 'home.low' for F1 kinds (see FR-27), and use 'opencode-go'. Missing api members can follow additively.
- **Earlier answer:** GAPS.md intro and F9-5, F9-14, F9-23, F9-37, PV-1 answer that F1 already has these under other names and that 'the data layer adapts them inside ui-shell'. That does not close it: the evidence still holds, and a closed SubmissionState without 'scheduled' and a required backfill total cannot be filled by an adapter.

### FR-2: Send-later rows stored as 'scheduled' are exempt from the overdue rule and the due index, so they can go out days late

- **Severity:** blocker · **Artifact:** F1, F3, F4, F6 · **Owner:** engine (eng-contract) · **Reviewers:** PR-1 · **Evidence checked:** confirmed
- **Problem:** F1 makes 'scheduled' a separate submission state. F3 SendPort says the overdue rule 'applies to queued rows only', F4's sub_due index covers only state='queued', and the stand-in stores send-later rows as 'scheduled'. If eng-time follows the frozen text, a send-later message that fell due while the Mac was off is never suspended and goes out late at wake without 'Send now or Reschedule', which is the case ARCH 7.3 and the plan 10 E6 acceptance exist for. The timer loop's indexed query would also miss those rows. This is a safety hole.
- **Evidence:** packages/contract/src/schemas/compose.ts:63-77; packages/engine/src/ports/engine.ts:136-137 ('applies to `queued` rows only'); packages/engine/src/store/migrations/0001_initial.ts:119 (`CREATE INDEX sub_due ON submissions(not_before) WHERE state = 'queued'`); packages/contract-fixture/src/methods/compose.ts:291 (`state: later ? 'scheduled' : 'queued'`), :335 (reschedule writes 'scheduled').
- **Suggested fix:** Edit before the freeze. Either state in SendPort and SCHEMA.md that every row waiting on not_before (undo window or send later) is stored as 'queued' and 'scheduled' is only a wire view (notBefore past the undo window), and fix the fixture to match (no schema change); or extend the overdue rule and sub_due to 'scheduled'. F9 still needs 'scheduled' either way (FR-1).
- **Earlier answer:** ports.review-answers.md objection 4 introduced the 'queued rows only' wording to keep 'sending' rows from being suspended; it did not consider 'scheduled'. ports.walk.md send paragraph repeats it. The evidence still holds.

### FR-3: Operation/undo, Operation/retry and Queue/retry|discard act on any operation without the originating method's scope

- **Severity:** blocker · **Artifact:** F1 · **Owner:** engine (eng-contract) · **Reviewers:** SEC-2 · **Evidence checked:** confirmed
- **Problem:** Operation/undo and Operation/retry are triage and take any opId; Queue/retry and Queue/discard are admin and take any id. None checks the scope of the method that created the operation, and scopes are a set, not a hierarchy. Receipt.undoUntil names Operation/undo as the path for 'calendar writes that email guests', so undoing an Event/set sends cancellations or re-invitations; Operation/retry of a failed Event/set, Event/rsvp or Unsubscribe/run repeats a send-scope effect; Queue/retry on a failed submission resends mail (the stand-in calls Submission/set retry) for a caller holding only admin. The ops table records no originating caller or scope, and none of the four is audited. Fixable additively, but it is a safety hole, so it is a blocker.
- **Evidence:** packages/contract/src/api/mail.ts:174-196 (Operation/undo, Operation/retry: scope triage, any opId, no audit); schemas/common.ts:136-141 (Receipt.undoUntil doc); api/admin.ts:40-46 (Queue/retry admin, no audit); packages/contract-fixture/src/methods/core.ts:300-306 (Queue/retry on a failed Submission calls Submission/set retry); contract-fixture/src/methods/mail.ts:374-410 (undo and retry on any op record); packages/engine/src/store/migrations/0001_initial.ts:102-105 (ops has kind, no caller or scope).
- **Suggested fix:** Freeze the rule now: Operation/undo, Operation/retry, Queue/retry and Queue/discard require caller.scopes to include the originating method's scope (Submission/set for submissions), else 'forbidden'. Add audit:true to all four, an optional scope field on Operation and QueueItem, and a conformance case where a triage-only caller undoes an Event/set op and is refused.
- **Earlier answer:** Raised as should-fix S4 (and S11 for audit) in the platform early security review; no author answer is recorded in GAPS.md, ports.walk.md or ports.review-answers.md. GAPS.md E7 answers only that undoUntil exists. The evidence still holds in the candidate.

### FR-4: Plan/confirm and Ask/decide (triage, no audit) create provider events with guests, so invitations go out

- **Severity:** blocker · **Artifact:** F1 · **Owner:** engine (eng-contract) · **Reviewers:** SEC-1 · **Evidence checked:** confirmed
- **Problem:** Plan/confirm takes fields: partial(EventFields), which includes attendees (up to 500). Ask/decide accepting an addEvent proposal writes event: EventFields, attendees included, and that proposal is model output over untrusted mail (prompt injection). Both are triage, not audited, and on the listener. The README says send covers 'event edits with guests' and triage covers reversible changes only; an invitation email cannot be undone. Fixing it means retagging or narrowing inputs, which is not additive.
- **Evidence:** packages/contract/src/api/compose.ts:143-154 (Plan/confirm triage, fields partial EventFields); schemas/calendar.ts:121-127 (EventFields.attendees); schemas/ai.ts:171-174 (addEvent with event: EventFields); api/ai.ts:241-247 (Ask/decide triage, no audit); README.md:52-54 (scope table); generated/methods.generated.ts listenerMethods block includes Plan/confirm and Ask/decide; contract-fixture/src/methods/compose.ts:465-492 (fields spread into the created provider event).
- **Suggested fix:** Before the freeze: retag Plan/confirm and Ask/decide as send + audit, or omit attendees from Plan/confirm.fields and freeze the rule that accepting an addEvent proposal with any non-self attendee needs caller.scopes to include send (else 'forbidden'), audited. Add a registry test that no triage-reachable input carries attendees or recipients, plus a conformance case for each method. The notify plumbing is FR-19.
- **Earlier answer:** Raised as blockers S1 and S3 in the platform early security review; no author answer is recorded in the authors' docs. GAPS.md E30 calls proposals 'already there' without looking at scope. The evidence still holds.

### FR-5: Listener clients can grant AI consent and redirect where mail goes (provider address, Gemini paid mark, aiAllowed)

- **Severity:** blocker · **Artifact:** F1 · **Owner:** engine (eng-contract) · **Reviewers:** SEC-3 · **Evidence checked:** confirmed
- **Problem:** Consent/grant (admin, not uiOnly) is in listenerMethods, as are Settings/set (which can patch ai.providers.<id>.address to any http(s) host, ai.providers.gemini.paid, ai.features.* and ai.background) and Account/set (aiAllowed). One admin-scoped tool can point Summaries at a remote server, grant consent itself, and have background jobs send every thread there, and the owner never sees the consent card ARCH 8.3 requires. The consent table stores scope, version, provider and model but no address, so moving an 'ollama' or 'lmstudio' address to a remote host does not trigger re-consent, and AiProvider.local can go on claiming mail never leaves the Mac. Making Consent/grant uiOnly removes it from listenerMethods, so it is not additive.
- **Evidence:** packages/contract/src/api/ai.ts:346-353 (Consent/grant admin, audit, no uiOnly); generated/methods.generated.ts listenerMethods (from :317) includes Consent/grant, Settings/set, Account/set; schemas/settings.ts:143-147 (providers address, paid); schemas/common.ts:94-107 (HttpAddress checks only scheme and user-info); packages/engine/src/store/migrations/0001_initial.ts:150 (consent has no address column).
- **Suggested fix:** Before the freeze: mark Consent/grant uiOnly and regenerate. Freeze the rule that a non-window caller's Settings/set touching ai.*, and Account/set aiAllowed:true, answer 'forbidden' (or move those fields to a uiOnly method). Freeze that the consent version covers provider, model and address host, and that 'local' is computed from a loopback address, not the provider id. The consent address column can come later in an additive migration.
- **Earlier answer:** Raised as blocker S2 in the platform early security review; no author answer recorded. GAPS.md E22 and E25 call Consent and providers.address 'already there' without addressing who may call them. The evidence still holds.

### FR-6: Blob ids and frame tokens are not bound to their caller, so read-scoped Blob/get bypasses Data/export's uiOnly flag

- **Severity:** blocker · **Artifact:** F1 · **Owner:** engine (eng-contract) · **Reviewers:** SEC-4 · **Evidence checked:** confirmed
- **Problem:** Data/export is uiOnly but returns a blobId, and Blob/get (read, on the listener and MCP) returns any blob's bytes. Nothing in the contract says blob ids are unguessable or bound to the creator, and the stand-in issues sequential ids (blob-1, blob-2, ...). A read-scoped MCP agent can walk the ids and read exports, Diagnostics/export, Message/original output and other accounts' attachments; Blob/release lets any caller delete another's blob; DraftAttachment.blobId and Ai/transcribe accept any blob id. Mail/frame is on the listener and MCP and shares one 64-token cap, so a read client can evict the reader's live frames. This is a privacy hole.
- **Evidence:** packages/contract/src/api/mail.ts:296-317 (Blob/put/get/release, no binding stated); api/admin.ts:215-224 (Data/export admin, uiOnly, returns blobId); generated/methods.generated.ts listener and mcpMethods blocks both list Blob/get and Mail/frame; packages/contract-fixture/src/methods/core.ts:15-19 (blobOf uses fx.id('blob')) and engine.ts:183-185 (id(prefix) = `${prefix}-${++counter}`); schemas/compose.ts:7-17 (DraftAttachment.blobId).
- **Suggested fix:** Freeze the rule plus a conformance case: blob ids and frame tokens are at least 128-bit random and bound to the creating session or client; Blob/get, Blob/release, DraftAttachment.blobId, Ai/transcribe and GET /v1/blob/:id from another caller answer 'notFound'; a blob made by a uiOnly method is never readable by a listener caller; the frame-token cap is per caller. Preferably also mark Mail/frame, Mail/release and Mail/toggleQuotes uiOnly before the freeze, since a frame URL is useless outside Electron (non-additive once frozen).
- **Earlier answer:** Raised as should-fix S5, S13 and S16 in the platform early security review; no author answer recorded. GAPS.md E32 and E44 cover Blob/put and Diagnostics/export only as features. The evidence still holds.

### FR-7: Draft/set can rewrite a queued or scheduled send, and Submission records no revision, so the bytes that leave are undefined

- **Severity:** blocker · **Artifact:** F1, F6 · **Owner:** engine (eng-contract) · **Reviewers:** UI-2 · **Evidence checked:** confirmed
- **Problem:** Severity raised from the UI reviewer's gap because this is a safety hole. SubmissionAction.send pins a revision on input, but Submission stores none, and retry, sendAnyway and sendNow take none. The stand-in refuses Draft/set only while a submission is 'sending', so Draft/set (scope draft, exposed to MCP) succeeds while a send is queued, scheduled, failed, uncertain or suspended. An MCP agent steered by injected mail can change to, bcc or html of a message the owner already approved for send-later, which turns draft scope into send. ARCH 7.1's Gmail drafts.send would send the provider draft's current content.
- **Evidence:** packages/contract/src/schemas/compose.ts:79-98 (Submission has no revision), :102-119 (retry, sendAnyway, sendNow without revision); packages/contract/src/api/compose.ts:27-39 (Draft/set, scope draft, no refusal stated for a live submission); packages/contract-fixture/src/methods/compose.ts:13-16 (sending() checks only state 'sending'), :207-213 (Draft/set refused only while sending); generated mcpMethods includes Draft/set.
- **Suggested fix:** Pin before the freeze: Draft/set and Draft/resolve on a draft with a queued or scheduled submission are refused ('stateMismatch', undo the send to edit), or they cancel the submission and unlock the draft; a submission sends exactly the revision it recorded. Additively add Submission.revision and optional revision on retry, sendAnyway and sendNow. Fix the stand-in and add a conformance case.
- **Earlier answer:** Raised as should-fix S6 in the platform early security review (Draft/set while a send is held, and no revision on Submission); no author answer recorded. GAPS.md F9-9 answers only that sendNow, reschedule, sendAnyway and retry exist. The evidence still holds.

### FR-8: Ask/run scope.accountIds overrides an account's 'Use this account's mail for AI' toggle

- **Severity:** blocker · **Artifact:** F1, F6 · **Owner:** engine (eng-contract) · **Reviewers:** SEC-10 · **Evidence checked:** confirmed
- **Problem:** Severity raised from gap because it is a privacy hole: mail from an account the owner excluded from AI is sent to a provider. The stand-in uses `scope?.accountIds ?? accounts.filter(aiAllowed)`, so naming an excluded account searches and cites its mail, while excludedAccountIds still says it was left out. context.threadId is not checked against aiAllowed either. The contract never says the toggle bounds the scope, and the conformance suite has no case, so the real engine has no guard. The fix is a one-line frozen rule.
- **Evidence:** packages/contract-fixture/src/methods/ai.ts:284-294 (accountIds bypasses the aiAllowed filter); packages/contract/src/api/ai.ts:209-234 (Ask/run scope and context, no rule); schemas/ai.ts AskTurn.excludedAccountIds (:213-214).
- **Suggested fix:** Freeze that Ask/run, Ai/request, Ai/draft, Event/extract and context.threadId are intersected with aiAllowed accounts and never widen past them. Fix the stand-in and add a conformance case.
- **Earlier answer:** new (GAPS.md E26 says only that scope.accountIds absent means all accounts).

### FR-9: MCP exposes Draft/destroy, a destructive action, without a confirmation

- **Severity:** blocker · **Artifact:** F2 · **Owner:** engine (eng-contract) · **Reviewers:** SEC-11 · **Evidence checked:** confirmed
- **Problem:** Severity raised from gap because the fix is not additive after the freeze and this is a safety hole. ARCH 12.3 item 6 says destructive actions need an explicit grant and an in-app confirmation. mcpMethods is generated as scope in {read, draft}, which brings in Draft/destroy (audited; deletes locally and at the provider). An MCP agent following injected mail can delete the owner's drafts unprompted. Removing it after the freeze shrinks a published tool list, and adding a confirmation requirement later changes behaviour under existing clients.
- **Evidence:** packages/contract/generated/methods.generated.ts mcpMethods block (from :427) lists Draft/destroy; packages/contract/src/api/compose.ts:40-47 (Draft/destroy scope draft, audit); packages/contract/tests/generated.test.ts:37 (MCP rule is scope only).
- **Suggested fix:** Before the freeze, change the MCP rule to scope in {read, draft} and not audit (or add a `confirm` registry tag that the MCP adapter turns into an in-app confirmation request), regenerate, and update generated.test.ts.
- **Earlier answer:** Raised as should-fix S6 and S7 (no confirm tag) in the platform early security review, whose 'checked and fine' list also names Draft/destroy as the one MCP exception; no author answer recorded. The evidence still holds.

### FR-10: StoreWrite has no kinds for most tables provider and engine lanes write from day 4, and pending-op replay is absent

- **Severity:** gap · **Artifact:** F4 · **Owner:** engine (eng-store) · **Reviewers:** PR-4 · **Evidence checked:** confirmed
- **Problem:** Every provider fact must commit through store.commit, but the union covers only accounts, folders, messages, placements, flags, threads, workflow, sync state, sweep and meta. There is no write for ops (enqueue and settle), submissions (the 'sending' marker before the first byte), drafts and RemoteDraftFact, bodies and attachments, governor_state, provider_memory, sync_failures, calendars, events and the events sweep, notifications, header-thread merges, AccountWrite.reasonCode, or a {folder, uid} MessageTarget for IMAP deltas. ARCH 4.3 replay of pending ops is not implemented, so a local archive followed by a sync page fenced after the edit can bring INBOX back. All additive, but if each lane invents its own shape after the freeze, change proposals will collide.
- **Evidence:** packages/engine/src/store/port.ts:70-83 (union), :94-95 (MessageTarget remoteId | remoteThreadId only), :101-118 (AccountWrite, no reasonCode); store/commit.ts:61-66 ('eng-store completes it in Phase 1 (replay of pending ops, bodies, ...)'); ports/provider.ts StepResult memory, quarantine and threadMerges fields; ports/calendar.ts CalendarStepResult.
- **Suggested fix:** Freeze names and shapes now, even if commit.ts implements them in Phase 1: OpWrite, OpSettleWrite, SubmissionWrite, DraftWrite, BodyWrite, AttachmentWrite, GovernorWrite, ProviderMemoryWrite, FailureWrite, CalendarWrite, EventWrite, EventSweepWrite, ThreadMergeWrite, AccountWrite.reasonCode and MessageTarget {folder, uid}. Implement replay of pending ops for touched messages before day 6.
- **Earlier answer:** ports.review-answers.md objection 10 defers the events sweep write to prov-cal 'additive, since F4 has no event writes yet', and commit.ts defers replay to Phase 1. That answer accepts the gap rather than closing it; the evidence still holds and the shape-collision risk remains.

### FR-11: dispatch does not deny by default on scope, uiOnly, secret or host

- **Severity:** gap · **Artifact:** F5 · **Owner:** engine (eng-contract) · **Reviewers:** SEC-5 · **Evidence checked:** confirmed
- **Problem:** dispatch checks only that a handler exists; scope, uiOnly, secret and host gating are left to each of four transports built by different work packages. MethodContext.caller carries kind and scopes, but dispatch never compares them with the method's tags, so one transport that forgets a check exposes Mail/serve, Notification/claim or Clients/grant. The conformance suite has no scope or uiOnly case.
- **Evidence:** packages/engine/src/methods/index.ts:72-84 (doc: transport 'has checked' the scope; code: hasOwnProperty only); methods/types.ts:17-30 (Caller.kind and scopes, unused); packages/contract/tests/conformance/suite.ts (no scope matrix).
- **Suggested fix:** Additive inside F5: dispatch looks up the generated methodScope, host, uiOnly and secret tables and throws 'forbidden' unless the scope is in caller.scopes, host methods need caller.kind 'host', and uiOnly or secret methods need 'window' or 'host'. Add a test that a listener caller holding ['read'] gets 'forbidden' for Submission/set and Mail/serve.
- **Earlier answer:** Raised as should-fix S8 in the platform early security review; no author answer recorded. The evidence still holds.

### FR-12: No engine-side port for calendar writes, RSVP or provider filters, and handlers have no way to reach any port

- **Severity:** gap · **Artifact:** F3, F5 · **Owner:** engine (eng-contract) · **Reviewers:** PR-6 · **Evidence checked:** confirmed
- **Problem:** CalendarAdapter says writes come from methods/event.ts 'through the actor host', but AccountActorHost and ProviderPort have no put, remove or rsvp, and nothing routes RulesAdapter (Gmail filters for block and skip-Inbox). MethodContext carries only caller and signal ('Engine services arrive with the ports (F3)', but F3 does not add them), so methods/account.ts, sync.ts, event.ts and sender.ts have no frozen way to reach AccountActorHost, SendPort or StorePort.
- **Evidence:** packages/engine/src/ports/calendar.ts:119-123 and :144-152; ports/engine.ts:24-26 and :95-106 (AccountActorHost has no calendar or rules calls); ports/provider.ts:558-563 (RulesAdapter); methods/types.ts:25-30.
- **Suggested fix:** Additive: CalendarPort {put, remove, rsvp} and RulesPort {list, create, delete} beside SendPort and DraftSyncPort, plus an engine-services field on MethodContext or a documented injection point.
- **Earlier answer:** ports.walk.md says 'Engine modules never call adapters: they call ProviderPort, SendPort, DraftSyncPort and AccountActorHost', and its Google Calendar paragraph has Event/set call put(EventChange), but no frozen route exists. Not otherwise answered; the evidence still holds.

### FR-13: Failed, uncertain and suspended sends are a dead end: no cancel or dismiss, and Draft/destroy leaves an orphan submission

- **Severity:** gap · **Artifact:** F1, F6 · **Owner:** engine (eng-contract) · **Reviewers:** UI-2 · **Evidence checked:** confirmed
- **Problem:** SubmissionAction allows undo only for queued/scheduled, sendAnyway for uncertain and retry for failed. Nothing cancels a failed, uncertain or suspended submission, and a new send is refused ('already on its way') while one is live. Draft/destroy deletes the draft but leaves the submission, so Outbox/pending keeps reporting it and the Quit warning never clears. The owner cannot say 'don't send it' after 'We could not confirm this was sent', or drop a suspended send. The revision part is FR-7.
- **Evidence:** packages/contract/src/schemas/compose.ts:102-119 (no cancel); packages/contract-fixture/src/methods/compose.ts:8 (live set includes uncertain, failed, suspended), :266-267 (send refused while live), :314-320 (allowed actions), :229-233 (Draft/destroy does not touch the submission).
- **Suggested fix:** Additive: SubmissionAction {type:'cancel', submissionId} for failed, uncertain and suspended (the draft comes back unlocked), and a rule that Draft/destroy cancels any non-sending submission. Make the stand-in match.
- **Earlier answer:** GAPS.md F9-9 answers 'already there' for sendNow, reschedule, sendAnyway and retry; cancel after failure is not covered. The evidence still holds.

### FR-14: The undo-send receipt contradicts itself: undoable:false with undoUntil set

- **Severity:** gap · **Artifact:** F1, F6 · **Owner:** engine (eng-contract) · **Reviewers:** UI-3 · **Evidence checked:** confirmed
- **Problem:** Receipt.undoUntil is documented as 'until when Operation/undo cancels a held change'; undoable:false means 'no inverse'. A send receipt carries both (undoable:false, undoUntil = notBefore), and Operation/undo on it is refused. F9's one undo stack builds Z and the toast from receipts and Operation/undo, so global Z either offers Undo and fails or hides it during the undo-send window. The working path (Submission/set undo) is not tied to the receipt anywhere.
- **Evidence:** packages/contract/src/schemas/common.ts:135-141; api/mail.ts:174-181; packages/contract-fixture/src/methods/compose.ts:303-306 (undoable:false, then undoUntil: value.notBefore); contract-fixture/src/methods/mail.ts:374-377 (Operation/undo refuses undoable:false); apps/desktop/src/renderer/data/index.ts:675.
- **Suggested fix:** Pin before the freeze: either Operation/undo on a send opId cancels the submission while queued/scheduled (receipt undoable:true, undoUntil = notBefore), or undoUntil is meaningful only with undoable:true and send receipts name their undo path (an optional undoWith:'Submission/set'). The stand-in must match.
- **Earlier answer:** GAPS.md E7 and F9-7 answer that Receipt.undoUntil and Operation/undo are 'already there'; the send case was not considered. The evidence still holds.

### FR-15: The change log misses derived changes, so snapshot(seq0)+changes != snapshot(seqN)

- **Severity:** gap · **Artifact:** F4 · **Owner:** engine (eng-store) · **Reviewers:** PR-2 · **Evidence checked:** confirmed
- **Problem:** folderDelete cascades away message_folders, which changes Message.labels, but marks only the Folder (d) and touched Threads, never the Messages. Thread rollups rewrite thread_folders (and so Folder.unread) without writing a Folder change row. A client replaying changes keeps stale labels and sidebar counts after a label is deleted on the web or mail is read on another device. This fails ARCH 3.5 and the plan 10 E2 replay property.
- **Evidence:** packages/engine/src/store/commit.ts:248-256 (folderDelete marks Folder d only, touchFolderThreads marks threads); rollups() from :607 never calls mark('Folder', ...) (the only Folder marks are :245, :255, :274); packages/contract/src/schemas/account.ts:141-143 (Folder.unread counts threads).
- **Suggested fix:** Implementation only, additive: in folderDelete, mark Message u (and bump rev) for every message that had a placement there; in rollups, mark Folder u for each folder whose membership or unread count changed. Add both cases to the replay property generator.
- **Earlier answer:** new (ports.review-answers.md covers sweeps and generations, not derived change rows).

### FR-16: Hello has no token field, there is no hello reply, and the HTTP trust rules are not in the contract

- **Severity:** gap · **Artifact:** F1 · **Owner:** engine (eng-contract) · **Reviewers:** SEC-6 · **Evidence checked:** confirmed
- **Problem:** ARCH 9.4 and plan 10 E7 item 1 put a per-client token in the socket hello, but Hello has only v, apiVersion, appVersion and client, and zod objects strip unknown keys, so a token a client sends today is silently dropped by Hello.parse. There is no reply schema for 'unsupported'. For HTTP, the contract says nothing about Authorization, the Host allowlist, exact Origin or no reflected CORS.
- **Evidence:** packages/contract/src/wire.ts:31-37 (Hello without token); packages/contract/README.md 'Scopes and transports' (no Host, Origin or token rules); generated/openapi.json securitySchemes bearer only.
- **Suggested fix:** Additive but best now: token: line(128) on Hello (never logged), a HelloReply union {ok:true, session} | {ok:false, error:{type:'unsupported'|'forbidden'}}, and the HTTP rules in the README (Bearer only, exact Host and Origin, no reflected CORS, no-store, constant-time compare).
- **Earlier answer:** Raised as should-fix S9 and S12 (and S10/S17 for host wiring) in the platform early security review; no author answer recorded. The evidence still holds.

### FR-17: Fixture/control has no knobs for the failure screens the UI must show

- **Severity:** gap · **Artifact:** F6 · **Owner:** engine (eng-contract) · **Reviewers:** UI-11 · **Evidence checked:** confirmed
- **Problem:** Knobs cover status, pause, failed write, submission state and send outcome, setup progress, clock, ordering, park, mail delivery and rerank. A connect or reconnect cannot end failed, cancelled, wrong-account, denied or timed out (every flow succeeds after 800 ms); Ask cannot fail mid-stream or return an addEvent proposal; remote search results, paused or unavailable outcomes and a transcription result cannot be scripted. The 'replay' knob can inject raw frames, but the method replies and the 800 ms success still happen, so the reconnect sheet, Ask errors, Search's paused line and onboarding failures cannot be harness-tested.
- **Evidence:** packages/contract-fixture/src/control-types.ts:24-107 (knob list; 'replay' at :57); packages/contract-fixture/src/methods/account.ts:100-111 (flow always connects after 800 ms); methods/ai.ts Ask/run timeline from :347.
- **Suggested fix:** Additive ControlArgs: resolveConnect {connectId?, outcome, reasonCode?, delayMs?}; askScript {steps, text, citations, proposals, failAt?, problem?}; failNextAi {feature, reasonCode}; searchRemote {ids | error}; transcribeResult {text}; calendarChange {eventId, patch}.
- **Earlier answer:** GAPS.md E10 and E11 rejected these for F1 and 'forwarded' them to F6; the F6 candidate still lacks them, so the evidence still holds.

### FR-18: The governor's class-by-class policy lives only in an untracked input document

- **Severity:** gap · **Artifact:** F3 · **Owner:** engine (eng-contract) · **Reviewers:** PR-5 · **Evidence checked:** confirmed
- **Problem:** GovernorPort defines the retry rule but sends readers to 'the Providers proposal's table (section 4)' for each class's action (throttle escalation and AIMD, the daily stop with project scope, send_limit blocking sends only, anti_abuse cool-down, permission without pause, config on PROJECT). That proposal is untracked in the candidate and not one of F1-F9, and it still lists a 'conflict' class that F1 removed. prov-gov and the emulator fault kit would build against an unfrozen document.
- **Evidence:** packages/engine/src/ports/governor.ts:91-94; packages/contract/src/errors.ts:9-20 (no conflict class); git status in the candidate shows .freeze-inputs/ (with providers-port-proposal.md) untracked.
- **Suggested fix:** Doc only: copy the class-to-action table, without the conflict row, into governor.ts or a tracked doc under packages/engine/src/ports/.
- **Earlier answer:** new (ports.walk.md item 5 explains removing the conflict class, but the table was never moved into a frozen artifact).

### FR-19: Event/set notify cannot reach the adapter: CalendarAdapter.put and remove take no notify option

- **Severity:** gap · **Artifact:** F3 · **Owner:** engine (eng-contract) · **Reviewers:** PR-7, SEC-1 · **Evidence checked:** confirmed
- **Problem:** Event/set takes notify ('may notify guests'), but CalendarAdapter.put(change) and remove(ref) take none; only rsvp has opts.notify. Google's sendUpdates defaults to none, so guests would never hear about edits or cancellations, and a guest-free path (FR-4) cannot tell the adapter not to notify. CalDAV scheduling and Graph cancel and decline need the same input.
- **Evidence:** packages/contract/src/api/compose.ts:104-112 (Event/set notify); packages/engine/src/ports/calendar.ts:44-51 (EventChange without notify), :144-145 (put, remove), :147-152 (rsvp has opts.notify).
- **Suggested fix:** Additive: optional notify?: boolean on the F3 EventChange and on remove's ref object, or an opts:{notify} argument on put and remove.
- **Earlier answer:** ports.walk.md says invitations 'go out from Google when notify is set' and GAPS.md P6/P7 call Event/set and Event/rsvp 'already there', but the port never got the field. The evidence still holds.

### FR-20: Recurrence identity has no canonical form, and CalDAV href versus UID is inconsistent

- **Severity:** gap · **Artifact:** F1, F3, F4 · **Owner:** engine (eng-contract) · **Reviewers:** PR-8 · **Evidence checked:** confirmed
- **Problem:** events.recurrence_id is part of the unique key, but its string form is not defined: Google's originalStartTime can carry an offset or zone, all-day exceptions carry a date, and CalDAV RECURRENCE-ID can be TZID-local, so one occurrence can get duplicate rows and the Google instance id cannot be derived for RSVP. F1's occurrence id '<seriesId>@<originalStartUtc>' has no UTC value for all-day or floating series. SCHEMA.md says master_remote_id holds the CalDAV UID while remote_id must be the href, so the master join breaks and nothing keeps the iCalendar UID for matching invites. Graph calendarView/delta returns instances without masters, and EventFacts cannot tell an instance from an exception.
- **Evidence:** packages/engine/src/store/migrations/0001_initial.ts:156-161; packages/engine/src/store/SCHEMA.md:35 ('master_remote_id (GC recurringEventId, D UID)'); packages/engine/src/ports/calendar.ts:35-41 (EventRef.recurrenceId undefined form); packages/contract/src/schemas/calendar.ts:21-25, 41-55.
- **Suggested fix:** Doc edit before the freeze: canonical recurrence_id is the original start as UTC 'YYYYMMDDTHHMMSSZ', 'YYYYMMDD' for all-day, or local time plus TZID for floating; for CalDAV remote_id is the href and master_remote_id is empty. Later and additive: a uid column in 0002 and an optional instance marker on EventFacts.
- **Earlier answer:** GAPS.md P5 calls occurrence identity 'already there' (Event.id = seriesId@originalStartUtc); ports.review-answers.md objection 21 fixed only CalDAV overrides sharing a resource. Neither defines the canonical form, so the evidence still holds.

### FR-21: Calendar components cannot carry repeat scope, and F1 has no per-event hide

- **Severity:** gap · **Artifact:** F9, F1 · **Owner:** engine (eng-contract) + ui-core · **Reviewers:** UI-8 · **Evidence checked:** confirmed
- **Problem:** F1 has EditScope (occurrence | series | following) on Event/set and occurrence | series on Event/rsvp, but CalendarEventData has no recurring flag, CalendarGridProps.onMove/onResize and EventDetailProps reply.onSend take no scope, and there is no scope-chooser props interface. The event-detail mockup offers 'hide' in its More menu, but F1 can only hide whole calendars (Calendar/set) or destroy events at the provider.
- **Evidence:** apps/desktop/src/renderer/ui/props.ts:1846-1862 (CalendarEventData, no recurring), :1922-1924 (onMove, onResize without scope), :2007 (onSend: () => void); packages/contract/src/schemas/calendar.ts:133-137 (EventChange has no hide); api/compose.ts:85-96 (Calendar/set shown only); mockups/cal.js:205.
- **Suggested fix:** Additive: CalendarEventData.recurring, an optional scope argument on onMove, onResize and reply.onSend, and a ScopeChooser props interface. In F1, a local Aplos-side hide (EventChange {type:'hide', id, hidden}) that is never written to the provider.
- **Earlier answer:** GAPS.md P6, P7 and PV-7 confirm EditScope in F1, and U10 rejects component props as renderer-only, so the F9 half was never picked up by UI-core. Per-event hide is new. The evidence still holds.

### FR-22: events.includePlans has no defined meaning, and the plans view has no range

- **Severity:** gap · **Artifact:** F1, F6 · **Owner:** engine (eng-contract) · **Reviewers:** UI-7 · **Evidence checked:** confirmed
- **Problem:** The events ViewSpec accepts includePlans, but a window has one rowType ('Event'), so plan ids cannot be mixed in without the client calling the wrong T/get; the stand-in ignores the flag. The plans view has no from/to, so the grid's dashed 'From mail' outlines need every open plan and a client-side filter. Whatever the real engine later does with includePlans:true would be a semantic change under clients already built.
- **Evidence:** packages/contract/src/schemas/mail.ts:318-328 (includePlans; plans view without range), :404-410 (single rowType); grep shows includePlans used nowhere in packages/contract-fixture; apps/desktop/src/renderer/ui/props.ts:1862 (CalendarEventData kind 'event' | 'plan').
- **Suggested fix:** Pin before the freeze: includePlans is ignored and reserved (documented), or plans arrive as Event rows with an optional planId marker. Additively give the plans spec optional from/to.
- **Earlier answer:** GAPS.md E50 lists includePlans as 'already there' without defining it. The evidence still holds.

### FR-23: Reconnect connect frames omit accountId, and a cancelled reconnect reports mode 'new'

- **Severity:** gap · **Artifact:** F1, F6 · **Owner:** engine (eng-contract) · **Reviewers:** UI-4 · **Evidence checked:** confirmed
- **Problem:** The reconnect sheet can be reopened from the status slot, Settings or first sync and must find its in-flight flow by account, and F9 assumes accountId is 'always set for reconnect and grant'. F1 makes connect.accountId optional with no such promise. The stand-in emits the 'waiting' frame without accountId and emits every cancel as mode:'new' without accountId, so a reopened sheet cannot find or cancel its flow and a mode filter never sees the cancel.
- **Evidence:** packages/contract/src/wire.ts:178-187 (accountId optional); packages/contract-fixture/src/methods/account.ts:99-111 (waiting frame without accountId), :273-279 (cancel emits mode 'new'); apps/desktop/src/renderer/data/contract-shapes.ts:512; data/index.ts:836.
- **Suggested fix:** Additive: document that accountId is present on every reconnect and grantPermissions frame from 'waiting' on; make the stand-in send it and echo the flow's real mode on 'cancelled'; add a conformance case.
- **Earlier answer:** GAPS.md P1 and F9-17 call the connect frame and cancel 'already there'; the accountId promise is not addressed. The evidence still holds.

### FR-24: Sync/request force ('Retry now') and Account/lease pin:false have no F3 route

- **Severity:** gap · **Artifact:** F3 · **Owner:** engine (eng-contract) · **Reviewers:** PR-10 · **Evidence checked:** confirmed
- **Problem:** F1 Sync/request carries force (once per throttle pause) for DESIGN 7.1's 'Retry now', but AccountActorHost.request takes only {scope?, manual} and GovernorPort.clear accepts only 'auth' | 'config', so a forced request can only end in PausedError. Account/lease pin:false ('back to automatic') has no counterpart; F3 has only claimLease.
- **Evidence:** packages/contract/src/api/account.ts:121-127 (Account/lease pin), :141-150 (Sync/request force); packages/engine/src/ports/engine.ts:97-104 (request, claimLease); ports/governor.ts:132-133 (clear).
- **Suggested fix:** Additive: force?: boolean on request(); an optional GovernorPort.retryNow(account, budget) that admits one call and keeps the escalation step; claimLease(account, pin: boolean) or a releaseLease.
- **Earlier answer:** GAPS.md P13, F9-16 and PV-6 answer 'already there: Sync/request {force}' for the contract only; F3 has no route. The evidence still holds.

### FR-25: App-password and API-token accounts cannot reconnect, and Fastmail needs two secrets

- **Severity:** gap · **Artifact:** F1, F3 · **Owner:** engine (eng-contract) · **Reviewers:** PR-11 · **Evidence checked:** confirmed
- **Problem:** Account/reconnect takes only accountId and is not secret, so an iCloud or generic IMAP account whose app password was revoked (needsReauth) can only Disconnect and Connect, which discards queued changes and forces a resync, against ARCH 6.4. A Fastmail account on an API token also needs a separate app password for CalDAV, but ConnectRequest and Account/connect carry one secret.
- **Evidence:** packages/contract/src/api/account.ts:81-88 (Account/reconnect {accountId}); packages/engine/src/ports/provider.ts:354-365, :392-393 (ConnectRequest one secretRef).
- **Suggested fix:** Additive: Account/updateSecret (secret: true, audit) that feeds ConnectRequest mode 'reconnect' with a new secretRef, and an optional ConnectRequest.calendarSecretRef.
- **Earlier answer:** ports.walk.md IMAP paragraph says reconnect is connect({mode:'reconnect', secretRef}), but F1 gives the UI no way to supply that secret. The evidence still holds.

### FR-26: Drafts edited elsewhere: no precondition on save, no lookup to recognise Aplos's own draft writes, and a wrong idempotency claim

- **Severity:** gap · **Artifact:** F3 · **Owner:** engine (eng-contract) · **Reviewers:** PR-9 · **Evidence checked:** confirmed
- **Problem:** DraftUpload has no last-synced remote message id or change key, and DraftSaveResult has only saved | gone, so a 5 s idle save can overwrite a phone edit that history or delta has not reported yet. KnownLookup.trackedDraftIds is keyed by draft id, but a Gmail DRAFT history record gives only a message id, and ARCH 7.4 detects a remote edit as 'a message id Aplos did not write', so the adapter needs drafts.remote_message_id. saveDraft's doc says an update is idempotentWrite, which is false for JMAP and IMAP (create plus destroy), so a transient retry would duplicate the draft.
- **Evidence:** packages/engine/src/ports/provider.ts:313-321 (KnownLookup), :484-499 (DraftUpload, DraftSaveResult), :595-596 (saveDraft doc).
- **Suggested fix:** Additive: DraftUpload.baseRemoteMessageId?, a {kind:'conflict'} DraftSaveResult member, and KnownLookup.draftByMessageId(ids). Doc fix: the adapter picks the request kind; create-plus-destroy updates are 'write'.
- **Earlier answer:** ports.walk.md describes JMAP and IMAP updates as replaces 'reported as saved', and ports.review-answers.md objection 24 added drafts.remote_internet_id; neither changed the saveDraft doc or added the lookup. The evidence still holds.

### FR-27: No view returns Low-importance threads grouped by sender, which the Low sheet needs

- **Severity:** gap · **Artifact:** F1 · **Owner:** engine (eng-contract) · **Reviewers:** UI-5 · **Evidence checked:** confirmed
- **Problem:** DESIGN 7.2 orders Low importance by sender, and F9 LowSheetProps renders sender groups that hold their thread rows. F1 offers lowSenders (SenderGroup rows only, no thread ids per group, and ThreadSelector refuses non-thread views) and homeSection {section:'low'}, which returns threads newest-first in one 'low' section. Grouping a 200-row newest-first window splits senders across pages and gets counts wrong.
- **Evidence:** packages/contract/src/schemas/mail.ts:286-289 (homeSection, lowSenders), :334-344 (ThreadSelector only for thread views), :380-386 (SenderGroup); apps/desktop/src/renderer/ui/props.ts:946-958.
- **Suggested fix:** Additive: ViewSpec {kind:'lowBySender', accountId?} with Thread rows ordered by sender and one WindowSection per sender (key = address, label = name); being a thread view, it is selector-eligible per sender.
- **Earlier answer:** GAPS.md F9-30 documents WindowSection keys for lowSenders (one per sender), but those sections hold SenderGroup rows, not threads. The evidence still holds.

### FR-28: Thread/act cannot clear a reminder, and 'Clear from Home' on Back from Later discards Later dates

- **Severity:** gap · **Artifact:** F1 · **Owner:** engine (eng-contract) · **Reviewers:** UI-9 · **Evidence checked:** confirmed
- **Problem:** The reminder action says 'Neither field clears the reminder', so once the Undo toast is gone a reminder cannot be removed. 'Clear from Home' on Back from Later is documented as the 'later' action, which without until means Someday; applied with a selector to a block of items with different dates, every item loses its date and leaves Later's Overdue group, while DESIGN says the label sends them back to Later.
- **Evidence:** packages/contract/src/schemas/mail.ts:199-200 (later: until optional = Someday), :209-213 (reminder, 'Neither field clears'), :236-237 ('Clear from Home ... is `later` instead').
- **Suggested fix:** Additive: clear: bool() on the reminder action, and a clearFromHome action (or later {keepDate:true}) that keeps each laterUntil and takes the thread off Home.
- **Earlier answer:** GAPS.md F9-3 answered clearFromHome as 'already there: later with no until' and remindIfNoReply as reminder {at?, ifNoReply}. That answer is the cause of the defect, so it does not close it.

### FR-29: No method for recipient type-ahead

- **Severity:** gap · **Artifact:** F1 · **Owner:** engine (eng-contract) · **Reviewers:** UI-6 · **Evidence checked:** confirmed
- **Problem:** F9 RecipientField takes suggestions, and ARCH 3.2 keeps a correspondents table 'for heuristic Home + autocomplete', but no contract method exposes it. The renderer never holds the mailbox, and View/query search returns threads, not addresses, so To/Cc/Bcc completion cannot be built.
- **Evidence:** apps/desktop/src/renderer/ui/props.ts:1432 (suggestions); packages/contract/generated/methods.generated.ts (no Contact or recipient method); packages/engine/src/store/migrations/0001_initial.ts:76.
- **Suggested fix:** Additive: Contact/suggest {query: line(320), accountId?, limit?} → {list:[{address, name?, sentTo, receivedFrom}]}, scope read, ranked by correspondents; the stand-in serves it from demo participants.
- **Earlier answer:** new

### FR-30: Ask answers carry no citation anchors; chip placement relies on an undocumented '[n]' text convention

- **Severity:** gap · **Artifact:** F1 · **Owner:** engine (eng-contract) · **Reviewers:** UI-10 · **Evidence checked:** confirmed
- **Problem:** DESIGN 7.7 places [1] chips inline in the answer, and F9's AnswerSegment has a 'cite' segment, but AskTurn.answer.blocks are {text, strong ranges} and progress frames stream plain delta text. Where a chip sits can only come from parsing '[n]' in model-written prose (as the stand-in writes it), which F1 never documents; it is ambiguous next to strong offsets, and quoted mail can contain the same text.
- **Evidence:** packages/contract/src/schemas/ai.ts:194-205 (blocks text and strong only); wire.ts:147-169 (progress delta); packages/contract-fixture/src/methods/ai.ts:297 (`${...} [${i + 1}].`); apps/desktop/src/renderer/ui/props.ts:1544-1561.
- **Suggested fix:** Additive: optional cites:[{at: Count, n: Count}] per block and an optional citation 'at' on progress text, with offsets measured on text with markers removed; or document the '[n]' marker contract and that the engine strips stray markers, before the freeze.
- **Earlier answer:** GAPS.md E27 (closed: progress citation kind) and E28 ('already there': answer.blocks) did not cover inline anchors. The evidence still holds.

### FR-31: An IMAP UIDVALIDITY change makes the next placement commit throw on the unique mf_uid index

- **Severity:** gap · **Artifact:** F4 · **Owner:** engine (eng-store) · **Reviewers:** PR-3 · **Evidence checked:** confirmed
- **Problem:** After UIDVALIDITY changes, the resync writes new UIDs while messages not yet relisted still hold old UIDs in the same folder. place() handles only a (message_id, folder_id) conflict, so the partial unique index mf_uid(folder_id, uid) throws and the whole step fails every time, and the reset never completes. A FolderWrite with a new uidValidity updates that column only.
- **Evidence:** packages/engine/src/store/migrations/0001_initial.ts:58 (`CREATE UNIQUE INDEX mf_uid ON message_folders(folder_id, uid) WHERE uid IS NOT NULL`); store/commit.ts:224-246 (folder upsert sets uidvalidity only), :405-416 (place ON CONFLICT(message_id, folder_id) only).
- **Suggested fix:** Define in FolderWrite's doc now, implement in Phase 1: a FolderWrite whose uidValidity differs from the stored one sets message_folders.uid = NULL for that folder in the same transaction; the adapter's full resync then sweeps without UID bounds.
- **Earlier answer:** ports.walk.md IMAP paragraph covers only reset: 'uidValidityChanged' at the port; the store side is new. Confirmed by reading the code; the reviewer's runtime probe was not re-run.

### FR-32: The diagnostics bundle is content-free only in dev builds

- **Severity:** gap · **Artifact:** F1 · **Owner:** engine (eng-contract) · **Reviewers:** SEC-7 · **Evidence checked:** confirmed
- **Problem:** DiagnosticsBundle claims nothing enters it except through its schema, but output schemas run only through checkResult (tests and dev builds), so in a release the schema never runs on Diagnostics/preview or export. Even when it runs, errors[].error is ClassifiedErrorSchema, whose method, reason, code and item are unpatterned strings and providerMessage is only length-capped. The store keeps free-text error columns (accounts.status_detail, ops.last_error, submissions.error, sync_failures.last_reason) that a builder would read without the Logger's cleanError, which is not exported.
- **Evidence:** packages/contract/src/schemas/session.ts:237-238 (bundle errors); errors.ts:47-72 (unbounded strings); registry/index.ts:147-149 (checkResult 'For tests and dev builds only'); packages/engine/src/diag/log.ts (cleanError not in its exports); store/migrations/0001_initial.ts free-text error columns.
- **Suggested fix:** Additive: the host parses every bundle in production with a strict variant before preview, save or copy (Diagnostics/copy included), using an error schema whose fields follow logCodePattern and logAddressHashPattern with providerMessage redacted; export cleanError and require the builder to pass every stored error through it; add the E7 canary test.
- **Earlier answer:** Raised as should-fix S14 in the platform early security review; no author answer recorded. GAPS.md E44 calls the bundle 'already there'. The evidence still holds.

### FR-33: Free-text AI test messages can return the tail of a key

- **Severity:** gap · **Artifact:** F1 · **Owner:** engine (eng-contract) · **Reviewers:** SEC-8 · **Evidence checked:** confirmed
- **Problem:** Ai/testKey answers message: z.optional(z.string()) (and is on the listener), and Problem.message is also unbounded; nothing says it must be engine-chosen copy rather than provider text. Some providers' 401 text echoes a masked key with its last four characters, and the redactor's sk- pattern stops at the asterisks, so the tail survives into the renderer and any admin listener client.
- **Evidence:** packages/contract/src/api/ai.ts:178-190 (Ai/testKey message: z.string()); schemas/common.ts:153-158 (Problem.message); packages/engine/src/diag/redact.ts:25 (sk- token shape requires 8 word characters, so a masked form does not match).
- **Suggested fix:** Additive: freeze that message on Ai/testKey, Ai/test and Problem is engine copy chosen by reasonCode, never provider text; add a redactor shape for masked keys (a known key prefix followed by three or more asterisks).
- **Earlier answer:** new (GAPS.md E23 and E24 removed last4 and made keys write-only, but did not cover free-text messages).

### FR-34: Nothing enforces the stand-in-only srcdoc path, the stand-in's srcdoc has no inner CSP, and F3 has no ImageProxy port

- **Severity:** gap · **Artifact:** F1, F3, F6 · **Owner:** engine (eng-contract) · **Reviewers:** SEC-9 · **Evidence checked:** confirmed
- **Problem:** MailFrame.srcdoc is frozen into v1 with only a comment saying the real engine never sets it, and no conformance rule or Session flag lets a packaged renderer refuse it, so a release could ship the same-origin path ARCH 10 forbids. The stand-in's document has no inner meta CSP, which ARCH 10 Stopgap requires. F3 has no ImageProxy port, although Mail/serve's image route needs the host proxy and plan 10 E4 item 6's SSRF rules belong in its contract.
- **Evidence:** packages/contract/src/schemas/mail.ts:177-190 (srcdoc optional); packages/contract-fixture/src/methods/mail.ts:214 (`<!doctype html><meta charset="utf-8"><body>...`, no CSP); packages/engine/src/ports/ has no ImageProxy (grep); ports/content.ts:29-58.
- **Suggested fix:** Additive: a conformance rule that srcdoc is absent on the real-engine target; a rule that the renderer uses srcdoc only in unpackaged builds when capabilities.mailFrame is false, inside sandbox=""; an inner CSP meta in the stand-in (default-src 'none'; style-src 'unsafe-inline'; img-src data:); an ImageProxy port in F3 with the resolved-address, redirect, port, size and type rules.
- **Earlier answer:** new (srcdoc arrived in commit 214f052, after the platform early review, whose S16 covered only Mail/frame exposure).

### FR-35: Type drift between ports, store and wire

- **Severity:** nit · **Artifact:** F1, F3, F4 · **Owner:** engine (eng-contract) · **Reviewers:** PR-12 · **Evidence checked:** confirmed
- **Problem:** F3 EventTime is kind: instant|date|local with tzid, while F1 is type: utc|date|floating with timeZone. F3 AccountRuntime.missingPermissions lacks the reasonCode the wire requires. F4 AccountWrite.capabilities is Record<string, boolean>, which cannot carry threading: 'headers'. F1 Folder.role lists no category.* roles (it is an open enum, so they parse, but they are undocumented). Each needs a mapping or a cast in every lane.
- **Evidence:** packages/engine/src/ports/calendar.ts:12-15 vs packages/contract/src/schemas/calendar.ts:21-25; packages/engine/src/ports/engine.ts:57; packages/engine/src/store/port.ts:107 vs ports/provider.ts:300 (threading: 'native' | 'headers'); packages/contract/src/schemas/account.ts:125-137.
- **Suggested fix:** Widen AccountWrite.capabilities to Record<string, boolean | string> (additive) and add a mapping note or optional field for the rest.
- **Earlier answer:** ports.review-answers.md objection 9 added category.* to F4 FolderRole, and GAPS.md PV-4 added threading to the contract capabilities; the F4 capabilities type and F1 Folder.role docs were not aligned. GAPS.md E8 fixed F1 EventTime, not F3's.

### FR-36: HttpAddress allows a query string, and the budget test's title overstates what it measures

- **Severity:** nit · **Artifact:** F1, F4 · **Owner:** engine (eng-contract) · **Reviewers:** SEC-12 · **Evidence checked:** confirmed
- **Problem:** HttpAddress rejects user-info but accepts a query or fragment, so a custom server URL with a key in its query would be echoed by Settings/get (read scope, on MCP). The engine budget test is titled 'the new engine plus zod stays under 400,000 bytes' but bundles no zod; the number is honest for the engine, but engine plus zod is not measured anywhere (reviewer measured 252,423 bytes unminified, 141,737 minified, under budget).
- **Evidence:** packages/contract/src/schemas/common.ts:99-107 (isPlainHttp checks protocol and credentials only); packages/engine/tests/portability.test.ts:83-93.
- **Suggested fix:** Refuse a search or hash part in HttpAddress; rename the test or add a second assertion bundling engine + contract registry + zod/mini, and record the number.
- **Earlier answer:** The budget half was raised as should-fix S18 in the platform early security review with no author answer; the title is unchanged. The HttpAddress half is new.

## Checklist items marked gap or not present

- ui: 1 fixture and control channel - gap: no connect outcomes, Ask/AI failure scripts, remote search or transcribe results (FR-17)
- ui: 2 view specs - gap: no Low threads grouped by sender (FR-27); includePlans undefined (FR-22)
- ui: 3 Thread/act, undo, receipts - gap: reminder cannot be cleared, Clear from Home drops dates (FR-28); send receipt contradictory (FR-14)
- ui: 5 submissions and draft-changed-elsewhere - gap: no cancel after failure (FR-13), no recorded revision and Draft/set allowed on held sends (FR-7), receipt contradiction (FR-14), F9 lacks 'scheduled' (FR-1)
- ui: 6 setup and AI governance - gap in F9 only: setup.begin/end lack setupId/reason, setConsent maps to non-existent Consent/set (FR-1)
- ui: 10 APLOS_TEST=1 in main - not-present (F8 not in the candidate)
- ui: weekly reconnect line and sheet - gap: reconnect frames omit accountId, cancel reports mode 'new' (FR-23); no knob to fail a reconnect (FR-17)
- ui: calendar repeat scopes and RSVP - gap: F9 carries no scope or recurring flag, no per-event hide (FR-21)
- ui: honest send states and undo send - gap: dead-end after failure (FR-13), undefined revision (FR-7), contradictory receipt (FR-14), F9 drops 'scheduled' (FR-1)
- providers: IMAP - gap: UIDVALIDITY change throws (FR-31); no folder+uid store target (FR-10); no app-password reconnect (FR-25)
- providers: Graph calendar - gap: instance vs exception (FR-20), no notify on put/remove (FR-19), no calendar write port (FR-12)
- providers: CalDAV - gap: href vs UID identity, no UID column (FR-20); Fastmail needs a second secret (FR-25)
- providers: Google Calendar sync and patch - gap: no notify on edit/delete (FR-19), no canonical recurrence_id (FR-20), no Event store writes (FR-10)
- providers: primary-device lease - gap: Account/lease pin:false has no F3 route (FR-24)
- providers: governor - gap: class table only in untracked doc (FR-18), no governor_state write (FR-10), no Retry now path (FR-24)
- providers: send state machine - gap: 'scheduled' exempt from overdue rule and due index (FR-2); no submission write kind (FR-10)
- providers: change log replay property - gap: folderDelete and unread rollups write no change rows (FR-15)
- providers: F8 APLOS_TEST=1 test mode - not-present
- security: scope tags - gap: Plan/confirm and Ask/decide (FR-4), Operation/* and Queue/* (FR-3); missing audit on Plan/confirm, Ask/decide, Operation/*, Queue/retry, Diagnostics/verbose, Account/lease
- security: Ask/Plan/AI actions that create invitations - gap (FR-4, FR-19)
- security: consent and AI provider settings scope - gap (FR-5)
- security: key handling - gap: provider text in testKey/Problem messages (FR-33), query strings in HttpAddress (FR-36)
- security: data export scope - gap: export blob readable via Blob/get (FR-6)
- security: undo/retry scope - gap (FR-3)
- security: caller binding of handles and blobs - gap (FR-6)
- security: default-deny dispatch - gap (FR-11)
- security: hello/token for socket and HTTP - gap (FR-16)
- security: Mail/frame - gap: srcdoc unenforced, no inner CSP, no ImageProxy port (FR-34); frame tokens on listener with shared cap (FR-6)
- security: diagnostics bundle redaction - gap (FR-32)
- security: F8 test mode - not-present; when it lands it must be compiled only under APLOS_E2E, refuse non-temporary data dirs, show:false, fake clock and emulated providers, no real Keychain items or external sends
