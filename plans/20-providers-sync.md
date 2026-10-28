# Workstream plan 20: Providers, sync and connectivity

Planning only, 2026-10-27, branch `revamp`. Nothing here is implemented and nothing from this phase goes to main without the owner. This plan executes `plans/ARCHITECTURE.md` (the binding decisions; cited as ARCH) for everything that talks to a mail or calendar provider. `plans/DESIGN.md` (cited as DESIGN) is binding only where a provider state reaches the screen.

**Conventions.** `RC/` means `research/email-clients/`. Evidence labels as in ARCH: **[V]** verified in a research report or Aplos file (path given); **[C]** a project's own claim; **[S]** secondary source; **[I]** inference; **[U]** unverified, to be settled by a named live experiment (§5.5). Where research and `plans/_council/CONTEXT.md` disagree, CONTEXT wins: Aplos releases are Developer ID signed and notarized; the repository is private; Google OAuth is in Testing mode; Microsoft has no client ID; the first real Gmail sync failed with 403. Defect ids `D1-D25` come from `RC/protocols/proto-google.md` §9; `M1-M10`, `I1-I10`, `J1-J7`, `C1-C4`, `X1-X3` from `RC/protocols/proto-others.md` §6. Milestones here are named **PV0-PV11** (PV1 splits into PV1a and PV1b) so they cannot be confused with ARCH's M0-M10, and plan 10's milestones are cited by their own names **E0-E8** (plan 10 §4.0 maps E to M); §4 maps all three.

`plans/00-roadmap.md` is the source of truth for sequencing. It re-cuts the PV milestones into eight `prov-*` lanes and counts in days from the owner's "go", not in weeks. The PV names stay as citations for the detail below. Anything in this plan that disagrees with the roadmap loses. The old PV0 is no longer a milestone: its pacing and error work is built into `prov-gmail` and `prov-gov` (§4), and there is no separate release for it.

## In plain English

This plan covers how Aplos talks to Gmail, Outlook, iCloud, Fastmail and calendars. **This round builds only Gmail and Google Calendar** (owner, 2026-10-27). Outlook, iCloud, Fastmail and other IMAP accounts are round 2. Their sections below stay as the design for round 2, and the shared rules frozen in this round already fit them.

Today Aplos cannot finish a real Gmail sync. Google limits how much work an app may do per person per minute, and Aplos asks for about ten minutes of work at once. Google refuses and Aplos starts over. Calendars also redownload every ten minutes, and renaming a Google event can wipe its meeting link.

There is no quick fix before the rebuild. The Gmail lane builds the fix in from its first day. Aplos counts its own requests, waits when Google says wait, shows subjects first and downloads message text only when you open a conversation. Another lane makes Google Calendar sync only changed events and keep meeting links. Outlook, iCloud and Fastmail wait for round 2.

The Google project stays in Testing mode, which costs nothing. Gmail then needs a reconnect every 7 days. Aplos warns you a day ahead, reconnects in one click and loses nothing. Opening Gmail to strangers needs a paid review, so it stays off the plan.

Two decisions below have defaults that apply unless you say otherwise. One free task is yours: creating test Gmail accounts. Nothing syncs while your Mac sleeps.

## Decisions for you

Defaults apply unless you say otherwise. On 2026-10-27 you answered decisions 1, 2, 3, 4 and 7. The roadmap also settled that there is no 0.2.4, the domain is aplos.email, the Google project stays in Testing mode with a smooth weekly reconnect, nothing costs money and there is one repo. Decisions 5 and 6 are still open. The roadmap's own decisions N3 (how the reconnect warns you) and N4 (where live Gmail checks run) also touch this plan.

1. **Google's review and the security check.** Answered 2026-10-27: no. Nothing that costs money, so no Google review, no CASA assessment and no demo video. Gmail stays in Testing mode with up to 100 listed test users and a reconnect every 7 days, made smooth (§4, PV5). Opening Gmail to strangers is a "later, if ever" item, written down in PV5.
2. **Register the Microsoft app now, and for whom?** Moved to round 2 on 2026-10-27 (Gmail first). When it comes: a free Entra app for personal and work accounts, tested with your own Outlook.com, no publisher check. Registering now needs an Azure sign-up with a card, so you decide then.
3. **Which mailboxes may live checks use?** Answered 2026-10-27, then widened the same day: automatic checks use your spare Gmail account (the "agent test account"), which you approved for full reading and AI. Agents may change it reversibly and send only to its own address. They never send to anyone else, delete permanently, unsubscribe or RSVP (full rules: roadmap, "Decisions already made"). Runs happen on this Mac at scheduled times, so no Google token sits on GitHub (roadmap N4). Anything on your main account is a check you run by hand.
4. **Should Block and "skip Inbox" rules also be created inside Gmail?** Answered 2026-10-27: yes. Keep the Gmail filter permission (`gmail.settings.basic`). Rules are mirrored with a visible label and keep working while your Mac sleeps (§4, PV4).
5. **How should Unsubscribe work?** When the sender supports one-click, Aplos sends it from your Mac after you confirm, and otherwise emails the sender or opens their page; always open the page; or off. **Default is the first.** It is one keystroke instead of a web form. Open.
6. **Which repeating-event edits ship first?** "This event only" and "all events", with "this and following" a release later; or all three at once. **Default is the first.** The third edit is where calendars most often corrupt events, so it gets its own tests. Open.
7. **If lazy bodies take longer than planned, what ships?** Answered 2026-10-27: moot. There is no interim release, so the smaller first window is not needed. The metadata-first window and lazy `thread.open` are part of `prov-gmail`, and a slip is reported to the Integrator the same day (§4).

Outside tasks for you (not decisions). All are free. None blocks the lanes from starting.

- Done 2026-10-27: the limit is 6,000 units a minute per user and 1,200,000 a minute for the project.
- Day 1: add your spare Gmail account to the Google project's test users.
- Round 2 only: the Microsoft Entra app, and throwaway iCloud and Fastmail accounts.
- Every 7 days: reconnect Gmail for yourself and the test accounts, about two minutes.
- Days 14 to 16: about an hour of live checks on your own accounts, including one send to yourself.

There is no Production switch, no brand check, no demo video and no domain work for Google. The privacy page on aplos.email belongs to the website lane (plan 40).

## Lanes and phases

Each PV milestone below maps to one lane, one phase and a range of days. Phase 0 is days 1 to 3 (freeze the shared rules), Phase 1 is days 4 to 13 (lanes run in parallel), Phase 2 is days 11 to 18 (join and check, live checks on days 12 to 16), Phase 3 is days 18 to 25 (daily use). Lanes own their paths exclusively (roadmap §2.2).

| Lane | Milestone content | Phase | Days |
|---|---|---|---|
| `prov-emu` | PV1a (Gmail emulator, fake clock, fault injector, scenario runner), the Google Calendar fake and conformance tier from PV1b, §5.4 live runner, §5.5 experiments register | 0, 1 | 1-9: Gmail by 4, Google Calendar by 6, live runner by 9 |
| `prov-gov` | PV2 (governor, lanes, actors, classifier registry, lease); the free parts of PV5 (client resolution, scope manifest and its test, granted scopes); the weekly reconnect | 1 | 4-9: HTTP client and classifier base by 5, governor by 7, accounts and reconnect by 9 |
| `prov-gmail` | PV3 with every former PV0 item (below) | 1, live in 2 | 4-12, emulator gate by 11; live runs 12-16 |
| `prov-gmail-write` | PV4 (drafts, send transport, filters, unsubscribe) | 1 | 6-12 |
| `prov-cal` | PV8's recurrence module, then PV9's Google Calendar part with RSVP | 1 | 5-13 |
| Round 2 | `prov-imap` (PV6), `prov-jmap` (PV7), `prov-graph` (PV10), CalDAV (rest of PV8), Graph calendar (rest of PV9), the IMAP, JMAP, DAV and Graph fakes (rest of PV1b) | later | not scheduled |
| Phases 2 and 3 | PV11 (hardening and soak); live checks (§5.4); deleting old provider files with the Integrator | 2, 3 | live 12-16, delete 14-17, hardening and soak 15-25 |

**Where the former PV0 items live.** The old PV0 was a hotfix. Every part that made it correct stays, inside the Gmail lanes, and the same emulator acceptance items apply. The day targets below sit inside `prov-gmail`'s days 4 to 12 and `prov-gov`'s days 4 to 9.

| Former PV0 item | Now in | Target day |
|---|---|---|
| Unit pacer and the one `GMAIL_COSTS` table | `prov-gmail` `client.ts`, from its first PR. It is the Gmail lane's governor stub. `prov-gov`'s governor replaces it by day 7 and reuses the cost table | 5, then 7 |
| Four-class error table (throttle, daily, send limit, reauth) | `prov-gmail` `classify.ts` from its first PR, on the classifier base `prov-gov` ships by day 5. The governor persists the pauses by day 7 | 5, then 7 |
| `quotaExceeded` stops and is never retried; sends never retried; zero requests during a pause, manual syncs included | Class table in `classify.ts`; `prov-gov` `methods/sync.ts` refuses manual runs during a stop | 5, 9 |
| Metadata-first window (Inbox, newest 50 threads, `format=metadata`, `fields` mask) with partial rows | `prov-gmail` `sync.ts` | 8 |
| Lazy `thread.open` and `ProviderPort.openThread` | `prov-gmail` `bodies.ts`; `ui-reader` makes the call; `eng-ai` skips partial rows | 8 |
| Cheap history rule (an unknown thread fetched only when it gains INBOX; over 150 fetches takes the fresh-window path) | `prov-gmail` `history.ts` | 9 |
| Search on Enter only | `prov-gmail` `search.ts`; `ui-ask` sends `server: true` on Enter | 9 |
| Granted scopes and the `gmail.modify` check | `prov-gov` `host/providers/oauth/**` with `prov-gmail` | 9 |
| Exact-reason logging (status, reason, method, units, pacer wait, pause class) | `prov-gmail` through the frozen `Logger` (F7) | 5 |
| EX1 to EX3 | Settled from the first live runs (§5.5) | 12-14 |

**Phase 0 work for this thread.** By the morning of day 2, send the Engine thread a proposal for `ProviderAdapter` (with `CalendarAdapter`, `findSent`, `costUnits`, `scopeCovered`), `GovernorPort`, `AccountActorHost`, the status vocabulary and the `reconnectBy` fact. Review schema 0001. Build the Gmail emulator in new files until it reproduces 0.2.3's failure. Write each lane's test plan from the acceptance lists below. Act as the Providers reviewer in the day-3 freeze review.

**A provider that is not ready by day 16 ships switched off.** The release does not wait for it.

## 1. Scope and non-goals

**In scope** (ARCH §5, §6, §7.1, §7.4, §12.4, §12.5, M0, M3, M7, M8, plus the provider half of M6):
- The adapter port and every provider adapter: Gmail REST, Microsoft Graph, IMAP and SMTP (iCloud, Fastmail IMAP, Yahoo, AOL, generic), JMAP (Fastmail), CalDAV, Google Calendar and Graph calendar.
- The per-account governor, lanes, error taxonomy, account actors and persisted cooldowns (ARCH §4, §6).
- Provider-side writes: label and flag changes, drafts, send transports, filters and rules, List-Unsubscribe capture and execution.
- Calendar sync, a client-side recurrence module and RSVP.
- OAuth client resolution, granted-scope handling and the weekly Gmail reconnect that Testing mode needs.
- The provider emulators, the conformance fixtures, the fault-injection kit and the live-provider check harness.
- The workflow-state transport over Gmail and IMAP (the hidden-label channel, with the D17/D18 fixes) and the primary-device lease protocol (ARCH §6.5, §13.1).

