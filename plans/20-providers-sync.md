# Workstream plan 20: Providers, sync and connectivity

Planning only, 2026-10-27, branch `revamp`. Nothing here is implemented and nothing from this phase goes to main without the owner. This plan executes `plans/ARCHITECTURE.md` (the binding decisions; cited as ARCH) for everything that talks to a mail or calendar provider. `plans/DESIGN.md` (cited as DESIGN) is binding only where a provider state reaches the screen.

**Conventions.** `RC/` means `research/email-clients/`. Evidence labels as in ARCH: **[V]** verified in a research report or Aplos file (path given); **[C]** a project's own claim; **[S]** secondary source; **[I]** inference; **[U]** unverified, to be settled by a named live experiment (§9). Where research and `plans/_council/CONTEXT.md` disagree, CONTEXT wins: Aplos releases are Developer ID signed and notarized; the repository is private; Google OAuth is in Testing mode; Microsoft has no client ID; the first real Gmail sync failed with 403. Defect ids `D1-D25` come from `RC/protocols/proto-google.md` §9; `M1-M10`, `I1-I10`, `J1-J7`, `C1-C4`, `X1-X3` from `RC/protocols/proto-others.md` §6. Milestones here are named **PV0-PV11** (PV1 splits into PV1a and PV1b) so they cannot be confused with ARCH's M0-M10, and plan 10's milestones are cited by their own names **E0-E8** (plan 10 §4.0 maps E to M); §4 maps all three. Other plans' references to "plan 20's M0" and "M3" mean PV0 and PV3.

## In plain English

This plan covers how Aplos talks to Gmail, Outlook, iCloud, Fastmail and calendars.

Today Aplos cannot finish a real Gmail sync. Google limits how much work an app can do per person per minute, and Aplos asks for about ten minutes of work at once. Google refuses and Aplos starts over. Calendars also redownload every ten minutes, and renaming a Google event can wipe its meeting link.

The plan has four stages. First, within about a week, update 0.2.4 makes Aplos count its own requests and wait instead of being refused. It shows subjects first and downloads message text only when you open a conversation. Second, a rebuilt Gmail connection shows your inbox in seconds and fills in the rest quietly. Third, iCloud and Fastmail get instant new-mail alerts, and calendars sync only what changed. Fourth, Outlook comes in but stays switched off until Microsoft is set up.

Google's review starts early because it takes weeks. It needs a privacy policy, a demo video and a paid security check.

You need to answer 7 questions below and finish a few outside tasks, such as registering a Microsoft app and creating test mailboxes. Nothing syncs while your Mac sleeps.

## Decisions for you

Defaults apply unless you say otherwise. Architecture decisions 1 to 3 (quick Gmail fix, Production mode, Gmail permission level) are assumed to use their defaults, so 0.2.4 starts now and you can veto it. This plan adds seven more. Answer 1 and 2 first, because they start slow outside processes.

1. **When do we start Google's review, and will you pay for the security check?** Start the brand check now and submit the full review once Gmail works well (about week 6), at roughly $540 to $4,500 a year for the check; never verify and stay "unverified"; or try for a local-only exemption first. **Default is the first.** The review runs while we build, so strangers can eventually install Aplos without a warning. Never verifying caps Aplos at 100 users. The exemption may cost weeks, because Google has insisted on the check even for local-only apps.
2. **Register the Microsoft app now, and for whom?** Register now for personal and work accounts, test with your own Outlook.com, and skip Microsoft's publisher check until you want other people's work accounts; register and also complete the publisher check; or wait. **Default is the first.** Outlook can be tested within a day. The publisher check is needed only for other people's company accounts. Waiting leaves Outlook untested and switched off.
3. **Which mailboxes may live checks use?** Throwaway test accounts for Gmail, Outlook.com, iCloud and Fastmail, plus read-only checks on your real ones that you run by hand; only your real accounts; or no live checks. **Default is the first.** Your real mailbox is never used in automatic cloud checks, and agents never send external mail. With only real accounts, a test that archives or labels runs on real mail. With no live checks, nothing is proven to work.
4. **Should Block and "skip Inbox" rules also be created inside Gmail?** Yes, with a visible label; ask per rule; or never. **Default is yes, for Block and skip-Inbox only.** They then keep working while your Mac sleeps. Never means they act only while Aplos runs. Answer before Google's review is submitted, because the permission that writes these rules is restricted and cannot change after submission.
5. **How should Unsubscribe work?** When the sender supports one-click, Aplos sends it from your Mac after you confirm, and otherwise emails the sender or opens their page; always open the page; or off. **Default is the first.** It is one keystroke instead of a web form.
6. **Which repeating-event edits ship first?** "This event only" and "all events", with "this and following" a release later; or all three at once. **Default is the first.** The third edit is where calendars most often corrupt events, so it gets its own tests and release.
7. **If the "download text only when opened" part of 0.2.4 takes more than two days, what ships?** A smaller first window of the newest 25 conversations with text already downloaded, plus the pacing and the daily-limit stop; hold 0.2.4 until the full version is done; or skip 0.2.4. **Default is the first.** Real Gmail works this week with a short inbox, and search reaches older mail. Holding delays the fix by days. Skipping delays real Gmail by about five weeks.

Outside tasks for you (not decisions). None block the 0.2.4 fix or the Gmail rebuild, but the Google ones wait longest, so do them early.

- Confirm the 6,000 units per minute limit in the Google Cloud console.
- Switch the Google project to Production (architecture decision 2).
- Set up a domain and privacy page for Google's brand check. The page exists at `apps/web/privacy`, but the Limited Use text must be added.
- Record an unlisted demo video.
- Register a Microsoft app.
- Create test mailboxes (decision 3).
- Request a Fastmail OAuth client before anyone else gets Aplos.

## 1. Scope and non-goals

**In scope** (ARCH §5, §6, §7.1, §7.4, §12.4, §12.5, M0, M3, M7, M8, plus the provider half of M6):
- The adapter port and every provider adapter: Gmail REST, Microsoft Graph, IMAP and SMTP (iCloud, Fastmail IMAP, Yahoo, AOL, generic), JMAP (Fastmail), CalDAV, Google Calendar and Graph calendar.
- The per-account governor, lanes, error taxonomy, account actors and persisted cooldowns (ARCH §4, §6).
- Provider-side writes: label and flag changes, drafts, send transports, filters and rules, List-Unsubscribe capture and execution.
- Calendar sync, a client-side recurrence module and RSVP.
- OAuth production readiness, granted-scope handling and the Google verification and CASA track.
- The provider emulators, the conformance fixtures, the fault-injection kit and the live-provider verification harness.
- The workflow-state transport over Gmail and IMAP (the hidden-label channel, with the D17/D18 fixes) and the primary-device lease protocol (ARCH §6.5, §13.1).

