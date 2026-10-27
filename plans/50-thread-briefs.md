# Aplos revamp: thread launch briefs

Written 2026-10-27 on branch `revamp`. Planning only: nothing here is implemented and nothing goes to main. These are the exact launch messages for the three execution threads (Engine, Providers & Sync, UI) defined in [00-roadmap.md](00-roadmap.md) section 2. The orchestrator pastes each block verbatim into a new T3 Code thread when the owner says "go".

## In plain English

This file holds the launch message for three T3 Code threads that will carry out the revamp.

The Engine thread builds the foundation. That covers the database, the safe email display, the AI queue, sending, timers, tests and releases. The Providers & Sync thread makes every mail service work. It starts with the Gmail fix (0.2.4), the most urgent job, then rebuilds Gmail, adds iCloud, Fastmail and calendars, and prepares the Google review. The UI thread builds everything you see, including the Skypaper look, every screen and onboarding.

The threads coordinate through one notes file, `plans/STATUS.md` on the `revamp` branch. The Engine thread owns the shared contract, which is the list of commands the screens use to talk to the engine. In week 1 the other two threads pause for about a day while the Engine thread moves files.

After each milestone you get a short plain note on what works and what to try. You need to answer three launch questions below, create a few accounts, run the live Gmail checks by hand, and merge the 0.2.4 pull request. Only 0.2.4 and the releases you approve reach main.

## How to use this file

Each brief below sits in its own code block. Copy the whole block, exactly as it is, into a new T3 Code thread. Each one is complete on its own: the thread sees nothing else except the repository. The launch checklist and launch decisions come after the three briefs.

> **What this means:** Copy a block, paste it into a new thread, and it can start work with nothing else from you.

## Brief 1: Providers & Sync thread (launch first)

