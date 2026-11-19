# Freeze review round 2 (2026-10-28)

Three fresh Claude Opus reviewers checked PR #28 at 9ec6518 merged with UI-core's F9 fix (`rv/ui-shell/contract-swap` at 1da5496). One verified the nine round-1 blockers, one verified the 27 gaps and nits, and one reviewed what round 1 could not see: F2's host wiring, F8 test mode and the new `checkAccess` rule. Round 1 is [findings.md](findings.md).

## In plain English

Most fixes hold: 30 of the 36 round-1 problems are fixed, and the other 6 are partly fixed. The new test mode and the new permission check brought two new must-fix problems: test mode would accept the app's real data folder, and the permission check lets an action through when it doesn't know the original permission. A few database details also need settling before the database layout freezes. Nothing here needs the owner.

## Before `contract-v1` (must fix)

| Item | Owner | What |
|---|---|---|
| R2H-1 | eng-host (F8) | Test mode must refuse the real app data folder, `/`, the home folder and any folder not created for the run |
| R2H-2 = R2B-1 | eng-contract, eng-store | The originating-scope check must fail closed: `ops.scope` and the queue item's scope NOT NULL in schema 0001, and a missing scope is refused |
| FR-7 (rest) | eng-contract (ports); prov-gmail-write later | The bytes that leave are the pinned revision: a `SubmissionPayload.baseRemoteMessageId` precondition for `drafts.send`, else send the pinned MIME; attached blobs live until the submission settles. ARCH 7.1 now says so (integrator) |
| FR-2 (rest) | eng-contract | ARCH 7.3 now covers `queued` and `scheduled` (integrator). Align `plans/engine/phase1-lanes.md` (eng-time's Done criteria) and `ports.review-answers.md`, and define the 5-minute grace and the waiting states once |
| R2H-4 | eng-host with plat-release | Decide how test mode is gated in packaged release builds (plan 40 wants it unavailable there) and record a DECIDED line |
| R2G-1 / FR-31 (rest) | eng-store | A folder write without `uidValidity` must not erase the stored value |
| FR-20 (rest) | eng-store | The store refuses a `recurrenceId` that is not in the canonical form; drop the "provisional" note |
| R2G-3 | eng-store | `correspondents` needs an account column (Contact/suggest's account filter and per-account purge) |
| R2G-4 | eng-store | Event/hide needs a store home (a column or a write kind) |

Everything else below is additive and may land in Phase 1. It is tracked in [../FREEZE.md](../FREEZE.md) and answered in the PR that fixes it.

## Blockers FR-1 to FR-9

The contract is close to freezing but should not freeze yet. Seven of the nine blockers hold on every path I checked, and each has a test I ran (I reverted FR-7 and FR-8 to confirm their tests catch it). FR-2 and FR-7 are only partly fixed. For FR-2, ARCHITECTURE.md 7.3 and eng-time's lane brief still say the overdue rule covers queued rows only, despite the engine's claim that ARCH was aligned. For FR-7, the Gmail drafts.send path can still send the provider draft's current content rather than the pinned revision. Before the freeze, also pin the fail-closed rules the fixes opened or left: a missing op scope (R2B-1), Draft/destroy cancelling sends with only draft scope (R2B-2), and via and clientId coming from the stored client (R2B-3). The consent, draftId and blob-lifetime gaps (R2B-4 to R2B-6) can land in the same pass.

Verdicts: 7 fixed, 2 not fully fixed.

### FR-2: partly-fixed

- **Evidence:** Contract: packages/contract/src/schemas/compose.ts:65-73 (the overdue rule covers queued and scheduled). Ports: packages/engine/src/ports/engine.ts:103-106, :166-171, :181-185. Store: migrations/0001_initial.ts:115,120 (sub_due WHERE state IN ('queued','scheduled')) and store/due.ts:9-46. Stand-in: contract-fixture/src/methods/compose.ts:58-73. Tests I ran: conformance send/overdue-suspends and send/cancel-and-discard pass; engine tests/store/due.test.ts ('scheduled sends are in sub_due ...') and ports.test.ts ('a send-later row that fell due ... is suspended') pass. SCHEMA.md:27 and :39 are aligned.
- **Still open:** The specs the lanes build from still state the old rule. plans/ARCHITECTURE.md:460 ('a queued submission is past not_before') and :462 ('The overdue rule applies to `queued` rows only') are unchanged in this candidate, although engine-answers says 'ARCH 7.3 is aligned (integrator)'. plans/engine/phase1-lanes.md:333, eng-time's own Done criteria, still says 'Overdue rule: `queued` rows only'. ports.review-answers.md:12 repeats it. An eng-time lane that follows its brief or ARCH rebuilds the hole. A smaller point: the 5-minute grace and the waiting-state list are defined three times (ports/engine.ts:182-185 OVERDUE_GRACE_MS, store/due.ts:9-12 OVERDUE_MS, contract-fixture compose.ts:13 overdueGraceMs), so they can drift.

### FR-7: partly-fixed

- **Evidence:** schemas/compose.ts:57-62 (a draft is locked while it has a live submission), :92-93 (Submission.revision), :113-116 and :131-136 (revision is checked on sendNow, sendAnyway and retry). Stand-in contract-fixture methods/compose.ts:23-35 (`unlocked`), :251-252 (Draft/set), :331-333 (Draft/resolve), :385 (records the revision), :445-446 (checks it). Conformance send/draft-locked-while-held passes. I reverted the lock in a temp copy and that case failed, so the test proves the fix.
- **Still open:** The provider half of the original problem is still open. ARCH 7.1 (ARCHITECTURE.md:452), ports.walk.md:25 and SubmissionPayload.remoteDraftId (engine/src/ports/provider.ts:538-540) still send Gmail mail with drafts.send whenever a synced remote draft exists. Nothing says the adapter must send the pinned `mime` rather than the remote draft's current content. SubmissionPayload also has no baseRemoteMessageId precondition like DraftUpload has (provider.ts:507-514). So a phone edit to the provider draft during the undo window or send-later hold is what leaves, which is exactly 'the bytes that leave are undefined'. Separately, Blob/release (read scope, MCP-exposed, api/mail.ts:319-325) can drop a blob the caller attached to a draft that is now held, and nothing says referenced blobs survive until the send.

### R2B-1: The originating-scope check fails open when an operation's scope was not recorded

- **Severity:** gap · **Artifact:** F1 access, F4 store
- **Problem:** requireScope(caller, undefined) passes. Operation.scope, QueueItem.scope, OpWrite.scope and ops.scope are all optional or nullable. So any op an engine lane writes without stamping scope (for example a calendar write committed by prov-gov, an Event/rsvp, or an Unsubscribe/run) can be undone or retried by a triage-only tool. That is the FR-3 hole for every path except the one conformance case. The conformance case itself accepts op.scope === undefined.
- **Evidence:** packages/contract/src/access.ts:69-71 (no check when scope is falsy); schemas/mail.ts:266-270 and schemas/session.ts:194-195 (z.optional); packages/engine/src/store/port.ts:401-402 (scope?: string); migrations/0001_initial.ts:105 (`scope TEXT`, nullable) and commit.ts:785 (`w.scope ?? null`); packages/contract/tests/conformance/suite.ts access/undo-needs-originating-scope (`if (op.scope !== undefined) assert.equal(op.scope, 'send')`).
- **Suggested fix:** Freeze that an absent originating scope falls back to methodScope[Operation.kind], and refuses a listener when that is unknown. Implement it in requireScope's callers, or add requireOriginating(caller, op). Make OpWrite.scope required for ops written on behalf of a method, and add conformance cases for an Event/rsvp op and an Unsubscribe/run op.

### R2B-2: Draft/destroy (draft scope) now cancels held, failed and suspended sends, an effect every other path guards with send

- **Severity:** gap · **Artifact:** F1, F6
- **Problem:** FR-13's fix makes Draft/destroy cancel the live submission. Draft/destroy is draft scope and is on the listener. But Submission/set undo and cancel need send, Queue/discard of a submission needs send, and Operation/undo of a send receipt needs send through scopeRule 'originating'. So a socket or HTTP client granted only draft can drop the owner's approved send-later messages, and the draft with them, which is the 'cheap scope reaches a dearer effect' pattern FR-3 set out to remove. MCP is not affected, because the method is audited.
- **Evidence:** packages/contract/src/api/compose.ts:40-47 (Draft/destroy scope draft, no scopeRule); packages/contract-fixture/src/methods/compose.ts:278-288 (cancel(tx, sub) on any live submission); contract-fixture methods/core.ts:340-347 (Queue/discard of the same submission does requireScope(cx.caller,'send')); api/admin.ts:50-60.
- **Suggested fix:** Give Draft/destroy scopeRule 'originating' when the draft has a live submission: the caller also needs send, else forbidden, or stateMismatch telling it to cancel the send first. Regenerate, and add a conformance case where a draft-only listener destroys a held draft and is refused.

### R2B-3: The MCP tool limit and blob ownership rest on optional, transport-set Caller fields, not on the stored client

- **Severity:** gap · **Artifact:** F1 access, F2 transports
- **Problem:** checkAccess applies mcpMethods only when caller.via === 'mcp', and the docs say 'the MCP adapter sets mcp'. Client.kind 'mcp' is stored at Clients/grant, but no rule ties it to via, and Hello.client.kind is self-declared. So a token granted to an MCP client, used over the socket or HTTP by the agent's shell or by an adapter that omits via, reaches Draft/destroy and every listener method in its grant. For the same reason principalOf gives every listener without a clientId the shared principal 'client:', so such clients read and release each other's blobs. Both fail open.
- **Evidence:** packages/contract/src/access.ts:17-25 (via?, clientId? optional), :57-58, :88-90 (`client:${caller.clientId ?? ''}`); packages/engine/src/methods/types.ts:34-46; packages/contract/src/schemas/session.ts:153-157 (Client.kind includes 'mcp'); packages/contract/src/wire.ts:37-43 (Hello.client.kind is caller-declared).
- **Suggested fix:** Freeze that the transport fills via and clientId from the authenticated token's stored Client row, never from the Hello frame, and that a Client of kind 'mcp' is limited to mcpMethods on every transport. Make checkAccess refuse a listener caller with no clientId. Add an access.test case for both.

### R2B-4: Background-AI consent covers only the Summaries provider, but background jobs also run on the Plans and Drafts models

- **Severity:** gap · **Artifact:** F1, F6
- **Problem:** The frozen consent version covers 'the Summaries provider and model, and that provider's address host'. AiJob kinds include plan and followup, which run on features.plans and features.drafts. If the owner moves Plans or Drafts to another provider or a remote custom address in Settings → AI, background plan and follow-up jobs send mail there with no new consent card. ARCH 8.3 says changing the provider bumps the version and pauses background AI.
- **Evidence:** packages/contract/src/schemas/ai.ts:130-134 (consent doc), :84 (AiJob.kind 'plan', 'followup'); packages/contract-fixture/src/methods/ai.ts:31-41 (consentKey reads only ai.features.summaries); plans/ARCHITECTURE.md:505.
- **Suggested fix:** Freeze that the consent version covers the provider, model and address host of every feature background jobs use (summaries, plans, drafts for follow-ups), or freeze that background jobs use only the Summaries model. Fix consentKey and add a conformance line where changing the Plans provider sets needsReconsent.

### R2B-5: Ai/draft and Ai/polish take a draftId that the AI-account rule does not cover

- **Severity:** gap · **Artifact:** F1, F6
- **Problem:** FR-8's rule is frozen for Ask/run scope and context, and for threadId on Ai/request, Ai/draft and Event/extract. Ai/draft and Ai/polish also accept draftId. A reply draft in an account left out of AI carries that account's thread as context, and nothing says the engine refuses it. The stand-in ignores draftId and no conformance case covers it, so the real engine has no guard against sending excluded mail through 'write a reply' or 'polish'.
- **Evidence:** packages/contract/src/api/ai.ts:77-88 (Ai/polish draftId), :89-101 (Ai/draft summary names only threadId; draftId optional); packages/contract-fixture/src/methods/ai.ts:221-234 (draftId unused); README.md:87 ('a scope or thread naming an excluded account').
- **Suggested fix:** Extend the frozen rule to draftId: a draft whose account is left out of AI answers forbidden with ai.accountExcluded on Ai/draft and Ai/polish. Check it in the stand-in and add it to ai/excluded-account-stays-out.

### R2B-6: The eng-contract lane brief binds blobs per session and releases them on disconnect, against the frozen principal rule

- **Severity:** gap · **Artifact:** plans/engine/phase1-lanes.md vs F1 access
- **Problem:** The frozen rule makes every window and main one principal, and each listener client its own. contract-3's Done criteria say blob handles are bound to the session that created them and released on disconnect. A lane that follows its brief would make a compose window's attachment notFound to the main window. It would also drop a draft's uploaded attachment when the composing window or tool disconnects, before a send-later goes out, which also undermines FR-7's 'the bytes that leave are the revision the owner sent'.
- **Evidence:** plans/engine/phase1-lanes.md:127-128 ('Blob handles are bound to the session that created them ... with a size cap and release on disconnect'); packages/contract/src/access.ts:83-90; packages/contract/README.md:84-87; schemas/compose.ts:6-17 (DraftAttachment.blobId persists on the draft).
- **Suggested fix:** Align the brief with principalOf (bound per principal, not per session). Freeze that a blob referenced by a draft or a live submission is kept, and copied or pinned at Draft/set, until the draft is sent or destroyed: neither Blob/release nor a disconnect removes it.

### R2B-7: MCP Draft/set and Draft/resolve can still overwrite or discard the owner's draft content unprompted

- **Severity:** nit · **Artifact:** F1 (MCP list)
- **Problem:** With Draft/destroy gone from MCP, an injected agent can still blank any owner draft with Draft/set (same id, empty to and html), or drop local edits with Draft/resolve keepTheirs. Neither is audited. The changes sync to the provider. ARCH 12.3 item 6 intends that nothing destructive runs without the owner. This is weaker than delete, but the effect is close.
- **Evidence:** packages/contract/generated/methods.generated.ts:431-485 (mcpMethods includes Draft/set and Draft/resolve); packages/contract-fixture/src/methods/compose.ts:248-276 (Draft/set replaces any unlocked draft); plans/ARCHITECTURE.md:606.
- **Suggested fix:** Freeze that an MCP caller's Draft/set and Draft/resolve act only on drafts that client created, and answer notFound for others. Or note the accepted risk in README's MCP paragraph.

## Gaps and nits FR-10 to FR-36

Of FR-10 to FR-36, 22 are fixed. FR-20, FR-31, FR-34 and FR-35 are only partly fixed: the store accepts non-canonical recurrence ids and still calls the Event id provisional, the UIDVALIDITY guard can be bypassed (reproduced as a UNIQUE failure), the srcdoc rule contradicts the stand-in's mailFrame:true, and Folder.role is undocumented. All engine (76), contract (209) and stand-in (25) tests pass in a scratch copy of the candidate. The contract can freeze, since none of the open items is a blocker. Before 0001 and the srcdoc rule are frozen, three gaps should be closed while they are cheap: the FolderWrite uidValidity patch rule (R2G-1), the srcdoc capability contradiction (R2G-2), and the account-less correspondents table (R2G-3). The Event/hide storage gap (R2G-4) and the nits can follow additively.

Verdicts: 23 fixed, 4 not fully fixed.

### FR-20: partly-fixed

- **Evidence:** packages/engine/src/ports/calendar.ts:36-48 (RECURRENCE_ID_FORMAT and doc), :50-57 (CalDAV href identity, uid fact), :104-110 (instance marker); SCHEMA.md:35. ports.test.ts:654 passes, but it only tests the regex.
- **Still open:** Nothing enforces the canonical form. packages/engine/src/store/calendar.ts event() (around lines 57-95) stores any recurrenceId string, so '2026-10-27T09:00:00+02:00' and '20261027T070000Z' still make two rows for one occurrence; the store should refuse values that fail RECURRENCE_ID_FORMAT. Also, store/calendar.ts:14 still says the Event change-log id is 'Provisional until FR-20 fixes the canonical event id', and contract schemas/calendar.ts:43 still says '<seriesId>@<originalStartUtc>', which does not cover all-day or floating occurrences. The mapping from store rows to the contract Event.id is still unpinned.

### FR-31: partly-fixed

- **Evidence:** packages/engine/src/store/commit.ts:381-388 (a changed uidvalidity clears the folder's UIDs); port.ts:174-178 (doc); tests/store/uidvalidity.test.ts passes.
- **Still open:** The guard can be bypassed. commit.ts:392 writes 'uidvalidity = excluded.uidvalidity', so a FolderWrite that omits uidValidity (FolderFacts.uidValidity is optional, ports/provider.ts:141, e.g. a folder list from LIST without STATUS) sets the stored value to NULL. The next real UIDVALIDITY change then counts as a 'first' validity and clears nothing. My probe in a scratch copy reproduced 'UNIQUE constraint failed: message_folders.folder_id, message_folders.uid' on the resync commit. See R2G-1.

### FR-34: partly-fixed

- **Evidence:** packages/contract/src/schemas/mail.ts:184-191 (frozen srcdoc rules); stand-in methods/mail.ts:10-11 and :225-226 (inner CSP meta); conformance mail/srcdoc-stand-in-only (suite.ts:893) passes; engine/src/ports/content.ts:116-162 (ImageProxy, IMAGE_PROXY_LIMITS).
- **Still open:** The frozen reader rule ('only while Session.capabilities.mailFrame is false') contradicts the stand-in, which reports mailFrame: true (contract-fixture/src/data/defaults.ts:203) and also sends srcdoc. A reader that follows the rule never uses srcdoc with the stand-in and loads an aplos-mail:// URL that nothing serves yet (R2G-2). The ImageProxy doc also names a non-existent imagePolicy 'allow' (R2G-5).

### FR-35: partly-fixed

- **Evidence:** packages/engine/src/ports/calendar.ts:12-17 (F3 EventTime is the F1 type), :20-27 (Attendee.address); ports/engine.ts:59-66 (missingPermissions reasonCode), :76-77 (lease.pinned); store/port.ts:155-156 (capabilities Record<string, boolean | string>), stored as JSON at commit.ts:339.
- **Still open:** F1 Folder.role (packages/contract/src/schemas/account.ts:125-137) still lists no category.* roles and has no note, while F4 FolderRole (store/port.ts:166-180) stores them. The open enum parses them, but they are undocumented on the wire. This is a nit.

### R2G-1: A FolderWrite without uidValidity erases the stored UIDVALIDITY, so the FR-31 guard is skipped and the resync throws again

- **Severity:** gap · **Artifact:** F4 (packages/engine/src/store/commit.ts)
- **Problem:** The folder upsert overwrites uidvalidity with excluded.uidvalidity even when the write leaves the field out. FolderFacts.uidValidity is optional, so a folder-list refresh without STATUS stores NULL. When UIDVALIDITY really changes later, before.uidvalidity is null, the UIDs are not cleared, and the first resync page collides on mf_uid. The reset then fails on every attempt, which is the failure FR-31 was meant to remove.
- **Evidence:** commit.ts:383-392 (the guard needs a non-null before value; 'uidvalidity = excluded.uidvalidity' with no COALESCE, unlike sync_scope); store/port.ts:174-188 (FolderWrite.uidValidity?: number | null, absent is not documented as keep); ports/provider.ts:141 (FolderFacts.uidValidity?: number). A probe in a scratch copy of HEAD (folder(1) with uids, then folder() without uidValidity, then folder(7) plus a placement giving b uid 1) threw 'UNIQUE constraint failed: message_folders.folder_id, message_folders.uid'.
- **Suggested fix:** Treat absent as keep: 'uidvalidity = COALESCE(?, uidvalidity)' with an explicit null to clear, matching AccountWrite's patch rule. Document this on FolderWrite and add the probe case to uidvalidity.test.ts.

### R2G-2: The frozen srcdoc rule requires capabilities.mailFrame false, but the stand-in reports true

- **Severity:** gap · **Artifact:** F1/F6 (MailFrame.srcdoc rule vs stand-in capabilities)
- **Problem:** The FR-34 rule says the reader uses srcdoc only in an unpackaged build while Session.capabilities.mailFrame is false, and otherwise uses url. The stand-in reports mailFrame: true and also sends srcdoc. A ui-reader lane that follows the frozen rule will load aplos-mail://m/<token> against the stand-in, and nothing serves that protocol before eng-html, so the reader is blank. Otherwise the lane ignores the rule, so the rule is not what the code does today.
- **Evidence:** packages/contract/src/schemas/mail.ts:184-190 (rule); packages/contract-fixture/src/data/defaults.ts:200-203 (mailFrame: true); packages/contract-fixture/src/methods/mail.ts:226-234 (srcdoc and url both set); the conformance case suite.ts:893-903 checks srcdoc only against engine.standIn, never against the capability.
- **Suggested fix:** Make the stand-in report mailFrame: false (meaning the sealed protocol is not available), or key the rule on a dedicated capability such as 'mailProtocol'. Add a conformance assertion that srcdoc is present only when that capability is false.

### R2G-3: The correspondents table has no account column, so Contact/suggest's accountId filter and per-account purge are impossible

- **Severity:** gap · **Artifact:** F4 (schema 0001) / F1 Contact/suggest
- **Problem:** Contact/suggest (the FR-29 fix) takes accountId and is ranked 'by the correspondents table', but correspondents is keyed by address alone, with no account_id and no cascade. The real engine cannot filter suggestions by account, and Account/disconnect ('everything Aplos stored for it') and Demo/remove cannot delete that account's correspondents. Addresses learned from a removed account keep being suggested. Changing the primary key later needs a table rebuild migration.
- **Evidence:** packages/engine/src/store/migrations/0001_initial.ts:75-77 (address TEXT PRIMARY KEY, no account_id); packages/contract/src/api/compose.ts:49-58 (accountId input); api/account.ts Account/disconnect summary; the stand-in counts per account from messages (methods/compose.ts:289-310), so it hides the gap.
- **Suggested fix:** Before 0001 ships, change it to correspondents(account_id REFERENCES accounts ON DELETE CASCADE, address, ..., PRIMARY KEY(account_id, address)), and say in SCHEMA.md that a cross-account suggestion sums the rows.

### R2G-4: Event/hide has no store home: no column, no write kind and no reserved lane kind

- **Severity:** gap · **Artifact:** F4 (store) for F1 Event/hide
- **Problem:** The FR-21 fix adds Event/hide, Event.hidden and includeHidden, and ids may name single occurrences. The events table has no hidden column, unedited occurrences have no row at all, and no CoreWrite kind or LANE_WRITE_KINDS entry exists for it. This is the shape-collision risk FR-10 was about: whichever lane builds Event/hide will invent its own table.
- **Evidence:** packages/contract/src/api/compose.ts:137-144; packages/engine/src/store/migrations/0001_initial.ts:157-160 (events columns); packages/engine/src/store/port.ts:80-110 (CoreWrite) and :602-617 (LANE_WRITE_KINDS has no eventHide); grep finds no 'hidden' for events in store/port.ts or SCHEMA.md.
- **Suggested fix:** Reserve the write now, either a CoreWrite 'eventHidden' {accountId, eventId, hidden} or a lane kind with an owner, plus a table such as event_hidden(account_id, event_id) keyed by the contract Event id, so occurrences can be hidden without a provider row.

### R2G-5: ImageProxy doc names imagePolicy 'allow', which does not exist

- **Severity:** nit · **Artifact:** F3 (packages/engine/src/ports/content.ts)
- **Problem:** The proxy is documented as serving only tokens rendered with imagePolicy 'allow', but Mail/frame's enum is 'block' | 'load'. eng-html could check the wrong literal.
- **Evidence:** packages/engine/src/ports/content.ts:152; packages/contract/src/api/mail.ts:247 (choice(['block', 'load'])).
- **Suggested fix:** Say imagePolicy: 'load'.

### R2G-6: The draft-save precondition can report a conflict caused by Aplos's own write

- **Severity:** nit · **Artifact:** F3 (DraftSyncPort / saveDraft doc)
- **Problem:** Gmail drafts.update is idempotentWrite and creates a new message id. If the reply to a successful update is lost and the adapter re-runs its baseRemoteMessageId check on retry, it sees its own new copy as an edit made elsewhere and returns conflict. The owner then gets a needless 'keep mine or take theirs'.
- **Evidence:** packages/engine/src/ports/provider.ts:507-512 (precondition on baseRemoteMessageId), :620-630 (an in-place update is idempotentWrite and re-sent on transient), :502-503 (per-revision internetId).
- **Suggested fix:** State that a current remote copy whose Message-ID equals DraftUpload.internetId is Aplos's own save and resolves as saved, not conflict.

### R2G-7: The strict bundle accepts any string shaped like a code, including some API-key shapes

- **Severity:** nit · **Artifact:** F1 (StrictDiagnosticsBundle)
- **Problem:** The strict parse is the backstop for stored error columns the builder forgot to clean. logCodePattern allows up to 100 characters of [A-Za-z0-9_.:/+-], so a short key in a reason or code field passes, for example a Groq-style key of about 56 word characters. Free text is caught, but key-shaped text is not.
- **Evidence:** packages/contract/src/log/events.ts:20 (logCodePattern); packages/contract/src/schemas/session.ts:258-287 (BundleError fields use code); the redactor's key shapes (engine/src/diag/redact.ts:21-34) are not applied by the strict parse.
- **Suggested fix:** Also refuse strings that match the known key prefixes (sk-, gsk_, AIza, ya29., GOCSPX-, gh*_) in the strict parse, or cap code fields at the lengths real reason codes need.

## Host wiring, F8 and the access rule (fresh review)

The contract should not freeze yet: R2H-1 (test mode accepts the real app data directory) is a safety hole, and R2H-2 (the originating-scope check skips its check when an op has no stored scope, and ops.scope is nullable in schema 0001) can only be fixed cheaply before 0001 freezes. The F2 host wiring itself holds: preload, engine-host, native-methods and server.ts all derive from the generated legacy tables, the host-agreement and dispatch tests pass in a temp copy of the tree, and host methods never reach the renderer. Before tagging, settle the F8 release-gate conflict with plan 40 (R2H-4) and make checkAccess deny listeners anything outside listenerMethods (R2H-3); the preview token (R2H-6) can stay in Phase 1 lane contract-7.

### R2H-1: Test mode accepts the real app data directory (or /, or home) as APLOS_DATA_DIR

- **Severity:** blocker · **Artifact:** F8
- **Problem:** testMode() only checks that APLOS_DATA_DIR is set and absolute. It does not refuse the real Aplos Mail data directory, the preview directory, the home directory or /. Test mode also skips the single-instance lock, and the legacy engine has no data lock (ARCH 4.1's run/aplos.lock is Phase 1). So an agent that passes the owner's path gets a hidden second engine reading and writing the real local mailbox store, possibly while the real app is running on it. The F8 brief and the round-1 security checklist both require refusing such a directory.
- **Evidence:** apps/desktop/src/main/test-mode.ts:14-20 (only isAbsolute); engine-host.ts:162 (engine dataDir = APLOS_DATA_DIR); lifecycle.ts:47 (no lock under isTest). I ran testMode() in a temp copy of the tree: APLOS_TEST=1 with '/Users/owner/Library/Application Support/Aplos Mail', '.../Aplos Mail Preview', '/' and '/Users/owner' all return {enabled:true}. apps/desktop/tests/test-mode.test.ts:12-18 covers only unset or relative paths.
- **Suggested fix:** In testMode(), resolve the path with realpath and refuse it unless it sits under os.tmpdir() (or an explicit allowed test root) and is not the default userData, the preview dir, home or /. Refuse it if the directory already holds engine-key.bin from a non-test run. Add those cases to test-mode.test.ts.

### R2H-2: The originating-scope check fails open when an operation or queue item has no recorded scope

- **Severity:** blocker · **Artifact:** F1/F4 access rule
- **Problem:** requireScope(caller, undefined) returns without a check. Operation.scope, QueueItem.scope, OpWrite.scope and the ops.scope column are all optional or nullable. So any real-engine op written without a scope can be undone, retried or discarded by a listener holding only triage or admin, which is exactly the FR-3 hole. Such an op could come from a lane that forgets the field, from replay, or from an engine-internal write. The stand-in is safe today only because callScope is always set inside dispatch, and its seeded scenarios hold no ops. Making the column NOT NULL after 0001 freezes needs a table-rebuild migration, and making OpWrite.scope required is a breaking type change for lanes.
- **Evidence:** packages/contract/src/access.ts:69-71 (`if (scope && !caller.scopes.includes(scope))`); packages/contract/src/schemas/mail.ts:270 and session.ts:195 (scope optional); packages/engine/src/store/port.ts:401-402 (OpWrite.scope?: string); packages/engine/src/store/migrations/0001_initial.ts:105 (`scope TEXT` nullable); packages/contract-fixture/src/methods/mail.ts:387,420 and core.ts:307,335 (requireScope(cx.caller, rec.scope)).
- **Suggested fix:** Before the freeze, make OpWrite.scope required and ops.scope NOT NULL in 0001. Add a fail-closed check for scopeRule handlers (for example `requireOriginating(caller, scope)`) that refuses a listener when the scope is missing. Add a test that a triage listener cannot undo an op stored with no scope.

### R2H-3: checkAccess is allow-by-default for every name outside the engine table, including desktop secret methods

- **Severity:** gap · **Artifact:** F1 access rule (checkAccess)
- **Problem:** checkAccess returns early when methodScope has no entry or methodHost is not 'engine', and this happens before the listener branch. So a listener caller passes for desktop methods (Ai/pasteKey, which is secret, plus Shell/open and System/login), for unknown names, for Fixture/control and for prototype keys such as 'toString' (methodScope['toString'] is a function, so it counts as truthy). Today the engine's dispatch (hasOwnProperty on handlers) and the stand-in (isMethod) stop these names first. But the README presents checkAccess as the one default-deny rule every transport uses, and a Phase 1 listener or MCP adapter that relies on it alone would pass them.
- **Evidence:** packages/contract/src/access.ts:46-47 (early return) and :54-61 (listener branch after it). In a temp copy of the tree, checkAccess allowed a listener holding every scope to call Ai/pasteKey, Shell/open, System/login, 'Nope/nope', 'Fixture/control', '__proto__' and 'toString'. Guards that cover it today: packages/engine/src/methods/index.ts:109; packages/contract-fixture/src/engine.ts:706.
- **Suggested fix:** Use own-property lookups (Object.hasOwn). For a listener, refuse anything not in listenerMethods before the early return. Throw unsupported for any name that is not a registered engine method rather than returning. Add a listener-on-desktop-method case to access.test.ts.

### R2H-4: Test mode is gated only by environment variables and is honoured in packaged, signed release builds, contrary to plan 40

- **Severity:** gap · **Artifact:** F8
- **Problem:** Exactly what gates it: APLOS_TEST must equal the string '1' and APLOS_DATA_DIR must be an absolute path. There is no app.isPackaged check, no build-time define and no signature check, and updater.ts says on purpose that it applies 'even in a packaged, signed app'. Plan 40 section 6 says F8 is compiled in only under an APLOS_E2E define, and that verify-hardening launches a release with these variables set and requires normal behaviour. The engine thread instead proved F8 on the packaged release (verify-release, which also passes --remote-debugging-port). Phase 1 lanes plan packaged runs with APLOS_TEST=1 (phase1-lanes.md:549). The two plans conflict, and lanes will build on whichever wins. One side effect: a release build launched with APLOS_TEST=1 and no data dir exits with code 2 and shows no UI.
- **Evidence:** apps/desktop/src/main/test-mode.ts:14-24; apps/desktop/src/main/updater.ts:18-19; lifecycle.ts:29-33; plans/40-platform-quality.md:273 and :729; plans/engine/phase1-lanes.md:549; .freeze-round2/engine-answers.md last line; apps/desktop/scripts/build-main.mjs:13 (only OAuth defines, no APLOS_E2E).
- **Suggested fix:** Settle it before the freeze and record the decision in DECISIONS.md. Either add an APLOS_E2E esbuild define so a release build ignores both variables, with an E2E variant for verify-release, or amend plan 40 and verify-hardening to accept env-gated test mode in releases and say why.

### R2H-5: Two paths in test mode still open the system browser or a macOS permission prompt

- **Severity:** gap · **Artifact:** F8
- **Problem:** Test mode gates shell.open, window navigation and the native mic method, but two paths remain. (1) The engine's openExternal request, used by Google and Microsoft OAuth connect and reconnect, calls external() with no isTest check, so a hidden test that connects through prov-emu's emulated OAuth opens the real default browser and takes focus. (2) The session permission-request handler calls systemPreferences.askForMediaAccess('microphone') with no isTest check, so a renderer getUserMedia call (Voice) raises the macOS microphone permission dialog. Both break the headless, nothing-system-wide rule F8 promises. Separately, nothing automated proves the use-mock-keychain switch keeps safeStorage off the login keychain; it rests on the packaged verify-release run.
- **Evidence:** apps/desktop/src/main/engine-host.ts:97-101 (openExternal → external(args[0])); apps/desktop/src/main/security.ts:55-71 (askForMediaAccess in the permission handler); compare native-methods.ts:68 and :167, which are gated; lifecycle.ts:41 (use-mock-keychain) has no test.
- **Suggested fix:** Under isTest, have the engine's openExternal request record the URL (for an emulator to complete) and return without opening it. Make the permission handler answer false (or a test-configured value) without calling askForMediaAccess. Add a unit test that drives each path through injectable shell/systemPreferences stubs.

### R2H-6: The browser-preview server has no per-run token, accepts requests with no Origin, reflects CORS, and serves secret and UI-only legacy methods

- **Severity:** gap · **Artifact:** F2 (server.ts)
- **Problem:** isTrustedRequest checks Host exactly, but it accepts any request without an Origin header, and there is no token at all. So any local process that sets Host: 127.0.0.1:<port> can call ai.key.set, ai.key.delete, workflow.code, workflow.enable, account.connect and data.export on the preview's data. It also reflects the request Origin in Access-Control-Allow-Origin, while the contract README now says no CORS headers are ever reflected, every request carries a Bearer token and a Host mismatch answers 421. Plan 10 schedules the token for Phase 1 (contract-7), so this is not a freeze blocker, but the F2 'derive from the registry' wiring does not apply secret or uiOnly tags to the legacy names at all.
- **Evidence:** apps/desktop/src/main/server.ts:22-27 (`!req.headers.origin ||`), :76-79 (reflected ACAO), :127-130 (serves every legacyEngineMethods name); packages/contract/src/legacy-methods.ts:37-55 (ai.key.set, workflow.*, data.export tagged only 'engine'); apps/desktop/tests/desktop.test.ts:15 (asserts no-Origin is trusted); packages/contract/README.md HTTP rules; plans/10-engine-foundation.md:173; plans/engine/phase1-lanes.md:149-151.
- **Suggested fix:** Keep it in contract-7, but note it in GAPS.md now. Until then, refuse requests with no Origin on /api/invoke. Derive a legacy secret/uiOnly set from legacyCoverage (any legacy name that maps to a secret or uiOnly v1 method) and refuse those over HTTP, except where the preview really needs them; if it needs ai.key.set, say so in DECISIONS.md.

### R2H-7: principalOf puts every listener without a clientId into one shared principal

- **Severity:** gap · **Artifact:** F1 access rule (principalOf)
- **Problem:** principalOf returns `client:${caller.clientId ?? ''}`, so every listener caller that lacks a clientId shares the principal 'client:'. They can then read and release each other's blobs and frame tokens, which defeats FR-6's per-client binding. The engine's own dispatch test already builds listener callers without a clientId, which shows a transport can easily do the same.
- **Evidence:** packages/contract/src/access.ts:88-89; packages/contract/src/access.ts:23 (clientId optional); packages/engine/tests/methods.test.ts:95 and :106 (listener callers with no clientId).
- **Suggested fix:** Make principalOf (and checkAccess for listener callers) throw when kind is 'listener' and clientId is missing or empty, or make Caller a union where listener requires clientId. Fix the tests to pass a clientId.

### R2H-8: Fixture/control is reachable from any stand-in session, including a read-only listener

- **Severity:** nit · **Artifact:** F6 stand-in
- **Problem:** Fixture.call() handles the control method before dispatch and before checkAccess, whatever the session's caller. That is harmless in-process, but contract-7 plans to serve the stand-in through the preview's loopback HTTP host, where any client could script failures, connect outcomes and Ask answers. The session lookup also falls back to windowCaller (all scopes) for an unknown session id, which is fail-open.
- **Evidence:** packages/contract-fixture/src/engine.ts:749-752 (control before dispatch) and :715 (`?? windowCaller`). In a temp copy of the tree, a listener session holding only ['read'] got {ok:true} from Fixture/control while Data/export answered forbidden.
- **Suggested fix:** Refuse the control method unless the session's caller is a window or host (or a test-only flag set at createFixtureEngine). Throw instead of falling back to windowCaller.

### R2H-9: README says preload allows rendererMethods, but preload allows the legacy names; the typed client knows host methods

- **Severity:** nit · **Artifact:** F2 docs/client
- **Problem:** Preload, engine-host and native-methods correctly derive from the generated legacy tables (the host-agreement test passes), but the README describes the Phase 2 state as current. createClient's `known` set includes hostMethods (Mail/serve, Notification/claim), so the renderer client would send them and rely only on the engine to refuse.
- **Evidence:** packages/contract/README.md:66; apps/desktop/src/main/preload.ts:3-5 (legacyMethods); packages/contract/src/client/index.ts:40.
- **Suggested fix:** Reword README:66 to 'until Phase 2 preload allows legacyMethods; from Phase 2 rendererMethods'. Build `known` from rendererMethods so the client refuses host methods locally with unsupported.

### R2H-10: F8's listed Playwright base is not in the candidate

- **Severity:** nit · **Artifact:** F8
- **Problem:** FREEZE.md's F8 row names tests/e2e/playwright.config.ts as part of the artifact, but no Playwright config exists anywhere in the tree. Phase 1 lanes note that plat-ci owns it and use _electron.launch until it lands. The freeze checklist row should not be ticked as written.
- **Evidence:** plans/FREEZE.md:27; `find . -name 'playwright.config*'` (excluding node_modules) returns nothing; plans/engine/phase1-lanes.md:54.
- **Suggested fix:** Either land the pinned config with F8 or edit the FREEZE.md row to make the Playwright base a plat-ci Phase 1 item.