**Not in scope.**
- The store schema, change log, contract registry, transports, AI job queue and consent, the submissions state machine, timer loop, notifications, lifecycle and diagnostics. These are plan 10; we consume them through the port in §3.
- Any UI, copy or design. Plan 30 owns screens; we supply status codes, reasons and progress facts.
- CI wiring, signing, distribution and licence work (plan 40), except the emulator suites we hand to CI.
- Gmail over IMAP, the `mail.google.com` scope, Pub/Sub and any relay (ARCH §17). Proton beyond the Bridge note. Contacts sync (CardDAV, Graph contacts). JMAP Sieve and ManageSieve. Outlook IMAP as a doorbell (kept as a documented later option, §7 PV10). WebSocket JMAP unless the live session advertises it. `Email/queryChanges` (ARCH §17). The residue of C4: VTODO, alarms and free/busy (`freebusy-query` returns 400 on iCloud [S]). Server-side IMAP search beyond Inbox and Archive (I9's ESEARCH and LIST-STATUS) is a PV6 stretch item, not a gate.
- Any reference-project code, assets, branding or wording. GPL, AGPL and unlicensed reports (Mailspring, Nylas, Stalwart, Pimalaya) are idea sources only (`RC/SYNTH-architecture.md` §12.1).

> **What this means:** This plan owns everything between Aplos's engine and the outside providers, plus the practice providers and the Google paperwork. It does not own the database, the screens or the build pipeline.

## 2. Ground truth: what exists and what breaks

Aplos on main (`72095ff`) has the adapters in `apps/desktop/src/main/` (`google.ts` 425 lines, `microsoft.ts` 571, `imap.ts` 583, `imap-session.ts` 145, `imap-index.ts` 172, `jmap.ts` 539, `caldav.ts` 201, `ical.ts` 255) and a small original emulator for Google and Microsoft in `apps/desktop/scripts/emulation/` (154 lines, used by `tests/emulation.test.ts`). `engine/gate.ts` (39 lines) is the only scheduler. The tests `microsoft`, `imap`, `imap-session`, `jmap`, `caldav` and `sync-safety` run today and must stay green until each adapter is replaced behind the same behaviour. The one exception is `tests/integrations.test.ts:190` ("Google rate limits sent as 403 are retried"), which asserts the PR #23 behaviour that PV0 deliberately reverses and is inverted there.

Defect map. Every defect has an owning milestone and a named regression test (§5 rule 1).

| Defects | What breaks (evidence) | Fixed in |
|---|---|---|
| D1, D2, D3, D13, D14, D16 | First sync never finishes; search costs about 12,000 units a pause; a 2,000-thread archive in Gmail web costs about 240,000 units; label-only changes cost 40 units (`RC/protocols/proto-google.md` §1.2, §9) | PV0 (paced metadata window, search on Enter, the INBOX-gain rule and a per-run cap for D3), PV3 (full fix: per-message labels at zero fetch, D13/D14) |
| D4, D5, D6, D21, D25 | `invalid_grant` shown as a retryable 400; granted scopes ignored; error classes conflated (including `quotaExceeded` retried 5 times, `google.ts:110`); every connect forces consent; `sub` unchecked | PV0 (D4, D5, D6 minimal: throttle, daily and reauth classes), PV2 (full taxonomy), PV3 (D21, D25), PV5 |
| D7, D20 | Sends retried on the daily send limit; large sends through JSON under 45 s | PV0 (never retry a send, D7), PV4 (upload send, D20; the never-retry rule moves into the governor in PV2) |
| D8, D9, D10 | One trashed reply trashes the thread; drafts render as messages; `reset:true` ignored | PV3 |
| D11, D12, D24 | Event save wipes Meet links and RSVPs; calendars re-pulled every 10 minutes; `hidden`/`selected` ignored | PV9 |
| D15, D17, D18, D19, D22, D23 | Serial part fetches; workflow rounds full-fetch every copy; no `fields` masks or gzip; snippet entities; no abort on close | PV3 (all six; the workflow channel D17/D18 moved here from PV4 because the lease rides it) |
| M1, M4, M5, M10 | Graph runs about 12 in flight against 4; no checkpoints; full bodies at sync; `response_mode=query` and a one-JSON-key index | PV10 |
| M2 | Filtered delta likely hides older mail moved back in | PV10 (after live experiment EX4) |
| M3, M6, M7, M9 | Five folders only; auth reasons discarded; 3 MB send cap; no drafts, rules or List-Unsubscribe | PV10 |
| M8 | Graph calendar re-read in full every time | PV9 (needs PV10's Graph auth for live parts) |
| I1, I2, I3, I4, I5, I8 | One serialized IMAP connection; whole `BODY[]` at sync; unbounded catch-up; O(n) expunge scans; false deletions under `MESSAGELIMIT`; Yahoo IDLE omits expunges (a periodic CONDSTORE resync runs even with IDLE) | PV6 |
| I6, I7, I9, I10 | No OAuth login; iCloud username copy; no drafts, `\Answered`, List-Unsubscribe; imapflow 2.4.3 | PV6 |
| J1-J7 | No JMAP push; heavy first sync; limits ignored; token-only auth; drafts hidden | PV7 |
| C1, C2, C3, C4 | No CalDAV sync token; server-side recurrence; credentials leak across redirects; no RSVP (VTODO, alarms, free/busy stay out of scope) | PV8, PV9 |
| X1, X2, X3 | Gate ignores `Retry-After`; accounts sync serially; no shared scheduler | PV2 |

**One amendment to ARCH §5.1 (A1), now recorded in ARCH as amendment AM-1 (2026-10-27; not ARCH's A1, the LaunchAgent) and going into DECISIONS.md at E2a.** ARCH says opening a thread uses `threads.get?format=full` (120 units) when the thread has two or more messages, else `messages.get?format=full` (60). The engine cannot know the count. Rows built in P1 come from the newest message only; `messages.list` and `threads.list` carry no count; a `messages.get` metadata reply has none. Learning it costs a 40-unit `threads.get` minimal.
- *Arithmetic.* Probe-then-fetch costs 40 + 60 = 100 for a single-message thread (saves 20 against 120) and 40 + 120 = 160 for a conversation (loses 40). Always fetching the thread costs 120 either way. A free guess from `In-Reply-To` and `References` is unsafe: a newest message without them can still have older siblings, and a wrong guess shows a conversation with messages missing.
- *Rule (A1).* Opening a thread, and body prefetch, use `threads.get?format=full` (120). `messages.get?format=full` (60) is used only when the engine already knows the thread has exactly one message, for example one created by a `messagesAdded` history record whose thread was unknown. This keeps ARCH's intent (the cheapest correct open) without a guess. The prefetch cap (at most 20% of target) is priced at 120 per thread, so 100 prefetched threads take about 10 minutes of that lane.
- *Why not honour the ARCH wording.* It is not implementable without a paid count lookup that loses on conversations. PV3 therefore treats ARCH §5.1's "two or more messages" sentence as superseded by A1; nothing else in §5.1 changes.

> **What this means:** Every known provider bug has a home milestone and a test that proves it fixed. Aplos's own early test providers exist but are too small to catch the bugs, so they are rebuilt first.

## 3. Shape of the work: modules, the adapter port, error mapping

### 3.1 Module layout and ownership

ARCH ADR-19 names three packages (`contract`, `engine`, `mail-html`); plan 10 §3 adds `contract-fixture` and the test-only `packages/emulators`, recorded as an ADR-19 amendment in ARCH on 2026-10-27. **Adapters live in the app, at `apps/desktop/src/host/providers/<name>/`** (plan 10 §3, settled): they need Node (`imapflow`, `nodemailer`, `net`), their dependencies stay in `apps/desktop/package.json` (the only manifest electron-builder reads), and keeping them out of `packages/engine` leaves the neutral core's 400,000-byte budget and its no-`node:` portability rule untouched, with no path exception. The **neutral** parts of this plan (account actors, governor, lanes, status, lease, and the pure recurrence module) live in `packages/engine/src/sync/**` and `packages/engine/src/calendar/**` and reach adapters only through the ports in `packages/engine/src/ports.ts`. Promotion of the adapters to a `packages/providers` workspace is a later mechanical move, allowed only when a second consumer needs them (plan 10 §3).

| Path | Contents | Owner |
|---|---|---|
| `apps/desktop/src/host/providers/{google,microsoft,jmap,caldav}/` | Fetch-only adapters, one folder each. They import nothing from `electron` (so they could later move to a shared package) and are reached by the engine only through `ProviderAdapter` | Plan 20 |
| `apps/desktop/src/host/providers/imap/` | IMAP and SMTP adapters (Node sockets) | Plan 20 |
| `apps/desktop/src/host/providers/shared/` | HTTP client with no retries and abortable I/O, `Retry-After` parser (seconds and HTTP-date), classifier base, MIME/header helpers, redirect policy | Plan 20 |
| `packages/engine/src/sync/` | Account actors, governor, lanes, status, lease | Plan 20 (tables and store API: plan 10) |
| `packages/engine/src/calendar/recurrence/` | The client-side recurrence module (ARCH §5.5, ADR-20) | Plan 20 |
| `packages/emulators/` (test-support workspace; never bundled into the app) | Provider emulators, fault kit, fake clock, scenario runner. Consumed by plan 10's E6 and E8 and plan 40's E2E job as `@aplos/emulators` in tests only | Plan 20 |
| `apps/desktop/scripts/live/` | The live-provider runner (§5.4), implementing plan 40's `SmokeProbe` for tier R | Plan 20 |
| `apps/desktop/src/main/{google,microsoft,imap,imap-session,imap-index,jmap,caldav,ical}.ts`, `apps/desktop/scripts/emulation/` | Today's files. Stay in place and keep working until each adapter is replaced; moved by `git mv` into `apps/desktop/src/host/providers/` in the PR that makes the replacement pass the old tests, then deleted | Plan 20 |
| `apps/desktop/src/main/{oauth-config,vault}.ts`, `workflow-sync.ts`, `workflow-crypto.ts` | OAuth client resolution and the workflow transport | Plan 20 touches; plan 10 owns the vault |

Plan 10 §3 and §7.1 carry the same paths, so no further layout edit is needed in either plan.

### 3.2 The adapter port (what plan 10 and plan 20 both build against)

Adapters never loop on `fetch`, never retry, never write the database, and never decide pacing. Everything goes through `ctx.governor.run` (ARCH §6.1). Sketch, not final syntax:

```ts
interface ProviderAdapter {
  kind: 'google' | 'microsoft' | 'imap' | 'jmap'
  connect(req: ConnectRequest, ctx): Promise<{identity, grantedScopes, capabilities}>
  // One bounded step per call. The actor commits the result with its resume token in ONE store transaction.
  syncStep(acct, scope: SyncScope, state: SyncState, lane: Lane, ctx): Promise<StepResult>
  fetchBody(acct, ref, lane, ctx): Promise<ProviderBody>          // provider-original form, ARCH §3.3
  apply(acct, ops: CoalescedOps, ctx): Promise<OpOutcome[]>       // idempotent writes only
  saveDraft?(acct, draft, ctx) / send(acct, submission, ctx)      // send: no retry, marker already committed
  findSent?(acct, messageId, ctx): Promise<SentRef | undefined>   // settles an `uncertain` send
  search?(acct, query, ctx): Promise<ThreadRef[]>                 // server search, on Enter only
  watch?(acct, ctx): AsyncIterable<Hint>                          // data-free push hint: IDLE, EventSource
  calendar?: CalendarAdapter                                      // list, syncStep, put, delete, rsvp
}
StepResult = { upserts, labelDeltas, placements, removals?, nextState, done, scopeCovered, costUnits }
```

`scopeCovered` is what makes deletion inference legal: the actor sweeps only items inside a scope whose round completed (ARCH §4.2 rule 3). `costUnits` feeds the governor and the diagnostics bundle. `Hint` never carries data (ARCH §4.2 rule 8). Capabilities come from the grant and from server `CAPABILITY`, never from names (ARCH §5.1, `RC/SYNTH-architecture.md` §3.5).

**Relation to plan 10's ports** (`packages/engine/src/ports.ts`, plan 10 §7.1). `ProviderAdapter` is in plan 10's ports table and is frozen with C1 at the end of E1. Plan 10's `SendPort.send`/`findSent` and `DraftSyncPort` are the engine-side callers of `ProviderAdapter.send`, `saveDraft` and a `findSent(acct, messageId)` method that this sketch adds. `GovernorPort` and `AccountActorHost` are implemented in `packages/engine/src/sync/`. Until PV2 merges, adapters run behind a pass-through `GovernorPort` stub, so PV3 can start before the real governor exists.

### 3.3 Error mapping

Each adapter owns a classifier that returns `{class, reason, code, retryAfterMs?, providerMessage}`; the classes and actions are ARCH §6.3. The adapter-specific inputs:

| Provider | Reads | Notes |
|---|---|---|
| Gmail | HTTP status, `error.errors[0].reason`, **and message text** | The per-minute refusal can say only `rateLimitExceeded` (`RC/SYNTH-architecture.md` §0.9). 429 with "Too many concurrent requests" is `throttle` with in-flight 1. "Mail sending" is `send_limit`. Parse `Retry-After` in both formats (D6) |
| Google Calendar | 403 `rateLimitExceeded`/`userRateLimitExceeded` vs `quotaExceeded` | The first two are `throttle`; `quotaExceeded` is `anti_abuse` (hours). 410 is a one-calendar resync. 412 `conditionNotMet` is an edit conflict |
| Token endpoints | `error`, `error_description`, AADSTS code | `invalid_grant`, `admin_policy_enforced`, `interaction_required`, consent-required map to `needsReauth`, `needsAdmin` or `needsPermission`. 408/429/5xx at the token endpoint are `transient`; keep the refresh token on network failure |
| Graph | Status, `Retry-After`, per-sub-response status inside a 200 `$batch` | A 200 batch says nothing about sub-requests (`RC/protocols/proto-others.md` §1.3) |
| IMAP | `NO`/`BAD` text, `[AUTHENTICATIONFAILED]`, `ETHROTTLE`, Office 365 "Request is throttled", `[MESSAGELIMIT n lastUID]` | `MESSAGELIMIT` is "partial", never "absent" |
| JMAP | HTTP 429, `Retry-After`, `rateLimit` SetError, `cannotCalculateChanges` | The last one is a resync, not an error |
| CalDAV | 401/403/404/412/507, `DAV:valid-sync-token` precondition | 507 on sync-collection means page; invalid token means empty-token resync, keeping unchanged ETags |

> **What this means:** One narrow door connects every provider to the engine. Adapters only talk to the provider; the budget keeper decides when, and the engine decides what to save. That is what makes each provider testable alone.

## 4. Milestones

Order, weeks, dependencies and effort are in one table; each milestone then follows in the fixed format of the brief. Weeks count from the start of the revamp branch, nominal; live verification, not coding, is the constraint (ARCH §15). **Plan 10's milestones are named E0-E8** (plan 10 §4.0); the "Needs from plan 10" column uses those names. Where ARCH's M-number differs it is in the ARCH column (E3 and E4 are both ARCH M4; E7 is M9; E8 is M10).

| PV | Name | ARCH | Needs from plan 10 | Weeks | Agent-days | Gate |
|---|---|---|---|---|---|---|
| PV0 | Gmail made real (0.2.4) | M0 | E0's `Logger` interface only (E0 joins the 0.2.4 train if ready; a redacted stub stands in otherwise; PV0 never waits) | 0-1 | 5-7 | Real first sync completes, paced |
| PV1a | Gmail emulator, kit, port, harness skeleton | new | **E1** (packages, `ports.ts`, status types, freeze C1) | 1-3 | 8 | Emulator reproduces 0.2.3's Gmail failure |
| PV1b | IMAP, Graph, JMAP and DAV fakes, conformance tier | new | E1 | 3-8, each just before its consumer | 8 | Each fake reproduces its adapter's field failure |
| PV2 | Governor, actors, error taxonomy | M3a | **E1** (`AccountActorHost`, heartbeat supervisor), **E2** (`governor_state`, `sync_state`) | 3-5 | 7-8 | Fake-clock suite green |
| PV3 | Gmail connector, lease and workflow channel | M3b | **E2** (`message_folders`, `thread_folders`, change log, replay API, `store.commit`); E5's `baseline_done_at` consumer is a stub until here | 3-6 (starts on a stub governor) | 15-17 | **Gmail daily-driver gate** (live) |
| PV4 | Gmail write side: drafts, filters, unsubscribe | M6 part | **E6** (`submissions`, drafts table, `DraftSyncPort`, `SendPort`), **E4** (image-proxy address rules for one-click unsubscribe) | 6-8 | 7-8 | Live draft round trip |
| PV5 | OAuth readiness, Google verification and CASA track | §12.5 | **E4** (isolation test results as evidence); plan 40 site and CI | 0-26 elapsed, 3 engineering | 15 | Submission accepted for review |
| PV6 | IMAP, iCloud, Yahoo, generic | M7a | **E2** (placements, per-folder `sync_state`), **E6** (Drafts) | 6-9 | 12-13 | iCloud live pass |
| PV7 | JMAP and Fastmail | M7b | **E2**, **E6** | 7-9 | 7-8 | Fastmail live pass; with PV6 this is ARCH M7's **multi-provider daily-driver gate** |
| PV8 | Recurrence module and CalDAV | M7c | **E2** (`calendars`, `events`) | 7-9 | 10 | Golden corpus green |
| PV9 | Google Calendar, Graph calendar and RSVP | M8a | **E2**; PV8 | 8-10 | 10 | Live edit keeps Meet link |
| PV10 | Microsoft Graph mail (dark) | M8b | **E2**, **E6** (drafts) | 8-10 | 10 | Emulator proof; live when the client id exists |
| PV11 | Hardening and the final provider gate | M10 | **E8** (soak harness, fault injection, shim removal) | 10-12 | 5 | All defect tests pass; soak clean |

**Capacity, honestly.** The column sums to about 120-127 agent-days, on the Providers & Sync thread (ARCH's S thread), which also owns plan 10's E2a (5-6 days, weeks 1.5-3; `plans/00-roadmap.md` §2). It is feasible only because PV6, PV7, PV8, PV9 and PV10 fan out into parallel workflows on disjoint folders in weeks 6-10, and the owner's review and the live passes (Gmail, iCloud, Fastmail, later Outlook) then become the limit. The critical path is PV0, PV1a, PV2 and PV3's live gate. ARCH's "Gmail daily-driver about week 5" holds only if the workflow-channel and lease work packages of PV3 run on a second agent; otherwise it is week 6. **Cut order if the schedule slips:** PV10 live parts (dark anyway), PV9's Graph calendar, "this and following" edits (Decision 6), PV4's filters and unsubscribe, then PV7's WebSocket path. Nothing in PV0-PV3 is cut.

PV3 and PV6 are the long poles. PV3 starts in week 3 against a pass-through governor stub and plugs in PV2's governor when it merges (end of week 5 at the latest, earlier if PV2's first work package lands).

### PV0: Gmail made real (0.2.4)

**Goal.** A real Gmail account finishes a first sync under the 6,000-unit quota, shows subjects first, downloads message text only when a thread is opened, stops instead of hammering when Google refuses, and records the exact refusal. Old data model only (ARCH §15 M0, Decision 1). It is small by construction: one adapter, the gate, and a few engine lines. It must build, test and release from `main` without anything else from the revamp. It owns the one `hotfix/0.2.4` branch (§9); E0 and the other small main-bound slices join it only if they are ready.

**Why the first 0.2.3 sync fails, in one paragraph** (`RC/protocols/proto-google.md` §1.2, §9 D1). 500 `threads.get?format=full` at 120 units is about 60,000 units; four workers spend 6,000 in 5-10 s; each request then retries for about 31 s, the window needs about 50 s to free budget, one thread runs out of retries, `Promise.all` rejects, nothing is committed, and the gate starts over 30 s later. PR #23's retry (`google.ts:110-133`) cannot help and is itself wrong in one respect: it lists `quotaExceeded` among the retryable rate reasons, but that reason means a quota that will not clear in seconds.

**Deliverables.**
1. **Unit pacer** inside `google.ts` (about 60 lines; PV2's governor replaces it and reuses its cost table). One `GMAIL_COSTS` table priced from `RC/protocols/proto-google.md` §1.1 (`getProfile`/`labels.list` 1, `history.list` 2, `messages.list` 5, `threads.list` 10, `messages.get` 20 metadata or 60 full, `threads.get` 40 metadata or 120 full, `messages.attachments.get` 20, `threads.modify` 10, `messages.modify` 5, `messages.batchModify` 50, `messages.insert` 25, `messages.send` 100). A sliding 60-second log per account with a target of **3,000 units per minute** (50%, because other Macs and any older build share the quota, ARCH §6.5), one request in flight, and a priority for the interactive open. Every `api()` call waits for budget and never sends past it, workflow rounds and sends included.
2. **Classification and pause (D1, D4, D6, D7).** The 5-try loop and `RATE_REASONS` regex are replaced by four classes. Classification reads status, reason and message text, because the per-minute refusal can carry only `rateLimitExceeded`.

   | Class | Matches | Action |
   |---|---|---|
   | throttle | 429 or 403 `rateLimitExceeded`, `userRateLimitExceeded`, `RATE_LIMIT_EXCEEDED`, `RESOURCE_EXHAUSTED`, `concurrentLimitExceeded`, 429 "Too many concurrent requests" | Pause this account's Google calls for `Retry-After` (seconds and HTTP-date, no 30 s cap), else 60 s, then 5 min, then up to 1 h; reset after 10 quiet minutes; halve the pacer target (floor 1,000), regrow 250 per minute after 10 quiet minutes. The failing request is not retried inside the adapter; it throws a `GoogleError` carrying `retryAfterMs` |
   | daily | 403 `dailyLimitExceeded`, **`quotaExceeded`** (removed from the retry regex), bandwidth caps | **Stop and surface, never retry.** The account's Google calls stop until the next midnight Pacific [C] (Calendar `quotaExceeded`, which is an anti-abuse limit: 3 hours); the error shows Google's own reason and the resume time |
   | send limit | 429 with "Mail sending" text, on any send | Never retried; the message stays failed with "until HH:MM" (D7) |
   | reauth | token endpoint `invalid_grant` or `admin_policy_enforced`; a 401 that persists after one forced refresh | `connected:false` with a reason; sync and op flush stop for that account; Reconnect is shown (D4) |

   While a pause or stop is active, `api()` throws at once without a network request, so no call can leak out of it. The pause state lives in memory in 0.2.4 (a restart forgets it and costs at most one request before the stop is re-learned); `governor_state` persistence arrives with PV2. 5xx and timeouts keep today's behaviour until PV2.
3. **Gate and engine honour it (X1, minimal).** `gate.ts` uses the error's `retryAfterMs` for its `retryAt` (never earlier than its own backoff), and `ready(key, manual)` refuses manual runs while a stop is active; today `manual` returns true during backoff (`gate.ts`), so the Sync button bypasses any pause. `service.ts` sets `connected:false` on a reauth error, and the sync error copy changes from "Reconnect the account or try again" (`service.ts:678`) to a paused-until sentence for throttle and daily.
4. **Metadata-first window (D1, D16).** The first window lists Inbox only (no `includeSpamTrash`), newest 50 threads, then `threads.get?format=metadata` with the From, To, Cc, Subject, Date, Message-ID, List-Unsubscribe headers and a `fields` mask (40 units each, about 2,000 units, one request in flight). Messages carry the snippet as `text` plus a new optional `Message.partial: true`. A **per-run memo** keeps fetched threads across a pause and across `StaleSync` re-runs (`service.ts:584-586` re-runs `provider.sync` up to three times), so a retry does not re-spend the window.
5. **Lazy bodies.** The old model has no open-thread hook (`MailProvider` has no body fetch; `Message.text` is required). Add the optional `MailProvider.openThread(account, remoteId)`, which runs `threads.get?format=full` (120 units, interactive priority, resolving body-part attachments as `fullThread` does today), and an engine method `thread.open {id}` that replaces the thread's messages while keeping workflow fields and emits the usual change. The method is added to the three hand-kept allowlists (`preload.ts:8`, `electron.ts:20`, `server.ts:15`); the Reader calls it when a selected thread has a partial message and shows the snippet meanwhile. Summaries, Ask context and AI jobs skip a thread with a partial message until it is opened (one guard in the engine), so the model is never given snippets as if they were mail. No schema change: the field is optional JSON, and a 0.2.3 build reading such a thread shows snippet text.
6. **Incremental sync stays cheap (D3, minimal).** In `history()`, an unknown thread is fetched only when a `labelsAdded` record for it includes `INBOX` (history records carry `labelIds`); added or changed threads are fetched as metadata, not full; known label-only changes keep `format=minimal` (40). If a single history pass would need more than 150 thread fetches it takes the existing fresh-window path instead, which bounds the cost. Full per-message labels at zero fetch (D13, D14) wait for PV3.
7. **Search on Enter only (D2).** The engine `search` payload gains `server: boolean`; the debounce at `App.tsx:179` runs the local search only, and Enter sends `server: true`, which runs `messages.list?q=` for 10 results and then metadata (about 210 units).
8. **Granted scopes (D5).** The token response's `scope` is stored on the account (optional `grantedScopes`); connect is refused without `gmail.modify` in a plain sentence; Calendar and settings capability follow the grant instead of `calendarConnected:true`.
9. **Log.** Google's exact status, reason, message (truncated to 300 characters), method, units, pacer wait and pause class go through plan 10's E0 `Logger` (redacted allowlist, 10 MB x 5 rotation); no bodies, subjects, addresses or tokens.

**Owns/touches.** `apps/desktop/src/main/google.ts`; `src/engine/{gate,provider,service}.ts`; `src/shared/types.ts` (two optional fields); the three allowlists; `renderer/App.tsx` (the search call) and one Reader call (plan 30's optional `srcdoc` slice also changes `Reader.tsx`, so §9 fixes the merge order); `tests/integrations.test.ts` (the retry test at line 190 is inverted), `tests/emulation.test.ts`, `scripts/emulation/providers.ts` (extended).

**Depends on.** Nothing it waits for. PV0 codes against plan 10 E0's `Logger` interface; if E0 has not merged into `hotfix/0.2.4` when PV0 is ready, PV0 binds that interface to a minimal redacted stub (status, reason, units, pause class, no content) and E0 follows in a later patch or only on `revamp`. It does not wait for E1 or anything later. Owner actions: confirm 6,000 units per minute in the Cloud console, and the Production-mode decision. Main, with 0.2.4, is merged into `revamp` at step 0 of plan 10's freeze window, before plan 30's U0 starts.

**Acceptance (live, the owner's account, run locally and by hand; never in CI; mocked Google never counts).**
- A real first sync completes with the first rows visible within 45 s, zero refusals in the log, and the logged units-per-minute series never above 3,000.
- Opening a thread shows its text (the log shows one `threads.get` full); a typed search makes zero Google calls until Enter (spy test).
- The log shows the reason of any refusal, which settles experiments EX1 and EX2 (§5.5).
- Emulator (the old one, extended to refuse above 6,000 units per minute and to return message-only `rateLimitExceeded`, `quotaExceeded`, `dailyLimitExceeded`, a concurrency 429 and "Mail sending"): a 500-thread mailbox syncs its window with zero refusals; `quotaExceeded` produces one request and then a stop until the stated time; a send is never retried; `invalid_grant` ends in `connected:false` with no further calls; a manual sync during a pause makes zero requests; a `StaleSync` re-run costs under 100 units; 2,000 threads relabelled elsewhere cost under 2,500 units.
- If the old model cannot hold a metadata window with lazy bodies within two days of work, ship the fallback of Decision 7 (25 threads with text, about 3,000 units, paced) and record that in PROGRESS.md; PV3 supersedes either.

**Branch.** The one plan 20 work that targets main: the 0.2.4 release train of §9. Only the owner merges and releases.
**Work packages.** Fan out four agents: (A) pacer, classes and gate; (B) metadata window, memo, history rule, `openThread`/`thread.open`, allowlists and the Reader call; (C) reauth, scope check, search on Enter and the test inversion; (D) E0 call sites and the emulator extension. Verify adversarially: a reviewer with the emulator and only Google's documents tries to produce a run that retries a send, runs two requests in flight, exceeds 3,000 units in 60 s, retries after `quotaExceeded`, loops on `invalid_grant`, sends a request during a pause, or gets past a pause with repeated manual syncs.
**Estimate.** 5-7 days plus one live check (the lazy-body hook and the pacer are the difference from a bare retry fix).

### PV1a: Gmail emulator, kit, port and harness skeleton

**Goal.** A fake Gmail that fails the way the real one does, a port to build against, and a live harness skeleton: everything PV2 and PV3 need, nothing they do not. The proof of faithfulness is that the unmodified 0.2.3 Gmail adapter fails on it exactly as it fails in the field. PV0 extends the old emulator by hand for its own tests; PV1a replaces that emulator with the faithful one.
**Deliverables.**
1. **Gmail emulator** (`packages/emulators/gmail`). A sliding-window 6,000-unit per-user meter with the §1.1 price table (`RC/protocols/proto-google.md` §1.1); a configurable concurrency cap answering 429 "Too many concurrent requests for user"; `fields` masks honoured; the batch endpoint with a 100-call cap and a refusal curve of 0% at 10, 1.2% at 25, 19% at 50 calls [C, `RC/SYNTH-architecture.md` §3.2]; `history.list` with non-contiguous ids, per-record label ids and 404 on expiry; drafts, filters, `messages.send` with the "Mail sending" 429; `dailyLimitExceeded`; message-only `rateLimitExceeded` and `Retry-After` in both formats; a switch that makes `messages.get` cost 5 (grandfathered project).
2. **Kit.** Fake clock (so 60 s, 5 min and 1 h backoffs run in milliseconds), fault injector (drop connection mid-page, 403/429 storm, corrupt page, kill the engine process between two named points), and a scenario runner with `db_matches_server` and invariant checks after each scenario (`RC/arch/mailspring.md` line 277).
3. **Port.** §3.2 types, the classifier base and the status vocabulary, agreed with plan 10 (ARCH §6.4).
4. **Live harness skeleton** (§5.4), implementing plan 40's `SmokeProbe` interface for tier R.
**Owns/touches.** `packages/emulators/**` (Gmail emulator, kit), `apps/desktop/src/host/providers/shared/**`, `packages/engine/src/ports.ts` additions by contract PR with plan 10, `apps/desktop/scripts/live/**`; replaces the Gmail half of `scripts/emulation/`; one-line additions to `package.json` workspaces (the `packages/emulators` workspace).
**Depends on.** Plan 10 **E1**: the `packages/engine` move and `ports.ts` (days 1-2 of E1), the status types and the contract freeze C1 (end of E1, week 2). Work before the move lands on `apps/desktop/src/engine` paths and moves with the rename commit. Plan 40: a Linux CI job is needed only by PV1b.
**Acceptance.**
- The 0.2.3 `google.ts` run against the Gmail emulator never completes a 500-thread first sync and logs the D1 sequence; the committed test asserts the old failure and is inverted when PV3's fix lands. PV0's adapter completes it (the same emulator proves PV0).
- A seven-scenario smoke runs in under 60 s with the fake clock.
- The port and status vocabulary are reviewed by plan 10's owner and frozen with C1.
**Work packages.** Fan out one agent for the Gmail emulator, one for the kit, one for the port and harness skeleton. Verify adversarially: a separate agent, given only the vendor docs and not the emulator, writes ten "this must be refused" requests and runs them; any request the emulator accepts is a fidelity bug.
**Estimate.** 8 agent-days over about 2 weeks (1 day of review).

### PV1b: IMAP, Graph, JMAP and DAV fakes and the conformance tier

**Goal.** The other providers' practice servers, each delivered just before the milestone that needs it (Graph before PV10, IMAP before PV6, JMAP and DAV before PV7 and PV8), so they are not on PV3's path. Each reproduces its 0.2.3 adapter's field failure first.
**Deliverables.**
1. **IMAP fixture server** (own implementation) with **personalities**, each quirk citing its source: `icloud` (no QRESYNC, `UID FETCH n:*` returns nothing above max UID, folder names Sent Messages and Deleted Messages, a connection cap of about 5 [S], no Sent copy on SMTP), `yahoo` (`MESSAGELIMIT` 1000, IDLE without expunges, limited mode), `exchange` (no CONDSTORE, "Request is throttled", late Sent copy), `dovecot` (full QRESYNC), `drops-idle` (kills IDLE sockets on a schedule). Pattern from Mailspring's scriptable fake with 14 personalities (`RC/arch/mailspring.md` §testing, line 236) [V], implemented from scratch.
2. **Graph emulator.** 4 in flight per mailbox and 10,000 per 10 minutes; `$batch` of 20 with per-sub-request 429 inside a 200; `Retry-After`; per-folder delta with `nextLink`/`deltaLink`, immutable ids, 410 `syncStateNotFound`, rotating refresh tokens, AADSTS errors, and a **toggle for the unverified behaviour** that filter options are baked into the `deltaLink` (M2).
3. **JMAP, CalDAV and conformance tier.** A minimal JMAP and CalDAV fake for unit tests, plus **Docker scripts for real servers on Linux CI only**: Dovecot (IMAP4rev2), Stalwart (IMAP, JMAP with EventSource, CalDAV) and Radicale (CalDAV), run strictly outside the shipped app because Stalwart is AGPL (`RC/arch/stalwart.md` line 279, `RC/arch/emailengine.md` line 229, `RC/arch/pimalaya.md` line 211) [V]. A **conformance suite** runs the same scenarios against fake and real server and fails when they disagree.

**Owns/touches.** `packages/emulators/**`, CI Docker scripts (plan 40 runs them).
**Depends on.** PV1a (kit and port); plan 10 E1; plan 40 for a Linux Docker job (macOS runners cannot run Docker [I]).
**Acceptance.**
- The 0.2.3 `microsoft.ts` against the Graph emulator fails the whole sync on one sub-request 429 (M1); the 0.2.3 IMAP adapter blocks an archive behind a first sync (I1); the 0.2.3 JMAP adapter fetches bodies for 500 threads (J3); the 0.2.3 CalDAV adapter sends a full expanded query per calendar every poll (C1). Each is a committed test that asserts the old failure, to be inverted when its fix lands.
- Conformance suite passes against Dovecot for every IMAP personality scenario that Dovecot can express.
**Work packages.** One agent per fake (IMAP, Graph, JMAP/DAV) plus one for the conformance tier. Verify adversarially as in PV1a.
**Estimate.** 8 agent-days spread across weeks 3-8.

### PV2: Governor, actors and error taxonomy

**Goal.** One budget keeper per account and one retry layer, so no adapter can be refused for pacing again (ARCH §6, ADR-09).
**Deliverables.**
- `governor.run(account, {budget, lane, cost, kind, signal}, fn)` with the six lanes and budget table of ARCH §6.2; waits, never sends past budget; a pause aborts queued and in-flight siblings through one `AbortController`.
- AIMD: Gmail targets start at 4,500 units/min on the primary device and 1,500 elsewhere; a refusal halves (floor 1,000) and starts a cooldown; 10 quiet minutes regrow 250/min.
- Cooldown escalation 60 s, 5 min, up to 1 h, reset after 10 quiet minutes; `daily` stops the budget until reset (Gmail: next midnight Pacific [C]); persisted in `governor_state`. This replaces PV0's in-memory pacer and pause state, and reuses PV0's cost table and its throttle, daily, send-limit and reauth classes unchanged, so behaviour does not change on the day PV2 merges.
- Roles: the pacer's per-device target comes from a `role` input (`primary` 4,500, `secondary` 1,500), set by a setting until PV3's lease supplies it.
- The classifier registry (§3.3) and the status vocabulary of ARCH §6.4.
- Account actors: own connections, cursors, op flush, incremental loop and backfill; accounts run concurrently (X2); 30 s heartbeats; a silent actor restarts alone after 2 minutes (ARCH §2.4); wake handling that reconnects with jitter.
- Gate replaced; every SDK `maxRetries: 0` (Anthropic and OpenAI SDK defaults; the AI side is plan 10) and a lint rule forbidding `fetch` or `setTimeout` retry loops in `apps/desktop/src/host/providers`.
**Owns/touches.** `packages/engine/src/sync/**`, `apps/desktop/src/host/providers/shared/**`; plan 10 owns the tables.
**Depends on.** PV1a (emulator, kit, port). Plan 10 **E1** (`AccountActorHost`, the heartbeat supervisor of E1 deliverable 4, `GovernorPort` and the classified-error record shared with E0's log) and **E2** (`governor_state`, `sync_state`, `sync_failures`, `accounts.status*`); until E2 merges, state lives in an in-memory fake store behind the same interface.
**Acceptance.** Fake-clock tests cover escalation, reset, daily stop, AIMD halve and regrow and in-flight drop to 1 on a concurrency 429; against the Gmail emulator a 500-thread sync takes zero refusals; two emulated devices (one primary at 4,500, one at 1,500) stay under 6,000 sustained; a kill and restart reads the persisted cooldown and does not hammer a paused account; a property test shows no call is sent while the budget is exhausted.
**Work packages.** Fan out: governor and lanes; AIMD and persistence; classifier registry; actor runtime and wake. Verify adversarially: a reviewer writes a fuzzer that interleaves refusals, aborts, restarts and clock jumps and asserts the invariants "units in any 60 s window never exceed the target" and "exactly one retry layer".
**Estimate.** 7-8 agent-days (about 1.5 weeks).

### PV3: Gmail connector, lease and workflow channel (the daily-driver gate)

**Goal.** Inbox in seconds, the rest quiet, local edits that never flip back, three Macs sharing one quota, and real data proving it (ARCH §5.1, §6.5, M3; ARCH puts the lease in M3, so it ships with the connector, not later).
**Deliverables.**
- **First sync P0-P5** exactly as ARCH §5.1: cursor first, Inbox list deduped by thread, newest message as `format=metadata` with a `fields` mask and the nine headers, commit per 50 threads with the page token, Sent 30 days, prefetch at most 20% of target, idle backfill to 90 days. **`baseline_done_at` marks the first window:** it is set when P1's newest ~50 Inbox threads are committed, never at the end of backfill. The checkpoint facts for the loading screen are connected, `found` (an optional estimate, only when the provider gives one), read n of the first-window total, `resumeAt` and a reason code. Pages from P2 onward are backfill: they never create notifications or count as new mail. HTTP batches start at 10 and follow AIMD (growth by 5 to 25). A User-Agent containing `gzip` and a measured size check (D19).
- **Incremental:** `history.list`, all four types, 500 per page; label deltas applied at zero fetch (D13); added messages fetched as metadata; `DRAFT` skipped unless tracked (D9); unknown thread fetched only when it gained `INBOX` (D3); cursor advanced per history page; a 404 triggers a bounded Inbox resync and a generation sweep (D10). Cadence 15 s focused, 60 s without a window, 5 min on battery, immediately on wake, network change and focus, plus or minus 25% (`RC/protocols/proto-google.md` §5A).
- **Thread model:** per-message labels; status from messages not in Trash or Spam (D8); snippet entities decoded (D22).
- **Ops:** per-message, per-label, coalesced into `messages.batchModify` (50 units per 1,000); `threads.modify` for one thread; replay and fence supplied by plan 10 (ARCH §4.3).
- **Open-thread rule A1** of §2 (`threads.get` full on open and prefetch). User labels sync lazily, 25 per page, interactive lane. Body parts stored as attachments resolve in the interactive lane in batches, never serially per worker (D15).
- **Workflow channel (D17, D18) and primary-device lease** (moved here from PV4): gate each round on `history.list?labelId=<app label>` (2 units); skip known app-data message ids; paginate past 50 copies; tie-break edit time by device id. The lease (`{deviceId, until}`, 30-minute TTL, ties to the lower id, ARCH §6.5) supplies PV2's `role`, so a second Mac running 0.3.0 defaults to 1,500 and three Macs cannot sum to 13,500 against 6,000. Settings fact "Background work runs on" is plan 30's; the lease value is ours.
- **Auth:** `prompt=select_account` with `login_hint`; `sub` compared on reconnect; granted scopes stored and checked; refresh token and client id stored as one bundle with serialized refreshes (D21, D5); abort on `close()` (D23).
**Owns/touches.** `apps/desktop/src/host/providers/google/{auth,sync,history,ops,thread}.ts` and their tests; `getSendAs` failure classes (D25); `workflow-sync.ts`, `workflow-crypto.ts`, `packages/engine/src/sync/lease.ts`; the PV0 files it supersedes (`src/main/google.ts`, `gate.ts`) are moved by `git mv` and deleted in the PR that makes the new adapter pass the old tests.
**Depends on.** Plan 10 **E2** (`message_folders`, `thread_folders`, `thread_workflow`, change log, `store.commit` with replay and fence, `sync_state`, `baseline_done_at`, and plan 10's legacy bridge (§4.2 there: reads **and** writes through `legacyStoreAdapter`) so the 0.2.x renderer keeps working; IMAP, JMAP, Graph and CalDAV legacy sync keep running through that bridge until PV6-PV10 (ARCH M7 and M8) replace them) and **E1** (contract freeze C1, `ports.ts`). PV1a. PV2 for the real governor; PV3 starts in week 3 on the pass-through stub and switches when PV2 merges. Plan 10's **E5** reads `baseline_done_at` (a stub actor until PV3); plan 10's **E3** supplies the `Thread/act` receipts that PV3's ops answer (the legacy bridge covers the gap). The schema PV3 needs is E2a's, with a hard date at the end of week 3.
**Acceptance (live, a real Gmail account, owner-assisted; mocked Google never counts).**
- First 50 threads visible in under 15 s; 500 threads in about 3 minutes; zero refusals in the log.
- Kill the engine mid-backfill: it resumes from the stored page.
- A 2,000-thread archive made in Gmail web costs under 100 sync units (read from `costUnits`, cross-checked in the Cloud console quota graph).
- Delete one reply in Gmail web: the conversation stays in the Inbox.
- A draft made on a phone appears in Drafts and never inside the thread.
- The units-per-minute series is attached as evidence (§5.4).
- Two Macs signed into the same account: one holds the lease, the other stays at or under 1,500 units a minute, the combined series stays under 6,000; a workflow round with 3 copies costs under 10 units when idle.
**Work packages.** Fan out: first-sync phases; history incremental; thread and label model; ops and coalescing; auth hardening; `fields` and gzip measurement; workflow gating and lease (on a second agent, so the Gmail gate does not wait for it). Verify adversarially: (a) a property test that runs random interleavings of local ops and history pages and asserts the replay invariant "effective state equals provider state plus pending ops"; (b) a "ghost hunter" that forces cursor expiry with 20 history pages pending and asserts zero ghost threads; (c) an independent cost audit that recomputes units from the emulator's request log and compares with `costUnits`; (d) a two-device lease fuzz with clock jumps and killed holders.
**Estimate.** 15-17 agent-days (about 3 weeks including the live pass); release 0.3.0 together with plan 10's E1, E2a and E2b (ARCH M3; E3 is not required), tagged from main after the owner merges `revamp`.

### PV4: Gmail write side: drafts, filters and unsubscribe

**Goal.** Drafts that follow you between devices, rules that act while the Mac sleeps, and one-key unsubscribe. (The shared state channel and the lease moved to PV3.)
**Deliverables.**
- **Drafts API** (ARCH §7.4): upload 5 s after idle and on close (15 units); skip unchanged fingerprints; serialize per draft by stable `draftId`; large drafts through `/upload/`; `DRAFT` history records with a message id Aplos did not write raise a conflict ("keep mine, take theirs, keep both"); reply threading from the selected message (D9).
- **Send transport:** `drafts.send` when a remote draft exists, else `/upload/…/messages/send` as `message/rfc822`, resumable above 5 MB (D20); never retried; `uncertain` settled with `rfc822msgid:` (the state machine is plan 10's, ARCH §7.1).
- **Filters:** a `sender_rules` mirror for Block and skip-Inbox through `settings.filters.create` (5 units), `list` (1); delete-and-recreate for edits; application to existing mail through `messages.list` plus `batchModify`; capability derived from the granted `gmail.settings.basic` scope. Decision 4 controls the default.
- **List-Unsubscribe:** capture `List-Unsubscribe` and `List-Unsubscribe-Post` at sync (already in the P1 header list), store in `messages.list_unsub`; execution per Decision 5: RFC 8058 one-click POST from the engine under the image proxy's SSRF rules (ARCH §10), else `mailto:` through the account, else open the page.
**Owns/touches.** `apps/desktop/src/host/providers/google/{drafts,filters,send}.ts`, `apps/desktop/src/host/providers/shared/unsubscribe.ts`.
**Depends on.** Plan 10 **E6** (`submissions`, drafts table with `revision`, `DraftSyncPort`, `SendPort`, `NotSentError`; contract methods `Draft/*` and `Submission/set`, plus `Unsubscribe/run`, named in plan 10's contract at C1) and **E4** (the image proxy's address rules, ARCH §10, reused by the one-click executor); PV3.
**Acceptance.** Emulator: a draft edited on two devices raises one conflict; a send killed before the marker, after the marker and after acceptance causes no duplicate (shared with plan 10's test); a filter mirror survives a delete-and-recreate edit. Live: a draft round trip to the owner's phone Gmail app; one filter created, seen in Gmail settings and deleted; one real one-click unsubscribe on a list the owner chooses.
**Work packages.** Fan out: drafts; send and upload; filters; unsubscribe. Verify adversarially: a reviewer reads Google's draft and filter pages, then attacks edit-conflict, deleted-remotely and unchanged-fingerprint cases; another probes the one-click executor for redirect, private-address and non-HTTPS abuse.
**Estimate.** 7-8 agent-days (about 1.5 weeks).

### PV5: OAuth readiness and the Google verification and CASA track

**Goal.** Aplos can be installed by strangers without a warning, and a source build or fork can run with its own OAuth clients. This track is mostly other people's time; engineering is about three weeks.
**Deliverables (engineering).**
- **Client resolution:** official builds embed official ids; source builds read `APLOS_GOOGLE_CLIENT_ID`, `APLOS_GOOGLE_CLIENT_SECRET`, `APLOS_MS_CLIENT_ID` from the environment or Settings (ARCH §14.2; `src/main/oauth-config.ts` already prefers env over bundled).
- **Scope manifest:** one table of every scope with its feature and the exact consent text, generated from code and checked by a test. Current scopes: `gmail.modify`, `gmail.settings.basic`, `calendar.calendarlist.readonly`, `calendar.events` (`google.ts:310`) [V]. The test fails if code requests a scope the manifest lacks. **Scope freeze:** no new restricted scope after submission (ARCH ADR-03). **Decision 4 is settled first:** `gmail.settings.basic` is restricted and is needed only to write filters (reading send-as addresses and signatures is covered by `gmail.modify` [I, verify against the `sendAs.list` reference before relying on it]); if filter mirroring is declined, the scope is dropped from the manifest and the review gets smaller. `calendar.calendarlist.readonly` and `calendar.events` are re-checked against the same rule.
- **Granted-scope UX facts:** every token response's `scope` stored; features derived from it; "grant missing permissions" runs a full re-consent because incremental auth is unsupported for installed apps [V `RC/protocols/proto-google.md` §8.1].
- **Token lifecycle:** `refresh_token_expires_in` honoured; the 100-token cap avoided by never forcing consent (D21).
- **CASA evidence pack** (`docs/security/casa/`, created when this milestone runs): data inventory (what mail text goes where, with `trainsOnInputs` per AI provider), data-flow diagram showing no Aplos server, secrets handling (Keychain-wrapped key, vault), dependency scan and static analysis output, the mail-frame isolation test results (plan 10 E4), incident and deletion procedure. The lab's own checklist decides the rest; assume an application-security checklist style [I].
- **Prompt-injection and no-training statements:** background jobs have no tools; suggested actions are proposals needing a keystroke (ARCH §8.5); AI providers with unpaid-tier training are not mail-eligible (`RC/protocols/proto-google.md` §8.2).
**Owner and external steps, in order.** (1) Production switch (ARCH Decision 2). (2) Consent screen branding and domain verification; the privacy page at `apps/web/privacy` gets the Limited Use statement (plan 40's truthfulness pass). (3) Brand check: 2-3 business days [V]. (4) Scope justifications and the unlisted English demo video that shows the client id in the consent URL and each scope in use; a shot list is prepared by an agent, recorded by the owner (agents never drive visible windows). (5) Submit restricted-scope review: "several weeks" [V]. (6) Choose a CASA lab; Google assigns the level [V]; cost [S]. (7) Annual revalidation reminder.
**Gate.** Submission only after PV3 passes live, because the video must show a working client. If Decision 1 is (b), stop after step 2 and keep the 100-user cap.
**Depends on.** PV3 (live Gmail pass, for the demo video). Plan 10 **E4** (isolation test results as evidence) and **E5** (consent and `trainsOnInputs` as data-inventory facts). Plan 40 (site, CI, secrets; its §6.8 evidence pack: this milestone owns the Google-specific documents `docs/security/casa/{data-inventory,scope-justifications,limited-use}.md` and plan 40 owns the general pack and the scan outputs, so there is one folder and no duplicate).
**Acceptance.** Scope-manifest test green; a source build connects with env-supplied client ids on a throwaway project; the review is submitted and tracked in PROGRESS.md with dates. Approval is outside our control and is not an acceptance criterion.
**Work packages.** Fan out: client resolution and manifest test; evidence pack drafts; video shot list and consent text. Verify adversarially: a reviewer plays the Google reviewer, reading the policy pages cited in `RC/protocols/proto-google.md` §8.2, and lists every claim in our text that the code does not support.
**Estimate.** About 15 agent-days spread over months; 6-12 weeks elapsed for Google [I].

### PV6: IMAP, iCloud, Yahoo and generic hosts

**Goal.** Push and fast triage on IMAP; no whole-message downloads; no false deletions (ARCH §5.3, §5.6).
**Deliverables.**
- **Two connections per account on the primary device, one elsewhere.** A holds IDLE on INBOX, restarted per host (25 min default, Yahoo 3 min); B is a priority command queue that releases between folders (I1). Reconnect backoff depends on how long the connection survived.
- **Capability ladder:** QRESYNC where advertised and allowed by the host table; else CONDSTORE `CHANGEDSINCE` plus a bounded expunge check; else windowed flag scans (newest 400 UIDs every 2 min, deep scan every 10). `STATUS` skips unchanged folders; non-INBOX folders rotate every 2-5 min (I4).
- **Host table** (`apps/desktop/src/host/providers/imap/hosts.ts`, declarative): QRESYNC allowed, IDLE restart, `MESSAGELIMIT`, connection cap, Sent-copy behaviour, username rules, daily byte budget. iCloud: QRESYNC off unless a scripted VANISHED probe passes (experiment EX5); tolerate `UID FETCH n:*`; append our own Sent copy; usernames per `RC/protocols/proto-others.md` §5 with the custom-domain note in the preset copy (I7).
- **Tiered fetch:** envelope, BODYSTRUCTURE, flags, size, List-Unsubscribe and References first; text for the recent window; attachments on open; catch-up after a gap takes the newest 500 and leaves a gap cursor (I2, I3); 1,000 MB/day budget per account.
- **Never infer deletion from a partial answer:** read `MESSAGELIMIT`, chunk below it (500 if unannounced on Yahoo), treat `[MESSAGELIMIT n lastUID]` as partial (I5).
- **Placements** as `message_folders` rows; roles from SPECIAL-USE, never names alone. **Threading** from OBJECTID `THREADID` where advertised, else header-based ancestors (Message-ID, References, In-Reply-To) with merge when a new message bridges two threads, as Geary does (`RC/arch/geary.md` line 233) [V]; root Message-ID as the workflow `sync_key`.
- **Writes:** `\Answered` and `$Forwarded`, `$Junk`/`$NotJunk` (I9); Drafts via `APPEND` then delete the previous copy by `APPENDUID`, or by per-revision Message-ID without UIDPLUS (`RC/arch/nylas-sync-engine.md`) [V].
- **Auth:** `accessToken` path through the login type (I6), used by nothing until a host needs it. **Library:** imapflow 2.4.3 to 2.9.x with the changelog read for IDLE and lock changes, and its `error` event no longer swallowed (I10).
- **iCloud connection discipline:** primary device 2, others 1, so three Macs use 4, under the reported cap of about 5 [S].
**Owns/touches.** `apps/desktop/src/host/providers/imap/**` (from `imap.ts`, `imap-session.ts`, `imap-index.ts`; the O(n²) JSON index becomes rows, I4).
**Depends on.** Plan 10 **E2** (`message_folders` placements, per-folder `sync_state`, `sync_failures`) and **E6** (the Drafts table and `DraftSyncPort`); PV1a, PV1b's IMAP fixture (landing in week 5-6), PV2.
**Acceptance.** Emulator: an archive issued during a first sync completes in under 2 s of fake time; `exchange` and `icloud` personalities never produce a false deletion under `MESSAGELIMIT`; killing mid-batch resumes at the last committed UID; no `BODY[]` fetched for list display (request-log assertion); a 5-minute offline gap catches up in bounded batches. Dovecot conformance green. Live (owner's iCloud, Decision 3): new mail appears within seconds; an archive made on the phone arrives; at most 2 connections per device role (server-side count from the harness); a long sync never blocks triage; the VANISHED probe result is recorded as E5.
**Work packages.** Fan out: connection actors and IDLE; capability ladder and host table; tiered fetch and gap cursor; threading; writes and drafts; imapflow upgrade. Verify adversarially: a reviewer tries to make Aplos delete mail by serving partial `SEARCH` results, a changed `UIDVALIDITY` and a dropped connection between `EXPUNGE` and its response.
**Estimate.** 12-13 agent-days (about 2.5 weeks) plus the live pass.

### PV7: JMAP and Fastmail

**Goal.** Instant updates with no polling load, and a first sync that costs previews, not bodies (ARCH §5.4).
**Deliverables.**
- One EventSource per account on `eventSourceUrl` (`types=Email,Mailbox,Thread,EmailDelivery`, `closeafter=no`, `ping=60`); a watchdog after two missed pings; throttled reconnect honouring `Retry-After`; reconnect on wake; `/changes` every 60 s as a floor (J1; `RC/SYNTH-architecture.md` §3.5). Dropped events are harmless because the pull follows.
- Lists use `preview`; bodies lazy; `header:List-Unsubscribe:asURLs` (J3, J7). Limits come from the session: `maxConcurrentRequests`, `maxObjectsInGet`, `maxCallsInRequest` (J2); `rateLimit` SetErrors handled; `sessionState` change refetches the session.
- Drafts: an `Email/set` create with `$draft` in the Drafts mailbox, and edits as create-new plus destroy-old in one request [I, RFC 8621 emails are immutable apart from keywords and mailboxes].
- Single-request `EmailSubmission` kept (already idempotent; `RC/protocols/proto-others.md` §6.3).
- WebSocket only if the live session advertises `urn:ietf:params:jmap:websocket` (experiment EX7).
- API-token path stays the owner path; Fastmail OAuth and CalDAV with the same grant wait on the registration (J5, J6).
**Owns/touches.** `apps/desktop/src/host/providers/jmap/**`.
**Depends on.** Plan 10 **E2** (placements, `sync_state`) and **E6** (Drafts); PV1b's JMAP fake and the Stalwart conformance job; PV2. With PV6 this is ARCH M7's **multi-provider daily-driver gate** (iCloud and Fastmail live, ARCH §15 M7).
**Acceptance.** Stalwart conformance for push and `/changes`; fake-clock watchdog test; emulator first sync with 500 threads fetches no body (log assertion); new mail visible within 3 s of delivery on the live Fastmail account; EventSource kept at one socket per account.
**Work packages.** Fan out: push loop; preview-first sync; drafts; limits. Verify adversarially: kill the stream silently (no FIN) and assert the watchdog reconnects; swap `sessionState` mid-run.
**Estimate.** 7-8 agent-days (about 1.5 weeks), parallel to PV6.

### PV8: Recurrence module and CalDAV

**Goal.** Calendars that sync only what changed and show repeating events correctly on every server (ARCH §5.5, ADR-20).
**Deliverables.**
- **Recurrence module** (`packages/engine/src/calendar/recurrence/`): masters plus overrides stored; expansion on query for a visible range; RRULE (FREQ, INTERVAL, BYDAY with ordinals, BYMONTHDAY, BYSETPOS, WKST, COUNT, UNTIL in UTC and floating), RDATE, EXDATE, RECURRENCE-ID overrides, all-day, DST. Decision spike first: evaluate `ical.js` (MPL-2.0) against the bundle budget and licence, otherwise extend `ical.ts` (today it handles RRULE only for VTIMEZONE observances, C2). Choose by the golden corpus, not taste.
- **CalDAV sync:** one `PROPFIND Depth:1` on the home for ctag and sync-token every 5 min and on focus; changed collections run `sync-collection` (RFC 6578) then `calendar-multiget` 50 at a time; 507 paging; invalid token means empty-token resync reusing unchanged ETags; 2 in flight; `PUT` with `If-Match`, `If-None-Match: *` on create. Fallback without sync-token: `calendar-query` for ETags plus multiget.
- **Redirects:** same registrable domain only (allows `caldav.icloud.com` to `pNN-caldav.icloud.com`); otherwise drop credentials and explain (C3). Principal PROPFIND uses Depth 0 on iCloud; always send DTEND on PUT; do not trust `If-Match: *` there [S, `RC/protocols/proto-others.md` §4.2].
- Edits: single occurrence (override) and whole series; "this and following" behind Decision 6.
**Owns/touches.** `apps/desktop/src/host/providers/caldav/**`, `packages/engine/src/calendar/**`; `ical.ts` folds in.
**Depends on.** Plan 10 **E2** (`calendars`, `events` tables; masters and overrides need a column for the recurrence id, which plan 20 asks plan 10 to review before E2 merges); PV1b's CalDAV fake and the Radicale and Stalwart conformance jobs; plan 30 for the edit-scope UI. The recurrence module is pure and can start in week 3 with no dependency.
**Acceptance.** A golden corpus of at least 80 cases (DST edges, ordinal BYDAY, BYSETPOS, leap day, moved and cancelled overrides, EXDATE with TZID, floating times) agrees with two independent oracles used at test time only; an idle account costs one request per poll (request-log assertion); the redirect test proves no `Authorization` header reaches another registrable domain; the Radicale and Stalwart conformance runs pass; live iCloud and Fastmail calendars show a weekly meeting with an edited occurrence correctly.
**Work packages.** Fan out: recurrence spike and corpus; sync loop; redirect and quirks; occurrence edits. Verify adversarially: a reviewer generates random RRULEs and compares with both oracles over ten years; another feeds servers that ignore expand, return 507, and invalidate tokens.
**Estimate.** 10 agent-days (about 2 weeks), parallel to PV6 and PV7.

### PV9: Google Calendar, Graph calendar and RSVP

**Goal.** Editing a Google event never loses its Meet link or guests' answers, and replying yes or no works on every calendar.
**Deliverables.**
- **Google Calendar** (own budget, 600 requests/min per user, 50% target, 2 in flight): per-calendar `syncToken` with `singleEvents=false`; primary every 2-5 min, others 15-30, list 30, all jittered plus or minus 25%; `events.patch` with `If-Match` and only changed fields (D11); 410 resyncs one calendar only; decoupled from mail sync, errors reported per calendar (D12); `hidden` and `selected` respected (D24); `forbiddenForNonOrganizer` makes shared fields read-only; 412 raises an edit conflict (`RC/protocols/proto-google.md` §7).
- **RSVP:** Google by patching the self attendee's `responseStatus` (the whole `attendees` array is replaced on patch, so send it complete with one change), with `sendUpdates` set so the organizer is told [I, experiment EX11 checks it with a second account]; CalDAV by updating the user's own `PARTSTAT` in the event resource, with the server's scheduling doing the reply [U, experiment EX11]; Graph by the event `accept`, `tentativelyAccept` and `decline` actions [I]. Non-organizers can change only their response and personal fields.
- **Graph calendars:** `calendarView/delta` per calendar over a rolling window; the token encodes the window, so a monthly re-window runs a resync of that calendar (`RC/protocols/proto-others.md` §1.1, M8).
**Owns/touches.** `apps/desktop/src/host/providers/google/calendar.ts`, `apps/desktop/src/host/providers/microsoft/calendar.ts`, `packages/engine/src/calendar/**`.
**Depends on.** Plan 10 **E2** (`calendars`, `events`); PV8 (recurrence module and edit scopes); PV2 (the `gcal` and `graph` budgets); PV10's Graph auth for the Graph calendar live parts only; the Google parts need nothing from PV10.
**Acceptance.** Emulator: a patch that changes only the title leaves `conferenceData`, reminders, colour and attendee responses byte-identical (D11 regression); one failing calendar leaves the others syncing; an idle poll costs 1 request per calendar. Live: rename an event with a Meet link and verify the link survives; RSVP to an invitation the owner sends from a second account.
**Work packages.** Fan out: Google sync tokens; patch writer; RSVP across three protocols; Graph calendar delta. Verify adversarially: a reviewer diffs the event JSON before and after every write on the emulator, field by field.
**Estimate.** 10 agent-days (about 2 weeks; Graph calendar parts wait for PV10).

### PV10: Microsoft Graph mail (ships dark)

**Goal.** Outlook that obeys Microsoft's limits and sees all mail, built and proved on the emulator now, live when a client id exists (ARCH §5.2).
**Deliverables.**
- **Scheduler:** at most 4 requests in flight per mailbox; an unordered `$batch` of at most 20 counts as 4; failed sub-requests retried after the largest `Retry-After`; a token bucket at 75% of 10,000 per 10 minutes; one shared scheduler for sync, actions, attachments and app data (M1, X3).
- **Window and delta:** the visible window from a plain list query with light `$select`; each role folder then runs an **unfiltered** delta in the backfill lane with persisted `nextLink` checkpoints (M2, M4). Delta polling 30-60 s focused, 2-5 min in the background. Bodies, attachment lists and inline images lazy (M5). Contingency if experiment EX4 shows the unfiltered first round is too slow: it simply runs for hours in the backfill lane, since correctness does not depend on speed (ARCH §5.2); a filtered fast path is allowed only for the visible window.
- **Folders beyond five:** custom folders tracked with `sync_scope` `lazy` (M3).
- **Auth:** refresh rotation (store the new token, delete the old, one serialized refresh per account); AADSTS code and description logged and mapped (`interaction_required`, consent required, "admin approval required" to `needsAdmin`); granted `scope` compared (M6). `MailboxSettings.Read` is requested today; rules need write access, so adding `MailboxSettings.ReadWrite` forces re-consent [I] and is decided with the rules work.
- **Drafts** native; `internetMessageHeaders` for List-Unsubscribe (M9); **rules** through `messageRules` for Block and skip-Inbox (Decision 4).
- **Send:** MIME through `/me/sendMail` keeping `internetMessageId`; the 3 MB cap stays until an upload-session path is proven to keep the Message-ID (experiment EX10, M7).
- **M10:** the authorization request uses `response_mode=form_post`, or stays on `query` with the code never logged (an explicit choice recorded in DECISIONS.md); the one-JSON-key message index becomes `message_folders` rows through plan 10's store.
- Everything behind a capability flag that is off in release builds until `MICROSOFT_CLIENT_ID` exists.
**Owner steps.** Entra public client registered under "Mobile and desktop applications", `common` authority, `http://localhost` redirect (port ignored), and the `127.0.0.1` URI added through the manifest; `[::1]` is unsupported [V `RC/protocols/proto-others.md` §1.5]; publisher verification only per Decision 2.
**Owns/touches.** `apps/desktop/src/host/providers/microsoft/**`.
**Depends on.** Plan 10 **E2** (placements, `sync_state`, folder scopes) and **E6** (Drafts, `SendPort`); PV1b's Graph emulator (the first PV1b item, week 7); PV2 (the `graph` budget). Live parts need the Entra client id (an owner action).
**Acceptance.** Emulator: 12 concurrent callers produce at most 4 in flight; a sub-request 429 inside a 200 batch retries only that sub-request after the right wait; a 410 resyncs; a kill mid-delta resumes at the `nextLink`; with the baked-filter toggle on, the unfiltered design still reports a message moved in from last year. Live when the id exists: experiments EX4 and EX10 recorded; a first sync of the owner's Outlook.com completes with zero 429s.
**Work packages.** Fan out: scheduler; delta and checkpoints; auth and AADSTS; drafts, rules, headers; send. Verify adversarially: a reviewer runs the emulator in both filter-behaviour modes and tries to find mail Aplos misses.
**Estimate.** 10 agent-days emulator-side (about 2 weeks); live pass is 1-2 days after the client id exists.

### PV11: Hardening and the final provider gate

**Goal.** Prove the whole provider stack under bad weather (ARCH M10). The multi-provider daily-driver gate itself is PV6 plus PV7 (ARCH M7); this is the hardening gate before 0.4.0.
**Depends on.** Plan 10 **E8** (soak harness `scripts/soak.ts`, shared fault injection, shim removal; it runs the owner's real accounts through our actors) and every earlier PV; plan 10's E7 diagnostics bundle for the provider status matrix.
**Deliverables.** Seven-day soak with sleep and wake and battery cycles across Gmail, iCloud and Fastmail test accounts; fault-injection runs per provider (drops, 403/429 storms, corrupt page, disk full via plan 10's hook); wake and network-change reconnect verified per provider; a **provider status matrix** (what each account state looks like in the diagnostics bundle); live-experiment register (§5.5) closed or carried forward; removal of shims and the old emulator; defect-test audit (§5 rule 1).
**Acceptance.** Zero ghost threads after a forced cursor expiry on each provider; zero false deletions under `MESSAGELIMIT`; zero duplicate sends; flat memory over 24 hours; Gmail units per minute never above 6,000 in the soak series; every defect id has a passing named test; a clean 0.3.x to 0.4.0 update with accounts still syncing.
**Work packages.** Fan out: one soak runner per provider; fault matrix; wake and network. Verify adversarially: a reviewer reads the soak evidence and tries to find an hour with a gap, a spike or a missing event.
**Estimate.** 5 agent-days over 1 week of work, 7 days elapsed soak (overlaps plan 10's E8).

> **What this means:** Thirteen steps, each with a goal, a proof and a way to attack the result. A safe, limited Gmail arrives within about a week as 0.2.4; the full Gmail app you can live in follows around week five or six, iCloud and Fastmail by about week nine, calendars and Outlook right after, and Google's review runs alongside. If time runs short, the cut order above says what goes first.

## 5. Test strategy

### 5.1 Rules

1. **Every defect has a named test.** Test titles begin with the defect id (`D3 bulk archive costs under 100 units`). PV11 greps the id list from the two protocol reports and fails if any is missing.
2. **Reproduce, then fix.** A defect's test first asserts the old behaviour against the emulator (PV0 and PV1a for Gmail, PV1b for the others), then is inverted by the fix.
3. **Emulators prove logic, never acceptance.** Mocked Google never counts as live acceptance (AGENTS.md). Each live-only claim is named in §5.5.
4. **No secrets, no mail in logs, evidence or fixtures.** Fixtures are original; no reference-project code or data.

### 5.2 Layers

- *Unit:* classifiers fed recorded error bodies (including message-only `rateLimitExceeded`), `Retry-After` in both formats, AIMD, the capability ladder, host table, recurrence, redirect policy, scope manifest.
- *Emulator scenarios* (PV1a, PV1b): first sync, kill mid-page, cursor expiry, bulk archive, 403/429 storms, `MESSAGELIMIT`, drop and reconnect, draft conflicts, calendar patch, each run with the fake clock and `db_matches_server` invariants.
- *Property tests:* replay equals provider plus pending ops; no deletion outside a completed scope; units in any 60 s window never exceed the target; recurrence versus two oracles.
- *Conformance:* fake versus Dovecot, Stalwart, Radicale on Linux CI, never bundled.
- *Fault injection:* the engine killed between named points (before the send marker, after it, after provider acceptance, mid-page, mid-delta).
- *Benchmarks:* units per minute series per run, time to first 50 threads, time to 500, request counts per idle poll (Gmail 2 units per history poll, CalDAV 1 request, JMAP 0 while the stream is up).
- *Adversarial review* is a first-class step in every milestone (listed under Work packages) and uses an agent that has not seen the implementation.

### 5.4 The live-provider verification harness

`apps/desktop/scripts/live/`, a CLI, headless (no window is driven). **Tiers M and S never run in CI.** Tier R is the same probe code that plan 40's `npm run smoke:live` runs through its `SmokeProbe` interface (plan 40 Q4 Layer 2 and decision G: nightly or weekly, dedicated throwaway test accounts only, whose tokens are CI secrets, read-only, never the owner's real mailbox); plan 20 writes the per-provider probes and the content-free evidence format, plan 40 owns `scripts/smoke/`, the schedule and `provider-status.json`. No token for the owner's real account is ever stored in CI; runs against the owner's account are local and manual. Local credentials come from the backend environment or a dedicated test vault outside the repository at `~/Library/Application Support/Aplos Mail Live/`, created when the owner runs a one-time interactive sign-in for each test account; nothing is printed or committed. Three tiers:
- **R (read-only):** connect, first sync, incremental, idle polls, search; safe on real accounts when run locally by the owner, and the only tier a CI smoke may run, on throwaway accounts only.
- **M (mutating):** labels, archives and drafts on a dedicated test label or test mailbox; owner flag required.
- **S (send):** owner-run only, to the owner's own address. Agents never send external mail (AGENTS.md).
Each run writes a **content-free evidence file** (counts, timings, units per minute, error classes, request counts, connection counts, versions; no subjects, bodies, addresses or tokens) to `verification/live/<date>-<provider>.md`, and PROGRESS.md cites it when an acceptance item is checked. While Google is in Testing mode, test tokens expire in 7 days [V `RC/protocols/proto-google.md` §8.1], so the Production switch also unblocks the harness.

### 5.5 Live experiments register

Experiments are named EX1-EX11 so they cannot be confused with plan 10's milestones E0-E8 (there is no EX9).

| # | Question | Source | Settled in |
|---|---|---|---|
| EX1 | Which `reason` did the first 403 carry? | `RC/protocols/proto-google.md` open questions | PV0 |
| EX2 | Does this project's `messages.get` really cost 20 units, not 5 (grandfathering)? | `RC/SYNTH-architecture.md` §4.4 | PV0, Cloud console |
| EX3 | Does a bulk archive in Gmail web cost under 100 sync units? | ARCH M3 acceptance | PV3 |
| EX4 | Does a filtered Graph delta hide older mail moved back, and is the first unfiltered round affordable? | `RC/protocols/proto-others.md` §9 Q1-Q2 | PV10 |
| EX5 | iCloud real connection cap, VANISHED behaviour, CalDAV expand | same §9 Q3, Q6 | PV6, PV8 |
| EX6 | Yahoo `MESSAGELIMIT` 500 or 1000, enforced or soft | same §9 Q4 | PV6 (if a Yahoo test account exists) |
| EX7 | Does Fastmail advertise the JMAP WebSocket; OAuth registration lead time | same §9 Q5 | PV7 |
| EX8 | Does Graph accept a "start from now" delta token | same §9 Q1 | PV10 |
| EX10 | Does a Graph upload-session send keep the `internetMessageId` | ARCH §5.2 [U] | PV10 |
| EX11 | Does iCloud or Fastmail CalDAV send the RSVP reply when `PARTSTAT` is updated | not in research | PV9 |

> **What this means:** Practice providers prove the logic quickly and cheaply. Only real accounts prove the real thing, so live checks are written down, run by the owner where mail would be sent, and never replaced by mocks.

## 6. Risks and mitigations

| Risk | Likelihood and impact | Mitigation |
|---|---|---|
| A second cause hides behind the Gmail 403 | Medium, high | PV0 logs the exact reason; PV3 acceptance is live, not emulated |
| The emulators are too forgiving, so bugs survive | Medium, high | Reproduce-then-fix (PV1a and PV1b acceptance); an agent that has not seen the emulator writes refusal probes; Docker conformance tier |
| Google's review stalls or demands CASA at the highest level | High, medium | Start early; evidence pack; stay in unverified mode with the 100-user cap; source builds with own client ids (ARCH §14.2) |
| Quota math is wrong for this project (5 vs 20 units) | Medium, medium | EX2 on day one; costs live in a table the governor reads; refusal-driven AIMD absorbs errors |
| IMAP hosts misbehave in ways no personality covers | High, medium | Host table is data, not code; verbose protocol log (ARCH §11); personalities added from field reports |
| iCloud connection cap hit by three Macs | Medium, medium | Primary 2, others 1; lease; live count in the harness |
| Graph cannot be tested without a client id | Certain, medium | Ships dark; emulator in both delta modes; live pass is 1-2 days once the id exists |
| Recurrence edits corrupt events | Medium, high | Two-oracle corpus; "this and following" a release later (Decision 6); never write a series Aplos cannot round-trip, refuse and say so |
| Two threads collide on shared files | Medium, medium | Ownership table (§3.1); the port is frozen with plan 10's C1 (end of E1); plan 10's store API is the only door |
| PV0's `thread.open` and lazy bodies run longer than two days | Medium, medium | Decision 7 fallback (25 threads with text, paced); PV0 never blocks on the lazy part |
| A `StaleSync` re-run or a second Mac re-spends the first window | Medium, high | PV0's per-run memo and 3,000 target; PV3's lease and role-based targets; two-device emulator acceptance in PV2 and PV3 |
| Plan 20 is over capacity (about 120-127 agent-days on the S thread that also owns E2) | High, medium | PV1b just in time; parallel fan-out in weeks 6-10; the cut order in §4; honest week 6 for the Gmail gate |
| Four plans edit the same 0.2.4 files (logger, `srcdoc`, release workflow, Gmail) | Medium, medium | One 0.2.4 train with a fixed merge order (§9) |
| One-click unsubscribe abused for SSRF | Low, high | Reuse the image proxy's address rules; HTTPS only; confirmation first |
| Provider terms or prices change (Gmail billing "later in 2026") | Medium, low | Costs and cadences are settings; cadence is a lever (`RC/protocols/proto-google.md` §5A) |
| Live tests touch real mail | Low, high | Tiers R/M/S; owner flag for M; sends owner-only; test accounts per Decision 3 |
| Reference code leaks into Aplos | Low, high | Idea-only rule repeated in every brief; licence scan in plan 40 |

> **What this means:** The biggest risks are outside our code: Google's review, Microsoft's registration and whether our practice providers are honest. The plan keeps each one small, early and checkable.

## 7. Interfaces and contracts with other workstreams

**Plan 10 (engine foundation).** Names below are plan 10's milestones (E0-E8) and ports (plan 10 §7.1).
- *We consume:* the store transaction API (`store.commit` with replay of pending ops and the mutation fence, E2), `sync_state`, `sync_failures`, `governor_state`, `provider_memory`, `message_folders`/`thread_folders`, `changes`, `ops`, `drafts`, `submissions`, `jobs`, `notifications`, `calendars`, `events`; the ports `GovernorPort`, `AccountActorHost`, `SendPort`, `DraftSyncPort` (E1, E6); the contract methods `Sync/request`, `Thread/act`, `Submission/set`, `Draft/*`, `MessageBody/get`, `Setup/*`; the diagnostics event catalog (we emit `sync.gmail.page_committed`, `governor.paused`, `send.uncertain`-style ids) and E0's `Logger`; wake and network signals and the timer loop with deadline-source registration (E1, E6).
- *We provide:* `ProviderAdapter` (§3.2) and the status vocabulary, frozen with C1 at the end of E1; `costUnits`, cooldowns and per-account status for the diagnostics bundle (E7); the baseline marker semantics (`baseline_done_at` set when the first window, P1's newest ~50 Inbox threads, is committed; never at the end of backfill; backfill pages never notify) so AI and notifications stay silent until then; the lease role; the emulators and fault kit in `packages/emulators` (`@aplos/emulators`) for E6 and E8; the `trainsOnInputs` fact for AI-provider eligibility is theirs, the Google policy consequence is ours.
- *Cross-plan edits, now reconciled (2026-10-27, `plans/00-roadmap.md`):*
  1. Adapters live in `apps/desktop/src/host/providers/<name>/` (plan 10 §3); neutral actors, governor and recurrence live in `packages/engine/src/{sync,calendar}/**`; emulators in the test-only `packages/emulators`. Plan 10's portability rule needs no path exception.
  2. `ProviderAdapter` (with `findSent`) is in plan 10's §7.1 ports table and frozen with C1; `SendPort` and `DraftSyncPort` are its engine-side callers.
  3. Plan 10's contract names `Account/connect`, `Account/reconnect` and `Account/grantPermissions` (D5), `Unsubscribe/run` (today's `thread.unsubscribe`), `Event/set {scope: occurrence|series|following}` and `Event/rsvp` at C1; this plan supplies their behaviour (PV3, PV4, PV8, PV9).
  4. One 0.2.4 train (§9): `hotfix/0.2.4`, owned by PV0; E0 and the other slices join only if ready.
  5. The ARCH §5.1 amendment A1 (§2) is recorded in ARCH's amendments section as AM-1 (2026-10-27) and goes into DECISIONS.md at E2a.
  6. Plan 10's E2a schema review includes the recurrence id on `events` rows and `message_folders` keyed for IMAP placements before E2a merges.
- *To settle together at E1:* who owns the governor code (this plan: provider budgets and `packages/engine/src/sync/`; plan 10: the AI governor, sharing one base class); the lease role input.

**Plan 30 (UI).**
- *We provide:* account states (`needsReauth`, `needsPermission`, `needsAdmin`, `misconfigured`, `paused(until, reason)`, `offline`, `backfilling(n of m)`), first-sync checkpoint facts for the loading screen (connected, `found` as an optional estimate, read n of the first-window total, resume time, plain reason code; DESIGN §7.12 as amended), which plan 10's `Setup/status` aggregates, error reason codes mapped to DESIGN §7.15 copy keys, capability flags (labels, drafts, serverSearch, calendar, filters, push), recurrence edit scopes and RSVP actions, unsubscribe availability per message, and the "Background work runs on" lease fact.
- *We never provide:* copy or raw provider strings. The UI never shows a raw error (DESIGN §7.12). The one exception is 0.2.4, where the old engine still writes its own sentences, as it does today.
- *We need:* the connect flows of the new onboarding (DESIGN §7.11) to call `Account/connect` and honour `Setup/end`; a Settings account row for "grant missing permissions"; in 0.2.4, the one Reader call to `thread.open` and a partial-message state (plan 30's U0 owns `Reader.tsx` and merges after PV0, §9).

**Plan 40 (platform, quality).**
- *We provide:* emulator suites for the CI emulator E2E job; a Linux-only Docker job spec for Dovecot, Stalwart and Radicale (macOS runners cannot run Docker [I]); the scope manifest test; the Google-specific CASA documents (PV5) for plan 40's §6.8 pack; per-provider probes for plan 40's `SmokeProbe` (tier R only).
- *We need:* no CI-stored token for the owner's real account and no live tier M or S in CI (plan 40's nightly checks run tier R on throwaway accounts only, decision G); the privacy page's Limited Use text and no-telemetry statement; licence checks for new dependencies (`ical.js` MPL-2.0 if chosen, imapflow MIT, a public-suffix package for redirects; Stalwart AGPL as test-only, never bundled); the public releases repository so verification links resolve (ARCH Decision 11); a Linux Docker job by week 6 for PV1b's conformance tier; the 0.2.4 release itself must not wait for plan 40's Q0 (it uses the existing release process if Q0 is not ready).

> **What this means:** We hand the engine team a single door for providers, hand the UI team plain status facts, and hand the platform team test suites and security paperwork. The cross-plan edits are listed and already reconciled, so nobody has to guess where the plans meet.

## 8. What to read first

For every agent on this plan, in order: this file; `plans/ARCHITECTURE.md` §4-§7, §12.4-§12.5, §15; `RC/protocols/proto-google.md` (all; §1, §2, §3, §9 are the working core); `RC/protocols/proto-others.md` (§0, §2.3, §6, §7, §8); `RC/SYNTH-architecture.md` §3, §4. By milestone:
- PV0: `RC/protocols/proto-google.md` §0-§3 and §9 D1-D7; `apps/desktop/src/main/google.ts:95-260`, `src/engine/{gate.ts,service.ts:580-690}`, `tests/integrations.test.ts:190`; plan 10 E0; plan 30 U0.
- PV1a, PV1b, PV2: `RC/arch/mailspring.md` (testing and personalities), `RC/arch/emailengine.md` (tests, IDLE lifecycle), `RC/arch/pimalaya.md` (Neverest tests, batch curve), `RC/arch/stalwart.md` §fixture, `RC/arch/zero.md` (unit reservations), `RC/arch/extra-bulwark-legacy-proxy.md`.
- PV3, PV4: `RC/arch/zero.md`, `RC/arch/nylas-sync-engine.md` (draft-by-Message-ID), `RC/arch/extra-flectar-mail.md` (generation sweep), `research/inbox-zero/*.md`.
- PV5: `RC/protocols/proto-google.md` §8; `research/pr21-onboarding-review.md` (connect-flow findings; PR #21 is not merged by this plan).
- PV6, PV7: `RC/arch/geary.md` (threading), `RC/arch/deltachat-core.md` (interrupt model), `RC/arch/extra-parula-mustang.md` (JMAP loop), `RC/gaps/macos-daemon-lifecycle.md` §5 (wake).
- PV8, PV9: `RC/protocols/proto-google.md` §7; `RC/protocols/proto-others.md` §4.
- Live code: `apps/desktop/src/main/{google,microsoft,imap,imap-session,imap-index,jmap,caldav,ical}.ts`, `src/engine/{gate,provider,ports,service}.ts`, `scripts/emulation/*.ts`, and the matching tests; `SPEC.md`, `DECISIONS.md` (2026-10-15 ops order, 10-16 M26 and M29), `PROGRESS.md`, `TODO.md` (M11 is the unchecked live-verification item this plan finally closes).
- Provenance: GPL, AGPL and unlicensed projects supply ideas only; copy no code, assets or wording.

> **What this means:** Read the Google and other-provider reports first, then only the research for the step you are on. Ideas from other mail apps are welcome; their code never is.

## 9. PR and branch strategy within the revamp

- **Base.** Everything except PV0 branches from `revamp`; pull requests target `revamp`, never main. Nothing goes to main without the owner. PR #21 is neither merged nor rebased by this plan.
- **Branch names.** Git cannot hold a branch `revamp` and branches named `revamp/...` at the same time (`cannot lock ref 'refs/heads/revamp/x': 'refs/heads/revamp' exists`; checked). All plans therefore use `rv/<workstream>/<slug>` (`plans/00-roadmap.md` §4). This plan runs on the Providers & Sync thread: `rv/providers/pv<N>-<slug>` per milestone and `rv/providers/pv<N>-wp<M>-<slug>` per work package, each in its own git worktree; no branch name is ever a folder of another.
- **The one exception: PV0, on one 0.2.4 train.** The train is **one branch, `hotfix/0.2.4`, cut from main at `72095ff` and owned by PV0**. Each slice is developed on its own short branch from main and joins by PR into `hotfix/0.2.4`, opened only on the owner's yes (ARCH Decision 1, recommended yes); the owner merges the train to main and tags 0.2.4 from main. Merge order:
  1. **PV0** (`hotfix/0.2.4-gmail`, 5-7 days), the payload. It codes against E0's `Logger` interface and ships with a minimal redacted stub behind that interface if E0 is not ready. It touches `Reader.tsx` only for one `thread.open` call.
  2. **Optional slices, only if ready when PV0 is:** plan 10's **E0** logger (`hotfix/0.2.4-log`); plan 30's **`srcdoc` stopgap** in `Reader.tsx` (`hotfix/0.2.4-srcdoc`, rebased on PV0 so the two Reader edits do not collide); plan 40's **Q0-main** releases-home switch (`hotfix/0.2.4-releases-home`) and **Q5A-main** site and privacy page (`hotfix/0.2.4-site`). **PV0 never waits for any of them**; a slice that misses the train ships later or only on `revamp` (RELEASING.md's existing process is enough for PV0).
  Main is then merged into `revamp` at step 0 of plan 10's freeze window, so the old-model fix does not vanish; a slice that lands on main after the format commit comes back through plan 40's `format-merge.mjs`. PV3 supersedes PV0, and its first PR moves `google.ts` and `gate.ts` by `git mv` and deletes the pacer.
- **Milestone branches** (several PRs when large): `rv/providers/pv1a-emulator`, `rv/providers/pv1b-fakes`, `rv/providers/pv2-governor`, `rv/providers/pv3-gmail`, `rv/providers/pv4-gmail-writes`, `rv/providers/pv5-verify`, `rv/providers/pv6-imap`, `rv/providers/pv7-jmap`, `rv/providers/pv8-recurrence`, `rv/providers/pv9-calendars`, `rv/providers/pv10-graph`, `rv/providers/pv11-hardening`; plan 10's E2a, which this thread runs, is `rv/providers/e2a-store`. PV6, PV7, PV8 and PV10 touch disjoint folders and may run at once.
- **Order of merges.** PV1a before PV2 and PV3; the port types merge with plan 10's C1 contract freeze (end of E1); PV2 before PV3 merges, though PV3 starts earlier on the stub; the Gmail rewrite lands behind plan 10's legacy bridge (E2b, reads and writes) so every build stays launchable (ARCH §15). During plan 10's E1 freeze window (its §9: merge main, rename, Q1a format, contract skeleton, codemod, Q1b; 24 hours) no plan 20 PR touches `src/engine`, `src/main` or renderer call sites; plan 20 rebases after each. The old adapter files are moved or deleted only in the PR that makes their replacement pass the old tests.
- **Review budget.** One review pass per PR, batched. Do not re-trigger Cubic after every fix; verify locally with `npm run typecheck`, `npm test` and the emulator suites first, and ask for review once per milestone (owner preference, memory note "Cubic review budget").
- **Commits.** Authored as Kainoa Newton <k@kainoa.me>, each ending with the attribution line the harness provides. Flag any repo whose `git config user.email` differs before committing.
- **Evidence in PRs.** A PR that checks an acceptance item links the emulator run and, where the item is live, the content-free evidence file from §5.4. Live items are checked in PROGRESS.md only with that file. No screenshots of mail are attached; plan 30 owns visual evidence.
- **Secrets.** Never commit `.env`, tokens, test vaults or evidence containing addresses. Run the history scan from plan 40 before the repository ever goes public.

> **What this means:** Work happens on branches off `revamp`, in small batched reviews. Only the 0.2.4 Gmail fix goes to main on its own, on one agreed branch that a few other small fixes may join if they are ready, and only when you say so. Later stable releases reach main when you merge `revamp`.

## Evidence index

`plans/ARCHITECTURE.md` (§4-§7, §10, §12, §13, §15, ADR-03, ADR-09, ADR-10, ADR-20, Decisions 1-4, 11); `plans/DESIGN.md` (§7.11, §7.12, §7.15); `plans/_council/CONTEXT.md`; `RC/protocols/proto-google.md` (§1.1, §1.2, §2, §3, §5, §6, §7, §8, §9 D1-D25); `RC/protocols/proto-others.md` (§0-§8, defects M1-M10, I1-I10, J1-J7, C1-C4, X1-X3); `RC/SYNTH-architecture.md` (§3, §4, §8, §12.1); `RC/arch/mailspring.md` (lines 236-238, 277), `emailengine.md` (225-231, 290), `pimalaya.md` (211), `stalwart.md` (279), `geary.md` (233), `nylas-sync-engine.md`; `research/pr21-onboarding-review.md`; `plans/10-engine-foundation.md` (§3, §4.0, E0-E8, §7.1, §9), `plans/30-ui-revamp.md` (U0, §8.2), `plans/40-platform-quality.md` (§6.8, Layer 2 smoke, §8); Aplos main `72095ff`: `apps/desktop/src/main/{google.ts:110-133 (retry loop and the rate-reason regex), :162, :179, :201, :310, microsoft.ts:33, oauth-config.ts}`, `src/engine/{ports,provider,gate}.ts`, `src/engine/service.ts:584-586, :669, :678`, `src/main/{preload.ts:8, electron.ts:20, server.ts:15}`, `src/renderer/App.tsx:179`, `tests/integrations.test.ts:190`, `scripts/emulation/`, `.github/workflows/release.yml`, `TODO.md` M11.
