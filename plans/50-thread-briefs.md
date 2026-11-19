# Aplos revamp: thread launch briefs

Written 2026-10-27 on branch `revamp`, rewritten the same day after the owner's answers. Planning only: nothing here is implemented and nothing goes to main. These are the launch messages for the six T3 Code threads defined in [00-roadmap.md](00-roadmap.md) section 5. The orchestrator pastes each block verbatim into a new thread when the owner says go.

## In plain English

This file holds one launch message for each of the six threads that build the revamp.

The Engine thread goes first. In the first two or three days it restructures the code and writes the shared rules every other thread builds on: the list of commands between the screens and the engine, the connection points for mail providers, the database layout and the logger. The UI-core thread writes the design tokens and style rules at the same time. Three reviewers try to break those rules before they freeze.

Then about 23 lanes run at once. This round is Gmail and Google Calendar only; Outlook, iCloud, Fastmail and other IMAP accounts wait for round 2. The Engine thread builds the database, live lists, the clock for scheduled sends and reminders, the AI queue, the sealed email frame and the menu-bar life. The Providers thread builds the practice servers, Gmail and Google Calendar. The UI-core thread builds the design system, the app shell, Home and the reader. The UI-screens thread builds onboarding, Calendar, Settings, Ask and the command palette. The Platform and website thread builds the test pipeline, the release safety work and the aplos.email site. The Integrator merges everything, runs the full test suite, and writes you one short summary a day.

The owner reviews per big feature. When a thread finishes one, it posts plain-English steps, screenshots and a short recording. The owner gives feedback until it looks good. The thread then runs deep review passes, opens a pull request into `revamp`, handles the comments and merges it itself unless something the owner would notice changed. Every brief ends with the full process and its own features.

You don't need to read the briefs. You need the launch checklist and the two launch questions at the end.

> **What this means:** Six messages, one per thread. Paste each into a new thread and it can start with nothing else from you.

**Lean mode (owner, 2026-10-28; every thread):** Sonnet by default, the free OpenCode models for mechanical code, and Opus only for a named short list. Agents read lane cards, not whole plans. Threads start fresh past about 150,000 tokens. At most two layers of agents, and one review per PR. The rules are in roadmap section 5.1a and override anything below that asks for Opus, adversarial panels or nested lane leads.

## How to use this file

Each brief sits in its own code block. Copy the whole block, exactly as it is, into a new T3 Code thread. Each brief is complete on its own: the thread sees nothing else except the repository. Shared sections (coordination, branches, workflows, quality, hard rules, the owner review loop) repeat in every brief on purpose.

## Brief 1: Engine thread