**Not in scope.**
- The store schema, change log, contract registry, transports, AI job queue and consent, the submissions state machine, timer loop, notifications, lifecycle and diagnostics. These are plan 10; we consume them through the port in §3.
- Any UI, copy or design. Plan 30 owns screens; we supply status codes, reasons and progress facts.
- CI wiring, signing, distribution and licence work (plan 40), except the emulator suites we hand to CI.
- Gmail over IMAP, the `mail.google.com` scope, Pub/Sub and any relay (ARCH §17). Proton beyond the Bridge note. Contacts sync (CardDAV, Graph contacts). JMAP Sieve and ManageSieve. Outlook IMAP as a doorbell (kept as a documented later option, §7 PV10). WebSocket JMAP unless the live session advertises it. `Email/queryChanges` (ARCH §17). The residue of C4: VTODO, alarms and free/busy (`freebusy-query` returns 400 on iCloud [S]). Server-side IMAP search beyond Inbox and Archive (I9's ESEARCH and LIST-STATUS) is a PV6 stretch item, not a gate.
- Google's restricted-scope review and its paid security assessment, and any other paid track. They are off the plan (PV5, "Later, if ever").
- Any reference-project code, assets, branding or wording. GPL, AGPL and unlicensed reports (Mailspring, Nylas, Stalwart, Pimalaya) are idea sources only (`RC/SYNTH-architecture.md` §12.1).

> **What this means:** This plan owns everything between Aplos's engine and the outside providers, plus the practice providers and the weekly Gmail reconnect. It does not own the database, the screens or the build pipeline.

## 2. Ground truth: what exists and what breaks

Aplos on main (`72095ff`) has the adapters in `apps/desktop/src/main/` (after Phase 0 they stay there or sit under `legacy/` folders as read-only reference until a lane replaces them; roadmap §1.1) (`google.ts` 425 lines, `microsoft.ts` 571, `imap.ts` 583, `imap-session.ts` 145, `imap-index.ts` 172, `jmap.ts` 539, `caldav.ts` 201, `ical.ts` 255) and a small original emulator for Google and Microsoft in `apps/desktop/scripts/emulation/` (154 lines, used by `tests/emulation.test.ts`). `engine/gate.ts` (39 lines) is the only scheduler. The tests `microsoft`, `imap`, `imap-session`, `jmap`, `caldav` and `sync-safety` run today and must stay green until each adapter is replaced behind the same behaviour. The one exception is `tests/integrations.test.ts:190` ("Google rate limits sent as 403 are retried"), which asserts the PR #23 behaviour that `prov-gmail` deliberately reverses and is inverted there.

Defect map. Every defect has an owning milestone and a named regression test (§5 rule 1).

| Defects | What breaks (evidence) | Fixed in |
|---|---|---|
| D1, D2, D3, D13, D14, D16 | First sync never finishes; search costs about 12,000 units a pause; a 2,000-thread archive in Gmail web costs about 240,000 units; label-only changes cost 40 units (`RC/protocols/proto-google.md` §1.2, §9) | `prov-gmail` (PV3, with the former PV0 items: paced metadata window, search on Enter, the INBOX-gain rule and a per-run cap for D3; full fix: per-message labels at zero fetch, D13/D14) |
| D4, D5, D6, D21, D25 | `invalid_grant` shown as a retryable 400; granted scopes ignored; error classes conflated (including `quotaExceeded` retried 5 times, `google.ts:110`); every connect forces consent; `sub` unchecked | `prov-gmail` (D4, D5, D6: throttle, daily, send-limit and reauth classes from the first PR), PV2 (full taxonomy for every provider), PV3 (D21, D25), PV5 |
| D7, D20 | Sends retried on the daily send limit; large sends through JSON under 45 s | `prov-gmail` (never retry a send, D7), PV4 (upload send, D20; the never-retry rule moves into the governor in PV2) |
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

**One amendment to ARCH §5.1 (A1), now recorded in ARCH as amendment AM-1 (2026-10-27; not ARCH's A1, the LaunchAgent) and going into DECISIONS.md when `eng-store` freezes schema 0001.** ARCH says opening a thread uses `threads.get?format=full` (120 units) when the thread has two or more messages, else `messages.get?format=full` (60). The engine cannot know the count. Rows built in P1 come from the newest message only; `messages.list` and `threads.list` carry no count; a `messages.get` metadata reply has none. Learning it costs a 40-unit `threads.get` minimal.
- *Arithmetic.* Probe-then-fetch costs 40 + 60 = 100 for a single-message thread (saves 20 against 120) and 40 + 120 = 160 for a conversation (loses 40). Always fetching the thread costs 120 either way. A free guess from `In-Reply-To` and `References` is unsafe: a newest message without them can still have older siblings, and a wrong guess shows a conversation with messages missing.
- *Rule (A1).* Opening a thread, and body prefetch, use `threads.get?format=full` (120). `messages.get?format=full` (60) is used only when the engine already knows the thread has exactly one message, for example one created by a `messagesAdded` history record whose thread was unknown. This keeps ARCH's intent (the cheapest correct open) without a guess. The prefetch cap (at most 20% of target) is priced at 120 per thread, so 100 prefetched threads take about 10 minutes of that lane.
- *Why not honour the ARCH wording.* It is not implementable without a paid count lookup that loses on conversations. PV3 therefore treats ARCH §5.1's "two or more messages" sentence as superseded by A1; nothing else in §5.1 changes.

> **What this means:** Every known provider bug has a home milestone and a test that proves it fixed. Aplos's own early test providers exist but are too small to catch the bugs, so they are rebuilt first.

## 3. Shape of the work: modules, the adapter port, error mapping

### 3.1 Module layout and ownership

ARCH ADR-19 names three packages (`contract`, `engine`, `mail-html`); plan 10 §3 adds `contract-fixture` and the test-only `packages/emulators`, recorded as an ADR-19 amendment in ARCH on 2026-10-27. **Adapters live in the app, at `apps/desktop/src/host/providers/<name>/`** (plan 10 §3, settled): they need Node (`imapflow`, `nodemailer`, `net`), their dependencies stay in `apps/desktop/package.json` (the only manifest electron-builder reads), and keeping them out of `packages/engine` leaves the neutral core's 400,000-byte budget and its no-`node:` portability rule untouched, with no path exception. The **neutral** parts of this plan (account actors, governor, lanes, status, lease, and the pure recurrence module) live in `packages/engine/src/sync/**` and `packages/engine/src/calendar/**` and reach adapters only through the ports in `packages/engine/src/ports.ts`. Promotion of the adapters to a `packages/providers` workspace is a later mechanical move, allowed only when a second consumer needs them (plan 10 §3).

| Path | Contents | Owner |
|---|---|---|
| `apps/desktop/src/host/providers/{google,microsoft,jmap,caldav}/` | Fetch-only adapters, one folder each. They import nothing from `electron` (so they could later move to a shared package) and are reached by the engine only through `ProviderAdapter` | `prov-gmail` and `prov-gmail-write` (google), `prov-graph` (microsoft), `prov-jmap`, `prov-cal` (caldav and calendar files) |
| `apps/desktop/src/host/providers/imap/` | IMAP and SMTP adapters (Node sockets) | `prov-imap` |
| `apps/desktop/src/host/providers/shared/` | HTTP client with no retries and abortable I/O, `Retry-After` parser (seconds and HTTP-date), classifier base, MIME/header helpers, redirect policy | `prov-gov` |
| `packages/engine/src/sync/` | Account actors, governor, lanes, status, lease | `prov-gov` (tables and store API: `eng-store`) |
| `packages/engine/src/calendar/recurrence/` | The client-side recurrence module (ARCH §5.5, ADR-20) | `prov-cal` |
| `packages/emulators/` (test-support workspace; never bundled into the app) | Provider emulators, fault kit, fake clock, scenario runner. Consumed by `eng-time`, the hardening work and plan 40's E2E job as `@aplos/emulators` in tests only | `prov-emu` |
| `apps/desktop/scripts/live/` | The live-provider runner (§5.4), implementing plan 40's `SmokeProbe` for tier R | `prov-emu` |
| `apps/desktop/src/main/{google,microsoft,imap,imap-session,imap-index,jmap,caldav,ical}.ts`, `apps/desktop/scripts/emulation/` | Today's files. Stay in place and keep working until each adapter is replaced; moved by `git mv` into `apps/desktop/src/host/providers/` in the PR that makes the replacement pass the old tests, then deleted | the lane that replaces each file |
| `apps/desktop/src/main/{oauth-config,vault}.ts`, `workflow-sync.ts`, `workflow-crypto.ts` | OAuth client resolution (moves to `host/providers/oauth/`) and the workflow transport (moves into `google/workflow.ts`) | `prov-gov` and `prov-gmail`; plan 10 owns the vault |

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

**Relation to the Phase 0 ports** (`packages/engine/src/ports.ts`, plan 10 §7.1). `ProviderAdapter` is in the ports table and is frozen as F3 at the end of Phase 0 (day 3), from this thread's proposal due the morning of day 2. `SendPort.send`/`findSent` and `DraftSyncPort` are the engine-side callers of `ProviderAdapter.send`, `saveDraft` and a `findSent(acct, messageId)` method that this sketch adds. `GovernorPort` and `AccountActorHost` are implemented in `packages/engine/src/sync/` by `prov-gov`. Until the governor merges (day 7), `prov-gmail` runs on its own unit pacer and the other adapters behind a pass-through `GovernorPort` stub, so PV3 can start before the real governor exists.

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

One table gives the lane, days, dependencies and effort for each milestone; each milestone then follows in the fixed format of the brief. Days count from the owner's "go" (day 1) and follow `plans/00-roadmap.md` §2.2 and §4. Live checks, not coding, are the constraint (ARCH §15). Plan 10's milestones are named E0-E8 (plan 10 §4.0), but the roadmap re-cut them into engine lanes, so "Needs from other lanes" names the lane or the frozen Phase 0 artifact (F1-F10, roadmap §1.2). ARCH's M-number is in its own column.

| PV | Lane | Name | ARCH | Needs from other lanes | Days | Agent-days | Gate |
|---|---|---|---|---|---|---|---|
| PV0 (folded) | `prov-gmail`, `prov-gov` | Gmail pacing and error handling, no longer a milestone | M0 | F7 `Logger`, F3 ports; the real store from day 6 | inside PV2 and PV3 | 5-7, counted in PV3 | The same emulator acceptance items, on the Gmail emulator |
| PV1a | `prov-emu` | Gmail emulator, kit, port proposal, harness skeleton | new | F3 ports (proposed by day 2), F1 | 1-4 | 8 | Emulator reproduces 0.2.3's Gmail failure |
| PV1b | `prov-emu` | IMAP, Graph, JMAP and DAV fakes, conformance tier, live runner | new | F3, F8 | 5-9, each just before its consumer | 8 | Each fake reproduces its adapter's field failure |
| PV2 | `prov-gov` | Governor, actors, error taxonomy, lease | M3a | F3 (`AccountActorHost`, `GovernorPort`), F4 (`governor_state`, `sync_state`) | 4-9 | 7-8 | Fake-clock suite green |
| PV3 | `prov-gmail` | Gmail connector, workflow channel, with every former PV0 item | M3b | `eng-store` real commit by day 6 (stub before); the Gmail emulator; the real governor from day 7 | 4-12, emulator gate by 11 | 15-17, plus 5-7 | **Gmail daily-driver gate** (live) |
| PV4 | `prov-gmail-write` | Gmail write side: drafts, send, filters, unsubscribe | M6 part | `prov-gmail` client by day 6; `eng-time` (submissions, drafts, `DraftSyncPort`, `SendPort`); `eng-html` (image-proxy address rules) | 6-12 | 7-8 | Live draft round trip |
| PV5 | `prov-gov` | OAuth readiness and the weekly reconnect | §12.5 | F4 (token-grant time), F1 (`reconnectBy`) | 4-9 | 6 | Scope-manifest test green; a reconnect keeps queued changes |
| PV6 | `prov-imap` | IMAP, iCloud, Yahoo, generic | M7a | IMAP emulator; real store (placements, per-folder `sync_state`); `eng-time` (Drafts) | 5-12 | 12-13 | iCloud live pass |
| PV7 | `prov-jmap` | JMAP and Fastmail | M7b | JMAP emulator; real store; `eng-time` | 6-11 | 7-8 | Fastmail live pass; with PV6 this is ARCH M7's **multi-provider daily-driver gate** |
| PV8 | `prov-cal` | Recurrence module and CalDAV | M7c | DAV emulator; real store (`calendars`, `events`) | 5-9 | 10 | Golden corpus green |
| PV9 | `prov-cal` | Google Calendar, Graph calendar and RSVP | M8a | Google calendar emulator; PV8; the governor's `gcal` and `graph` budgets | 9-13 | 10 | Live edit keeps Meet link |
| PV10 | `prov-graph` | Microsoft Graph mail (dark) | M8b | Graph emulator; `eng-time` (Drafts, `SendPort`) | 7-13 | 10 | Emulator proof; live when the Entra app exists |
| PV11 | Providers with the Integrator | Hardening and the final provider gate | M10 | Switch to the real engine done; `eng-host` diagnostics | Phases 2-3, days 15-25 | 5 | All defect tests pass; soak clean |

**Round 1 scope (owner, 2026-10-27).** This round runs PV1a, the Google Calendar part of PV1b, PV2 to PV5, PV8's recurrence module, PV9's Google part and PV11. PV6, PV7, PV10, CalDAV and the Graph calendar are round 2. That removes three lanes and roughly 40 agent-days, which go to Gmail depth instead: more emulator scenarios, longer soak and earlier live runs.

**Capacity, honestly (as first planned, all providers).** The column sums to about 115 agent-days across eight lanes. Plan 10's E2a no longer sits on this thread; the roadmap merged it into `eng-store`. The plan is feasible only because the lanes run in parallel on disjoint folders from day 4 to day 13, and the owner's review and the live passes (Gmail, iCloud, Fastmail, later Outlook) then become the limit. The critical path is the Gmail chain: `eng-store`'s real `store.commit` and change log (day 6), `prov-gmail` on the real store and, from day 7, the real governor, the emulator gate (day 11), scheduled live runs on the agent test account (days 12 to 14), and the owner's hand check on their own Gmail (days 14 to 15). The workflow-channel and lease work packages of PV3 run on a second agent so the Gmail gate does not wait for them. **Cut order if the schedule slips:** PV10 live parts (dark anyway), PV9's Graph calendar, "this and following" edits (Decision 6), PV4's filters and unsubscribe, then PV7's WebSocket path. Nothing in the Gmail read path is cut. A provider that is not ready by day 16 ships switched off.

PV3 is the long pole (PV6 was the other one, now round 2). `prov-gmail` starts on day 4 against its own unit pacer and plugs in the governor when `prov-gov` merges it (by day 7, day 9 at the latest).

### Gmail pacing and error handling (formerly PV0; now inside `prov-gmail` and `prov-gov`)

**Goal.** A real Gmail account finishes a first sync under the 6,000-unit quota, shows subjects first, downloads message text only when a thread is opened, stops instead of hammering when Google refuses, and records the exact refusal. This used to be a hotfix on the old data model. It is now the first thing `prov-gmail` builds, on the new store and ports, so the first live run on a test account already behaves this way. Nothing here may be dropped when the lane is re-cut: the unit pacer, the four-class error table, the `quotaExceeded` stop, the metadata-first window and lazy `thread.open` are what make the first sync finish.

**Why the first 0.2.3 sync fails, in one paragraph** (`RC/protocols/proto-google.md` §1.2, §9 D1). 500 `threads.get?format=full` at 120 units is about 60,000 units; four workers spend 6,000 in 5-10 s; each request then retries for about 31 s, the window needs about 50 s to free budget, one thread runs out of retries, `Promise.all` rejects, nothing is committed, and the gate starts over 30 s later. PR #23's retry (`google.ts:110-133`) cannot help and is itself wrong in one respect: it lists `quotaExceeded` among the retryable rate reasons, but that reason means a quota that will not clear in seconds.

**Deliverables.**
1. **Unit pacer** in `host/providers/google/client.ts` (about 60 lines). Until `prov-gov`'s governor lands (day 7) it is the Gmail lane's `GovernorPort` stub for Google only, so `prov-gmail` never runs unpaced. The governor then replaces it and reuses the cost table. One `GMAIL_COSTS` table, priced from `RC/protocols/proto-google.md` §1.1 (`getProfile`/`labels.list` 1, `history.list` 2, `messages.list` 5, `threads.list` 10, `messages.get` 20 metadata or 60 full, `threads.get` 40 metadata or 120 full, `messages.attachments.get` 20, `threads.modify` 10, `messages.modify` 5, `messages.batchModify` 50, `messages.insert` 25, `messages.send` 100). A sliding 60-second log per account with a target of **3,000 units per minute** (50%, because other Macs and any older build share the quota, ARCH §6.5), one request in flight, and a priority for the interactive open. Every call waits for budget and never sends past it, workflow rounds and sends included.
2. **Classification and pause (D1, D4, D6, D7).** No retry loop and no `RATE_REASONS` regex exist in the new adapter. Four classes replace them, in `classify.ts`. Classification reads status, reason and message text, because the per-minute refusal can carry only `rateLimitExceeded`.

   | Class | Matches | Action |
   |---|---|---|
   | throttle | 429 or 403 `rateLimitExceeded`, `userRateLimitExceeded`, `RATE_LIMIT_EXCEEDED`, `RESOURCE_EXHAUSTED`, `concurrentLimitExceeded`, 429 "Too many concurrent requests" | Pause this account's Google calls for `Retry-After` (seconds and HTTP-date, no 30 s cap), else 60 s, then 5 min, then up to 1 h; reset after 10 quiet minutes; halve the pacer target (floor 1,000), regrow 250 per minute after 10 quiet minutes. The failing request is not retried inside the adapter; it throws a `GoogleError` carrying `retryAfterMs` |
   | daily | 403 `dailyLimitExceeded`, **`quotaExceeded`** (never in a retry list), bandwidth caps | **Stop and surface, never retry.** The account's Google calls stop until the next midnight Pacific [C] (Calendar `quotaExceeded`, which is an anti-abuse limit: 3 hours); the error shows Google's own reason and the resume time |
   | send limit | 429 with "Mail sending" text, on any send | Never retried; the message stays failed with "until HH:MM" (D7) |
   | reauth | token endpoint `invalid_grant` or `admin_policy_enforced`; a 401 that persists after one forced refresh | Account status `needsReauth` with a reason; sync and op flush stop for that account; Reconnect is shown (D4) |

   While a pause or stop is active, the client throws at once without a network request, so no call can leak out of it. The pause state lives in memory until `prov-gov`'s governor persists it in `governor_state` (day 7); a restart before then forgets it and costs at most one request before the stop is re-learned. 5xx and timeouts are `transient`: the adapter throws and the actor backs off with jitter. There is no retry inside the adapter.
3. **The actor and `Sync/request` honour it (X1).** The account actor uses the error's `retryAfterMs` for its next attempt (never earlier than its own backoff). `methods/sync.ts` (`prov-gov`) refuses manual runs while a stop or pause is active; today `manual` returns true during backoff (`gate.ts`), so the Sync button bypasses any pause. A reauth error sets `needsReauth` and nothing else; a throttle or daily class sets `paused(until, reason)` with Google's reason code. Copy is plan 30's: the engine supplies the code and the time, never a sentence.
4. **Metadata-first window (D1, D16).** The first window lists Inbox only (no `includeSpamTrash`), newest 50 threads, then `threads.get?format=metadata` with the From, To, Cc, Subject, Date, Message-ID, List-Unsubscribe, Precedence and Auto-Submitted headers (ARCH §5.1's nine, which Home's `laneFor` needs) and a `fields` mask (40 units each, about 2,000 units, one request in flight). Thread rows carry the snippet as text and the frozen `partial: true` flag (F1). Each 50 threads commit with the page token, so a pause, a kill or a stale re-run resumes at the last committed page. A **per-run memo** of fetched but uncommitted threads covers the rest, so a retry does not re-spend the window.
5. **Lazy bodies.** `ProviderPort.openThread` (F3) runs `threads.get?format=full` (120 units, interactive priority, resolving body-part attachments as today's `fullThread` does) behind the engine's `thread.open {id}` call. The call replaces the thread's messages while keeping workflow fields and emits the usual change. `ui-reader` calls it when a selected thread has a partial row and shows the snippet meanwhile. Summaries, Ask context and AI jobs skip a thread with a partial row until it is opened (one guard in `eng-ai`), so the model is never given snippets as if they were mail. The contract registry generates the method lists and clients (F2), so there are no hand-kept allowlists to edit.
6. **Incremental sync stays cheap (D3).** In `history.ts`, an unknown thread is fetched only when a `labelsAdded` record for it includes `INBOX` (history records carry `labelIds`); added or changed threads are fetched as metadata, not full; known label-only changes cost nothing once per-message labels apply at zero fetch (D13, D14, below). If a single history pass would need more than 150 thread fetches it takes the fresh-window path instead, which bounds the cost.
7. **Search on Enter only (D2).** The contract's search input carries `server: boolean`. `ui-ask` runs the local search while typing and sends `server: true` on Enter, which runs `messages.list?q=` for 10 results and then metadata (about 210 units) in `search.ts`.
8. **Granted scopes (D5).** The token response's `scope` is stored on the account; connect is refused without `gmail.modify` in a plain sentence; Calendar and settings capabilities follow the grant instead of a fixed flag (`prov-gov`, PV5).
9. **Log.** Google's exact status, reason, message (truncated to 300 characters), method, units, pacer wait and pause class go through the frozen `Logger` (F7: redacted allowlist, 10 MB x 5 rotation); no bodies, subjects, addresses or tokens.

**Owns/touches.** `host/providers/google/{client,classify,sync,history,bodies,search}.ts` (`prov-gmail`); the shared HTTP client and classifier base in `host/providers/shared/**` and `methods/sync.ts` (`prov-gov`). Today's `apps/desktop/src/main/google.ts` and `gate.ts` are read-only reference (now under `legacy/`); the retry test at `tests/integrations.test.ts:190` ("Google rate limits sent as 403 are retried") asserts the PR #23 behaviour this work reverses, so it is inverted in the PR that replaces the adapter.

**Depends on.** `eng-store`'s real `store.commit` and change log (day 6; an in-memory fake store behind the same interface before then), the Gmail emulator from `prov-emu` (day 4), the frozen `Logger` (F7) and `ProviderPort.openThread` (F3). The governor from `prov-gov` is not a dependency of correctness: the lane's own pacer covers days 4 to 7. Owner action: confirm 6,000 units per minute in the Cloud console.

**Acceptance (the emulator gate by day 11; live runs on the agent test account days 12 to 14, then the owner's own Gmail by hand on days 14 to 15; mocked Google never counts as live acceptance).**
- A real first sync completes with the first rows visible within 45 s, zero refusals in the log, and the logged units-per-minute series never above 3,000.
- Opening a thread shows its text (the log shows one `threads.get` full); a typed search makes zero Google calls until Enter (spy test).
- The log shows the reason of any refusal, which settles experiments EX1 and EX2 (§5.5).
- Emulator (the Gmail emulator, which refuses above 6,000 units per minute and returns message-only `rateLimitExceeded`, `quotaExceeded`, `dailyLimitExceeded`, a concurrency 429 and "Mail sending"): a 500-thread mailbox syncs its window with zero refusals; `quotaExceeded` produces one request and then a stop until the stated time; a send is never retried; `invalid_grant` ends in `needsReauth` with no further calls; a manual sync during a pause makes zero requests; a stale re-run costs under 100 units; 2,000 threads relabelled elsewhere cost under 2,500 units.
- Decision 7 is moot, so there is no smaller fallback window. If the metadata window or lazy bodies run past day 11, the lane posts a SLIP in `plans/STATUS.md` the same day and the Integrator decides. The lane never ships unpaced.

**Branches.** `rv/prov-gmail/<slug>` and `rv/prov-gov/<slug>` (§9). Only the Integrator merges.
**Work packages.** Fan out four agents: (A) pacer, classes and the actor's pause handling (with `prov-gov`); (B) metadata window, memo, history rule, `openThread` and `thread.open`; (C) reauth, scope check, search on Enter and the test inversion; (D) logging calls and the emulator acceptance runs. Verify adversarially: a reviewer with the emulator and only Google's documents tries to produce a run that retries a send, runs two requests in flight, exceeds 3,000 units in 60 s, retries after `quotaExceeded`, loops on `invalid_grant`, sends a request during a pause, or gets past a pause with repeated manual syncs.
**Estimate.** 5-7 agent-days inside PV3's days 4 to 12, plus the live checks. The lazy-body hook and the pacer are the difference from a bare retry fix.

### PV1a: Gmail emulator, kit, port and harness skeleton

**Goal.** A fake Gmail that fails the way the real one does, a port to build against, and a live harness skeleton: everything PV2 and PV3 need, nothing they do not. The proof of faithfulness is that the unmodified 0.2.3 Gmail adapter fails on it exactly as it fails in the field. It replaces today's small emulator in `scripts/emulation/` for Gmail, and `prov-gmail` runs its acceptance items on it.
**Deliverables.**
1. **Gmail emulator** (`packages/emulators/gmail`). A sliding-window 6,000-unit per-user meter with the §1.1 price table (`RC/protocols/proto-google.md` §1.1); a configurable concurrency cap answering 429 "Too many concurrent requests for user"; `fields` masks honoured; the batch endpoint with a 100-call cap and a refusal curve of 0% at 10, 1.2% at 25, 19% at 50 calls [C, `RC/SYNTH-architecture.md` §3.2]; `history.list` with non-contiguous ids, per-record label ids and 404 on expiry; drafts, filters, `messages.send` with the "Mail sending" 429; `dailyLimitExceeded`; message-only `rateLimitExceeded` and `Retry-After` in both formats; a switch that makes `messages.get` cost 5 (grandfathered project).
2. **Kit.** Fake clock (so 60 s, 5 min and 1 h backoffs run in milliseconds), fault injector (drop connection mid-page, 403/429 storm, corrupt page, kill the engine process between two named points), and a scenario runner with `db_matches_server` and invariant checks after each scenario (`RC/arch/mailspring.md` line 277).
3. **Port.** §3.2 types, the classifier base and the status vocabulary, proposed to the Engine thread by the morning of day 2 and frozen as F3 on day 3 (ARCH §6.4).
4. **Live harness skeleton** (§5.4), implementing plan 40's `SmokeProbe` interface for tier R.
**Owns/touches.** `prov-emu`: `packages/emulators/**` (Gmail emulator, kit), `apps/desktop/scripts/live/**`, `scripts/smoke/probes/**`; replaces the Gmail half of `scripts/emulation/`. The ports (`packages/engine/src/ports.ts`) are proposed here and owned by `eng-contract`; the shared HTTP client belongs to `prov-gov`.
**Depends on.** The Engine thread's restructure (day 1) and the frozen ports and status types (F3, F1, day 3). Work before the move lands is new files only in `packages/emulators`, so nothing needs to move. `plat-ci`: a Linux CI job is needed only by PV1b.
**Acceptance.**
- The 0.2.3 `google.ts` run against the Gmail emulator never completes a 500-thread first sync and logs the D1 sequence; the committed test asserts the old failure and is inverted when `prov-gmail`'s fix lands. `prov-gmail`'s adapter completes it (the same emulator proves the former PV0 items).
- A seven-scenario smoke runs in under 60 s with the fake clock.
- The port and status vocabulary are reviewed by the Engine thread and frozen as F3 and F1 (day 3).
**Work packages.** Fan out one agent for the Gmail emulator, one for the kit, one for the port and harness skeleton. Verify adversarially: a separate agent, given only the vendor docs and not the emulator, writes ten "this must be refused" requests and runs them; any request the emulator accepts is a fidelity bug.
**Estimate.** 8 agent-days, days 1 to 4 (1 day of review).

### PV1b: IMAP, Graph, JMAP and DAV fakes and the conformance tier (round 1 builds only the Google Calendar fake and the conformance tier)

**Goal.** The other providers' practice servers, each delivered just before the milestone that needs it (IMAP by day 5, JMAP and DAV by day 6, Graph by day 7), so they are not on PV3's path. Each reproduces its 0.2.3 adapter's field failure first.
**Deliverables.**
1. **IMAP fixture server** (own implementation) with **personalities**, each quirk citing its source: `icloud` (no QRESYNC, `UID FETCH n:*` returns nothing above max UID, folder names Sent Messages and Deleted Messages, a connection cap of about 5 [S], no Sent copy on SMTP), `yahoo` (`MESSAGELIMIT` 1000, IDLE without expunges, limited mode), `exchange` (no CONDSTORE, "Request is throttled", late Sent copy), `dovecot` (full QRESYNC), `drops-idle` (kills IDLE sockets on a schedule). Pattern from Mailspring's scriptable fake with 14 personalities (`RC/arch/mailspring.md` §testing, line 236) [V], implemented from scratch.
2. **Graph emulator.** 4 in flight per mailbox and 10,000 per 10 minutes; `$batch` of 20 with per-sub-request 429 inside a 200; `Retry-After`; per-folder delta with `nextLink`/`deltaLink`, immutable ids, 410 `syncStateNotFound`, rotating refresh tokens, AADSTS errors, and a **toggle for the unverified behaviour** that filter options are baked into the `deltaLink` (M2).
3. **JMAP, CalDAV and conformance tier.** A minimal JMAP and CalDAV fake for unit tests, plus **Docker scripts for real servers on Linux CI only**: Dovecot (IMAP4rev2), Stalwart (IMAP, JMAP with EventSource, CalDAV) and Radicale (CalDAV), run strictly outside the shipped app because Stalwart is AGPL (`RC/arch/stalwart.md` line 279, `RC/arch/emailengine.md` line 229, `RC/arch/pimalaya.md` line 211) [V]. A **conformance suite** runs the same scenarios against fake and real server and fails when they disagree.
4. **Live runner** (§5.4) by day 9: per-provider probes, the content-free evidence format, and the `reconnectBy` check for expiring test-account tokens.

**Owns/touches.** `packages/emulators/**`, `apps/desktop/scripts/live/**`, CI Docker scripts (`plat-ci` runs them).
**Depends on.** PV1a (kit and port); F3; `plat-ci` for a Linux Docker job (macOS runners cannot run Docker [I]).
**Acceptance.**
- The 0.2.3 `microsoft.ts` against the Graph emulator fails the whole sync on one sub-request 429 (M1); the 0.2.3 IMAP adapter blocks an archive behind a first sync (I1); the 0.2.3 JMAP adapter fetches bodies for 500 threads (J3); the 0.2.3 CalDAV adapter sends a full expanded query per calendar every poll (C1). Each is a committed test that asserts the old failure, to be inverted when its fix lands.
- Conformance suite passes against Dovecot for every IMAP personality scenario that Dovecot can express.
**Work packages.** One agent per fake (IMAP, Graph, JMAP/DAV) plus one for the conformance tier. Verify adversarially as in PV1a.
**Estimate.** 8 agent-days, days 5 to 9.

### PV2: Governor, actors and error taxonomy

**Goal.** One budget keeper per account and one retry layer, so no adapter can be refused for pacing again (ARCH §6, ADR-09).
**Deliverables.**
- `governor.run(account, {budget, lane, cost, kind, signal}, fn)` with the six lanes and budget table of ARCH §6.2; waits, never sends past budget; a pause aborts queued and in-flight siblings through one `AbortController`.
- AIMD: Gmail targets start at 4,500 units/min on the primary device and 1,500 elsewhere; a refusal halves (floor 1,000) and starts a cooldown; 10 quiet minutes regrow 250/min.
- Cooldown escalation 60 s, 5 min, up to 1 h, reset after 10 quiet minutes; `daily` stops the budget until reset (Gmail: next midnight Pacific [C]); persisted in `governor_state`. This replaces the Gmail lane's in-memory pacer and pause state, and reuses its cost table and its throttle, daily, send-limit and reauth classes unchanged, so behaviour does not change on the day the governor merges.
- Roles: the pacer's per-device target comes from a `role` input (`primary` 4,500, `secondary` 1,500), set by a setting until the lease (next bullet) supplies it.
- Primary-device lease (`sync/lease.ts`; the protocol is in PV3): `{deviceId, until}`, 30-minute TTL, ties to the lower id (ARCH §6.5). It supplies `role`, so a second Mac defaults to 1,500 and three Macs cannot sum past 6,000.
- The classifier registry (§3.3) and the status vocabulary of ARCH §6.4.
- Account actors: own connections, cursors, op flush, incremental loop and backfill; accounts run concurrently (X2); 30 s heartbeats; a silent actor restarts alone after 2 minutes (ARCH §2.4); wake handling that reconnects with jitter.
- Old gate replaced (`gate.ts` stays in `legacy/` as reference); every SDK `maxRetries: 0` (Anthropic and OpenAI SDK defaults; the AI side is plan 10) and a lint rule forbidding `fetch` or `setTimeout` retry loops in `apps/desktop/src/host/providers`.
**Owns/touches.** `prov-gov`: `packages/engine/src/sync/**`, `host/providers/shared/**`, `host/providers/oauth/**`, `methods/{account,sync}.ts`; `eng-store` owns the tables.
**Depends on.** PV1a (emulator, kit, port proposal). The frozen ports (F3: `AccountActorHost`, `GovernorPort`), the classified-error record shared with the logger (F1, F7), and schema 0001 (F4: `governor_state`, `sync_state`, `sync_failures`, `accounts.status*`); until `eng-store`'s real commit lands (day 6), state lives in an in-memory fake store behind the same interface. The heartbeat supervisor is `eng-host`'s.
**Acceptance.** Fake-clock tests cover escalation, reset, daily stop, AIMD halve and regrow and in-flight drop to 1 on a concurrency 429; against the Gmail emulator a 500-thread sync takes zero refusals; two emulated devices (one primary at 4,500, one at 1,500) stay under 6,000 sustained; a kill and restart reads the persisted cooldown and does not hammer a paused account; a property test shows no call is sent while the budget is exhausted.
**Work packages.** Fan out: governor and lanes; AIMD and persistence; classifier registry; actor runtime and wake. Verify adversarially: a reviewer writes a fuzzer that interleaves refusals, aborts, restarts and clock jumps and asserts the invariants "units in any 60 s window never exceed the target" and "exactly one retry layer".
**Estimate.** 7-8 agent-days, days 4 to 9 (HTTP client and classifier base by 5, governor by 7, accounts and reconnect by 9).

### PV3: Gmail connector, lease and workflow channel (the daily-driver gate; `prov-gmail`, with the lease in `prov-gov`)

**Goal.** Inbox in seconds, the rest quiet, local edits that never flip back, three Macs sharing one quota, and real data proving it (ARCH §5.1, §6.5, M3; ARCH puts the lease in M3, so it ships with the connector, not later).
**Deliverables.**
- **Every former PV0 item**, from the lane's first PR: the unit pacer and cost table, the four error classes with the `quotaExceeded` stop, the metadata-first window, lazy `thread.open`, the cheap history rule, search on Enter, granted scopes and exact-reason logging (previous section). The phases below extend that window and never replace its pacing.
- **First sync P0-P5** exactly as ARCH §5.1: cursor first, Inbox list deduped by thread, newest message as `format=metadata` with a `fields` mask and the nine headers, commit per 50 threads with the page token, Sent 30 days, prefetch at most 20% of target, idle backfill to 90 days. **`baseline_done_at` marks the first window:** it is set when P1's newest ~50 Inbox threads are committed, never at the end of backfill. The checkpoint facts for the loading screen are connected, `found` (an optional estimate, only when the provider gives one), read n of the first-window total, `resumeAt` and a reason code. Pages from P2 onward are backfill: they never create notifications or count as new mail. HTTP batches start at 10 and follow AIMD (growth by 5 to 25). A User-Agent containing `gzip` and a measured size check (D19).
- **Incremental:** `history.list`, all four types, 500 per page; label deltas applied at zero fetch (D13); added messages fetched as metadata; `DRAFT` skipped unless tracked (D9); unknown thread fetched only when it gained `INBOX` (D3); cursor advanced per history page; a 404 triggers a bounded Inbox resync and a generation sweep (D10). Cadence 15 s focused, 60 s without a window, 5 min on battery, immediately on wake, network change and focus, plus or minus 25% (`RC/protocols/proto-google.md` §5A).
- **Thread model:** per-message labels; status from messages not in Trash or Spam (D8); snippet entities decoded (D22).
- **Home lane inputs (ARCH §8.2, DESIGN §7.2).** `laneFor` uses only what sync already has: the nine metadata headers, each message's `labelIds` (`CATEGORY_PROMOTIONS`, `CATEGORY_SOCIAL`, `CATEGORY_UPDATES`, `IMPORTANT`) and whether the user sent the thread's last message, which also drives Follow up. Delivery, reservation and bill markup and `text/calendar` parts live in the body, so the engine re-runs `laneFor` when a body arrives by open or prefetch; no body is ever fetched only to classify. IMAP, JMAP and Graph adapters pass headers and flags, with no categories.
- **Ops:** per-message, per-label, coalesced into `messages.batchModify` (50 units per 1,000); `threads.modify` for one thread; replay and fence supplied by plan 10 (ARCH §4.3).
- **Open-thread rule A1** of §2 (`threads.get` full on open and prefetch). User labels sync lazily, 25 per page, interactive lane. Body parts stored as attachments resolve in the interactive lane in batches, never serially per worker (D15).
- **Workflow channel (D17, D18) and primary-device lease** (moved here from PV4; `prov-gmail` builds the channel in `workflow.ts` and `prov-gov` the lease in `sync/lease.ts`): gate each round on `history.list?labelId=<app label>` (2 units); skip known app-data message ids; paginate past 50 copies; tie-break edit time by device id. The lease (`{deviceId, until}`, 30-minute TTL, ties to the lower id, ARCH §6.5) supplies PV2's `role`, so a second Mac running the redesigned release defaults to 1,500 and three Macs cannot sum to 13,500 against 6,000. Settings fact "Background work runs on" is plan 30's; the lease value is ours.
- **Auth:** `prompt=select_account` with `login_hint`; `sub` compared on reconnect; granted scopes stored and checked; refresh token and client id stored as one bundle with serialized refreshes (D21, D5); abort on `close()` (D23).
**Owns/touches.** `host/providers/google/{client,classify,sync,history,bodies,search,workflow}.ts` and their tests (`prov-gmail`; token handling uses `prov-gov`'s `host/providers/oauth/**`); `getSendAs` failure classes (D25); `workflow-sync.ts` and `workflow-crypto.ts` move into `workflow.ts` by `git mv`; `packages/engine/src/sync/lease.ts` (`prov-gov`). Today's `src/main/google.ts` is moved by `git mv` and the leftovers are deleted in the PR that makes the new adapter pass the old tests.
**Depends on.** `eng-store` (`message_folders`, `thread_folders`, `thread_workflow`, change log, `store.commit` with replay and fence, `sync_state`, `baseline_done_at`: schema 0001 is frozen in Phase 0 and the real commit lands by day 6) and the frozen contract and ports (F1, F3). `prov-emu`'s Gmail emulator (day 4). `prov-gov` for the real governor and the lease (day 7); before then the lane's own pacer stands in, so PV3 starts on day 4. `eng-ai` reads `baseline_done_at` (a stub actor until here); `eng-views` supplies the `Thread/act` receipts that the ops answer. There is no legacy bridge, because no release ships today's screens on the new engine. The other providers' old sync code stays in `legacy/` as reference until `prov-imap`, `prov-jmap`, `prov-cal` and `prov-graph` replace it.
**Acceptance (the emulator gate by day 11; live runs on the agent test account by the live runner, days 12 to 14, then the owner's own Gmail by hand, days 14 to 15; mocked Google never counts).**
- First 50 threads visible in under 15 s; 500 threads in about 3 minutes; zero refusals in the log.
- Kill the engine mid-backfill: it resumes from the stored page.
- A 2,000-thread archive made in Gmail web costs under 100 sync units (read from `costUnits`, cross-checked in the Cloud console quota graph).
- Delete one reply in Gmail web: the conversation stays in the Inbox.
- A draft made on a phone appears in Drafts and never inside the thread.
- The units-per-minute series is attached as evidence (§5.4).
- Two devices on the same account (two simulated devices on the emulator for the gate; live on a second Mac only if one is to hand): one holds the lease, the other stays at or under 1,500 units a minute, the combined series stays under 6,000; a workflow round with 3 copies costs under 10 units when idle.
**Work packages.** Fan out: first-sync phases; history incremental; thread and label model; ops and coalescing; auth hardening; `fields` and gzip measurement; workflow gating and lease (on a second agent, so the Gmail gate does not wait for it). Verify adversarially: (a) a property test that runs random interleavings of local ops and history pages and asserts the replay invariant "effective state equals provider state plus pending ops"; (b) a "ghost hunter" that forces cursor expiry with 20 history pages pending and asserts zero ghost threads; (c) an independent cost audit that recomputes units from the emulator's request log and compares with `costUnits`; (d) a two-device lease fuzz with clock jumps and killed holders.
**Estimate.** 15-17 agent-days, plus the former PV0's 5-7: days 4 to 12 with the emulator gate by 11, then the live runs (days 12 to 16). It ships in the one redesigned release (proposed 0.3.0), tagged from main after the owner merges `revamp`.

### PV4: Gmail write side: drafts, filters and unsubscribe

**Goal.** Drafts that follow you between devices, rules that act while the Mac sleeps, and one-key unsubscribe. (The shared state channel and the lease moved to PV3.)
**Deliverables.**
- **Drafts API** (ARCH §7.4): upload 5 s after idle and on close (15 units); skip unchanged fingerprints; serialize per draft by stable `draftId`; large drafts through `/upload/`; `DRAFT` history records with a message id Aplos did not write raise a conflict ("keep mine, take theirs, keep both"); reply threading from the selected message (D9).
- **Send transport:** the bytes sent are always the submission's pinned revision (ARCH 7.1). `drafts.send` only when `sendsRemoteDraft(payload)` is true, i.e. the remote draft is provably that revision (`baseRemoteMessageId` precondition); otherwise the pinned MIME by `/upload/…/messages/send` as `message/rfc822`, resumable above 5 MB (D20); never retried; `uncertain` settled with `rfc822msgid:` (the state machine is plan 10's, ARCH §7.1).
- **Filters:** a `sender_rules` mirror for Block and skip-Inbox through `settings.filters.create` (5 units), `list` (1); delete-and-recreate for edits; application to existing mail through `messages.list` plus `batchModify`; capability derived from the granted `gmail.settings.basic` scope. Decision 4 is answered (2026-10-27): filters are kept.
- **List-Unsubscribe:** capture `List-Unsubscribe` and `List-Unsubscribe-Post` at sync (already in the P1 header list), store in `messages.list_unsub`; execution per Decision 5: RFC 8058 one-click POST from the engine under the image proxy's SSRF rules (ARCH §10), else `mailto:` through the account, else open the page.
**Owns/touches.** `prov-gmail-write`: `host/providers/google/{send,drafts,filters,unsubscribe}.ts`, `methods/unsubscribe.ts`.
**Depends on.** `eng-time` (`submissions`, drafts table with `revision`, `DraftSyncPort`, `SendPort`, `NotSentError`; contract methods `Draft/*` and `Submission/set`, plus `Unsubscribe/run`, named in the contract at the freeze) and `eng-html` (the image proxy's address rules, ARCH §10, reused by the one-click executor); `prov-gmail`'s client by day 6.
**Acceptance.** Emulator: a draft edited on two devices raises one conflict; a send killed before the marker, after the marker and after acceptance causes no duplicate (shared with plan 10's test); a filter mirror survives a delete-and-recreate edit. Live (test account, tier M; the phone and unsubscribe steps by hand): a draft round trip to a phone Gmail app; one filter created, seen in Gmail settings and deleted; one real one-click unsubscribe on a list the owner chooses.
**Work packages.** Fan out: drafts; send and upload; filters; unsubscribe. Verify adversarially: a reviewer reads Google's draft and filter pages, then attacks edit-conflict, deleted-remotely and unchanged-fingerprint cases; another probes the one-click executor for redirect, private-address and non-HTTPS abuse.
**Estimate.** 7-8 agent-days, days 6 to 12.

### PV5: OAuth readiness and the weekly reconnect (`prov-gov`)

**Goal.** A source build or fork runs with its own OAuth clients, granted scopes drive features, and a Gmail account in Testing mode survives its 7-day token expiry without losing a queued change. The Google review and CASA track that this milestone used to carry is off the plan (the "later, if ever" paragraph at the end). Engineering is about 6 agent-days inside `prov-gov`'s days 4 to 9.
**Deliverables.**
- **Client resolution** (`host/providers/oauth/`, from `src/main/oauth-config.ts`): official builds embed official ids; source builds read `APLOS_GOOGLE_CLIENT_ID`, `APLOS_GOOGLE_CLIENT_SECRET`, `APLOS_MS_CLIENT_ID` from the environment or Settings (ARCH §14.2; `oauth-config.ts` already prefers env over bundled). The resolved client also says whether its Google project is in Testing mode, which is what turns on `reconnectBy` below.
- **Scope manifest:** one table of every scope with its feature and the exact consent text, generated from code and checked by a test. Current scopes: `gmail.modify`, `gmail.settings.basic`, `calendar.calendarlist.readonly`, `calendar.events` (`google.ts:310`) [V]. The test fails if code requests a scope the manifest lacks. Decision 4 is answered: `gmail.settings.basic` stays, because it writes filters (reading send-as addresses and signatures is covered by `gmail.modify` [I, verify against the `sendAs.list` reference before relying on it]). Adding a scope forces re-consent for every user, so a new scope needs a DECISIONS.md entry.
- **Granted-scope facts:** every token response's `scope` stored; features derived from it; "grant missing permissions" (`Account/grantPermissions`) runs a full re-consent because incremental auth is unsupported for installed apps [V `RC/protocols/proto-google.md` §8.1].
- **Token lifecycle:** `refresh_token_expires_in` honoured; the 100-token cap avoided by never forcing consent on a normal connect (D21).
- **The weekly reconnect (roadmap N3).** In Testing mode Google expires refresh tokens 7 days after consent [V `RC/protocols/proto-google.md` §8.1]. The engine side:
  1. *Grant time and `reconnectBy`.* The time of each token grant is stored on the account (a schema 0001 column, F4). For a Google account in Testing mode, `reconnectBy` is the grant time plus 7 days, or the expiry Google reports if it sends one. It is a fact in account status and `Setup/status` (F1). Other providers have none. Plan 30 draws the line in the sidebar a day ahead, the reconnect sheet and the Settings row from it.
  2. *`needsReauth` only on a real refusal.* An approaching `reconnectBy` never changes the status. The account stays `connected` and syncs until Google refuses (`invalid_grant`, `admin_policy_enforced`, a 401 after one forced refresh).
  3. *Reconnect.* `Account/reconnect` opens the OAuth flow with `login_hint` set to the account's address, so the same account is preselected. The returned `sub` must match the stored one; a different account is refused with a plain reason. Whether a repeat authorization without `prompt=consent` returns a new refresh token is [U] (experiment EX12); if it does not, reconnect alone adds `prompt=consent`.
  4. *Nothing is lost and nothing resyncs.* On success the new token bundle is stored with serialized refreshes, status returns to `connected`, queued operations, drafts and outbox items flush, and sync resumes from the stored cursors. The one exception is a history cursor Google has already expired: that takes the bounded Inbox resync of D10, never a full one. How old a cursor can be after an expiry is [U] (EX12).
  5. *While expired.* The reauth class stops every Google call at once, so an expired account makes zero requests, and local changes queue.
  6. *No notification by default.* The Mac notification is the optional alternative in roadmap decision 3. The engine sends it only if the owner picks it.
- **Live-runner checks for expiring tokens** (§5.4): before a run the runner reads each test account's `reconnectBy`. If it has passed, or falls inside the run's expected duration, the run skips that account with a clear message ("test account <label> expires <date>, reconnect it first"). A skip is its own result, never a failed gate, and the evidence file records days left to expiry.
**Owns/touches.** `host/providers/oauth/**`, `methods/account.ts`, the account half of `host/providers/shared/**`; `prov-gmail` reads the grant facts.
**Depends on.** F4 (the token-grant column) and F1 (`reconnectBy`, `Account/reconnect`, `Account/grantPermissions`); the real store from day 6 for persistence; `ui-shell`, `ui-onboard` and `ui-settings` draw the surfaces, so the engine only supplies facts.
**Acceptance.** Scope-manifest test green. A source build connects with env-supplied client ids on a throwaway project. On the Gmail emulator with the fake clock: on day 7 after the grant the refresh returns `invalid_grant`, the account becomes `needsReauth`, no further call is made, and 10 queued archives survive. Reconnecting through the emulator's consent flow with `login_hint` flushes the 10 archives, resumes from the stored cursors and makes zero resync requests (request-log assertion). A reconnect with a different `sub` is refused. `reconnectBy` is present 24 hours before it passes and is unchanged by a failed attempt. Live: the day-7 and day-14 reconnects of the test accounts and the owner's own account are real runs of this flow, and EX12 is recorded.
**Work packages.** Fan out: client resolution and manifest test; granted scopes; grant time, `reconnectBy` and reconnect flow; live-runner expiry check. Verify adversarially: a reviewer kills the engine between "token bundle stored" and "queue flushed" and asserts nothing is lost or sent twice, then reconnects with the wrong account.
**Estimate.** About 6 agent-days.

**Later, if ever.** Opening Gmail to people outside the 100-test-user list needs Google's restricted-scope review and a yearly CASA security assessment, and both cost money (`plans/40-platform-quality.md` §4A holds the old calendar, and roadmap §8.4 the decision). Both are off the active plan. Nothing here prevents it later: the scope manifest, the privacy page and the no-telemetry rule stay in place. Until then Aplos describes Gmail as available to invited testers.

### PV6: IMAP, iCloud, Yahoo and generic hosts (round 2)

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
**Depends on.** `eng-store` (`message_folders` placements, per-folder `sync_state`, `sync_failures`) and `eng-time` (the Drafts table and `DraftSyncPort`); PV1a, PV1b's IMAP fixture (day 5), PV2's HTTP client and classifier base (day 5) and governor (day 7).
**Acceptance.** Emulator: an archive issued during a first sync completes in under 2 s of fake time; `exchange` and `icloud` personalities never produce a false deletion under `MESSAGELIMIT`; killing mid-batch resumes at the last committed UID; no `BODY[]` fetched for list display (request-log assertion); a 5-minute offline gap catches up in bounded batches. Dovecot conformance green. Live (a throwaway iCloud account, Decision 3; the owner's own by hand): new mail appears within seconds; an archive made on the phone arrives; at most 2 connections per device role (server-side count from the harness); a long sync never blocks triage; the VANISHED probe result is recorded as E5.
**Work packages.** Fan out: connection actors and IDLE; capability ladder and host table; tiered fetch and gap cursor; threading; writes and drafts; imapflow upgrade. Verify adversarially: a reviewer tries to make Aplos delete mail by serving partial `SEARCH` results, a changed `UIDVALIDITY` and a dropped connection between `EXPUNGE` and its response.
**Estimate.** 12-13 agent-days, days 5 to 12, plus the live pass (days 12 to 16).

### PV7: JMAP and Fastmail (round 2)

**Goal.** Instant updates with no polling load, and a first sync that costs previews, not bodies (ARCH §5.4).
**Deliverables.**
- One EventSource per account on `eventSourceUrl` (`types=Email,Mailbox,Thread,EmailDelivery`, `closeafter=no`, `ping=60`); a watchdog after two missed pings; throttled reconnect honouring `Retry-After`; reconnect on wake; `/changes` every 60 s as a floor (J1; `RC/SYNTH-architecture.md` §3.5). Dropped events are harmless because the pull follows.
- Lists use `preview`; bodies lazy; `header:List-Unsubscribe:asURLs` (J3, J7). Limits come from the session: `maxConcurrentRequests`, `maxObjectsInGet`, `maxCallsInRequest` (J2); `rateLimit` SetErrors handled; `sessionState` change refetches the session.
- Drafts: an `Email/set` create with `$draft` in the Drafts mailbox, and edits as create-new plus destroy-old in one request [I, RFC 8621 emails are immutable apart from keywords and mailboxes].
- Single-request `EmailSubmission` kept (already idempotent; `RC/protocols/proto-others.md` §6.3).
- WebSocket only if the live session advertises `urn:ietf:params:jmap:websocket` (experiment EX7).
- API-token path stays the owner path; Fastmail OAuth and CalDAV with the same grant wait on the registration (J5, J6).
**Owns/touches.** `apps/desktop/src/host/providers/jmap/**`.
**Depends on.** `eng-store` (placements, `sync_state`) and `eng-time` (Drafts); PV1b's JMAP fake (day 6) and the Stalwart conformance job; PV2. With PV6 this is ARCH M7's **multi-provider daily-driver gate** (iCloud and Fastmail live, ARCH §15 M7).
**Acceptance.** Stalwart conformance for push and `/changes`; fake-clock watchdog test; emulator first sync with 500 threads fetches no body (log assertion); new mail visible within 3 s of delivery on the live Fastmail account; EventSource kept at one socket per account.
**Work packages.** Fan out: push loop; preview-first sync; drafts; limits. Verify adversarially: kill the stream silently (no FIN) and assert the watchdog reconnects; swap `sessionState` mid-run.
**Estimate.** 7-8 agent-days, days 6 to 11, parallel to PV6.

### PV8: Recurrence module and CalDAV (CalDAV is round 2)

**Goal.** Calendars that sync only what changed and show repeating events correctly on every server (ARCH §5.5, ADR-20).
**Deliverables.**
- **Recurrence module** (`packages/engine/src/calendar/recurrence/`): masters plus overrides stored; expansion on query for a visible range; RRULE (FREQ, INTERVAL, BYDAY with ordinals, BYMONTHDAY, BYSETPOS, WKST, COUNT, UNTIL in UTC and floating), RDATE, EXDATE, RECURRENCE-ID overrides, all-day, DST. Decision spike first: evaluate `ical.js` (MPL-2.0) against the bundle budget and licence, otherwise extend `ical.ts` (today it handles RRULE only for VTIMEZONE observances, C2). Choose by the golden corpus, not taste.
- **CalDAV sync:** one `PROPFIND Depth:1` on the home for ctag and sync-token every 5 min and on focus; changed collections run `sync-collection` (RFC 6578) then `calendar-multiget` 50 at a time; 507 paging; invalid token means empty-token resync reusing unchanged ETags; 2 in flight; `PUT` with `If-Match`, `If-None-Match: *` on create. Fallback without sync-token: `calendar-query` for ETags plus multiget.
- **Redirects:** same registrable domain only (allows `caldav.icloud.com` to `pNN-caldav.icloud.com`); otherwise drop credentials and explain (C3). Principal PROPFIND uses Depth 0 on iCloud; always send DTEND on PUT; do not trust `If-Match: *` there [S, `RC/protocols/proto-others.md` §4.2].
- Edits: single occurrence (override) and whole series; "this and following" behind Decision 6.
**Owns/touches.** `apps/desktop/src/host/providers/caldav/**`, `packages/engine/src/calendar/**`; `ical.ts` folds in.
**Depends on.** `eng-store` (`calendars`, `events` tables; the recurrence-id column is in schema 0001 from Phase 0, F4); PV1b's CalDAV fake (day 6) and the Radicale and Stalwart conformance jobs; `ui-calendar` for the edit-scope UI. The recurrence module is pure and starts on day 5 with no dependency.
**Acceptance.** A golden corpus of at least 80 cases (DST edges, ordinal BYDAY, BYSETPOS, leap day, moved and cancelled overrides, EXDATE with TZID, floating times) agrees with two independent oracles used at test time only; an idle account costs one request per poll (request-log assertion); the redirect test proves no `Authorization` header reaches another registrable domain; the Radicale and Stalwart conformance runs pass; live iCloud and Fastmail calendars show a weekly meeting with an edited occurrence correctly.
**Work packages.** Fan out: recurrence spike and corpus; sync loop; redirect and quirks; occurrence edits. Verify adversarially: a reviewer generates random RRULEs and compares with both oracles over ten years; another feeds servers that ignore expand, return 507, and invalidate tokens.
**Estimate.** 10 agent-days, days 5 to 9, parallel to PV6 and PV7.

### PV9: Google Calendar, Graph calendar and RSVP (Graph calendar is round 2)

**Goal.** Editing a Google event never loses its Meet link or guests' answers, and replying yes or no works on every calendar.
**Deliverables.**
- **Google Calendar** (own budget, 600 requests/min per user, 50% target, 2 in flight): per-calendar `syncToken` with `singleEvents=false`; primary every 2-5 min, others 15-30, list 30, all jittered plus or minus 25%; `events.patch` with `If-Match` and only changed fields (D11); 410 resyncs one calendar only; decoupled from mail sync, errors reported per calendar (D12); `hidden` and `selected` respected (D24); `forbiddenForNonOrganizer` makes shared fields read-only; 412 raises an edit conflict (`RC/protocols/proto-google.md` §7).
- **RSVP:** Google by patching the self attendee's `responseStatus` (the whole `attendees` array is replaced on patch, so send it complete with one change), with `sendUpdates` set so the organizer is told [I, experiment EX11 checks it with a second account]; CalDAV by updating the user's own `PARTSTAT` in the event resource, with the server's scheduling doing the reply [U, experiment EX11]; Graph by the event `accept`, `tentativelyAccept` and `decline` actions [I]. Non-organizers can change only their response and personal fields.
- **Graph calendars:** `calendarView/delta` per calendar over a rolling window; the token encodes the window, so a monthly re-window runs a resync of that calendar (`RC/protocols/proto-others.md` §1.1, M8).
**Owns/touches.** `apps/desktop/src/host/providers/google/calendar.ts`, `apps/desktop/src/host/providers/microsoft/calendar.ts`, `packages/engine/src/calendar/**`.
**Depends on.** `eng-store` (`calendars`, `events`); PV8 (recurrence module and edit scopes, same lane); PV2 (the `gcal` and `graph` budgets); `prov-graph`'s auth for the Graph calendar live parts only; the Google parts need nothing from it.
**Acceptance.** Emulator: a patch that changes only the title leaves `conferenceData`, reminders, colour and attendee responses byte-identical (D11 regression); one failing calendar leaves the others syncing; an idle poll costs 1 request per calendar. Live: rename an event with a Meet link and verify the link survives; RSVP to an invitation the owner sends from a second account.
**Work packages.** Fan out: Google sync tokens; patch writer; RSVP across three protocols; Graph calendar delta. Verify adversarially: a reviewer diffs the event JSON before and after every write on the emulator, field by field.
**Estimate.** 10 agent-days, days 9 to 13; the Graph calendar live parts wait for the Entra app.

### PV10: Microsoft Graph mail (round 2)

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
**Owner steps.** Entra public client registered under "Mobile and desktop applications", `common` authority, `http://localhost` redirect (port ignored), and the `127.0.0.1` URI added through the manifest; `[::1]` is unsupported [V `RC/protocols/proto-others.md` §1.5]; no publisher verification (Decision 2).
**Owns/touches.** `apps/desktop/src/host/providers/microsoft/**`.
**Depends on.** `eng-store` (placements, `sync_state`, folder scopes) and `eng-time` (Drafts, `SendPort`); PV1b's Graph emulator (day 7); PV2 (the `graph` budget). Live parts need the owner's free Entra client id (Decision 2).
**Acceptance.** Emulator: 12 concurrent callers produce at most 4 in flight; a sub-request 429 inside a 200 batch retries only that sub-request after the right wait; a 410 resyncs; a kill mid-delta resumes at the `nextLink`; with the baked-filter toggle on, the unfiltered design still reports a message moved in from last year. Live when the id exists: experiments EX4 and EX10 recorded; a first sync of the owner's Outlook.com completes with zero 429s.
**Work packages.** Fan out: scheduler; delta and checkpoints; auth and AADSTS; drafts, rules, headers; send. Verify adversarially: a reviewer runs the emulator in both filter-behaviour modes and tries to find mail Aplos misses.
**Estimate.** 10 agent-days emulator-side, days 7 to 13; the live pass is 1-2 days after the client id exists.

### PV11: Hardening and the final provider gate

**Goal.** Prove the whole provider stack under bad weather (ARCH M10). The multi-provider daily-driver gate itself is PV6 plus PV7 (ARCH M7); this is the hardening gate before the redesigned release (proposed 0.3.0). It runs in Phases 2 and 3, days 15 to 25, with the soak in the background during daily use.
**Depends on.** The switch to the real engine (days 11 to 13), `eng-host`'s diagnostics bundle and fault-injection hooks, the soak harness (`scripts/soak.ts`, which runs test accounts through our actors) and every earlier PV.
**Deliverables.** Seven-day soak with sleep, wake and battery cycles across Gmail, iCloud and Fastmail test accounts, started right after a reconnect so that it ends before the Gmail accounts' `reconnectBy` (or crossing one reconnect on purpose, which tests the flow); fault-injection runs per provider (drops, 403/429 storms, corrupt page, disk full via the engine's hook); wake and network-change reconnect verified per provider; a **provider status matrix** (what each account state looks like in the diagnostics bundle); the live-experiment register (§5.5) closed or carried forward; deletion of the old provider files and the old emulator with the Integrator (days 14 to 17); defect-test audit (§5 rule 1).
**Acceptance.** Zero ghost threads after a forced cursor expiry on each provider; zero false deletions under `MESSAGELIMIT`; zero duplicate sends; flat memory over 24 hours; Gmail units per minute never above 6,000 in the soak series; every defect id has a passing named test; a clean upgrade from a 0.2.x install keeps accounts syncing after plan 10's import.
**Work packages.** Fan out: one soak runner per provider; fault matrix; wake and network. Verify adversarially: a reviewer reads the soak evidence and tries to find an hour with a gap, a spike or a missing event.
**Estimate.** 5 agent-days, plus 7 days of elapsed soak that overlap daily use.

> **What this means:** Thirteen steps, each with a goal, a proof and a way to attack the result. The Gmail lane starts with pacing, so the first live run already finishes a sync. iCloud and Fastmail follow within the same Phase 1, calendars and Outlook finish by day 13, and live checks run on days 12 to 16. If time runs short, the cut order above says what goes first, and a provider that is not ready by day 16 ships switched off.

## 5. Test strategy

### 5.1 Rules

1. **Every defect has a named test.** Test titles begin with the defect id (`D3 bulk archive costs under 100 units`). PV11 greps the id list from the two protocol reports and fails if any is missing.
2. **Reproduce, then fix.** A defect's test first asserts the old behaviour against the emulator (`prov-emu`'s Gmail emulator for Gmail, PV1b for the others), then is inverted by the fix.
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

### 5.4 The live-provider check harness

`apps/desktop/scripts/live/`, a CLI, headless (no window is driven), owned by `prov-emu` (runner by day 9). **Tiers M and S never run in CI.** Tier R is the same probe code that plan 40's `npm run smoke:live` runs through its `SmokeProbe` interface (plan 40 Q4 Layer 2 and decision G: the agent test account only (tiers R, M and S-self), never the owner's main mailbox). By default the scheduled runs happen on this Mac at set times (roadmap N4), so no Google token sits on GitHub. A nightly GitHub run is the option the owner may pick later, and it would need a weekly token refresh there. Plan 20 writes the per-provider probes and the content-free evidence format, plan 40 owns `scripts/smoke/`, the schedule and `provider-status.json`. No token for the owner's real account is ever stored in CI; runs against the owner's account are local and manual. Local credentials come from the backend environment or a dedicated test vault outside the repository at `~/Library/Application Support/Aplos Mail Live/`, created when the owner runs a one-time interactive sign-in for each test account; nothing is printed or committed. The agent test account is listed as a test user in the Google project (up to 100). Three tiers:
- **R (read-only):** connect, first sync, incremental, idle polls, search; runs automatically on the agent test account on this Mac, and on the owner's main account only when the owner runs it.
- **M (mutating):** labels, archives, read state, stars, drafts and a run-scoped filter on the agent test account; every change is reversible, a filter is removed after the run, a flag is required, and it runs only on this Mac, never in CI. No permanent delete, no unsubscribe, no RSVP, no attendees.
- **S-self (send to self):** the agent test account sends only to its own address. The runner refuses any other recipient (To, Cc, Bcc, Reply-To) before the request is built, and a test proves that refusal. Runs only on this Mac.
- **S (send):** owner-run only, to the owner's own address. Agents never send external mail (AGENTS.md).
Each run writes a **content-free evidence file** (counts, timings, units per minute, error classes, request counts, connection counts, versions; no subjects, bodies, addresses or tokens) to `verification/live/<date>-<provider>.md`, and PROGRESS.md cites it when an acceptance item is checked. Google stays in Testing mode, so the test accounts' tokens expire every 7 days [V `RC/protocols/proto-google.md` §8.1]. Before each run the runner reads `reconnectBy` for every Google test account, skips an account that has expired or will expire during the run, says so in plain words, and records days left to expiry in the evidence file (PV5). The owner reconnects the test accounts on the same days as their own.

### 5.5 Live experiments register

Experiments are named EX1-EX14 so they cannot be confused with plan 10's milestones E0-E8 (there is no EX9).

| # | Question | Source | Settled in |
|---|---|---|---|
| EX1 | Which `reason` did the first 403 carry? | `RC/protocols/proto-google.md` open questions | `prov-gmail`, first live run |
| EX2 | Does this project's `messages.get` really cost 20 units, not 5 (grandfathering)? | `RC/SYNTH-architecture.md` §4.4 | `prov-gmail`, Cloud console |
| EX3 | Does a bulk archive in Gmail web cost under 100 sync units? | ARCH M3 acceptance | PV3 |
| EX4 | Does a filtered Graph delta hide older mail moved back, and is the first unfiltered round affordable? | `RC/protocols/proto-others.md` §9 Q1-Q2 | PV10 |
| EX5 | iCloud real connection cap, VANISHED behaviour, CalDAV expand | same §9 Q3, Q6 | PV6, PV8 |
| EX6 | Yahoo `MESSAGELIMIT` 500 or 1000, enforced or soft | same §9 Q4 | PV6 (if a Yahoo test account exists) |
| EX7 | Does Fastmail advertise the JMAP WebSocket; OAuth registration lead time | same §9 Q5 | PV7 |
| EX8 | Does Graph accept a "start from now" delta token | same §9 Q1 | PV10 |
| EX10 | Does a Graph upload-session send keep the `internetMessageId` | ARCH §5.2 [U] | PV10 |
| EX11 | Does iCloud or Fastmail CalDAV send the RSVP reply when `PARTSTAT` is updated | not in research | PV9 |
| EX12 | After a Testing-mode expiry, does a reconnect with `login_hint` and without `prompt=consent` return a new refresh token, and how old can a Gmail history cursor be and still answer? | `RC/protocols/proto-google.md` §8.1 (7-day expiry); ARCH §5.1 | PV5, first reconnect |
| EX13 | Does Gmail send `Retry-After` on the per-user 403 `rateLimitExceeded` or on 429? The emulator shows 0.2.3 would finish slowly, not fail, if it did, so the field failure suggests it does not | Providers thread, Gmail emulator gate (STATUS 2026-10-27) | `prov-gmail`, first live run |
| EX14 | Does a Testing-mode token response include `refresh_token_expires_in`? `reconnectBy` uses it when present, else grant time plus 7 days | Providers thread (STATUS 2026-10-27) | `prov-gov`, first live run |

> **What this means:** Practice providers prove the logic quickly and cheaply. Only real accounts prove the real thing, so live checks are written down, run by the owner where mail would be sent, and never replaced by mocks.

## 6. Risks and mitigations

| Risk | Likelihood and impact | Mitigation |
|---|---|---|
| A second cause hides behind the Gmail 403 | Medium, high | `prov-gmail` logs the exact reason from its first run; PV3 acceptance is live, not emulated |
| The emulators are too forgiving, so bugs survive | Medium, high | Reproduce-then-fix (PV1a and PV1b acceptance); an agent that has not seen the emulator writes refusal probes; Docker conformance tier |
| Testing mode expires Gmail tokens every 7 days | Certain, medium | The weekly reconnect (PV5): `reconnectBy`, a one-click `login_hint` reconnect, no resync, queued changes kept; the live runner checks `reconnectBy` and skips expired test accounts; the owner reconnects test accounts with their own |
| A reconnect without `prompt=consent` returns no refresh token | Medium, medium | EX12 on the first reconnect; the fallback adds `prompt=consent` to reconnect only |
| Quota math is wrong for this project (5 vs 20 units) | Medium, medium | EX2 on day one; costs live in a table the governor reads; refusal-driven AIMD absorbs errors |
| IMAP hosts misbehave in ways no personality covers | High, medium | Host table is data, not code; verbose protocol log (ARCH §11); personalities added from field reports |
| iCloud connection cap hit by three Macs | Medium, medium | Primary 2, others 1; lease; live count in the harness |
| Graph cannot be tested without a client id | Certain, medium | Ships dark; emulator in both delta modes; live pass is 1-2 days once the id exists |
| Recurrence edits corrupt events | Medium, high | Two-oracle corpus; "this and following" a release later (Decision 6); never write a series Aplos cannot round-trip, refuse and say so |
| Two threads collide on shared files | Medium, medium | Ownership table (§3.1) and the owners check; the ports are frozen as F3 on day 3; the store API is the only door |
| The metadata window and lazy `thread.open` run past day 11 | Medium, medium | A SLIP is posted the same day; pacing lands first, so the lane never runs unpaced; Decision 7 is moot |
| A stale re-run or a second Mac re-spends the first window | Medium, high | The per-run memo, page-token commits and the 3,000 target; the lease and role-based targets; two-device emulator acceptance in PV2 and PV3 |
| Plan 20 is over capacity (about 115 agent-days across eight lanes in days 4 to 13) | High, medium | PV1b just in time; parallel lanes on disjoint folders; the cut order in §4; a provider not ready by day 16 ships switched off |
| One-click unsubscribe abused for SSRF | Low, high | Reuse the image proxy's address rules; HTTPS only; confirmation first |
| Provider terms or prices change (Gmail billing "later in 2026") | Medium, low | Costs and cadences are settings; cadence is a lever (`RC/protocols/proto-google.md` §5A) |
| Live tests touch real mail | Low, high | Tiers R/M/S; owner flag for M; sends owner-only; test accounts per Decision 3 |
| Reference code leaks into Aplos | Low, high | Idea-only rule repeated in every brief; licence scan in plan 40 |

> **What this means:** The biggest risks are outside our code: the weekly Gmail expiry, Microsoft's registration and whether our practice providers are honest. The plan keeps each one small, early and checkable.

## 7. Interfaces and contracts with other workstreams

**Plan 10 (engine foundation).** Names below are plan 10's milestones (E0-E8) and ports (plan 10 §7.1).
- *We consume:* the store transaction API (`store.commit` with replay of pending ops and the mutation fence, E2), `sync_state`, `sync_failures`, `governor_state`, `provider_memory`, `message_folders`/`thread_folders`, `changes`, `ops`, `drafts`, `submissions`, `jobs`, `notifications`, `calendars`, `events`; the ports `GovernorPort`, `AccountActorHost`, `SendPort`, `DraftSyncPort` (E1, E6); the contract methods `Sync/request`, `Thread/act`, `Submission/set`, `Draft/*`, `MessageBody/get`, `Setup/*`; the diagnostics event catalog (we emit `sync.gmail.page_committed`, `governor.paused`, `send.uncertain`-style ids) and the frozen `Logger` (F7); wake and network signals and the timer loop with deadline-source registration (`eng-host`, `eng-time`).
- *We provide:* `ProviderAdapter` (§3.2) and the status vocabulary, frozen as F3 on day 3 (our proposal is due the morning of day 2); the account facts `reconnectBy` and the granted scopes; `costUnits`, cooldowns and per-account status for the diagnostics bundle (E7); the baseline marker semantics (`baseline_done_at` set when the first window, P1's newest ~50 Inbox threads, is committed; never at the end of backfill; backfill pages never notify) so AI and notifications stay silent until then; the lease role; the emulators and fault kit in `packages/emulators` (`@aplos/emulators`) for E6 and E8; the `trainsOnInputs` fact for AI-provider eligibility is theirs, the Google policy consequence is ours.
- *Cross-plan edits, now reconciled (2026-10-27, `plans/00-roadmap.md`):*
  1. Adapters live in `apps/desktop/src/host/providers/<name>/` (plan 10 §3); neutral actors, governor and recurrence live in `packages/engine/src/{sync,calendar}/**`; emulators in the test-only `packages/emulators`. Plan 10's portability rule needs no path exception.
  2. `ProviderAdapter` (with `findSent`) is in plan 10's §7.1 ports table and frozen as F3; `SendPort` and `DraftSyncPort` are its engine-side callers.
  3. Plan 10's contract names `Account/connect`, `Account/reconnect` and `Account/grantPermissions` (D5), `Unsubscribe/run` (today's `thread.unsubscribe`), `Event/set {scope: occurrence|series|following}` and `Event/rsvp` in the contract freeze (F1); this plan supplies their behaviour (PV3, PV4, PV8, PV9).
  4. There is no 0.2.4 and no hotfix train. Plan 10's E0 logger became Phase 0 artifact F7, and the Gmail pacing work is built into `prov-gmail` and `prov-gov`.
  5. The ARCH §5.1 amendment A1 (§2) is recorded in ARCH's amendments section as AM-1 (2026-10-27) and goes into DECISIONS.md when `eng-store` freezes schema 0001.
  6. The schema 0001 review (F4) includes the recurrence id on `events` rows, `message_folders` keyed for IMAP placements and the token-grant time before the freeze.
- *To settle in Phase 0:* who owns the governor code (`prov-gov`: provider budgets and `packages/engine/src/sync/`; `eng-ai`: the AI governor, sharing one base class); the lease role input.

**Plan 30 (UI).**
- *We provide:* account states (`needsReauth`, `needsPermission`, `needsAdmin`, `misconfigured`, `paused(until, reason)`, `offline`, `backfilling(n of m)`), first-sync checkpoint facts for the loading screen (connected, `found` as an optional estimate, read n of the first-window total, resume time, plain reason code; DESIGN §7.12 as amended), which plan 10's `Setup/status` aggregates, error reason codes mapped to DESIGN §7.15 copy keys, capability flags (labels, drafts, serverSearch, calendar, filters, push), recurrence edit scopes and RSVP actions, unsubscribe availability per message, the "Background work runs on" lease fact, and `reconnectBy` for Google accounts in Testing mode.
- *We never provide:* copy or raw provider strings. The UI never shows a raw error (DESIGN §7.12).
- *We need:* the connect flows of the new onboarding (DESIGN §7.11) to call `Account/connect` and honour `Setup/end`; a Settings account row for "grant missing permissions"; the reconnect surfaces (a status line a day before `reconnectBy`, the reconnect sheet and a Settings account row with Reconnect, all drawn from `reconnectBy`); and the reader's call to `thread.open` for a partial row, with the snippet shown meanwhile.

**Plan 40 (platform, quality).**
- *We provide:* emulator suites for the CI emulator E2E job; a Linux-only Docker job spec for Dovecot, Stalwart and Radicale (macOS runners cannot run Docker [I]); the scope manifest test; per-provider probes for plan 40's `SmokeProbe` (tier R only).
- *We need:* no CI-stored token for the owner's real account and no live tier M or S in CI (plan 40's nightly checks run tiers R and M on the agent test account only, decision G); the privacy page on aplos.email with Google's Limited Use sentence and the no-telemetry statement; licence checks for new dependencies (`ical.js` MPL-2.0 if chosen, imapflow MIT, a public-suffix package for redirects; Stalwart AGPL as test-only, never bundled); a Linux Docker job by day 7 for PV1b's conformance tier; a site that says Gmail is available to invited testers.

> **What this means:** We hand the engine team a single door for providers, hand the UI team plain status facts, and hand the platform team test suites and probes. The cross-plan edits are listed and already reconciled, so nobody has to guess where the plans meet.

## 8. What to read first

For every agent on this plan, in order: this file; `plans/00-roadmap.md` (§2.2, §4, §6, §7, §8.1, §10); `plans/ARCHITECTURE.md` §4-§7, §12.4-§12.5, §15; `RC/protocols/proto-google.md` (all; §1, §2, §3, §9 are the working core); `RC/protocols/proto-others.md` (§0, §2.3, §6, §7, §8); `RC/SYNTH-architecture.md` §3, §4. By milestone:
- Gmail pacing and error handling (formerly PV0): `RC/protocols/proto-google.md` §0-§3 and §9 D1-D7; the legacy `apps/desktop/src/main/google.ts:95-260`, `gate.ts` and `service.ts:580-690` (the engine files sit in `packages/engine/src/legacy/` after Phase 0) and `tests/integrations.test.ts:190`, all read-only.
- PV1a, PV1b, PV2: `RC/arch/mailspring.md` (testing and personalities), `RC/arch/emailengine.md` (tests, IDLE lifecycle), `RC/arch/pimalaya.md` (Neverest tests, batch curve), `RC/arch/stalwart.md` §fixture, `RC/arch/zero.md` (unit reservations), `RC/arch/extra-bulwark-legacy-proxy.md`.
- PV3, PV4: `RC/arch/zero.md`, `RC/arch/nylas-sync-engine.md` (draft-by-Message-ID), `RC/arch/extra-flectar-mail.md` (generation sweep), `research/inbox-zero/*.md`.
- PV5: `RC/protocols/proto-google.md` §8.1; `research/pr21-onboarding-review.md` (connect-flow findings; PR #21 is not merged by this plan).
- PV6, PV7: `RC/arch/geary.md` (threading), `RC/arch/deltachat-core.md` (interrupt model), `RC/arch/extra-parula-mustang.md` (JMAP loop), `RC/gaps/macos-daemon-lifecycle.md` §5 (wake).
- PV8, PV9: `RC/protocols/proto-google.md` §7; `RC/protocols/proto-others.md` §4.
- Live code: `apps/desktop/src/main/{google,microsoft,imap,imap-session,imap-index,jmap,caldav,ical}.ts`, `src/engine/{gate,provider,ports,service}.ts`, `scripts/emulation/*.ts`, and the matching tests; `SPEC.md`, `DECISIONS.md` (2026-10-15 ops order, 10-16 M26 and M29), `PROGRESS.md`, `TODO.md` (M11 is the unchecked live-verification item this plan finally closes).
- Provenance: GPL, AGPL and unlicensed projects supply ideas only; copy no code, assets or wording.

> **What this means:** Read the Google and other-provider reports first, then only the research for the step you are on. Ideas from other mail apps are welcome; their code never is.

## 9. PR and branch strategy within the revamp

- **Base.** Every lane branches from `revamp`; pull requests target `revamp`, never main. Nothing goes to main without the owner. PR #21 is neither merged nor rebased by this plan.
- **Branch names.** Git cannot hold a branch `revamp` and branches named `revamp/...` at the same time (`cannot lock ref 'refs/heads/revamp/x': 'refs/heads/revamp' exists`; checked). All plans therefore follow the roadmap's scheme `rv/<lane>/<slug>` (`plans/00-roadmap.md` §7): for example `rv/prov-gmail/history`, `rv/prov-gov/governor`, `rv/prov-emu/gmail`, `rv/prov-imap/idle`. Each lane works in its own git worktree. No branch name is ever a folder of another, so there is never a branch named exactly `rv/prov-gmail` or `rv/thread`. The Providers thread's coordination branch is `rv/thread/providers`.
- **No hotfix train.** Nothing in this plan targets main or ships ahead of the redesigned release. The former PV0 work is the first set of pull requests from `prov-gmail` and `prov-gov` into `revamp`.
- **Order of merges.** `prov-emu`'s Gmail emulator merges before `prov-gmail`'s first sync pull request (day 4). Port types are the frozen F3; later changes go through CONTRACT-CHANGE-PROPOSED to the Engine thread and are never edited here. `prov-gov`'s governor merges by day 7, and `prov-gmail` swaps its own pacer for it in one pull request. `prov-gmail-write` starts after `prov-gmail`'s client lands (day 6). `prov-imap`, `prov-jmap`, `prov-cal` and `prov-graph` touch disjoint folders and may run at once.
- **Old provider files.** They sit under `legacy/` folders after Phase 0 and keep building and testing as read-only reference. A replacement moves an old file by `git mv` into `apps/desktop/src/host/providers/` in the pull request that makes the new adapter pass the old tests. The Integrator deletes the leftovers with each owning lane on days 14 to 17.
- **Day 1.** The Engine thread's restructure chain touches existing files. Until it lands, this thread works only on new files in its own worktree: the Gmail emulator, the port proposal, test plans and the schema review.
- **Review budget.** One review pass per pull request, batched. Do not re-trigger Cubic after every fix; verify locally with `npm run typecheck`, `npm test` and the emulator suites first, and ask for review once per lane milestone (owner preference, memory note "Cubic review budget"). Lanes never merge their own pull requests.
- **Commits.** Authored as Kainoa Newton <k@kainoa.me>, each ending with the attribution line the harness provides. Flag any repo whose `git config user.email` differs before committing.
- **Evidence in PRs.** A PR that checks an acceptance item links the emulator run and, where the item is live, the content-free evidence file from §5.4. Live items are checked in PROGRESS.md only with that file. No screenshots of mail are attached; plan 30 owns visual evidence.
- **Secrets.** Never commit `.env`, tokens, test vaults or evidence containing addresses. The secret and history scan in plan 40 runs before the repository ever goes public, which is the owner's call.

> **What this means:** Every lane works on its own `rv/<lane>/<slug>` branches off `revamp`, in small batched reviews, and one thread merges everything. Main changes once, when you merge `revamp` for the redesigned release.

## Evidence index

`plans/ARCHITECTURE.md` (§4-§7, §10, §12, §13, §15, ADR-03, ADR-09, ADR-10, ADR-20, Decisions 1-4, 11); `plans/DESIGN.md` (§7.11, §7.12, §7.15); `plans/_council/CONTEXT.md`; `RC/protocols/proto-google.md` (§1.1, §1.2, §2, §3, §5, §6, §7, §8, §9 D1-D25); `RC/protocols/proto-others.md` (§0-§8, defects M1-M10, I1-I10, J1-J7, C1-C4, X1-X3); `RC/SYNTH-architecture.md` (§3, §4, §8, §12.1); `RC/arch/mailspring.md` (lines 236-238, 277), `emailengine.md` (225-231, 290), `pimalaya.md` (211), `stalwart.md` (279), `geary.md` (233), `nylas-sync-engine.md`; `research/pr21-onboarding-review.md`; `plans/10-engine-foundation.md` (§3, §4.0, E0-E8, §7.1, §9), `plans/30-ui-revamp.md` (§8.2), `plans/40-platform-quality.md` (Layer 2 smoke, §8); Aplos main `72095ff`: `apps/desktop/src/main/{google.ts:110-133 (retry loop and the rate-reason regex), :162, :179, :201, :310, microsoft.ts:33, oauth-config.ts}`, `src/engine/{ports,provider,gate}.ts`, `src/engine/service.ts:584-586, :669, :678`, `src/main/{preload.ts:8, electron.ts:20, server.ts:15}`, `src/renderer/App.tsx:179`, `tests/integrations.test.ts:190`, `scripts/emulation/`, `TODO.md` M11.