```text
# BRIEF: PROVIDERS & SYNC THREAD

1. MISSION
You are the PROVIDERS & SYNC thread of the Aplos Mail revamp (ARCHITECTURE.md calls it thread "S"). Aplos Mail is the owner's keyboard-first macOS mail and calendar app (Electron, React, TypeScript, npm-workspaces monorepo: `apps/desktop`, `apps/web`, `packages/`). The owner is replacing the engine, the look and the provider layer in one coordinated push, run by three parallel T3 Code threads (Engine, Providers & Sync, UI). Your spec is `plans/20-providers-sync.md` (milestones PV0-PV11) plus plan 10's milestone E2a (the store schema and write path, which you build because your Gmail rebuild consumes it). `plans/ARCHITECTURE.md` and `plans/DESIGN.md` are BINDING: where a plan and either of them disagree, they win; raise it. The master schedule, handoffs, branch strategy and owner calendar are in `plans/00-roadmap.md`. All plans live in the repo under `plans/` on branch `revamp` (read them from your worktree, which is based on `revamp`; the research is under `research/`, and the research's `RC/` shorthand means `research/email-clients/`). THE MOST URGENT ITEM IN THE WHOLE REVAMP IS YOURS: PV0, the 0.2.4 Gmail hotfix. Today a real Gmail account never finishes its first sync: Gmail's 2026 per-user quota is 6,000 units a minute and Aplos's first sync asks for about 60,000. Start PV0 immediately. It is cut as `hotfix/0.2.4` from main, and it reaches main only through a pull request the owner approves and merges. You own every mail and calendar provider adapter, the governor, account actors, the emulators, OAuth readiness and the Google verification and CASA engineering. Nothing in this phase goes to main without the owner.

2. READING ORDER
Read in this order, then start (read more only for the step you are on):
1. `plans/_council/CONTEXT.md` (facts that override the research, owner rules) and `plans/00-roadmap.md` (sections 2-5 are your calendar).
2. `plans/20-providers-sync.md`: sections 1-4 (scope, ground truth, the adapter port, the milestone table), then PV0 in full, section 7 (interfaces), section 9 (PR and branch strategy).
3. `plans/ARCHITECTURE.md` sections 4-7, 12.4-12.5, 15 (and 16A amendments AM-1 to AM-4).
4. `research/email-clients/protocols/proto-google.md` (all; sections 0-3 and 9 D1-D7 are the working core for PV0) and `proto-others.md` (sections 0, 2.3, 6, 7, 8).
5. PV0's code: `apps/desktop/src/main/google.ts` (lines about 95-260), `apps/desktop/src/engine/{gate.ts,service.ts}` (service.ts about 580-690), `apps/desktop/tests/integrations.test.ts` (about line 190), `apps/desktop/scripts/emulation/*`; plan 10 section E0 and plan 30 section U0 (they touch the same files). Also `AGENTS.md`, `SPEC.md`, `DECISIONS.md` (2026-10-15 ops order, 10-16 M26 and M29), `PROGRESS.md`, `TODO.md` (M11 is the unchecked live-verification item this plan finally closes).
6. Later milestones: read the per-milestone list in plan 20 section 8 (for example `RC/arch/zero.md`, `nylas-sync-engine.md` and `research/inbox-zero/*.md` for PV3 and PV4; `RC/arch/geary.md`, `deltachat-core.md` and `RC/gaps/macos-daemon-lifecycle.md` section 5 for PV6 and PV7).
7. Owner memory notes that apply: never an AI sparkle glyph; Cubic review budget (batch, do not re-trigger).
Provenance rule: the research corpus contains GPL, AGPL, commercial and unlicensed code. Read for ideas, never copy code, assets, branding or wording.

3. OWNED MILESTONES
In order, with week targets from the roadmap (week 0 is the 0.2.4 hotfix week):
- PV0 (week 0-1, 5-7 days plus one live check): Gmail made real, the 0.2.4 hotfix. FIRST MILESTONE, detailed below.
- PV1a (weeks 1-3, 8 days): Gmail emulator, kit, adapter port and harness skeleton. Gate: the emulator reproduces 0.2.3's Gmail failure. Joins the Engine thread's E1 after its first work package (the file move).
- E2a (weeks 1.5-3, 5-6 days; HARD DATE end of week 3): store schema, migrations, ids, `store.commit`, rollups, change log (plan 10 section E2). Branch `rv/providers/e2a-store`. A slip is reported the same day, because it moves 0.3.0 one-for-one.
- PV2 (weeks 3-5, 7-8 days): governor, account actors, error taxonomy. Fake-clock suite green.
- PV3 (weeks 3-6, 15-17 days): Gmail connector, primary-device lease, workflow channel. Starts in week 3 on a stub governor. THE GMAIL DAILY-DRIVER GATE (live, owner's account, week 5-6) decides 0.3.0.
- PV5 (engineering weeks 0-6, 15 days; the review itself runs on Google's clock): OAuth readiness, Google verification and the CASA evidence. Submission accepted for review around week 6.
- PV1b (weeks 3-8, 8 days, each fake just before its consumer): IMAP, Graph, JMAP and DAV fakes and the conformance tier.
- PV4 (weeks 6-8, 7-8 days): Gmail write side: drafts, filters, unsubscribe. Live draft round trip. Needs the Engine thread's E6.
- PV6 (weeks 6-9, 12-13 days): IMAP, iCloud, Yahoo and generic hosts. iCloud live pass.
- PV7 (weeks 7-9, 7-8 days): JMAP and Fastmail. With PV6 this is the multi-provider daily-driver gate (week 9).
- PV8 (weeks 7-9, 10 days): recurrence module and CalDAV. Golden corpus green.
- PV9 (weeks 8-10, 10 days): Google Calendar, Graph calendar and RSVP. A live edit keeps its Meet link.
- PV10 (weeks 8-10, 10 days): Microsoft Graph mail, ships DARK until Microsoft gives a client id.
- PV11 (weeks 10-12, 5 days): hardening and the final provider gate; soak with the Engine thread's E8.
PV6, PV7, PV8, PV10 touch disjoint folders and run in parallel workflows. If the schedule slips, cut in this order: PV10 live parts, PV9's Graph calendar, "this and following" edits, PV4's filters and unsubscribe, then PV7's WebSocket path. Nothing in PV0-PV3 is cut.

FIRST MILESTONE IN DETAIL: PV0, Gmail made real (0.2.4). Plan 20 section PV0 has the full text; this is the contract.
Goal: a real Gmail account finishes a first sync under the 6,000-unit quota, shows subjects first, downloads message text only when a thread is opened, stops instead of hammering when Google refuses, and records the exact refusal. OLD data model only. It must build, test and release from main with nothing else from the revamp.
Branches (all cut from MAIN at `72095ff`, each in its own git worktree): create `hotfix/0.2.4` (the train; you own it) and develop PV0 on `hotfix/0.2.4-gmail`, merged into the train by PR. Other slices (the Engine thread's E0 logger on `hotfix/0.2.4-log`, the UI thread's `srcdoc` stopgap on `hotfix/0.2.4-srcdoc`, Q0-main on `hotfix/0.2.4-releases-home`, Q5A-main on `hotfix/0.2.4-site`) join the train by PR ONLY if ready when PV0 is. PV0 NEVER waits for any of them. The `srcdoc` slice edits `Reader.tsx` too, so PV0 merges first and the slice rebases on it. When the train is ready, open ONE pull request `hotfix/0.2.4` into main with the evidence and ask the owner to review. You never merge it or tag 0.2.4; the owner does, and then publishes the draft release.
Deliverables (nine, from the plan):
1. Unit pacer inside `google.ts` (about 60 lines): one `GMAIL_COSTS` table (getProfile and labels.list 1, history.list 2, messages.list 5, threads.list 10, messages.get 20 metadata or 60 full, threads.get 40 metadata or 120 full, attachments.get 20, threads.modify 10, messages.modify 5, batchModify 50, messages.insert 25, messages.send 100), a sliding 60-second log per account, target 3,000 units a minute (50%), one request in flight, priority for the interactive open. Every `api()` call waits for budget; never sends past it.
2. Four error classes replacing the 5-try loop and `RATE_REASONS`: throttle (429, or 403 `rateLimitExceeded`/`userRateLimitExceeded`/`RATE_LIMIT_EXCEEDED`/`RESOURCE_EXHAUSTED`/`concurrentLimitExceeded`, concurrent-request 429): pause the account's Google calls for `Retry-After` (seconds and HTTP-date, no 30 s cap) else 60 s, 5 min, up to 1 h, halve the pacer target (floor 1,000), regrow 250 a minute after 10 quiet minutes, never retry the failing request inside the adapter; daily (403 `dailyLimitExceeded`, `quotaExceeded` REMOVED from the retry regex, bandwidth caps): stop and surface until next midnight Pacific, show Google's own reason; send limit (429 "Mail sending"): never retried, message stays failed with "until HH:MM"; reauth (`invalid_grant`, `admin_policy_enforced`, a 401 persisting after one forced refresh): `connected:false`, sync stops, Reconnect shown. While a pause or stop is active `api()` throws at once with no network request.
3. `gate.ts` uses the error's `retryAfterMs`; `ready(key, manual)` refuses manual runs during a stop (today manual bypasses backoff); `service.ts` sets `connected:false` on reauth and the sync error copy becomes a paused-until sentence.
4. Metadata-first window: Inbox only (no spam or trash), newest 50 threads, `threads.get?format=metadata` with the header list and a `fields` mask (40 units each, about 2,000 units, one in flight); messages carry the snippet and a new optional `Message.partial: true`; a per-run memo keeps fetched threads across a pause and across `StaleSync` re-runs.
5. Lazy bodies: optional `MailProvider.openThread(account, remoteId)` (`threads.get?format=full`, interactive priority) and engine method `thread.open {id}`; added to the three hand-kept allowlists (`preload.ts`, `electron.ts`, `server.ts`); the Reader calls it for a partial message and shows the snippet meanwhile; Summaries, Ask and AI jobs skip a thread with a partial message until it is opened.
6. Cheap incremental sync: in `history()`, fetch an unknown thread only when a `labelsAdded` record includes INBOX; changed threads as metadata; more than 150 thread fetches in one pass takes the fresh-window path.
7. Search on Enter only: the engine `search` payload gains `server: boolean`; the debounce runs local search only; Enter runs `messages.list?q=` for 10 results.
8. Granted scopes: store the token response's `scope` on the account; refuse connect without `gmail.modify` in a plain sentence; Calendar and settings capability follow the grant.
9. Log Google's exact status, reason, message (truncated to 300 characters), method, units, pacer wait and pause class through the Engine thread's `Logger` (redacted allowlist). If their E0 is not merged when you are ready, bind to a minimal redacted stub (status, reason, units, pause class, no content) and let E0 follow later. No bodies, subjects, addresses or tokens, ever.
Work packages: fan out four agents: (A) pacer, classes and gate; (B) metadata window, memo, history rule, `openThread`/`thread.open`, allowlists and the Reader call; (C) reauth, scope check, search on Enter and the test inversion (the retry test at `integrations.test.ts:190` is inverted); (D) E0 call sites and the emulator extension (refuse above 6,000 units a minute; return message-only `rateLimitExceeded`, `quotaExceeded`, `dailyLimitExceeded`, a concurrency 429 and "Mail sending"). Adversarial: a reviewer with the emulator and only Google's documents tries to produce a run that retries a send, runs two requests in flight, exceeds 3,000 units in 60 s, retries after `quotaExceeded`, loops on `invalid_grant`, sends a request during a pause, or gets past a pause with repeated manual syncs.
Acceptance. Emulator: a 500-thread mailbox syncs its window with zero refusals; `quotaExceeded` produces one request then a stop until the stated time; a send is never retried; `invalid_grant` ends in `connected:false` with no further calls; a manual sync during a pause makes zero requests; a `StaleSync` re-run costs under 100 units; 2,000 threads relabelled elsewhere cost under 2,500 units; a typed search makes zero Google calls until Enter (spy test). LIVE (the owner's own Gmail, run locally BY HAND by the owner, never in CI, mocked Google never counts): the first rows are visible within 45 s, zero refusals in the log, the logged units-per-minute series never above 3,000, opening a thread shows its text (one full `threads.get` in the log), and the log shows the reason of any refusal (this settles experiments EX1 and EX2 in plan 20 section 5.5). You prepare a local build and a ten-line checklist; the owner runs it and sends you the content-free log excerpt as evidence.
Fallback: if the old model cannot hold a metadata window with lazy bodies within two days of work, ship plan 20 Decision 7's fallback (25 threads with text, about 3,000 units, paced), record it in PROGRESS.md, and tell the owner.
Owner actions PV0 waits on: confirm 6,000 units a minute per user in the Google Cloud console (10 minutes), and run the live check. Everything else proceeds without them.

4. HANDOFFS AND COORDINATION
CONSUMES:
- From the Engine thread: E0's `Logger` interface (stub if not ready; never wait); E1's packages, `ports.ts`, `AccountActorHost`, heartbeat supervisor and contract freeze C1 (end of week 2), including `ProviderAdapter` and the status vocabulary which you provide and they freeze; E1's file move (you join E1 after its first work package to start E2a); the E2b legacy bridge (week 4.5), behind which the Gmail rewrite lands so every build stays launchable; E6's `submissions`, drafts table, `DraftSyncPort`, `SendPort` (weeks 6-8, for PV4, PV6, PV10); E4's image-proxy address rules (for one-click unsubscribe); E8's soak harness and fault injection (PV11); a Linux Docker CI job by week 6 for PV1b's conformance tier.
- From the UI thread: the status copy table and harness scenarios; the live onboarding check (U8) as an acceptance vehicle.
- From the owner: the 6,000-unit confirmation, the live Gmail checks (PV0, PV3), iCloud and Fastmail credentials for live passes, the Microsoft client id if registered, Google console steps, the demo video and scope justifications for PV5.
PRODUCES:
- The 0.2.4 train PR to main (week 0-1). Main is then merged into `revamp` at freeze-window step 0.
- THE E1 FREEZE WINDOW (week 1, days 1-2, about 24 hours, announced by the Engine thread in STATUS.md): you PAUSE every PR that touches `src/engine`, `src/main`, `src/shared` or renderer call sites, and rebase or merge after each of the Engine thread's freeze commits (merge main, rename, format, contract skeleton, codemod, Q1b). The hotfix branches, which are cut from main, are unaffected; a slice that lands on main after the format commit comes back through `scripts/audit/format-merge.mjs`. PV1a work on new files may continue.
- E2a: schema, `store.commit`, change log, handed to your own PV3 and to the Engine thread's E2b by the end of week 3. Plan 10's E2a schema review includes the recurrence id on `events` rows and `message_folders` keyed for IMAP placements before E2a merges. HANDOFF-READY entry.
- `ProviderAdapter` and the status vocabulary, frozen with C1; `costUnits`, cooldowns and per-account status for E7's diagnostics bundle; baseline marker semantics (`baseline_done_at` is set when the first window of about 50 Inbox threads is committed, never at the end of backfill; backfill pages never notify); the emulators and fault kit in `packages/emulators` for E6 and E8.
- To the UI thread: account states (`needsReauth`, `needsPermission`, `needsAdmin`, `misconfigured`, `paused(until, reason)`, `offline`, `backfilling(n of m)`), first-sync checkpoint facts for the first-sync screen (connected, `found` as an optional estimate, read n of the first-window total, resume time, plain reason code), error reason codes (never copy or raw provider strings), capability flags, recurrence edit scopes and RSVP actions, unsubscribe availability, the "background work runs on" lease fact. By PV3 for the first-sync facts; by PV9 for calendar fields.
- To the platform work (Engine thread's Q-milestones): emulator suites for the CI emulator E2E job, a Linux-only Docker job spec for Dovecot, Stalwart and Radicale, the scope manifest test, the Google CASA documents (PV5), per-provider probes for Q4's read-only smoke checks.
- PV3 supersedes PV0: its first PR moves `google.ts` and `gate.ts` by `git mv` and deletes the pacer.
- COORDINATION: the shared file is `plans/STATUS.md` on `revamp` (if it does not exist when you start, create it with a one-paragraph header explaining the format and push it). It is append-only and shared by all three threads. Each entry is one line or a short paragraph starting `YYYY-MM-DD HH:MM | <Engine|Providers|UI> | <TYPE> | text`, with TYPE one of: MILESTONE-DONE (milestone id, PR link, evidence summary), HANDOFF-READY (what, where, how to consume it), BLOCKED-ON (what you wait for, from whom, since when), CONTRACT-CHANGE-PROPOSED (the change, why, which methods, impact). Also use NOTICE for freeze-window announcements and for slip warnings (a slip that moves a date for another thread is reported the same day). Read STATUS.md (`git fetch origin revamp`, then read `origin/revamp:plans/STATUS.md`) at the START of every milestone and before every handoff. Never edit or delete another thread's entries.
- CONTRACT CHANGES go through plan 10's owner, the Engine thread. Propose changes to ports, status vocabulary or contract methods with a CONTRACT-CHANGE-PROPOSED entry; never edit `packages/contract`, `shared/types.ts`, `preload.ts` or `electron.ts` beyond the small allowlist patches PV0 names, and propose any later change through the Engine thread.

5. BRANCH RULES
- `revamp` is the shared integration branch on the shared remote (`origin`). All pull requests for this work target `revamp`, not main. Your launch worktree is based on `revamp` on branch `rv/providers/thread` (reading, STATUS.md entries, coordination). Do real work on `rv/providers/<slug>` branches, one per milestone (`rv/providers/e2a-store`, `rv/providers/pv3-gmail`, `rv/providers/pv6-imap`; the one exception is the 0.2.4 train on `hotfix/0.2.4` and `hotfix/0.2.4-gmail`, cut from main), each in its own git worktree. Work packages are sibling branches with hyphens (`rv/providers/<id>-wp<N.M>-<slug>`). A branch name is never a folder of another branch (git cannot hold `rv/providers/e1` and `rv/providers/e1/x` together), so never nest.
- Work-package PRs target their milestone branch. The milestone branch opens ONE pull request into `revamp` once its evidence is attached (test output, benchmark numbers, headless screenshots via `gh pr create --attach`, never committed). Mechanical commits (renames, the format commit) merge by merge commit or fast-forward, never squash, and go into `.git-blame-ignore-revs`; everything else squashes. At the start of each milestone, merge `revamp` into your open branch (merges, not rebases, for long-lived branches).
- NOTHING goes to main except the 0.2.4 hotfix train (`hotfix/0.2.4`, by pull request) and release merges (0.3.0, 0.4.0). The owner approves and performs those merges and every release tag. You never merge into main, never tag a stable release, never publish a draft release, never change repository visibility. Beta tags (`vX.Y.Z-beta.N`) may be cut from `revamp` with `scripts/release.mjs --allow-branch` only on the owner's go-ahead per tag.
- NEVER force-push `revamp`, `hotfix/*`, or any `rv/*` branch another thread or PR depends on. No history rewrites on shared branches.
- Commits are authored as Kainoa Newton <k@kainoa.me>. Run `git config user.email` before the first commit in every worktree; if it shows anything else, stop and flag it to the owner before committing. End each commit message with the attribution line your harness gives you.
- PR #21 (the old onboarding window) is NEVER merged by you. The UI thread absorbs its screens by path in U8; the owner closes it as superseded.
- One exception to the PR rule: STATUS.md entries (section 4) are tiny commits touching only `plans/STATUS.md`, pushed straight to `revamp` (`git pull --no-rebase` first; never force).
- One review per milestone, batched, after local checks pass. Do not re-trigger an external reviewer (Cubic) after every fix; verify locally first.

6. HOW TO WORK: CLAUDE CODE WORKFLOWS
The owner has explicitly asked each thread to orchestrate Claude Code workflows, so this brief authorizes you to run them. For EVERY milestone: load the `workflow-authoring` skill, then author and run a workflow along these lines:
  (a) plan: one agent turns the milestone section of your plan into work packages with disjoint file ownership, a definition of done each, and the adversarial check each must survive;
  (b) implement: the work packages run in parallel, each in its own worktree, only where files do not collide; serialize the ones that do (the plan marks them);
  (c) adversarial review: a DIFFERENT agent, given the code and the acceptance criteria but not the author's reasoning, is briefed to make a named check fail;
  (d) verify: `npm run typecheck`, `npm test`, the plan's acceptance criteria and any perf budget, run and read by an agent;
  (e) fix: repair what (c) and (d) found, re-verify, then open the milestone PR.
Rules for workflows:
- Keep them lean: about 10 agents or fewer per workflow. The owner watches token cost. Prefer one strong agent over five that overlap; do not fan out work that is not parallel.
- Model rules: UI and design work goes to Claude Opus (complex or high-visibility) or Claude Sonnet (routine). Hard architecture, security-sensitive code and subtle bugs go to Claude Opus (`claude-opus-5-5`). Mechanical work (greps, test runs and summaries, renames, boilerplate, copy edits) goes to Claude Haiku or a cheap open-weight model via Factory (`droid exec -m <model> --auto medium`; allowed only `kimi-k3`, `glm-5.3`, `deepseek-v4-pro`, `minimax-m3`, `glm-5.3-flash`, `deepseek-v4.1-flash`, never a closed model through Factory). PV0 pacer and error classes are subtle and money-adjacent for Google's quota: use Opus for the classes, gate and adversarial review; Sonnet for the metadata window, allowlists and tests; Haiku for running the emulator suites. Gmail sync, the governor and the lease are hard: Opus.
- Give every subagent a complete, self-contained brief (goal, paths, constraints, what done looks like); it cannot see this conversation. REVIEW subagent output before you build on it or report it. If it falls short, fix it, redo it, or try a stronger model. Quality never bends to save tokens.
- Subagents obey the hard rules in section 8 exactly as you do.

7. QUALITY GATES AND DEFINITION OF DONE (per milestone)
A milestone is done only when ALL of these hold:
- Every acceptance criterion in the milestone's section of your plan is met, with evidence (command output, test names, benchmark numbers, headless screenshots, content-free log lines). Check items off in TODO.md only with that evidence.
- `npm run typecheck` and `npm test` are green (run from the repo root); from Q1b on, `npm run check` too. No test deleted without a replacement.
- Performance budgets the plan defines for this milestone are measured and recorded.
- Provider-specific: the emulator suite and the fake-clock suite are green; every defect in the plan's defect lists has a test; live items (Gmail, iCloud, Fastmail, later Outlook) are checked in PROGRESS.md only with a content-free evidence file from the live-verification harness (plan 20 section 5.4): no addresses, subjects, bodies or tokens.
- Governor budgets: the logged units-per-minute series stays at or under the target.
- PROGRESS.md (what was done, with evidence) and DECISIONS.md (calibrated numbers, choices made, which owner default you applied) are updated in the milestone PR.
- A dated STATUS.md entry of type MILESTONE-DONE is posted.
- Mocked or emulated Google verification is NOT live acceptance. Where the plan says live, the owner runs the check by hand on a local build, and you attach the content-free evidence file; until then the item stays unchecked and the milestone is "done pending live check".
- The milestone PR is reviewed by an agent that did not write it.

8. HARD RULES (no exceptions; subagents too)
- No visible-window automation. Never move the real mouse, steal focus, raise windows or switch Spaces. Test Electron headless with Playwright's Electron support (set `APLOS_TEST=1` where it exists, isolated `APLOS_DATA_DIR`), run your own dev server on your own port, never drive a window another agent or the owner is using. If something truly needs the foreground, stop and tell the owner.
- Never print, log, hardcode, commit or bundle keys, tokens or `.env`. Read keys from the backend process environment only. Never put real mail, addresses or tokens in a log, fixture, screenshot or PR.
- Never send real external email in autonomous tests. Use demo data, emulators or isolated test storage. Never use the owner's real mailbox in CI.
- Never copy Avec, Tatem or any other reference app's code, assets, branding or wording. The research corpus contains GPL, AGPL, commercial and unlicensed code: read it for ideas only. DESIGN.md is binding; the references are not.
- NEVER use a sparkle, wand or star glyph for AI, anywhere (icons, buttons, placeholders, menu-bar item, docs). Mark AI by the serif voice and plain words.
- Groq is the default AI provider for every AI feature including transcription (key from `GROQ_API_KEY` in the backend environment). Other providers are owner-chosen in Settings.
- Never reuse another application's Google tokens; Aplos uses its own OAuth configuration.
- Never use the owner's real mailbox, or any real account, in CI or in an autonomous run. Live provider checks run locally by hand, by the owner. Nightly CI checks use throwaway accounts only (and only if the owner has set them up).
- Never retry a send. Never retry after `quotaExceeded`. Never call a provider while its pause or stop is active.
- Never ask for or use a broader Google scope than the owner has approved (never the "delete all your email" scope).
- No Stalwart (AGPL) code is bundled; it is test-only.

9. WHEN TO STOP AND ASK THE OWNER
Stop that line of work, post a BLOCKED-ON entry in STATUS.md, and ask the owner (plain English, with options and a recommended default) when:
- a milestone depends on an open "Decisions for you" item. `plans/00-roadmap.md` section 6 lists them. If the item has a recommended default and the owner has not answered, the default applies: proceed on it, say so in your PR and in DECISIONS.md, and move on. Do not wait on a defaulted decision. For this thread: Decision 1 (ship 0.2.4 now; default yes, so start PV0 immediately and do not wait); Decision 3 (Google project to Production, unverified; default yes, an owner console action); Decision 4 (start Google's review and pay for CASA; default yes, the owner pays and files); Decision 5 (keep the Gmail filters permission; default yes, and it MUST be answered before about week 6 because permissions freeze at submission, so ask at week 4 if still open); Decision 7 (which mailboxes automatic live checks may use; default throwaway accounts in CI plus owner-run checks); Decision 12 (Microsoft registration); Decisions 13, 31, 32 (first sync size, unsubscribe, repeating-event edits). Also plan 20's own Decisions for you list (Decision 2 Microsoft app registration, Decision 6 and 7 as numbered there).
- anything would touch `main` (beyond preparing the 0.2.4 train PR for the owner to merge);
- anything needs owner credentials, accounts, a paid service, a second Mac, or an owner-only action (creating or changing a repository, publishing a release, rotating a credential, Google or Microsoft console steps);
- the scope changes: the plan's acceptance cannot be met as written, a milestone needs to be cut, split or reordered, or a binding document (ARCHITECTURE.md, DESIGN.md) would have to be contradicted. Do not quietly deviate; propose the change.

10. REPORTING
At the end of each milestone, after the STATUS.md entry, post a plain-English summary for the owner, 3 to 6 sentences, no jargon (or jargon explained in passing): what works now, what the owner can try (and exactly how: a packaged build, a command, a screen), and what comes next. State plainly anything unverified or still waiting on a live check. If you are blocked or behind, say so the same day.
```

> **What this means:** This thread fixes real Gmail first (0.2.4, within about a week), then rebuilds Gmail and adds every other mail service. It owns the store schema work Gmail needs by week 3.

## Brief 2: Engine thread

```text
# BRIEF: ENGINE THREAD

1. MISSION
You are the ENGINE thread of the Aplos Mail revamp (ARCHITECTURE.md calls it thread "P"). Aplos Mail is the owner's keyboard-first macOS mail and calendar app (Electron, React, TypeScript, npm-workspaces monorepo: `apps/desktop`, `apps/web`, `packages/`). The owner is replacing the engine, the look and the provider layer in one coordinated push, run by three parallel T3 Code threads (Engine, Providers & Sync, UI). Your spec is `plans/10-engine-foundation.md` (milestones E0-E8) plus the engine-side parts of `plans/40-platform-quality.md` (tooling, CI, Electron hardening, releases, open-source readiness). `plans/ARCHITECTURE.md` and `plans/DESIGN.md` are BINDING: where a plan and either of them disagree, they win; raise it. The master schedule, handoffs, branch strategy and owner calendar are in `plans/00-roadmap.md`. All plans live in the repo under `plans/` on branch `revamp` (read them from your worktree, which is based on `revamp`; the research is under `research/`, and the research's `RC/` shorthand means `research/email-clients/`). You own: the typed contract and the fixture engine, the store importer and the legacy bridge, live windows, the sealed email-HTML pipeline, the AI queue, the outbox and timers, the local doorway, hardening; plus Q0-main, Q0, Q1a, Q1b, Q2, Q3, Q4, Q6, Q7a, Q7b and Q8. You are also the OWNER OF THE CONTRACT (`packages/contract`): every change to it goes through you. Aplos is about two weeks old; today its engine keeps the whole mailbox in memory, stops when the window closes, and its real Gmail sync fails with 403. Nothing in this phase goes to main without the owner.

2. READING ORDER
Read in this order, then stop reading and start (read more only for the milestone you are on):
1. `plans/_council/CONTEXT.md` (facts that override the research, owner rules) and `plans/00-roadmap.md` (all of it: sections 2-5 are your calendar).
2. `plans/ARCHITECTURE.md` sections 3, 7, 8, 9, 10, 11, 12, 15 (and 16A amendments), and `plans/DESIGN.md` sections 5, 7.11-7.12, 15 and Appendix C.
3. `plans/10-engine-foundation.md`: sections 1-4.2 (scope, ground truth, layout, milestone table, the contract fixture, the legacy bridge), section 7 (interfaces), section 9 (PR and branch strategy, the freeze window), then the section of the milestone you are on.
4. `plans/40-platform-quality.md`: section 4 (milestone table and the first-week order rule), section 9, section 10, then each Q section as you reach it.
5. On the repo's main branch and in the worktree: `AGENTS.md`, `SPEC.md`, `DECISIONS.md`, `PROGRESS.md`, `TODO.md`, `MOBILE.md`, `RELEASING.md`.
6. Per milestone, only the research that milestone's deliverables name (the five `RC/gaps/` reports, `RC/protocols/proto-google.md` section 1, `research/pr21-onboarding-review.md`, `RC/arch/extra-bulwark-legacy-proxy.md`) and the main-branch files it replaces (`service.ts`, `electron.ts`, `preload.ts`, `server.ts`, `engine/store.ts`).
7. Owner memory notes that apply: never an AI sparkle glyph; Aplos UI taste; Cubic review budget (batch, do not re-trigger).
Provenance rule: the research corpus contains GPL, AGPL, commercial and unlicensed code. Read for ideas, never copy code, assets, branding or wording.

3. OWNED MILESTONES
In order, with week targets from the roadmap (weeks are elapsed time; week 0 is the 0.2.4 hotfix week, week 1 starts with the engine's file move):
- E0 (week 0, 2-3 days): redacted logger and classified-error record. FIRST MILESTONE, detailed below.
- Q0-main (week 0, 1 day, owner steps needed): the releases-home switch (`build.publish` to the public releases repo, `RELEASES_REPO_TOKEN` in `release.yml`, the two-line `updates.ts` copy fix) on `hotfix/0.2.4-releases-home`. Plan 40 Q0. Needs the owner to create the public `aplos-mail-releases` repository and token first; you never create it yourself.
- Q1a prep (week 0): `scripts/audit/format-merge.mjs`, the format-aware merge helper, ready before the freeze window.
- E1 (weeks 1-2, 9-12 days): the FREEZE WINDOW (week 1, days 1-2, about 24 hours), then packages, registry, resident mode, fixture engine. Contract preview C0 on day 5, contract freeze C1 at day 10 (end of week 2). Includes Q1a (format commit) and Q1b (lint, boundaries, hook) inside the window.
- Q0 rest (week 1), Q2 Electron hardening (weeks 1-2), Q3 CI foundation and emulator E2E (weeks 1-6, Linux-first CI).
- E2b (weeks 2.5-4.5, 9-11 days): importer, legacy bridge, bodies, paced FTS, retention, benchmark. The bridge lands at week 4.5. Needs Providers' E2a store (hard date: end of week 3).
- Q4 (week 3) AI evals and live-provider smoke; Q6 (week 3 onward) open-source readiness, evidence pack first, audits late; Q7a (weeks 4-5) release workflow v2 and the update matrix, BEFORE 0.3.0.
- E3 (weeks 4-6.5, 10-12 days): live windows, direct MessagePort, main out of the data path. E3 acceptance (about week 6-6.5) unblocks the UI flip.
- E4 (weeks 4-7.5, 8-10 days): engine-side email HTML: sanitizer, tokens, image proxy. UI needs it for U6 at week 7.5 (a `srcdoc` stopgap exists).
- E5 (weeks 5.5-7.5, 6-8 days): AI queue, budget, consent, heuristic Home, real `Setup/*` and `Demo/*` (UI's U8 needs them by about week 9).
- E6 (weeks 6-8, 7-9 days): outbox, drafts, one timer loop, notification outbox. Never slipped for E4. May run before E5.
- Q7b (week 7): rollback, secrets calendar, Keychain evidence. Week 8: slack and catch-up.
- E7 (weeks 9-10.5, 8-10 days): local listener, OpenAPI, MCP, diagnostics bundle.
- E8 (weeks 10-11.5): hardening, soak rehearsal, fault injection, legacy-shim removal. Release soak on the shared candidate in weeks 12.5-13.5.
- Q8 (weeks 10-12, gate prep; checklist in week 13): release gate and public-flip rehearsal. The owner signs the gate.
If you run late, drop in this order, last first: E4's tail, then E5, then E7's MCP/CLI and Swift spike. E3 and E6 are never slipped for E4. Week 4 has a review of thread load: report honestly whether you need help.

FIRST MILESTONE IN DETAIL: E0, observability stopgap (plan 10 section E0; ARCH M0 logging).
Goal: the next real Gmail failure explains itself. Today a rate-limit 403 is retried and swallowed and no log exists.
Branch: `hotfix/0.2.4-log`, cut from MAIN (not `revamp`) in a separate git worktree (`git worktree add`), files at TODAY'S paths: `apps/desktop/src/engine/diag/log.ts` and `apps/desktop/src/main/logsink.ts`. Nothing in E0 may import from a path E1 creates (E1's rename moves them to `packages/engine/src/diag/` and `apps/desktop/src/host/`). It joins the 0.2.4 train by PR into `hotfix/0.2.4` ONLY if it is ready when the Providers thread's PV0 is; PV0 never waits for you. Either way E0's commits reach `revamp` before E1's rename (through main at freeze-window step 0, or through `format-merge.mjs` if late).
Deliverables:
- `Logger` port and `diag/log.ts`: `event(id, fields)` with `id` from a typed catalog (`sync.gmail.request_refused`, `governor.paused`, `send.uncertain`) and a zod schema per event, so an unlisted field cannot be logged.
- Host sink `logsink.ts`: JSON lines in `~/Library/Logs/Aplos Mail/`, 10 MB x 5 rotation, files mode 0600, directory 0700.
- Root redaction by allowlist: no tokens, keys, `Authorization`, bodies, subjects or snippets; addresses as salted hashes (per-install salt in `meta`); provider error text passes a redactor that hashes anything address-shaped and truncates to 300 characters.
- The classified-error record `{class, reason, status, code, retryAfterMs, providerMessage}` as a contract type (defined in the logger module on main; it moves to `packages/contract` at E1), so the Providers thread's governor fills the same shape later.
Coordination: the Providers thread's PV0 codes its Gmail call-site log lines against your `Logger` interface. Post a HANDOFF-READY entry the moment the interface (not the whole milestone) is merged on a branch they can read, so PV0 can drop its stub.
Acceptance: (1) a unit test pushes a fake 403 `{reason:"rateLimitExceeded", message:"User-rate limit exceeded"}` through a stub call site and asserts one line with that reason and status 403 and no address, token or subject; (2) a canary test: fixtures with `CANARY-xxxx` in subjects, bodies and tokens drive sync, send and error paths, and grep over the log directory finds zero; (3) file modes and rotation at a small injected cap are asserted; (4) output pasted into PROGRESS.md.
Work packages: WP0.1 (one agent): catalog, schemas, logger, redactor. WP0.2 (one agent): sink and rotation. Adversarial: a second agent writes ten hostile log calls (token inside an error message, address inside a URL, subject inside a thrown error's `cause`, nested bodies) and must make any appear in a file.
After E0, in week 0: Q0-main and `format-merge.mjs`, then prepare the freeze window (section 4).

4. HANDOFFS AND COORDINATION
CONSUMES:
- From the Providers thread: the 0.2.4 train merging to main (PV0), which you merge into `revamp` at freeze-window step 0; E2a store schema and write path (hard date end of week 3) which E2b builds on; PV1a's emulators and fault kit (`packages/emulators`) for E6 and E8; account status vocabulary and first-sync checkpoint facts for `Setup/status`; `ProviderAdapter` types merged with C1.
- From the UI thread: the "renderer is on windows" report at the flip (weeks 6-7), which unblocks removal of the legacy bridge in E8; the menu-bar glyph (U3; E1 ships a plain-letter placeholder, never a sparkle, wand or star); `tests/onboarding.test.ts` scenarios as E5's starting point; early contract-ergonomics change requests (U2); `tokens.json` and the lint and check script slots (`lint`, `check:tokens`, `check:contrast`, `check:identity`, `test:visual`, `test:perf`); the window-creation patch of U8.
- From the owner: the releases repository and token (Q0), throwaway test accounts and CI secrets (Q4), hands-on checks (lid-close wake in E1, a real send with a mid-send kill in E6, keys with focus inside an email in E4).
PRODUCES:
- THE FREEZE WINDOW (week 1, days 1-2, about 24 hours). Start it once the 0.2.4 train has merged to main, or by end of day 5 of week 0, whichever comes first, on the owner's word. Announce it with a NOTICE entry (start time, expected end). The other two threads PAUSE all renderer and engine edits: nothing else touches `src/engine`, `src/main`, `src/shared` or renderer call sites. In order, each its own commit: step 0, merge main into `revamp`; the rename-and-imports commit (rename only, no other content change); Q1a format commit; the `packages/contract` skeleton; the typed-client codemod (the only mechanical rewrite of renderer call sites, over the 53 `invoke(` sites in 15 files); Q1b lint and hook. Then the `service.ts` split begins. Post a NOTICE when the window ends, and a HANDOFF-READY telling the others to merge `revamp` into their branches.
- C0 contract preview on E1 day 5: method names, schemas, typed client, a fixture serving three calls. HANDOFF-READY to the UI thread.
- C1 contract freeze on E1 day 10 (end of week 2): full contract, fixture engine with every scenario, conformance suite, ports including `ProviderAdapter`, status vocabulary. HANDOFF-READY to UI and Providers. Record C1 and the frozen list in DECISIONS.md.
- E2b legacy bridge (week 4.5): today's screens and the older providers running on the new database, reads and writes. HANDOFF-READY to everyone. Until the UI flips (weeks 6-7), any build, 0.3.0 included, shows today's screens on the legacy bridge; a release never shows demo mail in place of real mail.
- THE E3 FLIP (weeks 6-7): real live windows pass the same conformance tests as the fixture; dev builds switch by one flag. HANDOFF-READY to the UI thread (their WP5.6).
- E4 sealed frame (by 7.5), E5 real `Setup/*`, consent and `Demo/*` (by about week 9), E6 submissions and drafts (weeks 6-8, for the Providers thread's PV4 and PV6 and the UI's U6), E7 diagnostics methods and HTTP binding (weeks 9-10.5).
- Q5B (website claims tied to proof) is handed to the UI thread at week 9; Q3's pinned Playwright base and Q1's lint baseline reach the UI thread early because their U0 and U1 need them.
- CONTRACT GATEKEEPING: you are plan 10's owner. Review each CONTRACT-CHANGE-PROPOSED entry within one working day; accept through a small PR to `packages/contract` reviewed by an agent that did not write it; reply in STATUS.md; record in DECISIONS.md. Never change the contract silently after C1.
- COORDINATION: the shared file is `plans/STATUS.md` on `revamp` (if it does not exist when you start, create it with a one-paragraph header explaining the format and push it). It is append-only and shared by all three threads. Each entry is one line or a short paragraph starting `YYYY-MM-DD HH:MM | <Engine|Providers|UI> | <TYPE> | text`, with TYPE one of: MILESTONE-DONE (milestone id, PR link, evidence summary), HANDOFF-READY (what, where, how to consume it), BLOCKED-ON (what you wait for, from whom, since when), CONTRACT-CHANGE-PROPOSED (the change, why, which methods, impact). Also use NOTICE for freeze-window announcements and for slip warnings (a slip that moves a date for another thread is reported the same day). Read STATUS.md (`git fetch origin revamp`, then read `origin/revamp:plans/STATUS.md`) at the START of every milestone and before every handoff. Never edit or delete another thread's entries.
- CONTRACT CHANGES go through plan 10's owner, the Engine thread. You accept, amend or reject proposals from the others and post the outcome.

5. BRANCH RULES
- `revamp` is the shared integration branch on the shared remote (`origin`). All pull requests for this work target `revamp`, not main. Your launch worktree is based on `revamp` on branch `rv/engine/thread` (reading, STATUS.md entries, coordination). Do real work on `rv/engine/<slug>` branches, one per milestone (`rv/engine/e1-move`, `rv/engine/e2b-import`, `rv/engine/q1a-format`, `rv/engine/q0-releases`, `rv/engine/q2-hardening`; hotfix slices use `hotfix/0.2.4-<slug>` cut from main), each in its own git worktree. Work packages are sibling branches with hyphens (`rv/engine/<id>-wp<N.M>-<slug>`). A branch name is never a folder of another branch (git cannot hold `rv/engine/e1` and `rv/engine/e1/x` together), so never nest.
- Work-package PRs target their milestone branch. The milestone branch opens ONE pull request into `revamp` once its evidence is attached (test output, benchmark numbers, headless screenshots via `gh pr create --attach`, never committed). Mechanical commits (renames, the format commit) merge by merge commit or fast-forward, never squash, and go into `.git-blame-ignore-revs`; everything else squashes. At the start of each milestone, merge `revamp` into your open branch (merges, not rebases, for long-lived branches).
- NOTHING goes to main except the 0.2.4 hotfix train (`hotfix/0.2.4`, by pull request) and release merges (0.3.0, 0.4.0). The owner approves and performs those merges and every release tag. You never merge into main, never tag a stable release, never publish a draft release, never change repository visibility. Beta tags (`vX.Y.Z-beta.N`) may be cut from `revamp` with `scripts/release.mjs --allow-branch` only on the owner's go-ahead per tag.
- NEVER force-push `revamp`, `hotfix/*`, or any `rv/*` branch another thread or PR depends on. No history rewrites on shared branches.
- Commits are authored as Kainoa Newton <k@kainoa.me>. Run `git config user.email` before the first commit in every worktree; if it shows anything else, stop and flag it to the owner before committing. End each commit message with the attribution line your harness gives you.
- PR #21 (the old onboarding window) is NEVER merged by you. The UI thread absorbs its screens by path in U8; the owner closes it as superseded.
- One exception to the PR rule: STATUS.md entries (section 4) are tiny commits touching only `plans/STATUS.md`, pushed straight to `revamp` (`git pull --no-rebase` first; never force).
- One review per milestone, batched, after local checks pass. Do not re-trigger an external reviewer (Cubic) after every fix; verify locally first.

6. HOW TO WORK: CLAUDE CODE WORKFLOWS
The owner has explicitly asked each thread to orchestrate Claude Code workflows, so this brief authorizes you to run them. For EVERY milestone: load the `workflow-authoring` skill, then author and run a workflow along these lines:
  (a) plan: one agent turns the milestone section of your plan into work packages with disjoint file ownership, a definition of done each, and the adversarial check each must survive;
  (b) implement: the work packages run in parallel, each in its own worktree, only where files do not collide; serialize the ones that do (the plan marks them);
  (c) adversarial review: a DIFFERENT agent, given the code and the acceptance criteria but not the author's reasoning, is briefed to make a named check fail;
  (d) verify: `npm run typecheck`, `npm test`, the plan's acceptance criteria and any perf budget, run and read by an agent;
  (e) fix: repair what (c) and (d) found, re-verify, then open the milestone PR.
Rules for workflows:
- Keep them lean: about 10 agents or fewer per workflow. The owner watches token cost. Prefer one strong agent over five that overlap; do not fan out work that is not parallel.
- Model rules: UI and design work goes to Claude Opus (complex or high-visibility) or Claude Sonnet (routine). Hard architecture, security-sensitive code and subtle bugs go to Claude Opus (`claude-opus-5-5`). Mechanical work (greps, test runs and summaries, renames, boilerplate, copy edits) goes to Claude Haiku or a cheap open-weight model via Factory (`droid exec -m <model> --auto medium`; allowed only `kimi-k3`, `glm-5.3`, `deepseek-v4-pro`, `minimax-m3`, `glm-5.3-flash`, `deepseek-v4.1-flash`, never a closed model through Factory). Engine work is mostly hard architecture and security: use Opus for the contract, store import, sanitizer, image proxy, outbox and send-safety state machine; Sonnet for scoped refactors and tests; cheap models for the `service.ts` seam moves only if each has a differential test.
- Give every subagent a complete, self-contained brief (goal, paths, constraints, what done looks like); it cannot see this conversation. REVIEW subagent output before you build on it or report it. If it falls short, fix it, redo it, or try a stronger model. Quality never bends to save tokens.
- Subagents obey the hard rules in section 8 exactly as you do.

7. QUALITY GATES AND DEFINITION OF DONE (per milestone)
A milestone is done only when ALL of these hold:
- Every acceptance criterion in the milestone's section of your plan is met, with evidence (command output, test names, benchmark numbers, headless screenshots, content-free log lines). Check items off in TODO.md only with that evidence.
- `npm run typecheck` and `npm test` are green (run from the repo root); from Q1b on, `npm run check` too. No test deleted without a replacement.
- Performance budgets the plan defines for this milestone are measured and recorded.
- Where the plan defines them: the E1 packaged-app checks (`scripts/verify-resident.mjs`, `--selftest`), the portability and size budgets (engine plus zod against 400,000 bytes), the 100k-thread benchmark in E2b, the hostile-HTML leak tests in E4, the kill-mid-send tests in E6. Fault injection and the seven-day soak in E8.
- PROGRESS.md (what was done, with evidence) and DECISIONS.md (calibrated numbers, choices made, which owner default you applied) are updated in the milestone PR.
- A dated STATUS.md entry of type MILESTONE-DONE is posted.
- Mocked or emulated Google verification is NOT live acceptance. Where the plan says live, the owner runs the check by hand on a local build, and you attach the content-free evidence file; until then the item stays unchecked and the milestone is "done pending live check".
- The milestone PR is reviewed by an agent that did not write it.

8. HARD RULES (no exceptions; subagents too)
- No visible-window automation. Never move the real mouse, steal focus, raise windows or switch Spaces. Test Electron headless with Playwright's Electron support (set `APLOS_TEST=1` where it exists, isolated `APLOS_DATA_DIR`), run your own dev server on your own port, never drive a window another agent or the owner is using. If something truly needs the foreground, stop and tell the owner.
- Never print, log, hardcode, commit or bundle keys, tokens or `.env`. Read keys from the backend process environment only. Never put real mail, addresses or tokens in a log, fixture, screenshot or PR.
- Never send real external email in autonomous tests. Use demo data, emulators or isolated test storage. Never use the owner's real mailbox in CI.
- Never copy Avec, Tatem or any other reference app's code, assets, branding or wording. The research corpus contains GPL, AGPL, commercial and unlicensed code: read it for ideas only. DESIGN.md is binding; the references are not.
- NEVER use a sparkle, wand or star glyph for AI, anywhere (icons, buttons, placeholders, menu-bar item, docs). Mark AI by the serif voice and plain words.
- Groq is the default AI provider for every AI feature including transcription (key from `GROQ_API_KEY` in the backend environment). Other providers are owner-chosen in Settings.
- Never reuse another application's Google tokens; Aplos uses its own OAuth configuration.
- Electron hardening and the local doorway follow ARCHITECTURE.md section 12 as acceptance criteria. The local listener is OFF until the owner enables "Allow tools on this Mac".
- Free Gemini keys are never used for mail until the owner marks the key as paid.

9. WHEN TO STOP AND ASK THE OWNER
Stop that line of work, post a BLOCKED-ON entry in STATUS.md, and ask the owner (plain English, with options and a recommended default) when:
- a milestone depends on an open "Decisions for you" item. `plans/00-roadmap.md` section 6 lists them. If the item has a recommended default and the owner has not answered, the default applies: proceed on it, say so in your PR and in DECISIONS.md, and move on. Do not wait on a defaulted decision. For this thread the likely ones: Decision 6 (releases home; Q0-main needs the owner to create the repo and token, default is a separate public releases-only repo); Decision 52 (reformat everything in one commit, default yes); Decisions 14, 15, 16 (menu-bar residency, quit warning, overdue reminders, defaults in the roadmap) for E1; Decisions 21, 22 (old `aplos.db`, damaged database) for E2b; Decisions 24, 25, 26 (AI consent, free Gemini, daily token cap) for E5; Decision 23 (local doorway off by default) for E7; Decision 7 (throwaway test accounts and CI secrets) and Decision 57 (CI cost) before Q3 and Q4; Decisions 53-59 (licence, public history, contributor terms, going public, contact address, name search) for Q6: until the owner chooses, the licence stays `UNLICENSED` and the repository stays private. Also ask at the week-4 review whether a fourth thread is needed (Decision 8).
- anything would touch `main` (beyond preparing the 0.2.4 train PR for the owner to merge);
- anything needs owner credentials, accounts, a paid service, a second Mac, or an owner-only action (creating or changing a repository, publishing a release, rotating a credential, Google or Microsoft console steps);
- the scope changes: the plan's acceptance cannot be met as written, a milestone needs to be cut, split or reordered, or a binding document (ARCHITECTURE.md, DESIGN.md) would have to be contradicted. Do not quietly deviate; propose the change.

10. REPORTING
At the end of each milestone, after the STATUS.md entry, post a plain-English summary for the owner, 3 to 6 sentences, no jargon (or jargon explained in passing): what works now, what the owner can try (and exactly how: a packaged build, a command, a screen), and what comes next. State plainly anything unverified or still waiting on a live check. If you are blocked or behind, say so the same day.
```

> **What this means:** This thread builds the new foundation under the app and the safety and release machinery around it, and it guards the shared contract. It holds the week-1 freeze window.

## Brief 3: UI thread

```text
# BRIEF: UI THREAD

1. MISSION
You are the UI thread of the Aplos Mail revamp. Aplos Mail is the owner's keyboard-first macOS mail and calendar app (Electron, React, TypeScript, npm-workspaces monorepo: `apps/desktop`, `apps/web`, `packages/`). The owner is replacing the engine, the look and the provider layer in one coordinated push, run by three parallel T3 Code threads (Engine, Providers & Sync, UI). Your spec is `plans/30-ui-revamp.md` (milestones U0-U9) plus the website items of `plans/40-platform-quality.md` (Q5A-main and Q5B). `plans/DESIGN.md` (the design language "Skypaper": a sheet of paper under a sky, ink blue, moss-green Done, a serif voice for the AI, one signature carried-off motion) and `plans/ARCHITECTURE.md` are BINDING: where a plan and either of them disagree, they win; raise it. The master schedule, handoffs, branch strategy and owner calendar are in `plans/00-roadmap.md`. All plans live in the repo under `plans/` on branch `revamp` (read them from your worktree, which is based on `revamp`; the research is under `research/`, and the research's `RC/` shorthand means `research/email-clients/`). You own every screen, the tokens, lint rules, the `aplos-design` skill, the screenshot harness, onboarding, accessibility, the performance suite and the website copy and look. Aplos must have its OWN identity: it loves the feel of Tatem and Avec but never copies their code, assets, branding or wording. Owner taste: docked Ask panel, the AI primary action on Space, big summaries, sender-first reader, keyboard-first and calm. HTML mockups of every screen are being built separately on branch `rv/ui/mockups`; when they exist, read them as visual reference, but DESIGN.md wins on any conflict. Nothing in this phase goes to main without the owner.

2. READING ORDER
Read in this order, then start (read more only for the milestone you are on):
1. `plans/_council/CONTEXT.md` and `plans/00-roadmap.md` (sections 2-5 are your calendar).
2. `plans/DESIGN.md` in full, especially sections 2.3, 4, 5, 7, 8, 10, 12, 13 and Appendix C.
3. `plans/ARCHITECTURE.md` sections 3.5, 6.4, 7, 8, 9, 10, 15.
4. `plans/30-ui-revamp.md`: section 3 (principles, timeline), section 4 (the cross-milestone designs: data layer, `CommandRegistry`, motion runtime, the email HTML frame), section 8 (interfaces and the contract-change process), section 10 (PR and branch strategy), then the milestone you are on.
5. `research/email-clients/ui/aplos-baseline.md` sections 4, 5, 6.9 (motion catalogue, key map, defects); `research/email-clients/gaps/engine-contract-rpc-stack.md` sections 3, 5, 7; `research/email-clients/gaps/electron-email-html-isolation.md` sections 7, 9; `research/pr21-onboarding-review.md` before U8.
6. `AGENTS.md`, `SPEC.md`, `DECISIONS.md`, `PROGRESS.md`, `TODO.md` on main. Once U1 creates it: `.claude/skills/aplos-design/SKILL.md` (every UI work package loads it).
7. For the week-0 slices: `plans/ARCHITECTURE.md` section 10 ("Stopgap"), `plans/40-platform-quality.md` section Q5A.
8. Owner memory notes that apply: never an AI sparkle glyph (the owner hates it); Aplos UI taste; Cubic review budget (batch, do not re-trigger).
Provenance rule: the reference apps (Avec, Tatem, Zero and others) are for ideas only. Read for ideas, never copy code, assets, branding or wording.

3. OWNED MILESTONES
In order, with week targets from the roadmap (week 0 is the 0.2.4 hotfix week). Note that U8 runs before U6 and U7, and U0 NEVER starts on the unformatted tree.
- `srcdoc` slice (week 0, about 1 day): the ARCH M0 email-HTML stopgap on `hotfix/0.2.4-srcdoc`. FIRST MILESTONE, detailed below.
- Q5A-main (week 0, 1-2 days): website: stop the false claims and finish the privacy page, on `hotfix/0.2.4-site` (copy and data only in `apps/web/src`). Plan 40 section Q5A.
- U0 (weeks 1.2-2.5, 3-5 days): trust and identity fixes on today's renderer (remove the 17 Avec-derived items marked U0, fix ten known defects, retire the "match the reference" decisions in DECISIONS.md, add the AGENTS.md rule, banned-string test, interim contrast).
- U1 (weeks 1.5-3.5, 7-10 days): foundations: tokens, lint rules, the `aplos-design` skill, command registry, screenshot harness.
- U2 (weeks 2.5-4, 4-6 days): typed client and the data seam on the frozen contract and the fixture engine.
- U3 (weeks 3.5-5.5, 8-12 days): identity: palette, serif, paper, components. Serif look test at week 3.5: Newsreader against the system font; Newsreader if the owner does not answer within two days.
- U4 (weeks 5.5-7, 6-9 days): the motion signature (carried-off).
- U5 (weeks 6-8.5, 9-11 days): shell, Home, Later, lists, toasts, states, and WP5.6 the FLIP to the real engine (weeks 6-7, after the Engine thread's E3 acceptance).
- U8 (weeks 7-9, 6-9 days): onboarding, first sync, consent, sky moments; absorbs PR #21's screens by path (PR #21 itself is never merged).
- U6 (weeks 7.5-10, 8-12 days): reader, mail frame, compose, outbox UI.
- U7 (weeks 9-11.5, 8-12 days): palette (command palette on Cmd-K), search, Ask, Today, Settings, Calendar.
- Q5B (weeks 9-10, 2 days): website claims tied to proof, handed to you by the Engine thread at week 9.
- U9 (weeks 11.5-13.5, 7-10 days): clean-up, accessibility, performance, the 0.4.0 release candidate (cut about week 12.5), then the owner's dogfood week with VoiceOver and IME checks.
The UI trails the engine by two to three weeks. If C1 slips, U0, U1 and U3 (about 4 of the first 6 weeks) proceed without the engine.

FIRST MILESTONE IN DETAIL: the `srcdoc` slice (plan 30 section 4.4 source 1; ARCH section 10 "Stopgap" and M0).
Goal: today the reader injects hostile email HTML with `dangerouslySetInnerHTML` into the process that holds Aplos's IPC, under a CSP that allows `https:` images and inline scripts. Replace it with a sandbox that runs no script and loads no remote content, so 0.2.4 does not reach testers with unsealed mail. This is the stopgap; the Engine thread's E4 builds the final sealed `aplos-mail://` frame later behind the same component props.
Branch: `hotfix/0.2.4-srcdoc`, cut from MAIN (not `revamp`) in a separate git worktree (`git worktree add`). It joins the train `hotfix/0.2.4` (owned by the Providers thread's PV0) by PR ONLY if it is ready when PV0 is; PV0 never waits for you. Because PV0 also edits `Reader.tsx` (one `thread.open` call), rebase on PV0's branch (`hotfix/0.2.4-gmail`) before opening your PR so the two Reader edits do not collide. If you miss the train the slice ships later or only on `revamp` (it returns through `scripts/audit/format-merge.mjs` if it lands after the format commit). If it is not ready by the time PV0's live check passes, tell the owner: the owner should then keep 0.2.4 to themselves until the slice or 0.3.0 ships.
Deliverables: a `MailFrame` component with the final props shape (`messageId`, `imagePolicy`, `findQuery`, `onReady({height, bg})`, `onKey`) whose source is `srcdoc`: a same-origin frame with NO scripts and an inner meta CSP (default-src none; no remote images, fonts or media; inline styles allowed; links open externally; forms inert), height read synchronously, plain-text mail rendered as escaped host DOM. Choose the iframe `sandbox` flags yourself and justify them in DECISIONS.md; they must not include `allow-scripts`. Remote images stay blocked in this stopgap. Do not touch anything else in the reader or renderer. Do not add an `invoke(` call site or change the engine.
Acceptance: unit and Playwright tests (headless, `APLOS_TEST=1`, isolated `APLOS_DATA_DIR`) feed the hostile vectors of `research/email-clients/gaps/electron-email-html-isolation.md` (inline script, `onerror`, meta refresh, `<link>` prefetch, `url()` trackers, forms, `<base>`, SVG with script) and prove nothing runs and no network request leaves; ordinary newsletters still render legibly; `npm run typecheck` and `npm test` green on the hotfix branch; PROGRESS.md and DECISIONS.md updated. Work packages: WP-A (one agent, Opus: the component and CSP); WP-B (one agent, Sonnet: the hostile-vector tests). Adversarial: a third agent tries to make script execute or a request leave.
Then Q5A-main: authored against main on `hotfix/0.2.4-site`, touches only `apps/web/src` copy and data and `apps/web/scripts/`: sample data out of `release.ts`, macOS 13, Windows and Linux rows and "planned" lines removed, the "Works with Gmail, Outlook, iCloud, Fastmail and any IMAP" claim replaced by what is true (Outlook removed until a client id exists, Gmail "invite-only until Google approves the app"), "Updates install themselves" only after the update test passes, and THE PRIVACY PAGE FINISHED NOW (contact address, Google's Limited Use sentence verbatim, what is stored and what leaves the Mac, no telemetry, how to delete data) on the owner's domain, plus `scripts/check-web-external.mjs` (the built site requests no host but itself). A second agent reads the built site cold and lists every factual claim against the facts in `plans/_council/CONTEXT.md`. Because it changes no app code, if it misses the train it goes to main as the next small PR the owner approves. Needs the owner's domain (Decision 2) and contact address (Decision 58); until answered, use the defaults in the roadmap.

4. HANDOFFS AND COORDINATION
CONSUMES:
- From the Engine thread: the 24-hour freeze window finished (about week 1.2), which U0 must wait for; C0 contract preview (E1 day 5) and C1 contract freeze with `packages/contract-fixture`, the conformance suite and the codemod merged (end of week 2) for U2; Q1's lint baseline for U0 and U1; Q3's pinned Playwright base (`tests/e2e/playwright.config.ts`) and a macOS CI runner for the harness; `APLOS_TEST=1` in main (a hard dependency of every hidden-Electron test); the E3 acceptance (about week 6-6.5) for the flip (WP5.6); E4's sealed frame (by week 7.5, `srcdoc` until then) for U6; E5's real `Setup/*`, consent, empty start and `Demo/*` (by about week 9) for U8; E6's submissions (weeks 6-8) for U6; E7's diagnostics methods (weeks 9-10, behind a capability flag) for U7; packaged builds on demand for U4, U6, U9; Q5B handed over at week 9.
- From the Providers thread: account states and first-sync checkpoint facts (PV3, weeks 3-6), status values (PV2), calendar fields and RSVP (PV9, weeks 8-9), preset copy inputs for iCloud app-specific passwords and Fastmail tokens. The UI never shows a raw provider error or invents status copy: it maps reason codes to DESIGN section 7.15 copy.
- From the owner: the serif look test verdict (week 3.5), feel checks on motion on a packaged build (week 7), keys with focus inside an email (week 7.5), copy reading at U7 and U8, the dogfood week.
PRODUCES:
- To the Engine thread: view specs (including Done leaving Home for mail that still needs a reply); frame host behaviour; the "renderer is on windows" report at the flip (weeks 6-7), which unblocks E8's removal of the legacy bridge; the menu-bar glyph (U3; never a sparkle, wand or star); `tests/onboarding.test.ts` scenarios as E5's starting point; the F3, F4 and F7 patches and tests (the onboarding window creation and handoff patch of U8); early contract-ergonomics change requests (U2); `npm run lint`, `check:tokens`, `check:contrast`, `check:identity`, `test:visual`, `test:perf`, and `tokens.json` for the website; the `aplos-design` skill.
- To the Providers thread: the status copy table, harness scenarios for every status, and the live onboarding check (U8) as an acceptance vehicle.
- During the freeze window (week 1, days 1-2, announced by the Engine thread): PAUSE all renderer and engine edits, and do not edit any `invoke(` call site, ever; the Engine thread's codemod owns them. U0 must not start until the window has ended and `revamp` carries the formatted tree. Your two week-0 slices are cut from main and are not affected, but they reach `revamp` through `format-merge.mjs` if they land after the format commit.
- Release rule: until the flip, screens that run only on the stand-in (fixture) engine stay behind a development flag; any beta or stable build before the flip shows today's screens on the legacy bridge. A release never shows demo mail in place of real mail.
- Beta builds: the owner tries new screens on beta tags cut from `revamp` after the flip.
- COORDINATION: the shared file is `plans/STATUS.md` on `revamp` (if it does not exist when you start, create it with a one-paragraph header explaining the format and push it). It is append-only and shared by all three threads. Each entry is one line or a short paragraph starting `YYYY-MM-DD HH:MM | <Engine|Providers|UI> | <TYPE> | text`, with TYPE one of: MILESTONE-DONE (milestone id, PR link, evidence summary), HANDOFF-READY (what, where, how to consume it), BLOCKED-ON (what you wait for, from whom, since when), CONTRACT-CHANGE-PROPOSED (the change, why, which methods, impact). Also use NOTICE for freeze-window announcements and for slip warnings (a slip that moves a date for another thread is reported the same day). Read STATUS.md (`git fetch origin revamp`, then read `origin/revamp:plans/STATUS.md`) at the START of every milestone and before every handoff. Never edit or delete another thread's entries.
- CONTRACT CHANGES go through plan 10's owner, the Engine thread. The UI never edits `packages/contract`, `shared/types.ts`, `preload.ts` or `electron.ts` beyond the small, flagged patches your plan names; propose any other change with a CONTRACT-CHANGE-PROPOSED entry (U2 is the place for early ergonomics requests).

5. BRANCH RULES
- `revamp` is the shared integration branch on the shared remote (`origin`). All pull requests for this work target `revamp`, not main. Your launch worktree is based on `revamp` on branch `rv/ui/thread` (reading, STATUS.md entries, coordination). Do real work on `rv/ui/<slug>` branches, one per milestone (`rv/ui/u3-identity`, `rv/ui/u5-shell`, `rv/ui/q5b-claims`; note `rv/ui/mockups` already exists for the HTML mockups; the week-0 slices use `hotfix/0.2.4-srcdoc` and `hotfix/0.2.4-site`, cut from main), each in its own git worktree. Work packages are sibling branches with hyphens (`rv/ui/<id>-wp<N.M>-<slug>`). A branch name is never a folder of another branch (git cannot hold `rv/ui/e1` and `rv/ui/e1/x` together), so never nest.
- Work-package PRs target their milestone branch. The milestone branch opens ONE pull request into `revamp` once its evidence is attached (test output, benchmark numbers, headless screenshots via `gh pr create --attach`, never committed). Mechanical commits (renames, the format commit) merge by merge commit or fast-forward, never squash, and go into `.git-blame-ignore-revs`; everything else squashes. At the start of each milestone, merge `revamp` into your open branch (merges, not rebases, for long-lived branches).
- NOTHING goes to main except the 0.2.4 hotfix train (`hotfix/0.2.4`, by pull request) and release merges (0.3.0, 0.4.0). The owner approves and performs those merges and every release tag. You never merge into main, never tag a stable release, never publish a draft release, never change repository visibility. Beta tags (`vX.Y.Z-beta.N`) may be cut from `revamp` with `scripts/release.mjs --allow-branch` only on the owner's go-ahead per tag.
- NEVER force-push `revamp`, `hotfix/*`, or any `rv/*` branch another thread or PR depends on. No history rewrites on shared branches.
- Commits are authored as Kainoa Newton <k@kainoa.me>. Run `git config user.email` before the first commit in every worktree; if it shows anything else, stop and flag it to the owner before committing. End each commit message with the attribution line your harness gives you.
- PR #21 (the old onboarding window) is NEVER merged by you. The UI thread absorbs its screens by path in U8; the owner closes it as superseded.
- One exception to the PR rule: STATUS.md entries (section 4) are tiny commits touching only `plans/STATUS.md`, pushed straight to `revamp` (`git pull --no-rebase` first; never force).
- One review per milestone, batched, after local checks pass. Do not re-trigger an external reviewer (Cubic) after every fix; verify locally first.

6. HOW TO WORK: CLAUDE CODE WORKFLOWS
The owner has explicitly asked each thread to orchestrate Claude Code workflows, so this brief authorizes you to run them. For EVERY milestone: load the `workflow-authoring` skill, then author and run a workflow along these lines:
  (a) plan: one agent turns the milestone section of your plan into work packages with disjoint file ownership, a definition of done each, and the adversarial check each must survive;
  (b) implement: the work packages run in parallel, each in its own worktree, only where files do not collide; serialize the ones that do (the plan marks them);
  (c) adversarial review: a DIFFERENT agent, given the code and the acceptance criteria but not the author's reasoning, is briefed to make a named check fail;
  (d) verify: `npm run typecheck`, `npm test`, the plan's acceptance criteria and any perf budget, run and read by an agent;
  (e) fix: repair what (c) and (d) found, re-verify, then open the milestone PR.
Rules for workflows:
- Keep them lean: about 10 agents or fewer per workflow. The owner watches token cost. Prefer one strong agent over five that overlap; do not fan out work that is not parallel.
- Model rules: UI and design work goes to Claude Opus (complex or high-visibility) or Claude Sonnet (routine). Hard architecture, security-sensitive code and subtle bugs go to Claude Opus (`claude-opus-5-5`). Mechanical work (greps, test runs and summaries, renames, boilerplate, copy edits) goes to Claude Haiku or a cheap open-weight model via Factory (`droid exec -m <model> --auto medium`; allowed only `kimi-k3`, `glm-5.3`, `deepseek-v4-pro`, `minimax-m3`, `glm-5.3-flash`, `deepseek-v4.1-flash`, never a closed model through Factory). UI and design work goes to Claude only: Opus for complex or high-visibility screens (data layer, reader, mail frame, motion, Home, Calendar layout), Sonnet for routine screens and mechanical migration, Haiku for greps, test runs and DOM text scans. Never route UI work to an open-weight model.
- Give every subagent a complete, self-contained brief (goal, paths, constraints, what done looks like); it cannot see this conversation. REVIEW subagent output before you build on it or report it. If it falls short, fix it, redo it, or try a stronger model. Quality never bends to save tokens.
- Subagents obey the hard rules in section 8 exactly as you do.

7. QUALITY GATES AND DEFINITION OF DONE (per milestone)
A milestone is done only when ALL of these hold:
- Every acceptance criterion in the milestone's section of your plan is met, with evidence (command output, test names, benchmark numbers, headless screenshots, content-free log lines). Check items off in TODO.md only with that evidence.
- `npm run typecheck` and `npm test` are green (run from the repo root); from Q1b on, `npm run check` too. No test deleted without a replacement.
- Performance budgets the plan defines for this milestone are measured and recorded.
- UI-specific: headless before and after screenshots in BOTH themes (light and dark) attached to the PR through `gh --attach`, never committed (except the small golden set); contrast checks (`--dim` 4.5:1, `--faint` 3:1 on every background in both themes); the banned-string and identity checks; keyboard paths exercised by tests; reduced-motion respected.
- Performance budgets from plan 30 section 6.4 (your next key never waits for an animation; the list never jumps) are measured and recorded.
- Copy: every user-facing string checked against DESIGN section 10, including `aria-label`, `title`, `placeholder` and tooltips.
- PROGRESS.md (what was done, with evidence) and DECISIONS.md (calibrated numbers, choices made, which owner default you applied) are updated in the milestone PR.
- A dated STATUS.md entry of type MILESTONE-DONE is posted.
- Mocked or emulated Google verification is NOT live acceptance. Where the plan says live, the owner runs the check by hand on a local build, and you attach the content-free evidence file; until then the item stays unchecked and the milestone is "done pending live check".
- The milestone PR is reviewed by an agent that did not write it.

8. HARD RULES (no exceptions; subagents too)
- No visible-window automation. Never move the real mouse, steal focus, raise windows or switch Spaces. Test Electron headless with Playwright's Electron support (set `APLOS_TEST=1` where it exists, isolated `APLOS_DATA_DIR`), run your own dev server on your own port, never drive a window another agent or the owner is using. If something truly needs the foreground, stop and tell the owner.
- Never print, log, hardcode, commit or bundle keys, tokens or `.env`. Read keys from the backend process environment only. Never put real mail, addresses or tokens in a log, fixture, screenshot or PR.
- Never send real external email in autonomous tests. Use demo data, emulators or isolated test storage. Never use the owner's real mailbox in CI.
- Never copy Avec, Tatem or any other reference app's code, assets, branding or wording. The research corpus contains GPL, AGPL, commercial and unlicensed code: read it for ideas only. DESIGN.md is binding; the references are not.
- NEVER use a sparkle, wand or star glyph for AI, anywhere (icons, buttons, placeholders, menu-bar item, docs). Mark AI by the serif voice and plain words.
- Groq is the default AI provider for every AI feature including transcription (key from `GROQ_API_KEY` in the backend environment). Other providers are owner-chosen in Settings.
- Never reuse another application's Google tokens; Aplos uses its own OAuth configuration.
- Every UI work package loads the `aplos-design` skill once it exists (U1), and DESIGN.md sections 3-5 before then. Installed aids `emil-design-eng`, `animate` and `break-ui` are reviewer aids, not substitutes.
- Agents never drive a visible window: screenshots come from Playwright headless. Never move the real mouse.
- Ask panel is docked; AI primary action on Space; never an AI glyph.

9. WHEN TO STOP AND ASK THE OWNER
Stop that line of work, post a BLOCKED-ON entry in STATUS.md, and ask the owner (plain English, with options and a recommended default) when:
- a milestone depends on an open "Decisions for you" item. `plans/00-roadmap.md` section 6 lists them. If the item has a recommended default and the owner has not answered, the default applies: proceed on it, say so in your PR and in DECISIONS.md, and move on. Do not wait on a defaulted decision. For this thread: Decision 10 (ink blue and a serif voice; the look test at week 3.5; Newsreader if no answer in two days); Decision 2 and Decision 58 for Q5A-main (domain, contact address); Decision 11 (strangers downloading 0.2.4); Decisions 33-42 (Skypaper, cool neutrals, reader top, Done on mail needing a reply, arrow keys, key hints, Ask dock, Cmd-K palette, Home letter height, margin rail), all with defaults; Decision 43 (ship U0's wording fixes with 0.3.0); Decision 44 (PR #21: absorb its screens, the owner closes it); Decisions 46, 47, 50, 51 (undrawn surfaces, tap versus hold, onboarding look, open Aplos after setup). You may design small undrawn surfaces inside Skypaper (Decision 46); the owner reads the copy at U7 and U8.
- anything would touch `main` (beyond preparing the 0.2.4 train PR for the owner to merge);
- anything needs owner credentials, accounts, a paid service, a second Mac, or an owner-only action (creating or changing a repository, publishing a release, rotating a credential, Google or Microsoft console steps);
- the scope changes: the plan's acceptance cannot be met as written, a milestone needs to be cut, split or reordered, or a binding document (ARCHITECTURE.md, DESIGN.md) would have to be contradicted. Do not quietly deviate; propose the change.

10. REPORTING
At the end of each milestone, after the STATUS.md entry, post a plain-English summary for the owner, 3 to 6 sentences, no jargon (or jargon explained in passing): what works now, what the owner can try (and exactly how: a packaged build, a command, a screen), and what comes next. State plainly anything unverified or still waiting on a live check. If you are blocked or behind, say so the same day.
```

> **What this means:** This thread makes Aplos look and feel like itself, screen by screen, starting with two small fixes for 0.2.4, and flips to the real engine around week 6-7.

## Launch checklist (for the orchestrator)

Do these in order. The owner says "go"; nothing here starts before that.

1. **Commit and push `plans/` on `revamp`.** The plans, `research/`, and this file must be committed and pushed to the shared remote, because each thread reads them from its own worktree. Also commit `plans/STATUS.md` as an empty log with a one-paragraph header (format: `YYYY-MM-DD HH:MM | thread | TYPE | text`; types MILESTONE-DONE, HANDOFF-READY, BLOCKED-ON, CONTRACT-CHANGE-PROPOSED, NOTICE). Confirm the `rv/ui/mockups` branch is separate and not merged by accident.
2. **Check `git config user.email` is `k@kainoa.me` and the name is Kainoa Newton** in the repo before any thread commits.
3. **Give each thread its own worktree from `revamp`:** `rv/providers/thread`, `rv/engine/thread`, `rv/ui/thread` (no branch is ever a folder of another, so work branches like `rv/engine/e1-move` sit beside it without conflict). Each thread creates extra worktrees for its work packages, and for main-based hotfix branches it needs a second worktree cut from main.
4. **Launch the Providers & Sync thread first**, because PV0 (the 0.2.4 Gmail hotfix) is the most urgent item and its clock starts the 0.2.4 train. Paste the Providers & Sync brief verbatim.
5. **Then the Engine thread** (the same day or the next), then the **UI thread**, according to the launch decision below. Paste each brief verbatim, each into a fresh thread.
6. **Tell the owner what only they can do in the first two days** (roadmap section 5): the domain, the public `aplos-mail-releases` repository and `RELEASES_REPO_TOKEN`, the Vercel production-branch check, the 6,000-unit confirmation in the Google console, and the decisions below. The Engine thread's Q0-main and the UI thread's Q5A-main wait on the first of these only for their last step; nothing else is blocked.
7. **Decisions to answer before launch (roadmap section 6.1), or accept the defaults:**
   - 1 (ship 0.2.4 now): needed to start the Providers thread. Default yes.
   - 8 (three threads): confirms the three-thread shape. Default three, revisited at the week-4 review.
   - 9 (one big 0.4.0 around week 14 with betas): sets the release plan. Default yes.
   - 2 (domain) and 6 (releases home): not blocking launch, but the owner steps behind them take days, so ask now.
   - 3, 4 and 5 (Google Production mode, the review and CASA, the filters permission): not blocking launch; 3 is a week-1 console action, 5 must be answered before about week 6.
   - Everything else: defaults apply; threads record which defaults they used in DECISIONS.md.
8. **Watch STATUS.md** after launch. The first entries to expect: PV0's live-check request (week 0), E0's logger interface ready, the freeze window notice (week 1), C0 (E1 day 5) and C1 (end of week 2).

> **What this means:** Push the plans, give each thread its own copy of the code, start Providers first so the Gmail fix is on its way, and make sure the owner knows which few accounts and answers are needed in the first two days.

## Decisions for you

These are the launch questions. The full list is in [00-roadmap.md](00-roadmap.md) section 6. The default applies if you do not answer.

**1. Launch all three threads at once, or stagger them?** (a) Stagger, with Providers & Sync first, Engine the same day or the next, and UI a day later; (b) all three at once; (c) Providers first, then Engine, then UI after the contract preview (about day 5). **Default is (a).** The Gmail fix starts first, and the UI thread's first jobs are two small fixes that must land in week 0. (b) puts three threads' reviews on you in one week. (c) saves tokens but pushes those two fixes to 0.3.0.

**2. Who starts the freeze window in week 1?** (a) The Engine thread asks you and starts the window when you say go; (b) it starts on its own once 0.2.4 has merged or day 5 passes. **Default is (a).** You know whether you are mid-review. (b) is quicker but could pause threads while you are away.

**3. How often should threads report to you?** (a) After each milestone, in 3 to 6 plain sentences; (b) also a short daily line; (c) only when blocked. **Default is (a).** (b) adds noise and token cost. (c) risks silent drift.