```text
# BRIEF: ENGINE THREAD

1. MISSION
You are the ENGINE thread of the Aplos Mail revamp. Aplos Mail is the owner's keyboard-first macOS mail and calendar app (Electron, React, TypeScript, npm-workspaces monorepo: `apps/desktop`, `apps/web`, `packages/`). The owner is rebuilding the engine, the provider layer and every screen at once and shipping them as ONE redesigned release (proposed 0.3.0). There is no 0.2.4 hotfix. Six T3 threads work in parallel: Engine (you), Providers, UI-core, UI-screens, Platform and website, and the Integrator. You lead PHASE 0, the foundation freeze, and you own the CONTRACT: every change to `packages/contract`, `packages/engine/src/ports.ts` and the method dispatch table goes through your lane `eng-contract`. After the freeze you run seven lanes in parallel. Schedule, lanes, owned paths and the freeze list are in `plans/00-roadmap.md` (reference sections 1-7). Where the roadmap and plans 10-40 disagree, the roadmap wins until the alignment pass lands; `plans/ARCHITECTURE.md` and `plans/DESIGN.md` win on technical and design substance. Nothing goes to main without the owner.

2. READING ORDER
1. `plans/_council/CONTEXT.md`, then `plans/00-roadmap.md` in full (reference sections 1, 2.1, 4, 6, 7 and 10 are your instructions).
2. `plans/ARCHITECTURE.md` sections 2, 3, 7, 8, 9, 10, 11, 12, 15, 16A.
3. `plans/10-engine-foundation.md`: sections 3, 4.1, 7, then the milestone sections your lanes implement (E1-E7, and E8 for Phase 2). Ignore its 0.2.4, legacy-bridge and codemod parts (roadmap section 10 lists what changed).
4. `plans/40-platform-quality.md` Q1 (your Phase 0 slots) and `plans/20-providers-sync.md` sections 3.2 and 7 (the ports you freeze).
5. `AGENTS.md`, `SPEC.md`, `DECISIONS.md`, `PROGRESS.md`, `TODO.md`.
6. Per lane, only the research its plan section names (`research/email-clients/gaps/*.md`, `research/pr21-onboarding-review.md`).
7. Owner memory: never an AI sparkle glyph; Cubic review budget (batch, never re-trigger after every fix).
Provenance: the research corpus contains GPL, AGPL, commercial and unlicensed code. Read it for ideas only; never copy code, assets, branding or wording.

3. YOUR LANES (exclusive paths; plan sections; Phase 1 days)
- `eng-contract`: `packages/contract/**`, `packages/contract-fixture/**`, `packages/engine/src/{runtime/**,methods/index.ts,methods/session.ts,methods/settings.ts}`, `apps/desktop/src/host/transports/port.ts`, `apps/desktop/src/main/{engine-host,server}.ts`, the generated part of `preload.ts`. Plan 10 section 4.1 and E1 items 3, 6, 7; E3's transport half (direct MessagePort, main out of the data path). Days 1-3 (freeze), then 4-10: every fixture scenario, the `Fixture/control` channel, the conformance suite, the preview host with its per-run token.
- `eng-store`: `packages/engine/src/store/**` including `store/import/**`, `packages/engine/bench/**`. Plan 10 E2 deliverables 1-11 and "The import". Days 4-10: real `store.commit` with rollups, ids and change log by day 6 (CRITICAL PATH: Providers' Gmail lane and `eng-views` wait for it), bodies, paced search and retention by 9, importer by 10.
- `eng-views`: `packages/engine/src/views/**`, `methods/{view,thread,operation}.ts`. Plan 10 E3 (view specs, window engine, holds, receipts, `Thread/act`, `Operation/undo`). Days 4-11. Goal: the conformance suite green on the real engine by day 11, which unblocks the UI's switch to the real engine.
- `eng-time`: `packages/engine/src/{outbox,clock}/**`, `methods/{submission,draft,outbox,later,reminder,notification}.ts`. Plan 10 E6 in full. Days 4-10.
- `eng-ai`: `packages/engine/src/ai/**`, `methods/{ai,ask,setup,demo,consent,queue}.ts`, `apps/desktop/src/host/ai/**` (today's `main/{groq,llm,ollama,anthropic,ai-keys}.ts` move here; all SDKs `maxRetries: 0`). Plan 10 E5 in full, plus the per-feature provider and model settings (Ask, Summaries, Drafts, Plans, Voice) from AGENTS.md. Days 4-11.
- `eng-html`: `packages/mail-html/**`, `apps/desktop/src/host/{protocol,proxy}/**`, `main/protocol.ts`, `methods/mail.ts`. Plan 10 E4 in full. Days 4-10.
- `eng-host`: `main/{lifecycle,menu-bar,windows,native-methods}.ts`, `host/{lifecycle,power,lock,crash}.ts`, `packages/engine/src/selftest.ts`, `host/transports/{socket,http}.ts`, `host/{mcp,cli}/**`, `packages/engine/src/diag/bundle/**`, `methods/{diagnostics,listener,clients}.ts`. Plan 10 E1 items 4-5 (resident mode, lock, wake, parked, self-test) by day 7, then E7 (socket, loopback HTTP, clients and scopes, OpenAPI, MCP, diagnostics bundle) by day 12.
Start order when you fan out: `eng-store` and `eng-views` first (critical), then `eng-time`, `eng-html`, `eng-ai`, `eng-host`. If you run late, cut in this order: E7's MCP and CLI extras, the Swift spike, then the AI queue's extras. Never cut the sealed frame, the outbox or the views.

4. PHASE 0 (days 1-3): YOU LEAD THE FREEZE
Post `NOTICE | restructure started` in STATUS.md. Nobody else edits existing files until step 4 lands.
4.1 Restructure chain (day 1, serial, each step its own commit, merge commits, mechanical ones in `.git-blame-ignore-revs`):
  Step 1, rename and imports, nothing else: `git mv apps/desktop/src/engine packages/engine/src/legacy` (today's engine files), the engine's `src/shared` dependencies to `packages/contract/src/legacy/` with one-line re-export stubs, today's renderer to `apps/desktop/src/renderer/legacy/`, workspaces `@aplos/engine` and `@aplos/contract` as internal source packages, tsconfig paths, the Vite alias, esbuild bundling `@aplos/*` but not third-party packages, a recursive portability test with a planted-import negative test, and `appVersion` through `EngineInit`. Proof: `git diff -M --stat` shows renames, the non-rename diff touches only import lines, `npm run typecheck`, `npm test`, `npm run package` and `verify-release.mjs` pass. Legacy code keeps building and its tests stay green; it is read-only reference until Phase 2 deletes it.
  Step 2, the Prettier format commit: the Platform thread has prepared it (plan 40 Q1a); it lands in this slot with its proof (identical minified output).
  Step 3, split `apps/desktop/src/main/electron.ts` into `windows.ts`, `lifecycle.ts`, `protocol.ts`, `menu-bar.ts`, `native-methods.ts`, `security.ts`, `updater.ts`, `engine-host.ts`. Code moves only, tests green.
  Step 4, the Platform thread's lint, boundaries, hook and `static` job (plan 40 Q1b) land in this slot.
  There is NO typed-client codemod over today's 53 `invoke(` sites and NO legacy bridge: no release ships today's screens on the new engine.
4.2 Frozen artifacts (days 2-3, parallel agents on new files; roadmap section 1.2 is the checklist):
  F1 contract v1 in `packages/contract/src/**`: every method name with zod input and output schemas (plan 10 section 4.1's verb list plus Consent, Listener, Clients, Diagnostics), all frames with `{dbEpoch, seq}` tokens and receipts, error types, the classified-error record `{class, reason, status, code, retryAfterMs, providerMessage}`, the status vocabulary (`starting`, `ok`, `syncing`, `backfilling(n of m)`, `paused(until, reason)`, `needsReauth`, `needsPermission`, `needsAdmin`, `misconfigured`, `offline`, `error`) plus a per-account `reconnectBy` time for Google's 7-day Testing-mode tokens, the `Setup/status` shape, the Thread row with `partial`, `Mail/frame`, capability flags, `Settings` with its `ui` object and a provider and model per AI feature, the logger event catalog.
  F2 generated allowlists and the typed client `api.*`; `preload.ts`, `engine-host.ts` and `server.ts` derive from the registry; a host-agreement test.
  F3 `packages/engine/src/ports.ts`: `ProviderAdapter` (with `CalendarAdapter` and `findSent`), `GovernorPort`, `AccountActorHost`, `SendPort` with `NotSentError`, `DraftSyncPort`, `ProviderPort.openThread`, `Clock`, deadline-source registration, `KeyProvider`, `MailHtml`, `Logger`, `StorePort`, `laneFor`. The Providers thread sends its proposal for the provider ports by the morning of day 2; you decide and freeze.
  F4 migration framework, `mail.db` schema 0001 (ARCH 3.2 plus the Providers review: recurrence id on `events`, `message_folders` keyed for IMAP placements, `sync_state`, `governor_state`, the account's token-grant time), the `store.commit` signature, and a minimal working commit that writes `changes` and bumps `seq` so other lanes can test against it.
  F5 `packages/engine/src/methods/index.ts`: every contract method mapped to one module file, each a stub throwing `NotImplemented`. Lanes fill their own files and never edit this table.
  F6 the stand-in engine (`packages/contract-fixture`) answering every method on `demo` and `empty`, the `Fixture/control` signatures, and the conformance suite layout. No Node or Electron imports; nothing from it ships.
  F7 the `Logger` port, redacting allowlist, and the log sink at final paths (`packages/engine/src/diag/log.ts`, `apps/desktop/src/host/logsink.ts`): JSON lines in `~/Library/Logs/Aplos Mail/`, 10 MB x 5 rotation, files 0600, directory 0700, no tokens, keys, bodies, subjects or snippets, addresses as salted hashes, provider text redacted and cut to 300 characters (plan 10 E0's acceptance, including the canary test).
  F8 with the Platform thread: `APLOS_TEST=1` and `APLOS_DATA_DIR` honoured in main (isolated data, no single-instance lock, no Dock, menu-bar or login item, windows created hidden).
4.3 The freeze review (day 3): the Integrator runs three adversarial reviewers (UI, Providers, security and platform) against F1-F9. Fix every gap they find. The engine plus zod must stay under 400,000 bytes; record the measured size. When the Integrator posts FROZEN and tags `contract-v1`, Phase 1 starts.

5. FROZEN ARTIFACTS
You PRODUCE F1-F8. You CONSUME F9 (the UI-core thread's tokens and data-hook signatures, for the `ui` settings object) and F10 (`plans/OWNERS.md`, the owners check). After the freeze: changes are additive within `v:1`; others propose them with CONTRACT-CHANGE-PROPOSED; you answer within half a day, make accepted changes in `eng-contract` by a small PR reviewed by an agent that did not write it, post CONTRACT-CHANGE-DONE, and record them in DECISIONS.md. A breaking change needs `v:2` and the owner. Schema changes after 0001 are new additive migrations owned by `eng-store`, proposed the same way.

6. PHASE 2 AND 3 ROLE
`eng-views` and `eng-contract` make the real engine pass the same conformance suite as the stand-in engine (an expected-fail list that shrinks from day 4 to zero by day 11). In Phase 2 you support the switch to the real engine, run the importer rehearsal command for the owner (a copy of `aplos.db`, content-free report), delete the legacy folders with the Integrator (plan 10 E8 item 4), and run E8's fault injection and the background soak during Phase 3.

7. COORDINATION
- `plans/STATUS.md` on `revamp` is the append-only log shared by all six threads. One line per entry: `YYYY-MM-DD HH:MM | <thread> | <TYPE> | <lane> | text`, TYPE one of NOTICE, FROZEN, HANDOFF-READY, LANE-DONE, REQUEST, BLOCKED-ON, CONTRACT-CHANGE-PROPOSED, CONTRACT-CHANGE-DONE, SLIP, READY-FOR-OWNER, APPROVED, MERGED. Read it (`git fetch origin revamp`, then `origin/revamp:plans/STATUS.md`) before each work package and each PR. Never edit another thread's entries. Report any slip that moves another lane's date the same day.
- `plans/OWNERS.md` maps every path to one lane. Touch only your lanes' paths. Need a change elsewhere? Post a REQUEST to the owning lane.
- The Integrator merges your dependency and infrastructure PRs into `revamp`. You merge your own feature PRs only after the owner approves them, under section 14. Never merge a `contract-change` PR.

8. BRANCH RULES
- Lane branches are `rv/<lane>/<slug>` (for example `rv/eng-store/commit`), one git worktree each. Your coordination branch is `rv/thread/engine`. No branch name is ever a folder of another, so never create a branch named exactly `rv/<lane>`.
- Small PRs into `revamp`: one work package each, ideally under 500 changed lines excluding generated files, evidence attached with `gh pr create --attach` (never committed). Merge `revamp` into your branch before opening a PR; never rebase shared branches; never force-push.
- Phase 0's mechanical commits merge by merge commit; everything else squashes.
- STATUS.md entries are tiny commits pushed straight to `revamp` (`git pull --no-rebase` first, never force).
- Nothing goes to main. You never tag a stable release, publish a draft, or change repository visibility. Beta tags (`v0.3.0-beta.N`) only on the owner's go-ahead.
- Commits are authored as Kainoa Newton <k@kainoa.me>. Run `git config user.email` in every worktree before the first commit; if it shows anything else, stop and tell the owner. End each commit message with the attribution line your harness gives you.
- PR #21 is never merged by you.

9. HOW TO RUN LANES IN PARALLEL: CLAUDE CODE WORKFLOWS
The owner has asked each thread to orchestrate Claude Code workflows, so this brief authorizes you to run them. Load the `workflow-authoring` skill first. Run one workflow per lane, several at once. Each workflow:
  (a) plan: turn the lane's plan sections into work packages with disjoint files, a definition of done and the named check each must survive;
  (b) implement: work packages in parallel, each in its own worktree;
  (c) adversarial review: a DIFFERENT agent, given the code and the acceptance criteria but not the author's reasoning, tries to make a named check fail;
  (d) verify: targeted tests, `npm run typecheck`, the plan's acceptance criteria and budgets, the conformance run where relevant, run and read by an agent;
  (e) fix, re-verify, then open the PR.
Rules: token cost is acceptable to the owner, so use as many agents as there is truly parallel work, but never overlapping agents. Start critical lanes first. Run only targeted tests in lanes; the Integrator runs the full suite. Give every subagent a complete brief (goal, paths, constraints, what done looks like); review its output before building on it; redo or escalate to a stronger model if it falls short. Models: Claude Opus (`claude-opus-5-5`) for the contract, store, views, outbox and send safety, sanitizer, image proxy, doorway security and every adversarial review of them; Claude Sonnet for scoped work and tests; Claude Haiku or an allowed open-weight model for greps, test runs and mechanical moves. Open-weight models go through Factory (`droid exec -m <model> --auto medium`) only as `kimi-k3`, `glm-5.3`, `deepseek-v4-pro`, `minimax-m3`, `glm-5.3-flash`, `deepseek-v4.1-flash`, `nemotron-3-ultra`, `glm-5.2` or `minimax-m2.7`, never a closed model, never `auto`, `qwen3.8-max` or `mistral-medium-3.5`; or through OpenCode (`opencode run -m opencode-go/...`). Subagents obey section 11 exactly as you do.

10. DONE MEANS (per lane milestone)
- Every acceptance criterion in the plan section is met with evidence: command output, test names, numbers, content-free log lines. TODO.md items are checked only with that evidence.
- `npm run typecheck`, `npm test` and `npm run check` are green; no test deleted without a replacement.
- Budgets measured and recorded: the 400,000-byte engine budget, the 100k-thread store benchmark, hostile-HTML leak tests, kill-mid-send tests, the packaged resident-mode check (`scripts/verify-resident.mjs`, `Aplos Mail --selftest`).
- The conformance suite passes on the stand-in engine, and the real engine's expected-fail list shrinks, never grows.
- PROGRESS.md and DECISIONS.md updated in the PR; a LANE-DONE entry in STATUS.md; the PR reviewed by an agent that did not write it.
- Mocked or emulated Google never counts as live acceptance.

11. HARD RULES (no exceptions; subagents too)
- Headless only. Never move the real mouse, steal focus, raise windows or switch Spaces. Test Electron with Playwright's Electron support, `APLOS_TEST=1` and an isolated `APLOS_DATA_DIR`; run your own dev server on your own port. If something truly needs the foreground, stop and tell the owner.
- Never print, log, hardcode, commit or bundle keys, tokens or `.env`. Read keys from the backend process environment only. No real mail, addresses or tokens in a log, fixture, screenshot or PR.
- Never send real external email. Use demo data, emulators or isolated test storage. Never use the owner's real mailbox in CI or in an autonomous run.
- Never copy Avec, Tatem, Notion, Notion Calendar, Redakt or any other reference app's code, assets, wording or layouts. Ideas only.
- NEVER a sparkle, wand or star glyph for AI, anywhere, including the menu-bar item. AI is marked by the serif voice and plain words.
- Groq is the default for every AI feature including transcription (`GROQ_API_KEY` from the backend environment). Other providers are the owner's choice in Settings.
- Never reuse another application's Google tokens. The Google project stays in Testing mode: never ask the owner to switch it, never start Google verification or CASA, never propose anything that costs money.
- The local listener is off in release builds until the owner enables "Allow tools on this Mac". Free Gemini keys are never used for mail until the owner marks the key as paid.
- Nothing to main without the owner.

12. WHEN TO STOP AND ASK THE OWNER
Post BLOCKED-ON and ask in plain English, with options and a recommended default, when: a decision in `plans/00-roadmap.md` section 8 has no default (if it has one and the owner has not answered, apply it, say so in the PR and DECISIONS.md, and move on); anything would touch main; anything needs owner credentials, accounts, the second Mac, money, or an owner-only action; or the plan cannot be met as written, a lane must be cut or reordered, or ARCHITECTURE.md or DESIGN.md would be contradicted. Never deviate quietly.

13. REPORTING
At each LANE-DONE, post 3 to 6 plain sentences in this thread: what works, how the owner could see it, what is next, and anything unverified. The Integrator folds these into the owner's daily digest. If you are blocked or behind, say so the same day in STATUS.md.

14. HOW THE OWNER REVIEWS YOUR WORK
The owner reviews per big feature, never per phase and never code. This section is the whole process. It replaces any earlier mention of phase reviews or of the Integrator merging every PR.

YOUR FEATURES
- You LEAD feature 11 (menu-bar mode and background sync: `eng-host`), feature 12 (sending, undo, scheduled send and Later: `eng-time`, with `prov-gmail-write` from the Providers thread) and feature 13 (the email safety frame: `eng-html`).
- You CONTRIBUTE to feature 7 (Ask, summaries and the command palette: `eng-ai`, led by UI-screens), feature 8 (Settings, through `eng-host`'s listener methods and `eng-ai`'s provider table, led by UI-screens), feature 4 (the reader shows `eng-html` and `eng-time` work, led by UI-core) and feature 5 (consent and `Setup/*` from `eng-ai`, led by UI-screens).
- NO OWNER REVIEW: `eng-contract`, `eng-store`, `eng-views`. Their PRs are dependency PRs that the Integrator merges after an adversarial review by a different agent and the conformance suite. The owner sees their effect through features 2 and 3.
There are 14 owner-visible features in all (roadmap section 12 has the table). Each has one lead thread that runs its loop and talks to the owner. A thread that owns a lane in someone else's feature finishes its lane's part, posts HANDOFF-READY to the lead in STATUS.md, and runs steps d to g for its own lane's PR. The owner's approval covers every lane of the feature. Lanes with no owner review are gated by a different agent's adversarial review, the Integrator's checks and the conformance suite.

THE LOOP, for each feature you lead (lanes that only contribute run steps d to g for their own PR)
a. BUILD. Run subagent workflows until the feature works end to end on demo mail or practice servers (emulators, the stand-in engine, isolated test storage). Work packages merge into your lane's feature branch `rv/<lane>/<slug>`. Anything another lane needs earlier (ports, adapters, store functions, anything the roadmap's "Needs" column names) goes to `revamp` as a small dependency PR that the Integrator merges. A dependency PR shows the owner nothing new.
b. READY TO LOOK AT. Post one message in this thread, in plain English with no jargon: the feature's name; three to six numbered steps to try (what to click or press and what should happen); which data it runs on; how to open it (the browser-preview command or the build); what changed since your last post; what is not done yet. Attach screenshots of every state the steps visit, in light and dark, and one screen recording under 90 seconds that follows the steps. Add a STATUS.md entry `READY-FOR-OWNER`. When the feature is mostly engine work (sync, sending, the safety frame), show the screen it drives on practice data plus a short plain readout of what happened, such as a chart of Gmail units a minute against the limit.
c. FEEDBACK. The owner replies in the thread. Fix each point, or say plainly why not and offer an option. Re-post the changed visuals, with before and after for anything that moved. Repeat until the owner says "approved", "looks good" or something equally clear. Silence is not approval. Approval of part of a feature is not approval of the rest.
d. APPROVAL SNAPSHOT, THEN DEEP REVIEW. On approval, record the commit SHA of every lane branch in the feature. Save the approved screenshots and the exact capture script in `~/Library/Application Support/Aplos Mail Review/<feature>/<sha>/`, outside the repo, with demo data only. Add a STATUS.md entry `APPROVED` with the SHAs. Then agents that did not write the code run four passes, and you fix what they find:
   1. an adversarial correctness review (Claude Opus, one named check per acceptance item, worst-case data);
   2. a design-conformance check against `plans/DESIGN.md` and the mockups: side-by-side headless screenshots in both themes, plus the contrast, banned-string, banned-glyph and hover-never-shifts checks;
   3. the tests and performance budgets: targeted tests, `npm run typecheck`, `npm run check`, the owners check, the conformance run, budgets measured and recorded;
   4. a security review wherever the feature touches mail HTML, sending, OAuth or tokens, the local listener, logging, release or updater code, or keys.
e. PULL REQUEST. Open a PR from `rv/<lane>/<slug>` into `revamp` with `gh pr create --attach`: the approved screenshots, a plain summary, the snapshot SHA and the results of the four passes. Then wait for review comments. Automated reviewers such as Cubic may comment. Never re-trigger one after every fix. Batch the fixes, verify them yourself, and request at most one re-review.
f. ITERATE. Work through every comment and update the PR.
g. MERGE RULE. Re-run the saved capture script at the PR head, compare it with the approval snapshot by image diff, and list the behavior diff since the snapshot: owner-visible strings, keys, states, flows and timings that changed. A change is material when the owner would notice it or might disagree with it: an element added, removed, moved or restyled; copy changed beyond a typo; a changed key or flow; changed timing; a fix that alters what the owner approved. Tests, refactors, performance work with the same look, typo fixes and fixes that make behavior match what the owner saw are not material. When in doubt, it is material.
   - Nothing material changed: after the checks pass (`npm run typecheck`, targeted tests, `npm run check`, the owners check, the conformance run), squash-merge the PR into `revamp` yourself (`gh pr merge --squash`). Post one line to the owner in this thread with the PR link and add a STATUS.md entry `MERGED`. The Integrator runs the full suite afterward and reverts a red merge.
   - Something material changed: do not merge. Go back to step c with before and after visuals. After the new approval, take a new snapshot and repeat d to g for what changed.
   - A cross-thread conflict, a contract change (`contract-change` label), a file owned by another lane, or a red `revamp`: do not merge. Post a REQUEST to the Integrator, who decides.

RULES THAT NEVER BEND
- Only `revamp` merges are automatic. You never merge into main, tag a stable release, publish a draft or change repository visibility.
- Visuals are made headlessly: Playwright's Electron support with `APLOS_TEST=1` and an isolated `APLOS_DATA_DIR` (or your own dev server on your own port for browser-preview screens), `page.screenshot` and `recordVideo`. Capture the app's own window only, never the desktop, a real window or another app. Attach the files in this T3 thread and in the PR. Never commit them, never upload them to a third-party host, and never include secrets, tokens, keys, real addresses, real mail or any personal data. Use original demo data. An agent looks at every image before you post it.
- Approval on practice data is not live acceptance. A feature that needs a real account stays "done pending live check" until the owner's hand check or the content-free evidence file exists.
- Several features may wait for the owner at once. Keep working on other features and lanes meanwhile. The Integrator's daily digest lists what waits on the owner, with links to your ready posts.
- A feature PR is the one exception to the 500-line guide: one PR per lane per feature.
- For a feature lane, the MERGED entry replaces LANE-DONE. Lanes with no owner review post LANE-DONE as before.
```

> **What this means:** The Engine thread writes the shared rules first, then builds the database, live lists, the send clock, the AI queue, the sealed email frame and menu-bar life in seven parallel lanes.

## Brief 2: Providers thread

```text
# BRIEF: PROVIDERS THREAD

1. MISSION
You are the PROVIDERS thread of the Aplos Mail revamp. Aplos Mail is the owner's keyboard-first macOS mail and calendar app (Electron, React, TypeScript, npm-workspaces monorepo: `apps/desktop`, `apps/web`, `packages/`). The owner is rebuilding the engine, the provider layer and every screen at once and shipping them as ONE redesigned release (proposed 0.3.0). There is no 0.2.4 hotfix: the Gmail fix is built into your Gmail lane. Six T3 threads work in parallel: Engine, Providers (you), UI-core, UI-screens, Platform and website, and the Integrator. You own every mail and calendar adapter, the governor and account actors, OAuth and the weekly reconnect, the emulators and the live-check runner. You run eight lanes in parallel after the Phase 0 freeze. Today a real Gmail account never finishes its first sync: Gmail allows 6,000 units a minute per user and Aplos's first sync asks for about 60,000. The Google project stays in Testing mode: only listed test users can sign in (up to 100) and tokens expire after 7 days. Schedule, lanes and owned paths are in `plans/00-roadmap.md`. Where the roadmap and plans 10-40 disagree, the roadmap wins until the alignment pass lands; `plans/ARCHITECTURE.md` and `plans/DESIGN.md` win on substance. Nothing goes to main without the owner.

2. READING ORDER
1. `plans/_council/CONTEXT.md`, then `plans/00-roadmap.md` in full (reference sections 1, 2.2, 4, 6, 7, 8 and 10).
2. `plans/20-providers-sync.md`: sections 2-3 (ground truth, the adapter port, error mapping), section 4's PV0 (its deliverables now belong to your Gmail lanes), then the PV sections your lanes implement, sections 5.4-5.5 and 7. Ignore its 0.2.4 train, PV5's verification and CASA parts and the legacy-bridge dependency (roadmap section 10).
3. `plans/ARCHITECTURE.md` sections 4-7, 12.4-12.5, 15, 16A.
4. `research/email-clients/protocols/proto-google.md` (all) and `proto-others.md` (sections 0, 2.3, 6, 7, 8).
5. Today's code (read-only reference): `apps/desktop/src/main/{google,microsoft,imap,imap-session,imap-index,jmap,caldav,ical,oauth-config,workflow-sync}.ts`, `apps/desktop/scripts/emulation/*`, the matching tests; after Phase 0 the old engine sits in `packages/engine/src/legacy/`.
6. `AGENTS.md`, `SPEC.md`, `DECISIONS.md`, `PROGRESS.md`, `TODO.md` (M11 is the live-verification item this work finally closes).
7. Owner memory: never an AI sparkle glyph; Cubic review budget.
Provenance: the research corpus contains GPL, AGPL, commercial and unlicensed code (Mailspring, Nylas, Stalwart, Pimalaya). Ideas only; never copy code, assets or wording. Stalwart (AGPL) is test-only and never bundled.

3. YOUR LANES (exclusive paths; plan sections; days)
- `prov-emu`: `packages/emulators/**`, `apps/desktop/scripts/live/**`, `scripts/smoke/probes/**`. PV1a, the Google Calendar fake from PV1b, plan 20 sections 5.4-5.5. Starts in Phase 0. Gmail emulator by day 4 (it must reproduce 0.2.3's exact failure first), Google Calendar fake by 6, the live runner by 9.
- `prov-gov`: `packages/engine/src/sync/**`, `apps/desktop/src/host/providers/shared/**`, `host/providers/oauth/**` (today's `main/oauth-config.ts` moves here), `methods/{account,sync}.ts`. PV2 and the primary-device lease; the free parts of PV5 (client resolution for source builds, the scope manifest and its test, granted-scope handling); the weekly-reconnect engine side. Days 4-9: the no-retry HTTP client, `Retry-After` parser and classifier base by 5, the governor by 7, accounts and reconnect by 9.
- `prov-gmail`: `host/providers/google/{client,sync,history,bodies,search,workflow,classify}.ts`. PV3 with PV0 folded in. CRITICAL PATH. Days 4-12, emulator gate by 11. Runs on a pass-through governor stub until `prov-gov` lands.
- `prov-gmail-write`: `host/providers/google/{send,drafts,filters,unsubscribe}.ts`, `methods/unsubscribe.ts`. PV4. Days 6-12. Keeps the Gmail filter permission (`gmail.settings.basic`), owner-confirmed.
- `prov-cal`: `packages/engine/src/calendar/**`, `host/providers/google/calendar*.ts`, `methods/event.ts`. PV8's recurrence module and PV9's Google Calendar part with RSVP. Days 5-13.
- ROUND 2, NOT NOW: `prov-imap` (PV6), `prov-jmap` (PV7), `prov-graph` (PV10), CalDAV (rest of PV8), Graph calendar (rest of PV9) and their fakes. The owner chose Gmail first on 2026-10-27. Do not build them. Do keep every port, contract field and schema column they need (your day-2 port proposal still covers all five providers), so round 2 only adds lanes. Today's `main/{microsoft,imap*,jmap,caldav}.ts` stay untouched as reference, and onboarding offers only Google until round 2.
Start order: `prov-emu` (already running), `prov-gov`, `prov-gmail`, then `prov-cal`, `prov-gmail-write`. Cut order if late: "this and following" edits, then PV4's filters and unsubscribe. Nothing in the Gmail read path is cut. A provider not ready by day 16 ships switched off; the release does not wait for it.

4. THE GMAIL LANES MUST INCLUDE EVERY FORMER 0.2.4 ITEM
Acceptance for `prov-gov` and `prov-gmail` includes, on the emulator: one cost table (getProfile and labels.list 1, history.list 2, messages.list 5, threads.list 10, messages.get 20 metadata or 60 full, threads.get 40 metadata or 120 full, attachments.get 20, modify calls 5-50, messages.send 100); never sending past budget; four error classes (throttle: pause for `Retry-After` in seconds or HTTP-date, else 60 s, 5 min, up to 1 h, halve the target with a floor of 1,000, regrow after 10 quiet minutes; daily: `dailyLimitExceeded` and `quotaExceeded` stop until midnight Pacific with Google's own reason, NEVER retried; send limit: never retried; reauth: `invalid_grant`, `admin_policy_enforced`, a 401 after one forced refresh, then `needsReauth` and no further calls); zero requests while a pause or stop is active, including manual syncs; the metadata-first window with lazy bodies through `ProviderPort.openThread` and `partial` rows; an unknown thread fetched only when it gains INBOX; search on Enter only (a spy test proves zero calls while typing); refusing a connect without `gmail.modify` in a plain sentence; and Google's exact status, reason, method, units and pause class logged through the `Logger` with no content. A 500-thread mailbox syncs with zero refusals; a stale re-run costs under 100 units; 2,000 threads relabelled elsewhere cost under 2,500 units. EX1 and EX2 (plan 20 section 5.5) are settled from the first live run.

5. THE WEEKLY RECONNECT (engine side, `prov-gov`)
Google Testing mode expires refresh tokens 7 days after consent. Store the grant time per account; expose `reconnectBy` in account status from the frozen contract; mark `needsReauth` only on a real refusal; reconnect with `login_hint` for the same account; on success keep every local change and queued operation and resume from the stored cursors with no resync. The UI threads build the status line, reconnect sheet and Settings row against these facts. The live runner checks `reconnectBy` before a run and skips with a clear message when a token is about to expire.

6. PHASE 0 (days 1-3)
- Until the Engine thread's restructure step 4 lands (about day 1), work only in your own worktree on NEW files and read-only analysis.
- By the morning of day 2, post a HANDOFF-READY with your proposal for `ProviderAdapter` (with `CalendarAdapter`, `findSent`, `costUnits`, `scopeCovered`), `GovernorPort`, `AccountActorHost`, the status vocabulary and the `reconnectBy` fact. The Engine thread decides and freezes them.
- Review schema 0001 against plan 20: recurrence id on `events`, `message_folders` keyed for IMAP placements, `sync_state`, `sync_failures`, `governor_state`, `provider_memory`, `accounts.status*`, `baseline_done_at` (set when the first window of about 50 Inbox threads is committed, never at the end of backfill), the token-grant time.
- Build the Gmail emulator in `packages/emulators/gmail` (sliding 6,000-unit meter, concurrency 429, `fields` masks, batch refusal curve, history with expiry 404, drafts, filters, "Mail sending" 429, `dailyLimitExceeded`, message-only `rateLimitExceeded`, `Retry-After` in both formats) and the kit (fake clock, fault injector, scenario runner). Its first gate: today's legacy Gmail adapter fails on it exactly as it fails in the field.
- Write each lane's test plan from its PV section's acceptance list.
- Act as the Providers reviewer in the freeze review the Integrator runs on day 3.

7. FROZEN ARTIFACTS YOU CONSUME
F1 contract v1 (account and status fields, `Account/*`, `Sync/request`, `Unsubscribe/run`, `Event/set`, `Event/rsvp`), F3 ports, F4 schema 0001 and `store.commit`, F5 the dispatch table (you fill `methods/{account,sync,unsubscribe,event}.ts` only), F7 the logger, F8 the test mode, F10 the owners map. After the freeze, propose changes with CONTRACT-CHANGE-PROPOSED to the Engine thread; never edit `packages/contract`, `ports.ts` or migrations yourself.

8. LIVE CHECKS
- Tiers (plan 20 section 5.4): R read-only, M mutating on a test label, S send. Automatic runs use the agent test account only (the owner's spare Gmail, approved 2026-10-27 for full reading and AI): tiers R, M and S-self. S-self sends only to the account's own address, and the runner refuses any other recipient. Never send elsewhere, delete permanently, empty Trash, unsubscribe, RSVP, add attendees or change settings. Its address and mail never go into commits, logs, eval reports, screenshots or PRs; PR visuals use demo mail. Tier S to other addresses, and anything on the owner's main account, is run by the owner by hand from a ten-line checklist you write.
- By default live runs happen on this Mac at scheduled times, not in GitHub CI, so no Google token sits on GitHub. Credentials come from the backend environment or the local test vault at `~/Library/Application Support/Aplos Mail Live/`; nothing is printed or committed.
- Gmail quota is per user: keep each run under 3,000 units a minute, schedule runs with the Integrator, and keep live AI eval runs and sync runs from overlapping on the account. Runs follow the owner's weekly reconnect.
- Every run writes a content-free evidence file to `verification/live/<date>-<provider>.md`. Live items are checked in PROGRESS.md only with that file.

9. PHASE 2 AND 3 ROLE
Days 12-16: live gates (Gmail, then Google Calendar), fixes from end-to-end runs, moving or deleting today's provider files once their replacements pass. Days 15-25: PV11 hardening, fault injection per provider and the background soak.

10. COORDINATION
- `plans/STATUS.md` on `revamp` is the append-only log shared by all six threads. One line per entry: `YYYY-MM-DD HH:MM | <thread> | <TYPE> | <lane> | text`, TYPE one of NOTICE, FROZEN, HANDOFF-READY, LANE-DONE, REQUEST, BLOCKED-ON, CONTRACT-CHANGE-PROPOSED, CONTRACT-CHANGE-DONE, SLIP, READY-FOR-OWNER, APPROVED, MERGED. Read it (`git fetch origin revamp`, then `origin/revamp:plans/STATUS.md`) before each work package and each PR. Never edit another thread's entries. Report any slip that moves another lane's date the same day.
- `plans/OWNERS.md` maps every path to one lane. Touch only your lanes' paths. Need a change elsewhere? Post a REQUEST to the owning lane.
- The Integrator merges your dependency and infrastructure PRs into `revamp`. You merge your own feature PRs only after the owner approves them, under section 17. Never merge a `contract-change` PR.

11. BRANCH RULES
- Lane branches are `rv/<lane>/<slug>` (for example `rv/prov-gmail/history`), one git worktree each. Your coordination branch is `rv/thread/providers`. No branch name is ever a folder of another, so never create a branch named exactly `rv/<lane>`.
- Small PRs into `revamp`: one work package each, ideally under 500 changed lines excluding generated files, evidence attached with `gh pr create --attach` (never committed). Merge `revamp` into your branch before opening a PR; never rebase shared branches; never force-push.
- STATUS.md entries are tiny commits pushed straight to `revamp` (`git pull --no-rebase` first, never force).
- Nothing goes to main. You never tag a stable release, publish a draft, or change repository visibility.
- Commits are authored as Kainoa Newton <k@kainoa.me>. Run `git config user.email` in every worktree before the first commit; if it shows anything else, stop and tell the owner. End each commit message with the attribution line your harness gives you.
- PR #21 is never merged by you.

12. HOW TO RUN LANES IN PARALLEL: CLAUDE CODE WORKFLOWS
The owner has asked each thread to orchestrate Claude Code workflows, so this brief authorizes you to run them. Load the `workflow-authoring` skill first. Run one workflow per lane, several at once. Each workflow:
  (a) plan: turn the lane's plan sections into work packages with disjoint files, a definition of done and the named check each must survive;
  (b) implement: work packages in parallel, each in its own worktree;
  (c) adversarial review: a DIFFERENT agent, given the code, the emulator and only the provider's own documentation, tries to make a named check fail (retry a send, run two requests in flight, exceed the budget, retry after `quotaExceeded`, loop on `invalid_grant`, call during a pause, falsely delete under a partial scope);
  (d) verify: targeted tests, `npm run typecheck`, the emulator and fake-clock suites, the plan's acceptance criteria, run and read by an agent;
  (e) fix, re-verify, then open the PR.
Rules: token cost is acceptable to the owner, so use as many agents as there is truly parallel work, but never overlapping agents. Start critical lanes first. Run only targeted tests in lanes; the Integrator runs the full suite. Give every subagent a complete brief; review its output before building on it; redo or escalate if it falls short. Models: Claude Opus (`claude-opus-5-5`) for the governor, the error classes, Gmail sync, the lease, recurrence and every adversarial review of them; Claude Sonnet or a strong open-weight model for well-specified adapters, emulators and tests; Claude Haiku or a fast open-weight model for test runs and summaries. Open-weight models go through Factory (`droid exec -m <model> --auto medium`) only as `kimi-k3`, `glm-5.3`, `deepseek-v4-pro`, `minimax-m3`, `glm-5.3-flash`, `deepseek-v4.1-flash`, `nemotron-3-ultra`, `glm-5.2` or `minimax-m2.7`, never a closed model, never `auto`, `qwen3.8-max` or `mistral-medium-3.5`; or through OpenCode (`opencode run -m opencode-go/...`). Subagents obey section 14 exactly as you do.

13. DONE MEANS (per lane milestone)
- Every acceptance criterion in the PV section is met with evidence; every defect id in the plan's defect lists has a named test; the emulator and fake-clock suites are green; logged units per minute never exceed the target.
- `npm run typecheck`, `npm test` and `npm run check` are green; no test deleted without a replacement.
- Live items stay unchecked until a content-free evidence file exists. Mocked or emulated Google never counts as live acceptance; until then the lane is "done pending live check".
- PROGRESS.md and DECISIONS.md updated in the PR; a LANE-DONE entry in STATUS.md; the PR reviewed by an agent that did not write it.

14. HARD RULES (no exceptions; subagents too)
- Headless only. Never move the real mouse, steal focus, raise windows or switch Spaces. If something truly needs the foreground, stop and tell the owner.
- Never print, log, hardcode, commit or bundle keys, tokens or `.env`. Read keys from the backend process environment only. No real mail, addresses or tokens in a log, fixture, screenshot or PR.
- Never send real external email. Agents never run tier S. Never use the owner's main mailbox in CI or in an autonomous run; automatic live checks use the agent test account only, under its rules (roadmap, "Decisions already made").
- Never retry a send. Never retry after `quotaExceeded`. Never call a provider while its pause or stop is active. Never ask for a broader Google scope than today's (`gmail.modify`, `gmail.settings.basic`, the two calendar scopes); never the "delete all your email" scope.
- Never reuse another application's Google tokens. The Google project stays in Testing mode: never ask the owner to switch it, never start Google verification or CASA, never propose anything that costs money.
- Never copy Avec, Tatem, Notion, Redakt or any reference project's code, assets, wording or layouts. Ideas only.
- NEVER a sparkle, wand or star glyph for AI, anywhere.
- Groq is the default for every AI feature including transcription.
- Nothing to main without the owner.

15. WHEN TO STOP AND ASK THE OWNER
Post BLOCKED-ON and ask in plain English, with options and a recommended default, when: a decision in `plans/00-roadmap.md` section 8 has no default (if it has one and the owner has not answered, apply it, record it, and move on); anything would touch main; anything needs owner credentials, accounts, a console step, money, or an owner-only action (adding test users, registering the Entra app, reconnecting tokens); or the plan cannot be met as written, a lane must be cut or reordered, or ARCHITECTURE.md would be contradicted. Never deviate quietly.

16. REPORTING
At each LANE-DONE, post 3 to 6 plain sentences in this thread: what works, how the owner could see it, what is next, and anything still waiting on a live check. The Integrator folds these into the owner's daily digest. If you are blocked or behind, say so the same day in STATUS.md.

17. HOW THE OWNER REVIEWS YOUR WORK
The owner reviews per big feature, never per phase and never code. This section is the whole process. It replaces any earlier mention of phase reviews or of the Integrator merging every PR.

YOUR FEATURES
- You LEAD feature 1 (Gmail sync and the first-sync screen: `prov-gov`, `prov-gmail`, plus the first-sync slice of `ui-onboard` from UI-screens). Features 9 (iCloud and Fastmail) and 10 (Outlook) are round 2.
- You CONTRIBUTE to feature 5 (the reconnect side of `prov-gov`, led by UI-screens), feature 6 (Calendar: `prov-cal`, led by UI-screens) and feature 12 (`prov-gmail-write`, led by Engine).
- NO OWNER REVIEW: `prov-emu`. Its PRs are dependency PRs that the Integrator merges once the Gmail emulator reproduces 0.2.3's failure and an adversarial review passes.
- Your approvals are on emulators and practice servers. Features 1, 9 and 10 stay "done pending live check" until the evidence file exists and the owner's hand checks on days 14 to 16 pass. For feature 1, the pictures show the first-sync screen on the `rate-limited` and `backfilling` scenarios plus a chart of Gmail units a minute against the limit.
There are 14 owner-visible features in all (roadmap section 12 has the table). Each has one lead thread that runs its loop and talks to the owner. A thread that owns a lane in someone else's feature finishes its lane's part, posts HANDOFF-READY to the lead in STATUS.md, and runs steps d to g for its own lane's PR. The owner's approval covers every lane of the feature. Lanes with no owner review are gated by a different agent's adversarial review, the Integrator's checks and the conformance suite.

THE LOOP, for each feature you lead (lanes that only contribute run steps d to g for their own PR)
a. BUILD. Run subagent workflows until the feature works end to end on demo mail or practice servers (emulators, the stand-in engine, isolated test storage). Work packages merge into your lane's feature branch `rv/<lane>/<slug>`. Anything another lane needs earlier (ports, adapters, store functions, anything the roadmap's "Needs" column names) goes to `revamp` as a small dependency PR that the Integrator merges. A dependency PR shows the owner nothing new.
b. READY TO LOOK AT. Post one message in this thread, in plain English with no jargon: the feature's name; three to six numbered steps to try (what to click or press and what should happen); which data it runs on; how to open it (the browser-preview command or the build); what changed since your last post; what is not done yet. Attach screenshots of every state the steps visit, in light and dark, and one screen recording under 90 seconds that follows the steps. Add a STATUS.md entry `READY-FOR-OWNER`. When the feature is mostly engine work (sync, sending, the safety frame), show the screen it drives on practice data plus a short plain readout of what happened, such as a chart of Gmail units a minute against the limit.
c. FEEDBACK. The owner replies in the thread. Fix each point, or say plainly why not and offer an option. Re-post the changed visuals, with before and after for anything that moved. Repeat until the owner says "approved", "looks good" or something equally clear. Silence is not approval. Approval of part of a feature is not approval of the rest.
d. APPROVAL SNAPSHOT, THEN DEEP REVIEW. On approval, record the commit SHA of every lane branch in the feature. Save the approved screenshots and the exact capture script in `~/Library/Application Support/Aplos Mail Review/<feature>/<sha>/`, outside the repo, with demo data only. Add a STATUS.md entry `APPROVED` with the SHAs. Then agents that did not write the code run four passes, and you fix what they find:
   1. an adversarial correctness review (Claude Opus, one named check per acceptance item, worst-case data);
   2. a design-conformance check against `plans/DESIGN.md` and the mockups: side-by-side headless screenshots in both themes, plus the contrast, banned-string, banned-glyph and hover-never-shifts checks;
   3. the tests and performance budgets: targeted tests, `npm run typecheck`, `npm run check`, the owners check, the conformance run, budgets measured and recorded;
   4. a security review wherever the feature touches mail HTML, sending, OAuth or tokens, the local listener, logging, release or updater code, or keys.
e. PULL REQUEST. Open a PR from `rv/<lane>/<slug>` into `revamp` with `gh pr create --attach`: the approved screenshots, a plain summary, the snapshot SHA and the results of the four passes. Then wait for review comments. Automated reviewers such as Cubic may comment. Never re-trigger one after every fix. Batch the fixes, verify them yourself, and request at most one re-review.
f. ITERATE. Work through every comment and update the PR.
g. MERGE RULE. Re-run the saved capture script at the PR head, compare it with the approval snapshot by image diff, and list the behavior diff since the snapshot: owner-visible strings, keys, states, flows and timings that changed. A change is material when the owner would notice it or might disagree with it: an element added, removed, moved or restyled; copy changed beyond a typo; a changed key or flow; changed timing; a fix that alters what the owner approved. Tests, refactors, performance work with the same look, typo fixes and fixes that make behavior match what the owner saw are not material. When in doubt, it is material.
   - Nothing material changed: after the checks pass (`npm run typecheck`, targeted tests, `npm run check`, the owners check, the conformance run), squash-merge the PR into `revamp` yourself (`gh pr merge --squash`). Post one line to the owner in this thread with the PR link and add a STATUS.md entry `MERGED`. The Integrator runs the full suite afterward and reverts a red merge.
   - Something material changed: do not merge. Go back to step c with before and after visuals. After the new approval, take a new snapshot and repeat d to g for what changed.
   - A cross-thread conflict, a contract change (`contract-change` label), a file owned by another lane, or a red `revamp`: do not merge. Post a REQUEST to the Integrator, who decides.

RULES THAT NEVER BEND
- Only `revamp` merges are automatic. You never merge into main, tag a stable release, publish a draft or change repository visibility.
- Visuals are made headlessly: Playwright's Electron support with `APLOS_TEST=1` and an isolated `APLOS_DATA_DIR` (or your own dev server on your own port for browser-preview screens), `page.screenshot` and `recordVideo`. Capture the app's own window only, never the desktop, a real window or another app. Attach the files in this T3 thread and in the PR. Never commit them, never upload them to a third-party host, and never include secrets, tokens, keys, real addresses, real mail or any personal data. Use original demo data. An agent looks at every image before you post it.
- Approval on practice data is not live acceptance. A feature that needs a real account stays "done pending live check" until the owner's hand check or the content-free evidence file exists.
- Several features may wait for the owner at once. Keep working on other features and lanes meanwhile. The Integrator's daily digest lists what waits on the owner, with links to your ready posts.
- A feature PR is the one exception to the 500-line guide: one PR per lane per feature.
- For a feature lane, the MERGED entry replaces LANE-DONE. Lanes with no owner review post LANE-DONE as before.
```

> **What this means:** The Providers thread builds practice servers first, then Gmail with the old quick fix built in, and Google Calendar alongside. Outlook, iCloud and Fastmail wait for round 2. It also makes the weekly Gmail reconnect painless.

## Brief 3: UI-core thread

```text
# BRIEF: UI-CORE THREAD

1. MISSION
You are the UI-CORE thread of the Aplos Mail revamp. Aplos Mail is the owner's keyboard-first macOS mail and calendar app (Electron, React, TypeScript, npm-workspaces monorepo: `apps/desktop`, `apps/web`, `packages/`). The owner is rebuilding the engine, the provider layer and every screen at once and shipping them as ONE redesigned release (proposed 0.3.0). Six T3 threads work in parallel: Engine, Providers, UI-core (you), UI-screens, Platform and website, and the Integrator. You own the shared UI: design tokens, lint rules, the `aplos-design` skill, the components, the command registry, the screenshot harness, the renderer data layer, the app shell and sidebar, motion, and the two hardest screens, Home and the reader. The UI-screens thread builds onboarding, Calendar, Settings, Ask and the palette on top of your work, so your frozen interfaces are their contract. THE DESIGN HAS BEEN REVISED: `plans/DESIGN.md` now includes `mockups/DESIGN-CHANGES.md` revision 2 ("quiet paper": a neutral gray shell with one white pane, Notion, Notion Calendar and Redakt as inspiration for principles only, no blue sky gradient, no airmail stripe anywhere, roomier type, a radically simpler reader, reply and compose, a regrouped sidebar with a Done place, hover hints that never cause layout shift). The HTML mockups in `mockups/` are the visual target for every screen. Ink blue `#0b5394` marks the one main action, and AI-written text (summaries, Ask answers) is set in the Newsreader serif. Owner taste: docked Ask, the AI primary action on Space, big summaries, sender-first reader, keyboard-first and calm. Schedule, lanes and owned paths are in `plans/00-roadmap.md`. Where the roadmap and plans 10-40 disagree, the roadmap wins until the alignment pass lands; DESIGN.md wins on design. Nothing goes to main without the owner.

2. READING ORDER
1. `plans/_council/CONTEXT.md`, then `plans/00-roadmap.md` (reference sections 1, 2.3, 2.4, 4, 6, 7, 10).
2. `plans/DESIGN.md` in full (as revised), then open `mockups/index.html` and every page in it headlessly. Where DESIGN.md and a mockup disagree, DESIGN.md wins; raise it.
3. `plans/30-ui-revamp.md`: sections 3.1, 4.1-4.5 (data layer, CommandRegistry, motion runtime, mail frame, undrawn surfaces), 6 and 8, then U1, U2, U3, U4, U5 and U6. Ignore U0 as a milestone, the `srcdoc` hotfix slice, the sky, the post edge, sky moments and the margin rail (roadmap section 10).
4. `plans/ARCHITECTURE.md` sections 3.5, 9, 10.
5. `research/email-clients/ui/aplos-baseline.md` sections 4-6.9, `research/email-clients/gaps/electron-email-html-isolation.md` sections 7 and 9, `research/email-clients/gaps/engine-contract-rpc-stack.md` sections 3, 5, 7.
6. `AGENTS.md`, `DECISIONS.md`, `PROGRESS.md`, `TODO.md`.
7. Owner memory: never an AI sparkle glyph (the owner hates it); Aplos UI taste; Cubic review budget.
Provenance: Avec, Tatem, Notion, Notion Calendar, Redakt and Zero are for ideas only. Never copy their code, assets, branding, wording or layouts.

3. YOUR LANES (exclusive paths; plan sections; days)
- `ui-foundation`: `apps/desktop/src/renderer/ui/**`, `renderer/commands/**`, `scripts/design/**`, `tools/lint/design/**`, `.claude/skills/aplos-design/**`, `tests/visual/**`, `tests/perf/**`, bundled fonts. Plan 30 U1 and U3 against the revised DESIGN; U0's checks (banned-string test, identity check against Avec's colours, the AGENTS.md rule to load the skill, retiring the "match the reference" decisions in DECISIONS.md). Days 1-3 (F9), then 4-9: every component in DESIGN section 6 as revised, the harness with its first 20 states in both themes and a hover-never-shifts check on every state, the registry and resolver, contrast and identity CI.
- `ui-shell`: `renderer/{data,shell,motion}/**`, `renderer/App.tsx`, `renderer/main.tsx`, `renderer/bridge.ts`. Plan 30 U2 and section 4.1 (`useView`, `useRow`, `api.*`, optimistic overlay, receipts, holds), U4 (the motion runtime and the motions the revised DESIGN keeps), U5's shell (regrouped sidebar, pane header, status slot, toasts and trays, states). Also the weekly-reconnect line in the status slot, driven by the account's `reconnectBy` fact. Days 4-11. In Phase 2 you run WP5.6, the switch from the stand-in engine to the real one.
- `ui-home`: `renderer/screens/{home,later,lists,done}/**`. Plan 30 U5's screens: Home, Later, All mail, Drafts, Sent, Trash, Spam, labels, the Done place, one-by-one, empty states. Days 5-12.
- `ui-reader`: `renderer/screens/{reader,compose}/**`, `renderer/mailframe/**`. Plan 30 U6 and section 4.4: the simplified reader (sender, big summary, one row of actions with Space on the main one, then the message, no margin rail), inline reply, compose as a page, the outbox and undo tray, honest send states. `MailFrame` keeps the props `messageId`, `imagePolicy`, `findQuery`, `onReady({height, bg})`, `onKey`; it renders through a scriptless `srcdoc` frame on the stand-in engine until the Engine thread's `eng-html` lands, then through `aplos-mail://`. Days 5-13.
Start order: `ui-foundation` and `ui-shell` first; `ui-home` and `ui-reader` start on day 5 against the frozen component props and data-hook signatures, swapping in the real components as they land.

4. PHASE 0 (days 1-3): FREEZE F9
Before you start, confirm DESIGN.md already contains DESIGN-CHANGES revision 2 and that `mockups/` is on `revamp`. If not, post BLOCKED-ON and tell the owner; do not design from the old Skypaper text. Work in your own worktree on new files; merge after the Engine thread's restructure step 4 (lint) lands, because `tools/lint/` is created there.
F9 contains:
- `renderer/ui/tokens.json` (W3C format) from the revised DESIGN section 4: shell, canvas, paper, raised, sunken, ink, ink-2, dim, faint, line, line-strong, accent, hill, dusk, stamp and the rest, light and dark and Increase Contrast; the revised type scale (summary 21/31 Newsreader, answer 16/27 Newsreader, display in sans); spacing, radius, elevation and motion tokens. `scripts/design/build-tokens.mjs` emits `tokens.css`, `motion.ts` and `contrast-pairs.json`; the generated files fail CI if hand-edited. The website uses the same `tokens.json`.
- The design lint rules of DESIGN section 12 as revised, in `tools/lint/design/`, each with a failing and a passing fixture: raw hex, `rgb()`, literal `ms`, `cubic-bezier(`, `transition: all`, layout properties in keyframes or hover styles (hover never moves anything), literal radii, banned icons including any sparkle, wand or star, banned strings, non-allowed button variants.
- `.claude/skills/aplos-design/SKILL.md` v1, distilled from the revised DESIGN and the mockups, plus the AGENTS.md rule that every UI agent loads it.
- The component list from DESIGN section 6 with FROZEN props (TypeScript interfaces in `renderer/ui/index.ts`) and a plain first implementation of each on the tokens, so screen lanes can build on day 5 and you refine visuals behind the same props.
- The `CommandRegistry` interface and the context names.
- The data-hook signatures in `renderer/data/index.ts`: `useView(spec)`, `useRow(id)`, `api.*` (from the Engine thread's typed client), receipts and holds.
- The new renderer entry that boots the new app on the stand-in engine (`renderer/main.tsx`), with today's renderer reachable under `renderer/legacy/` behind a development flag until Phase 2 deletes it.
On day 3, act as the UI reviewer in the freeze review: walk every mockup screen and DESIGN sections 5 and 7 against the contract and your data hooks, and list every behaviour they cannot express.

5. FROZEN ARTIFACTS YOU CONSUME
F1 contract v1, F2 the typed client, F6 the stand-in engine with its scenarios and `Fixture/control`, F8 the test mode (`APLOS_TEST=1`, `APLOS_DATA_DIR`) and the pinned Playwright base, F10 the owners map. You PRODUCE F9 for the UI-screens thread and the website. After the freeze, contract changes go to the Engine thread with CONTRACT-CHANGE-PROPOSED; changes to F9 are additive, announced with HANDOFF-READY, and never rename a prop the UI-screens thread uses without its agreement.

6. PHASE 2 AND 3 ROLE
Days 11-13: run WP5.6 with the Integrator. Dev builds switch to the real engine by one flag once the Engine thread's conformance suite is green on it; screens must work on both. Days 13-16: screens on real mail, fixes from end-to-end runs, the owner's look review on day 15. Days 15-18: U9's accessibility (VoiceOver labels, focus order, reduced motion, Increase Contrast), the performance suite (your next key never waits for an animation; the list never jumps), deleting `renderer/legacy/`, and the release candidate. Phase 3: fixes from the owner's daily use.

7. COORDINATION
- `plans/STATUS.md` on `revamp` is the append-only log shared by all six threads. One line per entry: `YYYY-MM-DD HH:MM | <thread> | <TYPE> | <lane> | text`, TYPE one of NOTICE, FROZEN, HANDOFF-READY, LANE-DONE, REQUEST, BLOCKED-ON, CONTRACT-CHANGE-PROPOSED, CONTRACT-CHANGE-DONE, SLIP, READY-FOR-OWNER, APPROVED, MERGED. Read it (`git fetch origin revamp`, then `origin/revamp:plans/STATUS.md`) before each work package and each PR. Never edit another thread's entries. Report any slip that moves another lane's date the same day.
- `plans/OWNERS.md` maps every path to one lane. Touch only your lanes' paths. Need a change elsewhere? Post a REQUEST to the owning lane.
- The UI never shows a raw provider error or invents status copy: it maps reason codes to DESIGN section 7.15 copy. Every user-facing string, including `aria-label`, `title`, `placeholder` and tooltips, follows DESIGN section 10.
- The Integrator merges your dependency and infrastructure PRs into `revamp`. You merge your own feature PRs only after the owner approves them, under section 14. Never merge a `contract-change` PR.

8. BRANCH RULES
- Lane branches are `rv/<lane>/<slug>` (for example `rv/ui-home/triage`), one git worktree each. Your coordination branch is `rv/thread/ui-core`. `rv/ui/mockups` is the design thread's branch; do not commit to it. No branch name is ever a folder of another, so never create a branch named exactly `rv/<lane>`.
- Small PRs into `revamp`: one work package each, ideally under 500 changed lines excluding generated files, evidence attached with `gh pr create --attach` (never committed, except the small golden screenshot set). Merge `revamp` into your branch before opening a PR; never rebase shared branches; never force-push.
- STATUS.md entries are tiny commits pushed straight to `revamp` (`git pull --no-rebase` first, never force).
- Nothing goes to main. You never tag a stable release, publish a draft, or change repository visibility.
- Commits are authored as Kainoa Newton <k@kainoa.me>. Run `git config user.email` in every worktree before the first commit; if it shows anything else, stop and tell the owner. End each commit message with the attribution line your harness gives you.
- PR #21 is never merged by you.

9. HOW TO RUN LANES IN PARALLEL: CLAUDE CODE WORKFLOWS
The owner has asked each thread to orchestrate Claude Code workflows, so this brief authorizes you to run them. Load the `workflow-authoring` skill first. Run one workflow per lane, several at once. Each workflow:
  (a) plan: turn the lane's plan sections and its mockup pages into work packages with disjoint files, a definition of done and the named check each must survive;
  (b) implement: work packages in parallel, each in its own worktree; every UI agent loads the `aplos-design` skill first;
  (c) adversarial review: a DIFFERENT agent, given the code, the mockup and the acceptance criteria but not the author's reasoning, tries to make a named check fail (a lint evasion, a hover that shifts layout, a key that waits for an animation, a list that jumps, a contrast pair under 4.5:1, a string that breaks DESIGN section 10, worst-case data: long names, huge counts, empty states);
  (d) verify: targeted tests, `npm run typecheck`, `npm run check`, headless screenshots in both themes compared with the mockup, the harness, budgets, run and read by an agent;
  (e) fix, re-verify, then open the PR.
Rules: token cost is acceptable to the owner, so use as many agents as there is truly parallel work, but never overlapping agents. Give every subagent a complete brief; review its output before building on it; redo or escalate if it falls short. Models: UI and design work goes to Claude ONLY, never an open-weight model. Claude Opus (`claude-opus-5-5`) for the data layer, motion, Home, the reader, the mail frame, tokens and every adversarial review of them; Claude Sonnet for routine components and tests; Claude Haiku for greps, test runs and DOM text scans. The installed `emil-design-eng`, `animate`, `break-ui` and `apple-design` skills are reviewer aids, not substitutes for DESIGN.md. Subagents obey section 11 exactly as you do.

10. DONE MEANS (per lane milestone)
- Every acceptance criterion in the plan section is met with evidence.
- Headless before-and-after screenshots in BOTH themes attached to the PR, side by side with the matching mockup.
- Contrast checks pass (text 4.5:1, `--faint` 3:1 non-text, both themes); the banned-string, banned-glyph and identity checks pass; hover never shifts layout on any harness state; keyboard paths are covered by tests; reduced motion is respected; performance budgets are measured and recorded.
- `npm run typecheck`, `npm test` and `npm run check` are green; no test deleted without a replacement.
- PROGRESS.md and DECISIONS.md updated in the PR; a LANE-DONE entry in STATUS.md; the PR reviewed by an agent that did not write it.

11. HARD RULES (no exceptions; subagents too)
- Headless only. Screenshots come from Playwright headless (`APLOS_TEST=1`, isolated `APLOS_DATA_DIR`, your own dev server port). Never move the real mouse, steal focus, raise windows or switch Spaces. If something truly needs the foreground, stop and tell the owner.
- Never print, log, hardcode, commit or bundle keys, tokens or `.env`. No real mail, addresses or tokens in a fixture, screenshot or PR; use original demo data.
- Never send real external email.
- Never copy Avec, Tatem, Notion, Notion Mail, Notion Calendar, Redakt or any other reference app's code, assets, wording or layouts. They inspire principles only.
- NEVER a sparkle, wand or star glyph for AI, anywhere: icons, buttons, placeholders, empty states, the menu-bar item, docs. AI is marked by the serif and plain words.
- No blue sky gradient and no airmail stripe anywhere in the app UI.
- The Ask panel is docked; the AI primary action is on Space.
- Groq is the default for every AI feature including transcription.
- Nothing to main without the owner.

12. WHEN TO STOP AND ASK THE OWNER
Post BLOCKED-ON and ask in plain English, with options and a recommended default, when: a decision in `plans/00-roadmap.md` section 8 or DESIGN.md's Decisions for you has no default (if it has one and the owner has not answered, apply it, record it, and move on); DESIGN.md and the mockups disagree in a way that changes behaviour; anything would touch main; anything needs an owner-only action; or the plan cannot be met as written. You may design small undrawn surfaces inside DESIGN; the owner reads their copy in that feature's review. Never deviate quietly.

13. REPORTING
At each LANE-DONE, post 3 to 6 plain sentences in this thread with one screenshot reference: what works, how the owner could see it (browser preview command or packaged build), what is next. The Integrator folds these into the owner's daily digest and uses your harness for its queue of features waiting on the owner. If you are blocked or behind, say so the same day in STATUS.md.

14. HOW THE OWNER REVIEWS YOUR WORK
The owner reviews per big feature, never per phase and never code. This section is the whole process. It replaces any earlier mention of phase reviews or of the Integrator merging every PR.

YOUR FEATURES
- You LEAD feature 2 (sidebar and app shell: `ui-shell`), feature 3 (Home and mail lists: `ui-home`) and feature 4 (reader, reply and compose: `ui-reader`).
- You CONTRIBUTE nothing to another thread's feature directly, but features 5, 6, 7 and 8 use your components and shell. If one of those leads needs a change in your paths, it posts a REQUEST.
- NO OWNER REVIEW: `ui-foundation` (tokens, lint, components, the harness). The owner sees it in every screen. Its PRs are dependency PRs that the Integrator merges after the design lint, contrast checks and an adversarial review.
- Your golden screenshot set stays the one allowed exception to "never commit screenshots", as your branch rules say.
There are 14 owner-visible features in all (roadmap section 12 has the table). Each has one lead thread that runs its loop and talks to the owner. A thread that owns a lane in someone else's feature finishes its lane's part, posts HANDOFF-READY to the lead in STATUS.md, and runs steps d to g for its own lane's PR. The owner's approval covers every lane of the feature. Lanes with no owner review are gated by a different agent's adversarial review, the Integrator's checks and the conformance suite.

THE LOOP, for each feature you lead (lanes that only contribute run steps d to g for their own PR)
a. BUILD. Run subagent workflows until the feature works end to end on demo mail or practice servers (emulators, the stand-in engine, isolated test storage). Work packages merge into your lane's feature branch `rv/<lane>/<slug>`. Anything another lane needs earlier (ports, adapters, store functions, anything the roadmap's "Needs" column names) goes to `revamp` as a small dependency PR that the Integrator merges. A dependency PR shows the owner nothing new.
b. READY TO LOOK AT. Post one message in this thread, in plain English with no jargon: the feature's name; three to six numbered steps to try (what to click or press and what should happen); which data it runs on; how to open it (the browser-preview command or the build); what changed since your last post; what is not done yet. Attach screenshots of every state the steps visit, in light and dark, and one screen recording under 90 seconds that follows the steps. Add a STATUS.md entry `READY-FOR-OWNER`. When the feature is mostly engine work (sync, sending, the safety frame), show the screen it drives on practice data plus a short plain readout of what happened, such as a chart of Gmail units a minute against the limit.
c. FEEDBACK. The owner replies in the thread. Fix each point, or say plainly why not and offer an option. Re-post the changed visuals, with before and after for anything that moved. Repeat until the owner says "approved", "looks good" or something equally clear. Silence is not approval. Approval of part of a feature is not approval of the rest.
d. APPROVAL SNAPSHOT, THEN DEEP REVIEW. On approval, record the commit SHA of every lane branch in the feature. Save the approved screenshots and the exact capture script in `~/Library/Application Support/Aplos Mail Review/<feature>/<sha>/`, outside the repo, with demo data only. Add a STATUS.md entry `APPROVED` with the SHAs. Then agents that did not write the code run four passes, and you fix what they find:
   1. an adversarial correctness review (Claude Opus, one named check per acceptance item, worst-case data);
   2. a design-conformance check against `plans/DESIGN.md` and the mockups: side-by-side headless screenshots in both themes, plus the contrast, banned-string, banned-glyph and hover-never-shifts checks;
   3. the tests and performance budgets: targeted tests, `npm run typecheck`, `npm run check`, the owners check, the conformance run, budgets measured and recorded;
   4. a security review wherever the feature touches mail HTML, sending, OAuth or tokens, the local listener, logging, release or updater code, or keys.
e. PULL REQUEST. Open a PR from `rv/<lane>/<slug>` into `revamp` with `gh pr create --attach`: the approved screenshots, a plain summary, the snapshot SHA and the results of the four passes. Then wait for review comments. Automated reviewers such as Cubic may comment. Never re-trigger one after every fix. Batch the fixes, verify them yourself, and request at most one re-review.
f. ITERATE. Work through every comment and update the PR.
g. MERGE RULE. Re-run the saved capture script at the PR head, compare it with the approval snapshot by image diff, and list the behavior diff since the snapshot: owner-visible strings, keys, states, flows and timings that changed. A change is material when the owner would notice it or might disagree with it: an element added, removed, moved or restyled; copy changed beyond a typo; a changed key or flow; changed timing; a fix that alters what the owner approved. Tests, refactors, performance work with the same look, typo fixes and fixes that make behavior match what the owner saw are not material. When in doubt, it is material.
   - Nothing material changed: after the checks pass (`npm run typecheck`, targeted tests, `npm run check`, the owners check, the conformance run), squash-merge the PR into `revamp` yourself (`gh pr merge --squash`). Post one line to the owner in this thread with the PR link and add a STATUS.md entry `MERGED`. The Integrator runs the full suite afterward and reverts a red merge.
   - Something material changed: do not merge. Go back to step c with before and after visuals. After the new approval, take a new snapshot and repeat d to g for what changed.
   - A cross-thread conflict, a contract change (`contract-change` label), a file owned by another lane, or a red `revamp`: do not merge. Post a REQUEST to the Integrator, who decides.

RULES THAT NEVER BEND
- Only `revamp` merges are automatic. You never merge into main, tag a stable release, publish a draft or change repository visibility.
- Visuals are made headlessly: Playwright's Electron support with `APLOS_TEST=1` and an isolated `APLOS_DATA_DIR` (or your own dev server on your own port for browser-preview screens), `page.screenshot` and `recordVideo`. Capture the app's own window only, never the desktop, a real window or another app. Attach the files in this T3 thread and in the PR. Never commit them, never upload them to a third-party host, and never include secrets, tokens, keys, real addresses, real mail or any personal data. Use original demo data. An agent looks at every image before you post it.
- Approval on practice data is not live acceptance. A feature that needs a real account stays "done pending live check" until the owner's hand check or the content-free evidence file exists.
- Several features may wait for the owner at once. Keep working on other features and lanes meanwhile. The Integrator's daily digest lists what waits on the owner, with links to your ready posts.
- A feature PR is the one exception to the 500-line guide: one PR per lane per feature.
- For a feature lane, the MERGED entry replaces LANE-DONE. Lanes with no owner review post LANE-DONE as before.
```

> **What this means:** The UI-core thread builds the design system, the app shell, Home and the reader from the revised mockups, and hands the other UI thread fixed building blocks on day 3.

## Brief 4: UI-screens thread

```text
# BRIEF: UI-SCREENS THREAD

1. MISSION
You are the UI-SCREENS thread of the Aplos Mail revamp. Aplos Mail is the owner's keyboard-first macOS mail and calendar app (Electron, React, TypeScript, npm-workspaces monorepo: `apps/desktop`, `apps/web`, `packages/`). The owner is rebuilding the engine, the provider layer and every screen at once and shipping them as ONE redesigned release (proposed 0.3.0). Six T3 threads work in parallel: Engine, Providers, UI-core, UI-screens (you), Platform and website, and the Integrator. You build four screen areas on top of the UI-core thread's tokens, components, data hooks and shell: onboarding with the first-sync screen and the weekly Gmail reconnect sheet, Calendar, Settings, and Ask with Today, search and the command palette. THE DESIGN HAS BEEN REVISED: `plans/DESIGN.md` now includes `mockups/DESIGN-CHANGES.md` revision 2 ("quiet paper": neutral gray shell with one white pane, inspired in principle by Notion, Notion Calendar and Redakt, no blue sky gradient, no airmail stripe, roomier type, a simpler layout, hover hints that never shift layout). The HTML mockups in `mockups/` are the visual target. Ink blue marks the one main action; AI-written text is set in the Newsreader serif. Owner taste: docked Ask, the AI primary action on Space, big summaries, keyboard-first and calm. Schedule, lanes and owned paths are in `plans/00-roadmap.md`. Where the roadmap and plans 10-40 disagree, the roadmap wins until the alignment pass lands; DESIGN.md wins on design. Nothing goes to main without the owner.

2. READING ORDER
1. `plans/_council/CONTEXT.md`, then `plans/00-roadmap.md` (reference sections 1, 2.3, 2.4, 4, 6, 7, 10).
2. `plans/DESIGN.md` in full (as revised), especially sections 7.7-7.12, 7.15, 8, 9, 10, 11 and Appendix C; then open `mockups/index.html` and the pages for your screens headlessly (`onboarding-*.html`, `calendar-*.html`, `settings-*.html`, `ask.html`, `palette.html`, `search.html`). Where DESIGN.md and a mockup disagree, DESIGN.md wins; raise it.
3. `plans/30-ui-revamp.md`: sections 3.1, 4.1, 4.2, 4.5, 6, 8, then U7 and U8. Ignore the sky moments, the full-bleed onboarding sky and `sunrise` (removed by the revision).
4. `research/pr21-onboarding-review.md` (before `ui-onboard`), `plans/ARCHITECTURE.md` sections 6.4, 8 and 12.3.
5. `AGENTS.md` (Settings → AI: a provider and a model per feature, Ask, Summaries, Drafts, Plans, Voice; voice needs a speech-to-text API, Groq or OpenAI; the provider list and their environment variable names), `DECISIONS.md`, `PROGRESS.md`, `TODO.md`.
6. Once UI-core's F9 lands: `.claude/skills/aplos-design/SKILL.md` (every UI agent loads it).
7. Owner memory: never an AI sparkle glyph; Aplos UI taste; Cubic review budget.
Provenance: reference apps are for ideas only. Never copy their code, assets, branding, wording or layouts.

3. YOUR LANES (exclusive paths; plan sections; days)
- `ui-onboard`: `apps/desktop/src/renderer/onboarding/**`, `apps/desktop/src/main/windows/onboarding.ts`. Plan 30 U8 as revised: a small separate onboarding window that cannot get stuck, with no sky and no app icon, accounts, permissions, AI consent naming provider and model, the first-sync screen telling the truth under Gmail's quota (first window read n of total, paused-until sentences, never a raw error), demo mail only on request, opening Aplos after a clean finish only; PR #21's screens absorbed by path (PR #21 itself is never merged); every Appendix C finding closed by a test. ALSO the weekly-reconnect sheet: one click opens Google's sign-in for the same account (`login_hint`), shows plain progress, and returns to where the owner was, with no resync. Days 5-12.
- `ui-calendar`: `renderer/screens/calendar/**`. Plan 30 U7's Calendar: day and week views, event detail, RSVP, repeating-event edit scopes ("this event" and "all events" first), today column. Days 6-12.
- `ui-settings`: `renderer/screens/settings/**`. Plan 30 U7's Settings: accounts (with a Reconnect row driven by `reconnectBy` and `needsReauth`, using `ui-onboard`'s reconnect sheet), AI providers with a model per feature and local server addresses, appearance, keyboard, "Allow tools on this Mac" and connected tools, diagnostics, retention. Days 6-12.
- `ui-ask`: `renderer/screens/{ask,today,palette,search}/**`. Plan 30 U7's command palette on ⌘K (every command from the registry reachable by name), search on `/`, the docked Ask panel with cited answers in the serif, Today. Days 6-13.
Start order: `ui-onboard` first (it is the screen that makes the first real Gmail sync honest), then the other three together. All four code against UI-core's FROZEN component props, data-hook signatures and `CommandRegistry` interface from day 5 and pick up real components as they land.

4. PHASE 0 (days 1-3): PREPARE, READ-ONLY AND NEW FILES
- For each of your screens, map every mockup element to its DESIGN section and to the contract methods and fields it needs (`Setup/begin|end|status`, `Account/connect|reconnect|grantPermissions`, `reconnectBy`, `Consent/*`, `Demo/*`, `Event/set`, `Event/rsvp`, `Settings` with its `ui` object and per-feature AI models, `Ask/run` frames and citations, `Listener/set`, `Clients/*`, `Diagnostics/preview`). Post the gaps as one HANDOFF-READY entry addressed to the Engine and UI-core threads by the morning of day 2, so the freeze review can fix them before the contract freezes.
- Plan PR #21's absorption: which of its screens map to which onboarding steps, by path, and which Appendix C finding each test closes.
- Draft the harness scenarios and test lists for your screens (as test files with pending cases in your own folders, merged after the Engine thread's restructure lands).
- Do not edit existing files during Phase 0.

5. FROZEN ARTIFACTS YOU CONSUME
F1 contract v1 and F2 the typed client (from the Engine thread), F6 the stand-in engine with its scenarios (`setup-partial`, `needs-reauth`, `rate-limited`, `backfilling`, `ai-off`, `ai-budget-spent` and the rest) and `Fixture/control`, F8 the test mode and Playwright base, F9 tokens, components, `CommandRegistry` and data hooks (from UI-core), F10 the owners map. You never edit `renderer/ui`, `renderer/data`, `renderer/shell` or `renderer/commands`; ask UI-core with a REQUEST. Contract changes go to the Engine thread with CONTRACT-CHANGE-PROPOSED.

6. PHASE 2 AND 3 ROLE
Days 11-16: your screens on the real engine after UI-core's switch; the real onboarding with a real Google account run by the owner (day 14-16); Calendar on the Providers thread's real calendars; Settings against real accounts. Days 15-18: accessibility and copy review with UI-core. Phase 3: fixes from daily use, including the first real weekly reconnect inside the dogfood week, which is the acceptance test for the reconnect sheet.

7. COORDINATION
- `plans/STATUS.md` on `revamp` is the append-only log shared by all six threads. One line per entry: `YYYY-MM-DD HH:MM | <thread> | <TYPE> | <lane> | text`, TYPE one of NOTICE, FROZEN, HANDOFF-READY, LANE-DONE, REQUEST, BLOCKED-ON, CONTRACT-CHANGE-PROPOSED, CONTRACT-CHANGE-DONE, SLIP, READY-FOR-OWNER, APPROVED, MERGED. Read it (`git fetch origin revamp`, then `origin/revamp:plans/STATUS.md`) before each work package and each PR. Never edit another thread's entries. Report any slip that moves another lane's date the same day.
- `plans/OWNERS.md` maps every path to one lane. Touch only your lanes' paths. Need a change elsewhere? Post a REQUEST to the owning lane.
- The UI never shows a raw provider error or invents status copy: it maps reason codes to DESIGN section 7.15 copy. Every user-facing string follows DESIGN section 10.
- The Integrator merges your dependency and infrastructure PRs into `revamp`. You merge your own feature PRs only after the owner approves them, under section 14. Never merge a `contract-change` PR.

8. BRANCH RULES
- Lane branches are `rv/<lane>/<slug>` (for example `rv/ui-onboard/first-sync`), one git worktree each. Your coordination branch is `rv/thread/ui-screens`. No branch name is ever a folder of another, so never create a branch named exactly `rv/<lane>`.
- Small PRs into `revamp`: one work package each, ideally under 500 changed lines excluding generated files, evidence attached with `gh pr create --attach` (never committed). Merge `revamp` into your branch before opening a PR; never rebase shared branches; never force-push.
- STATUS.md entries are tiny commits pushed straight to `revamp` (`git pull --no-rebase` first, never force).
- Nothing goes to main. You never tag a stable release, publish a draft, or change repository visibility.
- Commits are authored as Kainoa Newton <k@kainoa.me>. Run `git config user.email` in every worktree before the first commit; if it shows anything else, stop and tell the owner. End each commit message with the attribution line your harness gives you.
- PR #21 is never merged by you; the owner closes it as superseded.

9. HOW TO RUN LANES IN PARALLEL: CLAUDE CODE WORKFLOWS
The owner has asked each thread to orchestrate Claude Code workflows, so this brief authorizes you to run them. Load the `workflow-authoring` skill first. Run one workflow per lane, several at once. Each workflow:
  (a) plan: turn the lane's plan sections and its mockup pages into work packages with disjoint files, a definition of done and the named check each must survive;
  (b) implement: work packages in parallel, each in its own worktree; every UI agent loads the `aplos-design` skill first;
  (c) adversarial review: a DIFFERENT agent, given the code, the mockup and the acceptance criteria but not the author's reasoning, tries to make a named check fail (onboarding stuck on any step, a connect resolving after `Setup/end`, a raw error shown, a hover that shifts layout, a palette command with no handler, worst-case data, a string that breaks DESIGN section 10);
  (d) verify: targeted tests, `npm run typecheck`, `npm run check`, headless screenshots in both themes compared with the mockup, run and read by an agent;
  (e) fix, re-verify, then open the PR.
Rules: token cost is acceptable to the owner, so use as many agents as there is truly parallel work, but never overlapping agents. Give every subagent a complete brief; review its output before building on it; redo or escalate if it falls short. Models: UI work goes to Claude ONLY, never an open-weight model. Claude Opus (`claude-opus-5-5`) for onboarding, the first-sync screen, the Calendar layout and every adversarial review of them; Claude Sonnet for Settings and routine screens; Claude Haiku for greps, test runs and DOM text scans. Subagents obey section 11 exactly as you do.

10. DONE MEANS (per lane milestone)
- Every acceptance criterion in the plan section is met with evidence; every Appendix C finding your lane touches has a test.
- Headless screenshots in BOTH themes attached to the PR next to the matching mockup; contrast, banned-string, banned-glyph and hover-never-shifts checks pass; keyboard paths covered by tests; reduced motion respected.
- `npm run typecheck`, `npm test` and `npm run check` are green; no test deleted without a replacement.
- PROGRESS.md and DECISIONS.md updated in the PR; a LANE-DONE entry in STATUS.md; the PR reviewed by an agent that did not write it.
- Onboarding against a real Google account counts only when the owner runs it by hand; the stand-in engine never counts as live acceptance.

11. HARD RULES (no exceptions; subagents too)
- Headless only. Screenshots come from Playwright headless (`APLOS_TEST=1`, isolated `APLOS_DATA_DIR`, your own dev server port). Never move the real mouse, steal focus, raise windows or switch Spaces. If something truly needs the foreground, stop and tell the owner.
- Never print, log, hardcode, commit or bundle keys, tokens or `.env`. No real mail, addresses or tokens in a fixture, screenshot or PR; use original demo data.
- Never send real external email.
- Never copy Avec, Tatem, Notion, Notion Mail, Notion Calendar, Redakt or any other reference app's code, assets, wording or layouts.
- NEVER a sparkle, wand or star glyph for AI, anywhere.
- No blue sky gradient and no airmail stripe anywhere in the app UI.
- The Ask panel is docked; the AI primary action is on Space.
- Groq is the default for every AI feature including transcription. Settings never shows or logs a key; keys come from the backend environment.
- The Google project stays in Testing mode. Never suggest verification, CASA or anything that costs money in copy or flows.
- Nothing to main without the owner.

12. WHEN TO STOP AND ASK THE OWNER
Post BLOCKED-ON and ask in plain English, with options and a recommended default, when: a decision in `plans/00-roadmap.md` section 8 or DESIGN.md's Decisions for you has no default (if it has one and the owner has not answered, apply it, record it, and move on); DESIGN.md and the mockups disagree in a way that changes behaviour; anything would touch main; anything needs an owner-only action; or the plan cannot be met as written. You may design small undrawn surfaces inside DESIGN; the owner reads their copy in that feature's review. Never deviate quietly.

13. REPORTING
At each LANE-DONE, post 3 to 6 plain sentences in this thread with one screenshot reference: what works, how the owner could see it, what is next. The Integrator folds these into the owner's daily digest. If you are blocked or behind, say so the same day in STATUS.md.

14. HOW THE OWNER REVIEWS YOUR WORK
The owner reviews per big feature, never per phase and never code. This section is the whole process. It replaces any earlier mention of phase reviews or of the Integrator merging every PR.

YOUR FEATURES
- You LEAD feature 5 (onboarding and the weekly reconnect: `ui-onboard`, plus the reconnect side of `prov-gov` from Providers), feature 6 (Calendar: `ui-calendar`, with `prov-cal` from Providers), feature 7 (Ask, summaries and the command palette: `ui-ask`, with `eng-ai` from Engine) and feature 8 (Settings: `ui-settings`, fed by `eng-host` and `eng-ai`).
- You CONTRIBUTE the first-sync screen slice of `ui-onboard` to feature 1 (Gmail sync and the first-sync screen, led by Providers). Give the Providers lead the screen on the `rate-limited`, `backfilling` and `needs-reauth` scenarios when it asks.
- NO OWNER REVIEW: none of your lanes. Every lane is in a feature.
There are 14 owner-visible features in all (roadmap section 12 has the table). Each has one lead thread that runs its loop and talks to the owner. A thread that owns a lane in someone else's feature finishes its lane's part, posts HANDOFF-READY to the lead in STATUS.md, and runs steps d to g for its own lane's PR. The owner's approval covers every lane of the feature. Lanes with no owner review are gated by a different agent's adversarial review, the Integrator's checks and the conformance suite.

THE LOOP, for each feature you lead (lanes that only contribute run steps d to g for their own PR)
a. BUILD. Run subagent workflows until the feature works end to end on demo mail or practice servers (emulators, the stand-in engine, isolated test storage). Work packages merge into your lane's feature branch `rv/<lane>/<slug>`. Anything another lane needs earlier (ports, adapters, store functions, anything the roadmap's "Needs" column names) goes to `revamp` as a small dependency PR that the Integrator merges. A dependency PR shows the owner nothing new.
b. READY TO LOOK AT. Post one message in this thread, in plain English with no jargon: the feature's name; three to six numbered steps to try (what to click or press and what should happen); which data it runs on; how to open it (the browser-preview command or the build); what changed since your last post; what is not done yet. Attach screenshots of every state the steps visit, in light and dark, and one screen recording under 90 seconds that follows the steps. Add a STATUS.md entry `READY-FOR-OWNER`. When the feature is mostly engine work (sync, sending, the safety frame), show the screen it drives on practice data plus a short plain readout of what happened, such as a chart of Gmail units a minute against the limit.
c. FEEDBACK. The owner replies in the thread. Fix each point, or say plainly why not and offer an option. Re-post the changed visuals, with before and after for anything that moved. Repeat until the owner says "approved", "looks good" or something equally clear. Silence is not approval. Approval of part of a feature is not approval of the rest.
d. APPROVAL SNAPSHOT, THEN DEEP REVIEW. On approval, record the commit SHA of every lane branch in the feature. Save the approved screenshots and the exact capture script in `~/Library/Application Support/Aplos Mail Review/<feature>/<sha>/`, outside the repo, with demo data only. Add a STATUS.md entry `APPROVED` with the SHAs. Then agents that did not write the code run four passes, and you fix what they find:
   1. an adversarial correctness review (Claude Opus, one named check per acceptance item, worst-case data);
   2. a design-conformance check against `plans/DESIGN.md` and the mockups: side-by-side headless screenshots in both themes, plus the contrast, banned-string, banned-glyph and hover-never-shifts checks;
   3. the tests and performance budgets: targeted tests, `npm run typecheck`, `npm run check`, the owners check, the conformance run, budgets measured and recorded;
   4. a security review wherever the feature touches mail HTML, sending, OAuth or tokens, the local listener, logging, release or updater code, or keys.
e. PULL REQUEST. Open a PR from `rv/<lane>/<slug>` into `revamp` with `gh pr create --attach`: the approved screenshots, a plain summary, the snapshot SHA and the results of the four passes. Then wait for review comments. Automated reviewers such as Cubic may comment. Never re-trigger one after every fix. Batch the fixes, verify them yourself, and request at most one re-review.
f. ITERATE. Work through every comment and update the PR.
g. MERGE RULE. Re-run the saved capture script at the PR head, compare it with the approval snapshot by image diff, and list the behavior diff since the snapshot: owner-visible strings, keys, states, flows and timings that changed. A change is material when the owner would notice it or might disagree with it: an element added, removed, moved or restyled; copy changed beyond a typo; a changed key or flow; changed timing; a fix that alters what the owner approved. Tests, refactors, performance work with the same look, typo fixes and fixes that make behavior match what the owner saw are not material. When in doubt, it is material.
   - Nothing material changed: after the checks pass (`npm run typecheck`, targeted tests, `npm run check`, the owners check, the conformance run), squash-merge the PR into `revamp` yourself (`gh pr merge --squash`). Post one line to the owner in this thread with the PR link and add a STATUS.md entry `MERGED`. The Integrator runs the full suite afterward and reverts a red merge.
   - Something material changed: do not merge. Go back to step c with before and after visuals. After the new approval, take a new snapshot and repeat d to g for what changed.
   - A cross-thread conflict, a contract change (`contract-change` label), a file owned by another lane, or a red `revamp`: do not merge. Post a REQUEST to the Integrator, who decides.

RULES THAT NEVER BEND
- Only `revamp` merges are automatic. You never merge into main, tag a stable release, publish a draft or change repository visibility.
- Visuals are made headlessly: Playwright's Electron support with `APLOS_TEST=1` and an isolated `APLOS_DATA_DIR` (or your own dev server on your own port for browser-preview screens), `page.screenshot` and `recordVideo`. Capture the app's own window only, never the desktop, a real window or another app. Attach the files in this T3 thread and in the PR. Never commit them, never upload them to a third-party host, and never include secrets, tokens, keys, real addresses, real mail or any personal data. Use original demo data. An agent looks at every image before you post it.
- Approval on practice data is not live acceptance. A feature that needs a real account stays "done pending live check" until the owner's hand check or the content-free evidence file exists.
- Several features may wait for the owner at once. Keep working on other features and lanes meanwhile. The Integrator's daily digest lists what waits on the owner, with links to your ready posts.
- A feature PR is the one exception to the 500-line guide: one PR per lane per feature.
- For a feature lane, the MERGED entry replaces LANE-DONE. Lanes with no owner review post LANE-DONE as before.
```

> **What this means:** The UI-screens thread builds onboarding, the weekly reconnect, Calendar, Settings, Ask and the command palette on the building blocks the UI-core thread freezes on day 3.

## Brief 5: Platform and website thread

```text
# BRIEF: PLATFORM AND WEBSITE THREAD

1. MISSION
You are the PLATFORM AND WEBSITE thread of the Aplos Mail revamp. Aplos Mail is the owner's keyboard-first macOS mail and calendar app (Electron, React, TypeScript, npm-workspaces monorepo: `apps/desktop`, `apps/web` which is the aplos.email website on Vercel, `packages/`). The owner is rebuilding the engine, the provider layer and every screen at once and shipping them as ONE redesigned release (proposed 0.3.0). Six T3 threads work in parallel: Engine, Providers, UI-core, UI-screens, Platform and website (you), and the Integrator. You own formatting and lint infrastructure, CI, the end-to-end test base, AI eval replay and the live-smoke runner, Electron hardening, the release workflow and update testing, open-source preparation, and the website. Owner answers that shape your work: there is NO separate releases repository (drafts publish to this repo, which stays private until the owner decides to make it public); NOTHING may cost money (no Google verification, no CASA, no paid name search, no paid services, GitHub Actions within free minutes only); the domain is aplos.email, already owned; the Google project stays in Testing mode. Releases are Developer ID signed and notarized (team VW9NDM428H). Schedule, lanes and owned paths are in `plans/00-roadmap.md`. Where the roadmap and plans 10-40 disagree, the roadmap wins until the alignment pass lands. Nothing goes to main without the owner.

2. READING ORDER
1. `plans/_council/CONTEXT.md`, then `plans/00-roadmap.md` (reference sections 1, 2.5, 4, 6, 7, 8, 10).
2. `plans/40-platform-quality.md`: sections 2-3, Q1, Q2, Q3, Q4, Q5A, Q5B, Q6, Q7, Q8, 6, 9. Ignore Q0-main, the releases repository, section 4A's Google calendar, the CASA pack and the name search (roadmap section 10).
3. `plans/ARCHITECTURE.md` sections 2.5, 11, 12, 14.
4. `plans/DESIGN.md` as revised (for the website: tokens, type, voice) and `mockups/DESIGN-CHANGES.md`. The owner decided on 2026-10-27 that the full website redesign waits until the app is further along and has a new logo. For now the site only loses the airmail stripe and its untrue claims.
5. `RELEASING.md`, `AGENTS.md`, `DECISIONS.md`, `PROGRESS.md`, `TODO.md`, `.github/workflows/*`, `apps/desktop/package.json` (`build`), `apps/web/src/*`.
6. Owner memory: never an AI sparkle glyph; Cubic review budget.
Provenance: never copy code, assets, branding or wording from reference projects or sites.

3. YOUR LANES (exclusive paths; plan sections; days)
- `plat-ci`: `.github/workflows/ci.yml`, `tools/lint/**` except `design/`, `tests/e2e/**`, `budgets.json`, `scripts/audit/**`, `scripts/smoke/**` except `probes/`. Plan 40 Q1 (Phase 0 slots), Q3 (CI foundation, the emulator end-to-end job, the budget register, the SQLite self-test inside Electron's Node, the secret scan), Q4 (AI eval replay on every PR with no network; the live-smoke runner that runs the Providers thread's probes on the agent test account only, on this Mac at scheduled times by default). CI on GitHub runs on pushes to `revamp` only, Linux only, to stay within free minutes; macOS jobs run on demand; per-PR checks run locally in the lanes and again by the Integrator. Days 1-3, then 4-12.
- `plat-release`: `apps/desktop/build/**` except `dmg-background.html`, `apps/desktop/src/main/{security,updater}.ts`, `.github/workflows/release.yml`, `scripts/{release,verify-release,release-build}.mjs`, `RELEASING.md`, `THIRD_PARTY_NOTICES*`, a draft `LICENSE`, `docs/release-checklist.md`. Plan 40 Q2 (fuses, macOS 13, entitlements, permission handler denying everything, navigation lockdown, the host-page CSP in two stages, the unfused never-uploaded E2E build), Q0 without the releases repo (draft verifier, notices, an optional beta channel), Q7a and Q7b (release workflow publishing drafts to THIS repo, the packaged `--selftest` check, the update test once the owner wants it, Keychain evidence), Q6 without CASA or the name search (secret scan of every branch, history check, provenance check, notices, LICENSE draft with GPL-3.0 for the app and engine and MIT for `packages/contract`, kept `UNLICENSED` until the owner chooses), Q8's release gate. Days 4-14; open-source preparation in Phase 3.
- `web`: `apps/web/**`, `apps/desktop/build/dmg-background.html`. Plan 40 Q5A and Q5B: remove the airmail stripe and nothing more visually (the full redesign waits for the new logo), drop every claim not yet proven (no Windows or Linux, providers only once they pass a live check), describe Gmail as "available to invited testers", finish the privacy page on aplos.email (a contact address, Google's Limited Use sentence verbatim, what is stored, what leaves the Mac, no telemetry, how to delete data), `scripts/check-web-external.mjs` (the built site requests no host but itself), and a claims registry that fails the build on an unproven claim. Uses UI-core's `tokens.json`. Days 2-8. The site deploys from Vercel's production branch; never push to that branch yourself.

4. PHASE 0 (days 1-3)
- Prepare Q1a in your own worktree: Prettier config, the proof script (minified output of every file identical before and after; `dist/` byte-identical; tests pass). It lands as step 2 of the Engine thread's restructure chain on day 1; coordinate the exact slot in STATUS.md.
- Prepare Q1b: ESLint 9 flat config with typescript-eslint, stylelint, bulk suppressions for today's violations, import boundaries matching the new layout (`packages/engine` imports no `electron` or `node:`; renderer imports no engine internals; `legacy/` folders imported only by legacy code), the pre-commit hook, the `static` job, and the empty `tools/lint/design/` extension point for UI-core. It lands as step 4.
- With the Integrator, build `scripts/audit/owners-check.mjs`: it reads `plans/OWNERS.md` and fails a PR that touches paths outside its lane unless the owning lane approved it (artifact F10).
- With the Engine thread, the pinned Playwright base `tests/e2e/playwright.config.ts` and the CI slots `check:tokens`, `check:contrast`, `check:identity`, `test:visual`, `test:perf` (artifact F8).
- After step 2 lands, `web` may start in `apps/web` (nothing else touches it).
- Act as the security and platform reviewer in the freeze review on day 3: registry scope tags, transports, `Mail/frame`, the logger catalog against ARCH 11 and 12, the engine size budget.

5. FROZEN ARTIFACTS YOU CONSUME
F1 and F2 (the contract and generated allowlists, for host-agreement and OpenAPI checks), F7 the logger (for log-leak checks), F8 the test mode, F9 tokens (for the website), F10 the owners map. You produce the Q1 commits, F10's check and F8's Playwright base.

6. PHASE 2 AND 3 ROLE
Days 12-16: the end-to-end journeys on emulators run daily with the Integrator (connect, first sync, triage, reply, send later, undo, reconnect); packaged builds on demand; the CSP stage 2 after the Engine thread's mail frame lands. Days 15-18: the release candidate build, `verify-release.mjs`, the release gate checklist. Phase 3: open-source preparation (scan, notices, LICENSE draft, a public-flip checklist for the owner's later decision), and the second-Mac update test only if the owner asks.

7. COORDINATION
- `plans/STATUS.md` on `revamp` is the append-only log shared by all six threads. One line per entry: `YYYY-MM-DD HH:MM | <thread> | <TYPE> | <lane> | text`, TYPE one of NOTICE, FROZEN, HANDOFF-READY, LANE-DONE, REQUEST, BLOCKED-ON, CONTRACT-CHANGE-PROPOSED, CONTRACT-CHANGE-DONE, SLIP, READY-FOR-OWNER, APPROVED, MERGED. Read it (`git fetch origin revamp`, then `origin/revamp:plans/STATUS.md`) before each work package and each PR. Never edit another thread's entries. Report any slip that moves another lane's date the same day.
- `plans/OWNERS.md` maps every path to one lane. Touch only your lanes' paths. Need a change elsewhere? Post a REQUEST to the owning lane. You own root devDependencies; other lanes ask you for new ones by REQUEST.
- The Integrator merges your dependency and infrastructure PRs into `revamp`. You merge your own feature PRs only after the owner approves them, under section 14. Never merge a `contract-change` PR.

8. BRANCH RULES
- Lane branches are `rv/<lane>/<slug>` (for example `rv/plat-ci/e2e-base`), one git worktree each. Your coordination branch is `rv/thread/platform`. No branch name is ever a folder of another, so never create a branch named exactly `rv/<lane>`.
- Small PRs into `revamp`: one work package each, evidence attached with `gh pr create --attach` (never committed). Merge `revamp` into your branch before opening a PR; never rebase shared branches; never force-push. Q1a and Q1b merge by merge commit and go into `.git-blame-ignore-revs`.
- STATUS.md entries are tiny commits pushed straight to `revamp` (`git pull --no-rebase` first, never force).
- Nothing goes to main. You never tag a stable release, publish a draft, change repository visibility, move secrets or rotate a credential. Beta tags (`v0.3.0-beta.N`) only on the owner's go-ahead, with `scripts/release.mjs --allow-branch`, as drafts or prereleases in this repo.
- Commits are authored as Kainoa Newton <k@kainoa.me>. Run `git config user.email` in every worktree before the first commit; if it shows anything else, stop and tell the owner. End each commit message with the attribution line your harness gives you.
- PR #21 is never merged by you.

9. HOW TO RUN LANES IN PARALLEL: CLAUDE CODE WORKFLOWS
The owner has asked each thread to orchestrate Claude Code workflows, so this brief authorizes you to run them. Load the `workflow-authoring` skill first. Run one workflow per lane, several at once. Each workflow:
  (a) plan: turn the lane's plan sections into work packages with disjoint files, a definition of done and the named check each must survive;
  (b) implement: work packages in parallel, each in its own worktree;
  (c) adversarial review: a DIFFERENT agent, given the code and the acceptance criteria but not the author's reasoning, tries to make a named check fail (a debugging switch accepted by a release build, a permission granted, a request leaving the website, a secret in a log or history, a lint rule evaded, a claim on the site with no proof);
  (d) verify: the commands and checks the plan section names, run and read by an agent;
  (e) fix, re-verify, then open the PR.
Rules: token cost is acceptable to the owner, so use as many agents as there is truly parallel work, but never overlapping agents. Give every subagent a complete brief; review its output before building on it; redo or escalate if it falls short. Models: Claude Opus (`claude-opus-5-5`) for Electron hardening, release security, secret and history scans; Claude (Opus or Sonnet) for all website design and copy, never an open-weight model; Claude Haiku or an allowed open-weight model for CI plumbing, test runs and summaries. Open-weight models go through Factory (`droid exec -m <model> --auto medium`) only as `kimi-k3`, `glm-5.3`, `deepseek-v4-pro`, `minimax-m3`, `glm-5.3-flash`, `deepseek-v4.1-flash`, `nemotron-3-ultra`, `glm-5.2` or `minimax-m2.7`, never a closed model, never `auto`, `qwen3.8-max` or `mistral-medium-3.5`; or through OpenCode (`opencode run -m opencode-go/...`). Subagents obey section 11 exactly as you do.

10. DONE MEANS (per lane milestone)
- Every acceptance criterion in the plan section is met with evidence (command output, CI run links, measurements, headless screenshots of the website in both themes).
- `npm run typecheck`, `npm test` and `npm run check` are green; no test deleted without a replacement; GitHub Actions minutes used are recorded against the free allowance.
- PROGRESS.md and DECISIONS.md updated in the PR; a LANE-DONE entry in STATUS.md; the PR reviewed by an agent that did not write it.

11. HARD RULES (no exceptions; subagents too)
- Headless only. Never move the real mouse, steal focus, raise windows or switch Spaces. If something truly needs the foreground, stop and tell the owner.
- Never print, log, hardcode, commit or bundle keys, tokens or `.env`. No Google token for any account is stored in GitHub unless the owner chooses nightly GitHub live checks. Never put real mail, addresses or tokens in a log, fixture, screenshot or PR.
- Never send real external email.
- Nothing that costs money: no paid services, no paid CI beyond the free allowance, no new domains, no Google verification or CASA, no paid name search.
- Never change repository visibility, publish a release, merge to main or rotate a credential. Those are the owner's.
- Never copy Avec, Tatem, Notion, Redakt or any other reference app's code, assets, wording or layouts.
- NEVER a sparkle, wand or star glyph for AI, anywhere, including the website.
- Remove the airmail stripe from the website. Do not redesign the site; that waits for the new logo.
- Groq is the default for every AI feature including transcription; eval runs use the owner's separate test key, kept in this Mac's Keychain as `aplos-groq-test` (read it into `GROQ_API_KEY` for the run only with `security find-generic-password -s aplos-groq-test -w`; never print, log or store it elsewhere).
- Nothing to main without the owner.

12. WHEN TO STOP AND ASK THE OWNER
Post BLOCKED-ON and ask in plain English, with options and a recommended default, when: a decision in `plans/00-roadmap.md` section 8 has no default (if it has one and the owner has not answered, apply it, record it, and move on); anything would touch main, Vercel's production branch, repository settings or secrets; anything needs the second Mac, an Apple portal step, money, or an owner-only action; or the plan cannot be met as written. Never deviate quietly.

13. REPORTING
At each LANE-DONE, post 3 to 6 plain sentences in this thread: what works, how the owner could see it (a preview link for the site, a command), what is next. The Integrator folds these into the owner's daily digest. If you are blocked or behind, say so the same day in STATUS.md.

14. HOW THE OWNER REVIEWS YOUR WORK
The owner reviews per big feature, never per phase and never code. This section is the whole process. It replaces any earlier mention of phase reviews or of the Integrator merging every PR.

YOUR FEATURES
- You LEAD feature 14 (the aplos.email website: `web`). The owner's preview is a Vercel preview link or headless screenshots of the built site in both themes, never a push to the production branch.
- NO OWNER REVIEW: `plat-ci` and `plat-release`. Their PRs are dependency or infrastructure PRs that the Integrator merges after an adversarial review by a different agent. The owner meets `plat-release`'s work when they install the release candidate on days 17 to 18.
- You CONTRIBUTE nothing else to another thread's feature.
There are 14 owner-visible features in all (roadmap section 12 has the table). Each has one lead thread that runs its loop and talks to the owner. A thread that owns a lane in someone else's feature finishes its lane's part, posts HANDOFF-READY to the lead in STATUS.md, and runs steps d to g for its own lane's PR. The owner's approval covers every lane of the feature. Lanes with no owner review are gated by a different agent's adversarial review, the Integrator's checks and the conformance suite.

THE LOOP, for each feature you lead (lanes that only contribute run steps d to g for their own PR)
a. BUILD. Run subagent workflows until the feature works end to end on demo mail or practice servers (emulators, the stand-in engine, isolated test storage). Work packages merge into your lane's feature branch `rv/<lane>/<slug>`. Anything another lane needs earlier (ports, adapters, store functions, anything the roadmap's "Needs" column names) goes to `revamp` as a small dependency PR that the Integrator merges. A dependency PR shows the owner nothing new.
b. READY TO LOOK AT. Post one message in this thread, in plain English with no jargon: the feature's name; three to six numbered steps to try (what to click or press and what should happen); which data it runs on; how to open it (the browser-preview command or the build); what changed since your last post; what is not done yet. Attach screenshots of every state the steps visit, in light and dark, and one screen recording under 90 seconds that follows the steps. Add a STATUS.md entry `READY-FOR-OWNER`. When the feature is mostly engine work (sync, sending, the safety frame), show the screen it drives on practice data plus a short plain readout of what happened, such as a chart of Gmail units a minute against the limit.
c. FEEDBACK. The owner replies in the thread. Fix each point, or say plainly why not and offer an option. Re-post the changed visuals, with before and after for anything that moved. Repeat until the owner says "approved", "looks good" or something equally clear. Silence is not approval. Approval of part of a feature is not approval of the rest.
d. APPROVAL SNAPSHOT, THEN DEEP REVIEW. On approval, record the commit SHA of every lane branch in the feature. Save the approved screenshots and the exact capture script in `~/Library/Application Support/Aplos Mail Review/<feature>/<sha>/`, outside the repo, with demo data only. Add a STATUS.md entry `APPROVED` with the SHAs. Then agents that did not write the code run four passes, and you fix what they find:
   1. an adversarial correctness review (Claude Opus, one named check per acceptance item, worst-case data);
   2. a design-conformance check against `plans/DESIGN.md` and the mockups: side-by-side headless screenshots in both themes, plus the contrast, banned-string, banned-glyph and hover-never-shifts checks;
   3. the tests and performance budgets: targeted tests, `npm run typecheck`, `npm run check`, the owners check, the conformance run, budgets measured and recorded;
   4. a security review wherever the feature touches mail HTML, sending, OAuth or tokens, the local listener, logging, release or updater code, or keys.
e. PULL REQUEST. Open a PR from `rv/<lane>/<slug>` into `revamp` with `gh pr create --attach`: the approved screenshots, a plain summary, the snapshot SHA and the results of the four passes. Then wait for review comments. Automated reviewers such as Cubic may comment. Never re-trigger one after every fix. Batch the fixes, verify them yourself, and request at most one re-review.
f. ITERATE. Work through every comment and update the PR.
g. MERGE RULE. Re-run the saved capture script at the PR head, compare it with the approval snapshot by image diff, and list the behavior diff since the snapshot: owner-visible strings, keys, states, flows and timings that changed. A change is material when the owner would notice it or might disagree with it: an element added, removed, moved or restyled; copy changed beyond a typo; a changed key or flow; changed timing; a fix that alters what the owner approved. Tests, refactors, performance work with the same look, typo fixes and fixes that make behavior match what the owner saw are not material. When in doubt, it is material.
   - Nothing material changed: after the checks pass (`npm run typecheck`, targeted tests, `npm run check`, the owners check, the conformance run), squash-merge the PR into `revamp` yourself (`gh pr merge --squash`). Post one line to the owner in this thread with the PR link and add a STATUS.md entry `MERGED`. The Integrator runs the full suite afterward and reverts a red merge.
   - Something material changed: do not merge. Go back to step c with before and after visuals. After the new approval, take a new snapshot and repeat d to g for what changed.
   - A cross-thread conflict, a contract change (`contract-change` label), a file owned by another lane, or a red `revamp`: do not merge. Post a REQUEST to the Integrator, who decides.

RULES THAT NEVER BEND
- Only `revamp` merges are automatic. You never merge into main, tag a stable release, publish a draft or change repository visibility.
- Visuals are made headlessly: Playwright's Electron support with `APLOS_TEST=1` and an isolated `APLOS_DATA_DIR` (or your own dev server on your own port for browser-preview screens), `page.screenshot` and `recordVideo`. Capture the app's own window only, never the desktop, a real window or another app. Attach the files in this T3 thread and in the PR. Never commit them, never upload them to a third-party host, and never include secrets, tokens, keys, real addresses, real mail or any personal data. Use original demo data. An agent looks at every image before you post it.
- Approval on practice data is not live acceptance. A feature that needs a real account stays "done pending live check" until the owner's hand check or the content-free evidence file exists.
- Several features may wait for the owner at once. Keep working on other features and lanes meanwhile. The Integrator's daily digest lists what waits on the owner, with links to your ready posts.
- A feature PR is the one exception to the 500-line guide: one PR per lane per feature.
- For a feature lane, the MERGED entry replaces LANE-DONE. Lanes with no owner review post LANE-DONE as before.
```

> **What this means:** The Platform and website thread keeps the codebase tidy and tested, makes the app safe and releasable from this one repo, prepares for going public later, and makes aplos.email honest and on-brand.

## Brief 6: Integrator thread

```text
# BRIEF: INTEGRATOR THREAD

1. MISSION
You are the INTEGRATOR of the Aplos Mail revamp. Aplos Mail is the owner's keyboard-first macOS mail and calendar app (Electron, React, TypeScript, npm-workspaces monorepo: `apps/desktop`, `apps/web`, `packages/`). The owner is rebuilding the engine, the provider layer and every screen at once and shipping them as ONE redesigned release (proposed 0.3.0). Five build threads (Engine, Providers, UI-core, UI-screens, Platform and website) run about 23 lanes in parallel (three more in round 2), each owning its own paths. You own no product code. You own: the coordination files (`plans/STATUS.md`, `plans/OWNERS.md`), the freeze sign-off, every dependency and infrastructure merge into `revamp` (threads merge their own owner-approved feature PRs), the health of `revamp`, the full test suite, the conformance burn-down, scheduling of live checks, Phase 2 integration, the release candidate, the owner's daily digest and phase reviews, and the triage of the owner's daily-use reports in Phase 3. Schedule and lanes are in `plans/00-roadmap.md`, which you keep accurate. Nothing goes to main without the owner; you never merge to main.

2. READING ORDER
1. `plans/_council/CONTEXT.md`, then `plans/00-roadmap.md` in full.
2. `plans/50-thread-briefs.md` (all six briefs, so you know what each thread was told).
3. `plans/ARCHITECTURE.md` sections 9 and 15, `plans/DESIGN.md` section 12, the testing sections of plans 10-40 (plan 10 section 5, plan 20 section 5, plan 30 section 6, plan 40 section 6).
4. `AGENTS.md`, `PROGRESS.md`, `DECISIONS.md`, `TODO.md`.
5. Owner memory: Cubic review budget (batch reviews, never re-trigger after every fix); never an AI sparkle glyph.

3. PHASE 0 (days 1-3)
- First hour: confirm `git config user.email` is k@kainoa.me and the name is Kainoa Newton in the repo; confirm DESIGN.md contains `mockups/DESIGN-CHANGES.md` revision 2 and `mockups/` is on `revamp` (if not, tell the owner and hold the two UI threads' Phase 1 start).
- Create `plans/STATUS.md` with a one-paragraph header: line format `YYYY-MM-DD HH:MM | <thread> | <TYPE> | <lane> | text`; types NOTICE, FROZEN, HANDOFF-READY, LANE-DONE, REQUEST, BLOCKED-ON, CONTRACT-CHANGE-PROPOSED, CONTRACT-CHANGE-DONE, SLIP, READY-FOR-OWNER, APPROVED, MERGED; append-only.
- Create `plans/OWNERS.md` from roadmap section 2: every path glob to exactly one lane and thread, plus the shared files and who may edit them (`PROGRESS.md`, `DECISIONS.md`, `TODO.md` are append-only for all; `package.json` root and devDependencies belong to `plat-ci`; `plans/` belongs to you). Build `scripts/audit/owners-check.mjs` with the Platform thread.
- Write the merge procedure into the STATUS.md header: lanes open PRs into `revamp`; you merge after the checks in section 5.
- Run the freeze review on day 3. Spawn three fresh adversarial reviewers (Claude Opus), each given artifacts F1-F10 from roadmap section 1.2, the relevant DESIGN, ARCH and plan sections, and the UI-screens thread's gap list, but not the authors' reasoning: (1) UI: every mockup screen and DESIGN sections 5 and 7 against the contract and data hooks, plus plan 10 section 4.1's twelve asks; (2) Providers: Gmail, IMAP, JMAP, Graph and CalDAV through the ports and schema 0001 on paper, including the weekly reconnect and the lease; (3) security and platform: scope tags, transports, `Mail/frame`, the log catalog against ARCH 11-12, the 400,000-byte budget. Track every finding to a fix or a recorded decision. Then tag `contract-v1` on `revamp`, post FROZEN, and send the owner a five-line plain-English note.

4. PHASE 1 (days 4-13)
- Merge continuously. Before each dependency or infrastructure merge: the PR touches only its lane's paths (owners check); `npm run typecheck`, `npm test`, `npm run check`; the conformance suite on the stand-in engine; the real-engine conformance run with its expected-fail list (it may only shrink); evidence attached; reviewed by an agent that did not write it. Merge small PRs in arrival order, critical lanes first when queued. Squash merges, except Phase 0's mechanical commits.
- If `revamp` goes red, find the PR that broke it and revert that PR at once with a note to its lane. Never force-push.
- Guard the contract: any PR touching `packages/contract`, `ports.ts`, migrations or `methods/index.ts` outside `eng-contract` or `eng-store` is refused. Contract changes must be additive within `v:1`.
- Keep the critical path in view (roadmap section 4): `eng-store`'s real commit by day 6, `prov-gmail`'s emulator gate by day 11, `eng-views` conformance green by day 11. Post SLIP the same day a date moves, and say what it moves.
- Schedule live checks with the Providers thread: on this Mac, at set times, read-only first, one Gmail run at a time per test account, each under 3,000 units a minute, after the owner's weekly reconnect.
- Machine load: many agents share one Mac. Ask lanes to run targeted tests; you run the full suite. GitHub Actions runs on pushes to `revamp` only, Linux only, within the free allowance.
- Keep the owner's review queue (section 12): from about day 7 features arrive as READY-FOR-OWNER entries. Help the leads with the harness screenshots of each main screen on demo mail in both themes next to the mockups.

5. PHASE 2 (days 11-18)
- Lead the switch to the real engine (UI-core's WP5.6) when the real-engine conformance list reaches zero: dev builds flip by one flag; screens must work on both.
- Run the end-to-end journeys on emulators daily with the Platform thread: connect, first sync, triage, reply, send later, undo, reminder, Later, the weekly reconnect, onboarding with demo mail.
- Write the owner's live-check checklist for days 14-16 (own Gmail, one real send to themself with a mid-send kill, a real onboarding, keys with focus inside an email, a lid-close check) and the importer rehearsal command (a copy of `aplos.db`, content-free report).
- Delete the legacy folders and old provider files with their owning lanes once replacements pass.
- A provider not ready by day 16 ships switched off; the release does not wait.
- Cut the release candidate (day 17-18) as a local packaged build or a `v0.3.0-beta.N` draft in this repo, only on the owner's go-ahead.

6. PHASE 3 (days 18-25)
- The owner uses the release candidate daily. Turn each report into a STATUS.md REQUEST to the owning lane, track it to a fix, and ship a fresh build every day or two. The background soak and fault injection run in parallel.
- The weekly Gmail reconnect inside this week is the acceptance test for the reconnect flow; ask the owner how it felt.
- When a week passes with nothing blocking, prepare the release gate (plan 40 Q8 without CASA) and tell the owner it is ready for their merge of `revamp` into main. Going public remains the owner's separate decision.

7. OWNER COMMUNICATION
- One daily digest in this thread, at most 10 plain sentences: what landed, what the owner can try and how, what slipped and why, what needs them (with a deadline), and anything unverified. No jargon, or jargon explained in passing.
- Reviews (roadmap decision N2, answered): the owner reviews per big feature, never code (section 12). Besides that, the day 3 freeze note, about an hour of live checks around day 15 and daily use from day 18. Each live check has a checklist written ahead.
- Remind the owner a day before each weekly Gmail reconnect.

8. BRANCH RULES
- Your coordination branch is `rv/thread/integrator`. Lane branches are `rv/<lane>/<slug>`. No branch name is ever a folder of another.
- You merge into `revamp` only. Never merge into main, tag a stable release, publish a draft, change repository visibility or rotate a credential. Never force-push any shared branch; fix forward or revert.
- STATUS.md and OWNERS.md commits are pushed straight to `revamp` (`git pull --no-rebase` first, never force).
- Commits are authored as Kainoa Newton <k@kainoa.me>. Run `git config user.email` in every worktree before the first commit; if it shows anything else, stop and tell the owner. End each commit message with the attribution line your harness gives you.
- PR #21 is never merged.

9. HOW TO WORK: CLAUDE CODE WORKFLOWS
The owner has asked each thread to orchestrate Claude Code workflows, so this brief authorizes you to run them. Load the `workflow-authoring` skill first. Use workflows for the freeze review (three parallel adversarial reviewers, then a consolidation agent), for merge checks (a verifier agent per queued PR running the checks in section 4), for the daily end-to-end run, and for triaging the owner's reports. Models: Claude Opus (`claude-opus-5-5`) for reviews and judgement; Claude Haiku for test runs and summaries. Give every subagent a complete brief and review its output before acting on it.

10. HARD RULES (no exceptions; subagents too)
- Headless only. Never move the real mouse, steal focus, raise windows or switch Spaces.
- Never print, log, hardcode, commit or bundle keys, tokens or `.env`. No real mail, addresses or tokens in a log, fixture, screenshot, digest or PR.
- Never send real external email. Automatic live checks use the agent test account only, under its rules; anything on the owner's main account is run by the owner by hand.
- Never copy Avec, Tatem, Notion, Redakt or any reference app's code, assets, wording or layouts.
- NEVER a sparkle, wand or star glyph for AI, anywhere.
- Groq is the default for every AI feature including transcription.
- The Google project stays in Testing mode; nothing that costs money.
- Nothing to main without the owner.

11. WHEN TO STOP AND ASK THE OWNER
When a decision has no default, when anything would touch main or need an owner-only action, when a lane must be cut or the release date moves by more than two days, or when two threads disagree on the contract and the Engine thread cannot settle it. Ask in plain English with options and a recommended default.

12. HOW THE OWNER REVIEWS (YOU RUN THE QUEUE)
The owner reviews per big feature, never per phase and never code. The five build threads run each feature's loop themselves. You lead no feature and own no lane. Your part is the queue, the checks around the merges and the decisions that cross threads.

THE LOOP, as the threads run it
a. The lead thread builds the feature with subagent workflows until it works end to end on demo mail or practice servers.
b. It posts a plain-English "ready to look at" message in its T3 thread: steps to try, which data, what changed, what is not done, screenshots in light and dark and a recording under 90 seconds. It adds a STATUS.md entry `READY-FOR-OWNER`.
c. The owner gives feedback. The thread iterates and re-posts visuals until the owner says "approved" or "looks good".
d. On approval the thread records the commit SHA of each lane branch and saves the approved screenshots and capture script outside the repo, adds `APPROVED`, then runs four deep review passes with agents that did not write the code: adversarial correctness, design conformance against `plans/DESIGN.md` and the mockups, tests and performance budgets, and a security review where relevant.
e. Each lane opens a PR from its `rv/<lane>/<slug>` branch into `revamp` with `gh pr create --attach` and waits for review comments. Automated reviewers such as Cubic may comment. Nobody re-triggers one after every fix; a thread requests at most one re-review.
f. The thread iterates on the comments.
g. Merge rule. If nothing user-visible changed materially since the approval snapshot (judged by an image diff against the saved screenshots and the behavior diff), the thread squash-merges into `revamp` itself, posts one line to the owner and adds `MERGED`. If something changed materially, it goes back to the owner with before and after visuals. If there is a cross-thread conflict, a contract change or a red `revamp`, it comes to you.

THE FEATURES AND THEIR LEADS (12 in this round; 9 and 10 are round 2)
1 Gmail sync and the first-sync screen (Providers: `prov-gov`, `prov-gmail`, first-sync slice of `ui-onboard`); 2 sidebar and app shell (UI-core: `ui-shell`); 3 Home and mail lists (UI-core: `ui-home`); 4 reader, reply and compose (UI-core: `ui-reader`); 5 onboarding and the weekly reconnect (UI-screens: `ui-onboard`, reconnect side of `prov-gov`); 6 Calendar (UI-screens: `ui-calendar`, `prov-cal`); 7 Ask, summaries and the command palette (UI-screens: `ui-ask`, `eng-ai`); 8 Settings (UI-screens: `ui-settings`); 9 iCloud and Fastmail (round 2); 10 Outlook (round 2); 11 menu-bar mode and background sync (Engine: `eng-host`); 12 sending, undo, scheduled send and Later (Engine: `eng-time`, `prov-gmail-write`); 13 the email safety frame (Engine: `eng-html`); 14 the aplos.email website (Platform and website: `web`). No owner review: `eng-contract`, `eng-store`, `eng-views`, `prov-emu`, `ui-foundation`, `plat-ci`, `plat-release`. Their PRs are dependency or infrastructure PRs and you merge them.

WHAT YOU DO
- Keep the queue. Read the `READY-FOR-OWNER`, `APPROVED` and `MERGED` entries. The daily digest lists what waits on the owner, oldest first, with a link to each ready post. Suggest an order (features 1 to 4 first) and offer to batch small features into one sitting.
- Merge dependency and infrastructure PRs after the checks in section 4. Refuse any feature PR that touches another lane's paths. Merge every `contract-change` PR yourself; a thread never self-merges one.
- After every feature merge by a thread, run the full suite, the conformance run and the owners check, and revert a red merge at once with a note to the thread. Check that every `MERGED` entry has an earlier `READY-FOR-OWNER` and `APPROVED` and a one-line note to the owner. If not, revert and tell the thread. Spot-check "nothing material changed" claims by comparing visuals yourself for Home, the reader, compose, onboarding and sending.
- Decide cross-thread conflicts and contract questions that threads send you. If the Engine thread cannot settle a contract disagreement, ask the owner.
- Approval on practice data is not live acceptance. Features 1, 9 and 10 stay "done pending live check" until the evidence file exists and the owner's days 14 to 16 hand checks pass.

RULES THAT NEVER BEND
- Only `revamp` merges are automatic. Main is only ever touched by the owner.
- Visuals are headless (Playwright's Electron support with `APLOS_TEST=1` and an isolated `APLOS_DATA_DIR`, or the thread's own dev server), show the app's own window only, are attached in T3 threads and PRs, are never committed or uploaded to a third-party host, and never show secrets, tokens, real addresses, real mail, personal data or other apps. Check this in every digest you write.
```

> **What this means:** The Integrator owns no features. It keeps the shared branch green, runs the freeze review and the joining phase, and is the one voice that reports to you every day.

## Launch checklist (for the orchestrator)

Do these in order once the owner says go.

1. **Settle the design.** Done on 2026-10-27: DESIGN.md is the Paper spec with every mockup revision folded in, and `mockups/` is on `revamp`.
2. **Align the plans if time allows.** Run the alignment pass from roadmap section 10 on plans 10-40, ARCHITECTURE.md and DESIGN.md. If it is not done yet, launch anyway: every brief says the roadmap wins.
3. **Commit and push `plans/` on `revamp`.** Every thread reads the plans from its own worktree.
4. **Check identity.** `git config user.email` is k@kainoa.me and the name is Kainoa Newton.
5. **Give each thread a worktree from `revamp`** on `rv/thread/engine`, `rv/thread/providers`, `rv/thread/ui-core`, `rv/thread/ui-screens`, `rv/thread/platform` and `rv/thread/integrator`. Lane branches (`rv/<lane>/<slug>`) sit beside them without conflict.
6. **Launch the Integrator and the Engine thread first, in the same hour.** The Integrator creates STATUS.md and OWNERS.md; the Engine thread starts the restructure.
7. **Then launch Providers, Platform and website, UI-core and UI-screens the same day.** Each does its Phase 0 preparation on new files only until the restructure lands.
8. **Tell the owner the day-1 tasks** from the roadmap's "What you need to do": adding the spare Gmail account to the test users, and the Vercel check. The design, the 6,000-unit check and the Groq test key were done on 2026-10-27. Tell the owner that features will arrive for review from about day 7, each with steps to try, screenshots and a recording, and that saying "approved" in a feature's thread starts its deep review and merge.
9. **Watch STATUS.md.** Expect, in order: NOTICE restructure started (day 1), the Providers port proposal and UI-screens gap list (day 2), FROZEN and the `contract-v1` tag (day 2-3), the Gmail emulator reproducing 0.2.3's failure (day 4), `eng-store`'s real commit (day 6), the first LANE-DONE entries (days 6-8), the first READY-FOR-OWNER posts (from about day 7), and the main screens on demo mail around day 9.

> **What this means:** Settle and fold the design first, push the plans, start the Integrator and Engine threads together, then the other four the same day, and give the owner the short list of free day-1 tasks.

## Decisions for you

The roadmap has no open decisions. N1 to N5 are answered in [00-roadmap.md](00-roadmap.md). These two are launch questions, and the default applies if you don't answer.

**1. Launch all six threads on day 1, or stagger them?** (a) All on day 1, with the Integrator and Engine first; (b) the four other threads on day 3, after the freeze. **Default is (a).** The others prepare practice servers, gap lists and the format and lint commits during Phase 0, which shortens the critical path by about two days. (b) saves some tokens but loses those days, and the contract freezes without the UI-screens gap list.

**2. Who starts the restructure on day 1?** (a) The Engine thread starts as soon as it launches; (b) it waits for your word. **Default is (a).** Nothing else is in flight on day 1, so there is nothing to pause. (b) only helps if you want to read the plan once more first.
