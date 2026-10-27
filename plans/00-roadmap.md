# Aplos revamp: the master roadmap

Written 2026-10-27 on branch `revamp` by the integrator, after the four workstream plans were critiqued, revised and reconciled with each other. Planning only: nothing here is implemented, nothing goes to main, PR #21 stays unmerged. This file is the one to read first. It schedules the work; the binding decisions live in `plans/ARCHITECTURE.md` (ARCH) and `plans/DESIGN.md` (DESIGN), and the detail lives in plans 10, 20, 30 and 40.

**Names used below.** Engine milestones are **E0-E8** (plan 10), provider milestones **PV0-PV11** (plan 20), UI milestones **U0-U9** (plan 30), platform milestones **Q0-Q8** (plan 40). ARCH's own milestones are **M0-M10**; plan 10 section 4.0 and plan 20 section 4 map them. "Week 0" is the 0.2.4 hotfix week; week 1 starts with the engine's file move.

## In plain English

Today Aplos cannot finish syncing a real Gmail account, keeps your whole mailbox in memory, stops when you close the window, and still looks and reads a little like Avec. The revamp fixes all of that in one coordinated push.

What you will have at the end: a calm, keyboard-first mail and calendar app that is clearly Aplos. Sky-blue around a paper letter, a serif voice for the AI, and one signature "carried off" motion when you finish an email. Gmail's inbox appears in seconds and fills in quietly within Google's limits. iCloud and Fastmail get new mail within seconds. Calendars stop losing meeting links. Mail keeps arriving with the window closed. Each email is shown in a sealed box that cannot track you. A 100,000-message mailbox feels like a 100-message one.

How long. About a week for a small Gmail fix (0.2.4). About six weeks for a Gmail app you can live in on the new engine (0.3.0). About fourteen weeks for the whole revamp, new screens included (0.4.0). If reviews and live checks run slow, plan on seventeen or eighteen. Google's own review of Aplos runs alongside and may take months; until it finishes, Gmail works for you and up to 100 invited testers.

How it runs. Three T3 Code threads work in parallel: one for the engine, one for providers and sync, one for the screens. Each runs Claude Code workflows, checks its own work with a second agent, and hands you something to try at each step. Nothing reaches main until you say so.

What only you can do: a handful of decisions (section 6), a few accounts and forms for Google, about two hours of Google paperwork, one short demo video, and hands-on checks where a machine cannot judge.

> **What this means:** A real Gmail fix in a week, a livable new engine in about six, the full new Aplos in about fourteen. You steer through a short list of decisions and checks.

## 1. What the new Aplos will be

Honest, concrete changes, in the order you will feel them:

- **0.2.4 (end of week 0 or early week 1).** Real Gmail finally finishes a first sync. Aplos paces itself under Google's 6,000-units-a-minute limit instead of being refused and starting over. It shows subjects first and downloads a conversation's text when you open it. It stops instead of hammering when Google says "daily limit", and it writes down exactly why Google refused anything. Old screens, old engine.
- **0.3.0 (about week 6).** A new engine under today's screens. Your mail lives in a real database that opens in milliseconds at any size. Restarts no longer reload everything. Closing the window keeps Aplos in the menu bar, so mail, reminders and scheduled sends keep working. The Gmail connection is rebuilt: inbox in seconds, the rest filled in quietly, and a "budget keeper" so several Macs never exceed Google's allowance together. The Avec-like wording is gone (U0), and the app's safety switches are on.
- **Between 0.3.0 and 0.4.0 (weeks 6-13), on beta builds you choose to install.** The new look arrives screen by screen, on real mail from about week 7. Then come the sealed email box, an AI queue that runs only after you agree, honest scheduled sends and undo, iCloud and Fastmail with instant new mail (about week 9), calendars that sync only what changed, a new onboarding window and an honest first-sync screen, and Outlook built but switched off until Microsoft gives Aplos an app ID.
- **0.4.0 (about week 14).** Everything together, after a seven-day stress run of the engine and your own seven-day "dogfood" week on the same build. This is the version that can go public, if you choose.

What does not change: no Aplos server holds your mail, Groq stays the default AI, and nothing syncs while the Mac sleeps.

> **What this means:** Each release is useful on its own. 0.2.4 makes Gmail work. 0.3.0 makes the engine solid. 0.4.0 makes Aplos look and feel like itself.

## 2. The execution threads

You asked for one UI thread and one or two architecture threads. The plan uses **three threads**: two architecture threads (ARCH section 15 calls them P and S) and one UI thread. Plan 40's platform work is split between the Engine thread (tooling, CI, security, releases) and the UI thread (website). No fourth thread runs unless the week-4 review says the Engine thread is behind (plan 10 Decision 11, plan 40 decision L).

Each thread is one long-lived T3 Code thread with its own worktree. It fans each milestone out into Claude Code work packages (one agent and worktree each), has every result checked by an agent that did not write it, and opens one pull request per milestone into `revamp` with evidence. Models follow your rule: Claude for all UI work (Opus for complex screens, Sonnet for routine ones), Opus for hard or security-sensitive work, cheaper models for searches, test runs and mechanical edits.

| Thread | ARCH name | Owns | Milestones (each mapped to exactly one thread) | Agent-days |
|---|---|---|---|---|
| **Engine** | P | Contract, store import and legacy bridge, live windows, email HTML, AI queue, outbox and timers, local doorway, hardening; plus tooling, CI, Electron hardening, releases, open-source readiness | **E0, E1, E2b, E3, E4, E5, E6, E7, E8**; **Q0-main, Q0, Q1a, Q1b, Q2, Q3, Q4, Q6, Q7a, Q7b, Q8** | about 97-126 |
| **Providers & Sync** | S | Store schema, governor, account actors, every provider adapter, emulators, OAuth readiness, Google verification engineering | **PV0** (and the 0.2.4 train), **E2a**, **PV1a, PV1b, PV2, PV3, PV4, PV5, PV6, PV7, PV8, PV9, PV10, PV11** | about 125-133 |
| **UI** | (UI) | Every screen, tokens, lint rules, the design skill, the screenshot harness, onboarding, and the website copy | **`srcdoc` slice** (ARCH M0 stopgap), **U0, U1, U2, U3, U4, U5, U6, U7, U8, U9**; **Q5A-main, Q5A, Q5B** | about 69-100 |

Why E2a sits on Providers & Sync: it is the store schema and write path that plan 20's Gmail rebuild (PV3) needs by the end of week 3, so the thread that consumes it builds it (plan 10 section 4.0). Everything else in plan 10 is the Engine thread's.

Agent-days are not the limit; your review time, live checks and Google's calendar are.

> **What this means:** Three parallel teams, each with a clear list. Engine builds the foundation and the safety and release machinery. Providers & Sync makes every mail service work. UI builds everything you see. Every milestone has exactly one owner.

## 3. One unified timeline

### 3.1 Week by week (nominal)

Weeks are elapsed time. "Owner" is what needs you that week; the calendar in section 5 has the full list.

| Week | Engine thread | Providers & Sync thread | UI thread | Releases and handoffs |
|---|---|---|---|---|
| **0** | E0 logger (2-3 d); Q0-main releases-home switch (1 d); Q1a prep (`format-merge.mjs`) | **PV0** Gmail fix on `hotfix/0.2.4` (5-7 d) | `srcdoc` slice (about 1 d); Q5A-main site truth and privacy page (1-2 d) | 0.2.4 train: PV0, plus E0, `srcdoc`, Q0-main and Q5A-main only if ready. Owner: decisions, domain, releases repo, 6,000-unit check |
| **1** | **Freeze window** (days 1-2): main merged, engine rename, Q1a format, contract skeleton, codemod, Q1b. Then E1 (resident mode, registry, fixture); Q0 rest; Q2 hardening; Q3 starts | PV0 live check and tail; PV1a Gmail emulator starts; joins E1 after the move | U0 trust fixes (from about 1.2); U1 foundations (from 1.5) | **0.2.4** tagged from main. **C0 contract preview** on E1 day 5. Owner: Production switch, Search Console, branding |
| **2** | E1 finishes; Q2; Q3 | **E2a** store schema and write path; PV1a | U0; U1 | **C1 contract freeze** (end of week 2): fixture engine, conformance suite, ports including `ProviderAdapter`. First beta (fuses and resident mode) |
| **3** | **E2b** importer, legacy bridge, bodies, search; E4 spikes; Q4; Q6 (CASA pack first) | **E2a hard date** (end of week 3); PV2 governor; **PV3** Gmail rebuild starts on a stub governor | U1 ends; **U2** typed client and data layer (from 2.5) | Store API handed to PV3 |
| **4** | E2b ends (4.5); **E3** live windows; E4 sealed email box; Q7a | PV2; PV3 | U2 ends; **U3** identity (from 3.5) | **Week-4 review** of thread load (extra thread or not) |
| **5** | E3; E4; E5 AI queue starts (5.5) | PV2 merges; PV3 live work; PV1b fakes as needed | U3 ends (5.5); serif look test; **U4** motion | Owner: PV3 live Gmail checks, demo video, scope justifications |
| **6** | **E3 acceptance** (about 6-6.5); E4; E5; **E6** outbox and timers | **PV3 Gmail daily-driver gate**; PV4 Gmail writes; PV6 IMAP and iCloud | U4; **U5** shell and Home | **0.3.0** (ARCH M3) tagged from main after you merge `revamp`. Google review submitted |
| **7** | E4 ends (7.5); E5 ends (7.5); E6; Q7b | PV4; PV6; PV7 JMAP; PV8 recurrence and CalDAV | U4 ends; **WP5.6 flip to the real engine** (6-7); **U8** onboarding (from 7); U6 reader (from 7.5) | Flip: "renderer on windows" report unblocks E8's clean-up |
| **8** | E6 ends; slack week (catch-up) | PV6; PV7; PV8; PV9 calendars; PV10 Outlook (dark) | U5 ends (8.5); U8; U6 | Owner: one real send with a mid-send kill (E6) |
| **9** | **E7** local doorway and diagnostics; Q5B handed to UI | **PV6 + PV7 multi-provider gate**; PV9; PV10 | U8 ends; U6; **U7** palette, Ask, Settings, Calendar | Owner: iCloud and Fastmail live; real Google onboarding check |
| **10** | E7; **E8** hardening starts; Q8 gate prep | PV9 and PV10 end; **PV11** hardening | U6 ends; U7; Q5B claims | CASA lab and fixes run (weeks 6-12) |
| **11** | E8 (rehearsal soak, faults, shim removal) | PV11 | U7 ends (11.5) | Engine's own work done (about 11.5) |
| **12** | E8 ends; Q8 | PV11 ends | **U9** clean-up, accessibility, performance (from 11.5) | **0.4.0 release candidate** cut (about 12.5) |
| **13** | Release soak on the candidate; Q8 checklist | Soak with real test accounts | Dogfood week; VoiceOver and IME checks | Owner: dogfood week, sleep and wake cycles, second-Mac update |
| **14** | Fixes only | Fixes only | Fixes only | **0.4.0** tagged from main after you merge `revamp` |

### 3.2 Critical path and handoff points

There are two critical chains. They meet at the 0.4.0 release candidate.

1. **Gmail on the new engine (to 0.3.0).** PV0 → freeze window → E1's move → **E2a by the end of week 3** → PV2 and PV3 → PV3's live Gmail gate (week 5-6) → 0.3.0. A slip in E2a is reported the same day, because it moves 0.3.0 one-for-one.
2. **The new screens (to 0.4.0).** Freeze window → **C1** (end of week 2) → U2 → U3 → U4 → U5 → **flip after E3** (week 6-7) → U8, U6 and U7 → U9 → shared release candidate → 0.4.0. This chain is the longest; the UI trails the engine by two to three weeks.

The calendar chain outside our control is Google's: domain, brand check, video, submission (week 6), CASA (weeks 6-12), approval (week 10-14 at best). It gates "strangers can sign in to Gmail without a warning", not 0.4.0.

| Handoff | When | From → to | What passes |
|---|---|---|---|
| 0.2.4 train | Week 0-1 | Providers & Sync → main | PV0, plus any ready slice (E0, `srcdoc`, Q0-main, Q5A-main); PV0 never waits |
| Freeze window | Week 1, days 1-2 | Engine → everyone | Step 0 merge main into `revamp`; rename and imports; Q1a format; contract skeleton; codemod (the only rewrite of renderer call sites); Q1b; then the `service.ts` split |
| C0 preview | E1 day 5 | Engine → UI | Method names, schemas, typed client, fixture serving three calls |
| C1 freeze | E1 day 10 (end of week 2) | Engine → UI and Providers | Full contract, fixture engine with every scenario, conformance suite, ports including `ProviderAdapter`, status vocabulary |
| E2a store | End of week 3 | Providers (E2a) → Providers (PV3) | Schema, `store.commit`, change log |
| E2b bridge | Week 4.5 | Engine → everyone | Today's screens and older providers running on the new database (reads and writes) |
| 0.3.0 | About week 6 | All → main | E1, E2a, E2b, PV3; today's screens on the bridge |
| E3 → flip | Weeks 6-7 | Engine → UI (WP5.6) | Real live windows pass the same tests as the fixture; dev builds switch by one flag |
| Flip → E8 | Week 7 | UI → Engine | "Renderer on windows" report; the old bridge can be removed in E8 |
| E4, E5, E6 | Weeks 7.5-8 | Engine → UI and Providers | Sealed frame (U6), real `Setup/*`, consent and demo calls (U8, by week 9), submissions and drafts (PV4, U6) |
| Release candidate | About week 12.5 | All → owner | One build for the engine soak and your dogfood week |

### 3.3 Release train

| Release | Week | Branch | Contents |
|---|---|---|---|
| **0.2.4** | 0-1 | `hotfix/0.2.4` → main | Gmail paced and lazy; plus ready slices |
| **0.3.0-beta.N** | 2 onward | tagged from `revamp` | Fuses, resident mode, the new engine as it lands; for you and invited testers only |
| **0.3.0** | about 6 | `revamp` merged → main | ARCH M3: new store, Gmail rebuild, U0 wording fixes, hardening |
| **0.3.x-beta.N** | 6-13 | tagged from `revamp` | New screens after the flip, providers as they pass; a stable 0.3.x only if you ask |
| **0.4.0** | about 14 | `revamp` merged → main | Everything; one candidate passed both the seven-day soak and the dogfood week |

### 3.4 Honest totals

- **Nominal: about 14 weeks** from the start of week 1 to 0.4.0, plus the 0.2.4 week before it.
- **Pessimistic: about 17-18 weeks.** That assumes about two days of review wait per milestone, one failed live check, a serif or motion rework, and the Engine thread running the 1.5 weeks late that plan 10 already allows for in weeks 4-8.
- **Gmail daily-driver:** week 5 nominal, week 6 likely. **iCloud and Fastmail:** about week 9 (ARCH says 8; plan 20's honest estimate is 9).
- **Google approval:** outside our control. Weeks 10-14 at best; could be months.
- **Total effort:** about 290-360 agent-days across the three threads.

> **What this means:** Two things set the pace. The Gmail chain decides 0.3.0, around week six. The screens chain decides 0.4.0, around week fourteen. Google's review runs on its own clock alongside. If things run slow, expect about seventeen weeks, not twenty-five.

## 4. Branch and merge strategy

**The branches.**

- **`main`** holds only released code. Only you merge into it. Stable releases (0.2.4, 0.3.0, 0.4.0) are tagged from main (RELEASING.md).
- **`hotfix/0.2.4`** is the one 0.2.4 train, cut from main at `72095ff` and owned by plan 20's PV0. Each slice is built on its own short branch from main and joins by pull request: `hotfix/0.2.4-gmail` (PV0), `hotfix/0.2.4-log` (E0), `hotfix/0.2.4-srcdoc` (UI), `hotfix/0.2.4-releases-home` (Q0-main), `hotfix/0.2.4-site` (Q5A-main). PV0 never waits for a slice. A slice that misses the train ships later, or lands only on `revamp`. The website slice may go to main on its own, because it changes no app code.
- **`revamp`** is the integration branch. Every work pull request targets it.
- **Work branches are `rv/<workstream>/<slug>`**: `rv/engine/...`, `rv/providers/...` and `rv/ui/...`. Examples: `rv/engine/e1-move`, `rv/providers/pv3-gmail`, `rv/ui/u3-identity`, `rv/engine/q1a-format`. Why not `revamp/...`: Git stores branches like folders, so a branch called `revamp` cannot also have branches "inside" it. The same rule applies one level down. **A branch name is never a folder of another**, so work packages are siblings with hyphens (`rv/engine/e1-wp1.1-move`), never `rv/engine/e1-move/wp1.1`.

**How work merges.**

- Each work package has its own git worktree. Work-package pull requests target their milestone branch. The milestone branch opens one pull request into `revamp` when its evidence is attached (test output, benchmarks, headless screenshots via `gh pr create --attach`, never committed).
- Mechanical commits (the rename, the format commit) merge by merge commit or fast-forward and are listed in `.git-blame-ignore-revs`. Everything else squashes.
- **Staying current.** After each main release, `revamp` absorbs main. Anything cut from main before the format commit comes back through plan 40's `scripts/audit/format-merge.mjs`. Each thread merges `revamp` into its open branch at each milestone start. Merges, not rebases, for long-lived branches.
- **The freeze window** (week 1, days 1-2, about 24 hours) is the only time the threads stop. Nothing else touches `src/engine`, `src/main`, `src/shared` or renderer call sites while it runs.
- **Review budget.** One review per milestone, batched, after local checks pass. Cubic is not re-triggered after every fix.
- **Commits** are authored as Kainoa Newton <k@kainoa.me>. Any other `git config user.email` is flagged before committing. PR #21 is never merged; the UI absorbs its screens by path in U8, and you close it as superseded.

**What goes to main, and when.**

| When | What | How |
|---|---|---|
| Week 0-1 | The 0.2.4 train | Pull request from `hotfix/0.2.4`; you merge and tag |
| About week 6 | 0.3.0 | You merge `revamp` into main; tag from main |
| Weeks 6-13 | Nothing, unless you ask for a stable 0.3.x | Urgent fixes for 0.3.0 users go on a `hotfix/0.3.x` branch off main, then back to `revamp` |
| About week 14 | 0.4.0 | You merge `revamp`; tag from main |

**Beta tags.** `vX.Y.Z-beta.N` may be cut from `revamp` with `scripts/release.mjs --allow-branch`. They are published as prereleases to the public releases repository, each on your go-ahead, and never touch the stable feed. Whether electron-updater 6.8.9 treats `-beta.N` as a prerelease is unverified and is checked in Q0.

**One release rule.** Until the UI flips to the real engine (week 6-7), screens that run only on the stand-in engine stay behind a development flag. Any beta or stable build before the flip, 0.3.0 included, uses today's screens on the legacy bridge. A release never shows demo mail in place of your mail.

> **What this means:** Work happens on clearly named side branches and lands on `revamp` one checked piece at a time. Main changes only three times, each when you say so: 0.2.4, 0.3.0 and 0.4.0. Betas let you try work in progress without risking the stable app.

## 5. Owner actions on a calendar

Most of these are minutes each. The Google ones have long waits, so they come first. Sources: plan 40 sections 4A and External prerequisites, plan 20 External prerequisites, ARCH External prerequisites, and each plan's owner-run checks.

| When | Action | Why, and what it unblocks | Source |
|---|---|---|---|
| **Day 1-2** | Answer the top decisions in section 6 (silence means the defaults) | Everything starts on the defaults | All |
| Day 1-2 | Pick a domain and point it at the website (decision M) | Google only accepts a privacy page on your own domain; starts the review clock | Plan 40 §4A row 1 |
| Day 1 | Create the public `aplos-mail-releases` repository and a fine-grained token, `RELEASES_REPO_TOKEN` (about 30 min) | Downloads and auto-update work for anyone while the code stays private | Plan 40 Q0 |
| Day 1 | Check which branch Vercel publishes as production | Decides whether site fixes must go to main | Plan 40 Q5A [U] |
| Week 0 | Confirm 6,000 units a minute per user in the Google Cloud console (10 min) | PV0's pacing assumes it | ARCH M0; plan 20 PV0 |
| Week 0-1 | Run PV0's live check on your own Gmail (local, by hand); merge the 0.2.4 train and tag it; publish the draft | 0.2.4 ships | Plan 20 PV0 |
| Week 1 | Switch the Google project from Testing to Production, unverified (ARCH Decision 2) | Ends 7-day token expiry; shows the "unverified" screen; caps new users at 100 | Plan 40 §4A row 4 |
| Week 1 | Verify the domain in Search Console; add it on the consent screen | Needed for the brand check | Plan 40 §4A row 2 |
| Week 1-2 | Consent-screen branding (name, final icon, contacts); a role contact address (decision I) | Brand verification (2-3 business days) | Plan 40 §4A rows 5-6 |
| Week 1 | Create a throwaway Gmail test account and a separate Groq key, stored as GitHub environment secrets (decision G); check your plan's CI minutes (decision H) | Nightly read-only checks without touching your mailbox or AI allowance | Plan 40 Q4 |
| Week 1 | Register a Microsoft Entra app (plan 20 Decision 2) | Outlook can be tested within a day; otherwise it stays dark | Plan 20 PV10 |
| Any time before inviting others | Request a Fastmail OAuth client | Fastmail sign-in for people other than you | Plan 20 |
| Week 1 | Close the lid for a minute on a packaged build | Checks wake handling (E1) | Plan 10 E1 |
| Week 3.5 | Serif look test (Newsreader against the system font; Newsreader if no answer in two days) | Locks the AI voice | Plan 30 U3; DESIGN Decision 3 |
| Week 5-6 | Live Gmail checks for PV3, with an agent beside you | The Gmail daily-driver gate | Plan 20 PV3 |
| Week 5-6 | Settle the filter permission (Decision 5 below); record the unlisted demo video from an agent's shot list; approve scope justifications | Nothing can change after submission | Plan 40 §4A row 7 |
| Week 6 | Submit Google's restricted-scope review; approve the 0.3.0 merge and tag; fill update-matrix rows on two Macs | Google's clock starts; 0.3.0 ships | Plan 40 §4A row 8; Q7a |
| Weeks 6-10 | Choose and pay a CASA lab; findings fixed by the threads (weeks 8-12) | Required for restricted Gmail scopes | Plan 40 §4A rows 9-10 |
| Week 7 | Feel the motion on a packaged build (U4); try the new screens on real mail after the flip | Only you can judge feel | Plan 30 |
| Week 7.5 | Hand-check keys with focus inside an email (packaged app) | Unknown until checked; a fallback exists | Plan 10 E4; plan 30 U6 |
| Week 8 | One real send to yourself, with a mid-send kill, on Gmail and iCloud | Proves no double send | Plan 10 E6 |
| Week 9 | iCloud and Fastmail live checks; connect a real Google account through the new onboarding | Multi-provider gate; onboarding honesty | Plan 20 PV6-PV7; plan 30 U8 |
| Weeks 12.5-13.5 | Dogfood week on the release candidate; sleep and battery cycles; VoiceOver and one IME check; 0.3.x → 0.4.0 update on the second Mac | The final gate | Plans 10 E8, 30 U9, 40 Q8 |
| Week 14 | Sign the release gate; merge `revamp`; tag and publish 0.4.0 | Release | Plan 40 Q8 |
| After 0.4.0 (your choice) | Licence, public history, contributor terms, public flip; professional name search first | Open source, if and when you want it | Plan 40 C-F, J; Q6, Q8 |
| Yearly | CASA renewal | Keeps Gmail verified | Plan 40 §4A row 12 |

Agents never drive visible windows, send external mail, change repository visibility, publish a release or rotate a credential. Those stay yours.

> **What this means:** The first two days matter most: a domain, a releases repository, and your answers. After that it is a handful of short checks, one video, and one week of using the release candidate as your real mail app.

## 6. Decisions for you

There are about seventy decisions across the six documents. Many repeat each other, so they are merged below. **If you do not answer, every recommended default applies**, and the plans already proceed on them. The ten that matter most come first; the rest are in one table.

### 6.1 The ten that matter most

**1. Ship the quick Gmail fix, 0.2.4, now?** (ARCH Decision 1; plan 20 Decision 7)
- Options: (a) yes, within a week; (b) no, wait for the rebuild.
- **Default: (a).** Real Gmail works this week, and we learn exactly why Google refuses anything.
- Consequence: (a) costs a few days of work the rebuild later replaces. If opening conversations turns out bigger than two days, 0.2.4 ships a smaller window instead (the newest 25 conversations with text). (b) means real Gmail waits about six weeks.

**2. Which domain hosts the website and privacy page?** (plan 40 decision M)
- Options: (a) a subdomain of a domain you already own; (b) a new domain for Aplos; (c) wait.
- **Default: (a).** It takes an hour and starts Google's review clock early.
- Consequence: (b) is a cleaner brand for a small yearly cost. (c) blocks Google verification entirely, so Gmail stays limited to listed testers.

**3. Move the Google project from Testing to Production (unverified) now?** (ARCH Decision 2)
- Options: (a) yes, in week 1; (b) wait for verification.
- **Default: (a).** It ends the forced reconnect every 7 days and unblocks the nightly checks.
- Consequence: (a) shows an "unverified app" screen and caps new users at 100. (b) keeps weekly reconnects for weeks or months.

**4. Start Google's review, and pay for the security check (CASA)?** (plan 20 Decision 1; plan 40 §4A)
- Options: (a) brand check now, full review submitted about week 6, about $540-$4,500 a year for CASA; (b) never verify, stay capped at 100 users; (c) try for a local-only exemption first.
- **Default: (a).**
- Consequence: (a) means strangers can eventually sign in without a warning. (b) suits a private app for you and a few testers. (c) has likely failed for others and may lose weeks.

**5. Keep the permission that lets Aplos create Gmail filters?** (plan 20 Decision 4; ARCH Decision 3)
- Options: (a) yes, so Block and "skip Inbox" rules keep working while your Mac sleeps; (b) ask per rule; (c) no, and drop that permission.
- **Default: (a).** Keep today's Gmail permission level and never ask for the broader "delete all your email" one.
- Consequence: (c) shrinks Google's review but means rules act only while Aplos runs. **This must be answered before about week 6**, because permissions freeze when the review is submitted.

**6. Where do downloads and updates come from while the code is private?** (ARCH Decision 11; plan 40 decision B)
- Options: (a) a separate public "releases only" repository; (b) make the code public now; (c) host files yourself.
- **Default: (a).**
- Consequence: (a) works for anyone and exposes no code; its name is permanent, because every installed copy remembers it. (b) exposes unaudited history. (c) costs money and plumbing.

**7. Which mailboxes may automatic live checks use?** (plan 20 Decision 3; plan 40 decision G)
- Options: (a) dedicated throwaway test accounts in the cloud for small read-only nightly checks, plus checks on your own account run by hand on your Mac; (b) only by hand on your Mac; (c) fakes only.
- **Default: (a).** Your real mailbox is never used in CI.
- Consequence: (a) notices a Google or Apple change within a day. (b) keeps all secrets off the cloud, but problems surface later. (c) can never catch a real-world change, and mocks never count as proof.

**8. How many threads?** (plan 40 decision L; plan 10 Decision 11)
- Options: (a) three: Engine, Providers & Sync, UI, revisited at the week-4 review; (b) four, with a separate platform and quality thread; (c) four, with an extra engine thread for the email box and local doorway.
- **Default: (a).**
- Consequence: (a) keeps merge traffic and your review load lowest. (b) or (c) finish some pieces about two weeks sooner, at the cost of more parallel reviews and more colliding edits.

**9. One big 0.4.0 around week 14, with betas in between?** (plan 30 Decisions 3 and 12; plan 10 Decision 9; this roadmap)
- Options: (a) the screens start on a stand-in engine in week 2, switch to the real one around week 6-7, and 0.4.0 ships once the engine soak and your dogfood week pass on one build (about week 14), with betas in between and a stable 0.3.x only if you ask; (b) ship 0.4.0 at week 11 with unfinished screens; (c) also ship stable 0.3.x releases as each engine piece lands.
- **Default: (a).**
- Consequence: (a) ships one coherent release. (b) is earlier but ships a half-new look. (c) gets features to stable users sooner but shows a half-changed design.

**10. The look: ink blue, and a serif voice for the AI?** (DESIGN Decisions 2 and 3; plan 30 Decision 2)
- Options: (a) ink blue `#0b5394`, and Newsreader for summaries and Ask after a one-day look test you judge at week 3.5; (b) keep today's blue; (c) no serif, mark AI by colour.
- **Default: (a).** If you do not answer the look test within two days, Newsreader is used.
- Consequence: (a) is the strongest "this is not Avec" signal. (b) leaves Aplos's main colour close to Avec's. Either choice is one token to change later.

### 6.2 Everything else (defaults apply)

| # | Question | Default | Source |
|---|---|---|---|
| 11 | May strangers download 0.2.4 before Google approves? | Yes, invite-only: Gmail for up to 100 listed testers; other mail for anyone | Plan 40 N |
| 12 | Register Microsoft now? | Yes, personal and work accounts; skip publisher verification for now | Plan 20 D2 |
| 13 | How much mail does the first sync fetch? | Newest 500 Inbox conversations and 30 days of Sent, then quiet backfill to 90 days | ARCH D4 |
| 14 | Menu-bar residency when the last window closes? | Yes, menu bar only (Dock icon goes); start hidden at login; ⌘Q quits fully | ARCH D5; plan 10 D1 |
| 15 | Warn on ⌘Q with scheduled sends or reminders waiting? | Yes, naming how many | Plan 10 D2 |
| 16 | A reminder came due while the Mac slept? | Fire on wake, saying "was due 9:00" | Plan 10 D3 |
| 17 | A scheduled send came due while the Mac was off? | Ask after 5 minutes' grace | ARCH D9 |
| 18 | How much message text stays on the Mac? | 90 days plus opened, starred or unread, capped at 2 GB | ARCH D6 |
| 19 | Encrypt the database beyond FileVault? | No | ARCH D7 |
| 20 | Remote images? | Blocked until allowed per message or sender | ARCH D8 |
| 21 | The old `aplos.db` after the move? | Kept until 0.4.0 is stable, then "Remove old copy" offered | Plan 10 D4 |
| 22 | If the database is damaged? | Stop, keep the damaged file, offer Export, Restore or Rebuild | Plan 10 D6 |
| 23 | Local doorway for tools on by default? | Off until "Allow tools on this Mac" | Plan 10 D5 |
| 24 | Ask 0.2.x users for AI consent again? | Yes, once, naming provider and model | Plan 10 D7 |
| 25 | Free Gemini keys and mail? | Never for mail until you mark the key as paid | Plan 10 D8 |
| 26 | Background AI per day? | 150,000 tokens, adjustable | ARCH D13 |
| 27 | If engine work runs long, what waits? | The sealed email box's tail (a safe stopgap exists), then the AI queue, then the doorway's extras | Plan 10 D10 |
| 28 | Background helper that syncs after ⌘Q? | Only if quitting-stops-sync becomes a daily annoyance or a phone needs it | ARCH D14 |
| 29 | Phone app? | Later, as a remote for your Mac; it does not work while every Mac sleeps | ARCH D10 |
| 30 | Hosted push relay? | Not now; revisit only with a phone | ARCH D15 |
| 31 | Unsubscribe? | One-click after you confirm, else email the sender, else open the page | Plan 20 D5 |
| 32 | Repeating-event edits? | "This event" and "all events" first; "this and following" a release later | Plan 20 D6 |
| 33 | Adopt Skypaper? | Yes | DESIGN D1 |
| 34 | Cool sky neutrals instead of warm greys? | Yes | DESIGN D4 |
| 35 | Reader top? | Sender and date line, then the big summary, then the subject | DESIGN D5 |
| 36 | Done on mail that still needs a reply? | Leaves Home, with a "Remind me if no reply" toast | DESIGN D6 |
| 37 | Where arrow keys triage? | Only on Home, in the reader and one-by-one | DESIGN D7 |
| 38 | Key hints? | Hidden until hover or ⌘, except Space; a "Show all key hints" setting | DESIGN D8 |
| 39 | Ask dock on first run? | Closed, then remembered | DESIGN D9 |
| 40 | ⌘K? | A real command palette; `/` for search | DESIGN D10 |
| 41 | Home focus letter height? | Fixed, 160 px, summary two lines on Home only | DESIGN D11 |
| 42 | Reader margin rail? | Yes | DESIGN D12 |
| 43 | Ship U0's wording fixes early? | Yes, with 0.3.0 (no interim palette) | Plan 30 D1 |
| 44 | PR #21? | Absorb its screens; you close it as superseded | Plan 30 D4 |
| 45 | Visual baselines? | A small golden set plus same-machine comparison | Plan 30 D5 |
| 46 | May the UI thread design small undrawn surfaces? | Yes, inside Skypaper; you read the copy at U7 and U8 | Plan 30 D6 |
| 47 | Tap versus hold on R and A? | Tap acts instantly; holding adds dictation; one 250 ms threshold | Plan 30 D7 |
| 48 | How you try each milestone? | A local packaged build | Plan 30 D8 |
| 49 | Dogfood week before main? | Yes, seven days | Plan 30 D9 |
| 50 | Onboarding look? | Separate small window, sky full-bleed under the title bar, one paper sheet with a 16 px margin; demo only from a small top-right button; empty fresh install (settled by your wishes; DESIGN 7.11 amended) | Plan 30 D10 |
| 51 | Open Aplos automatically after setup? | Yes, on a clean finish only; it waits whenever anything went wrong; you can always enter early | Plan 30 D11 |
| 52 | Reformat every file in one commit? | Yes, inside the week-1 freeze window | Plan 40 A |
| 53 | Licence? | GPL-3.0 for the app and engine, MIT for `packages/contract`; `UNLICENSED` until you choose | ARCH D12; plan 40 C |
| 54 | Public history? | A fresh, curated history; the private repository stays your archive | Plan 40 D |
| 55 | Contributor agreement? | DCO sign-off | Plan 40 E |
| 56 | When does the code go public? | With 0.4.0, after the audits pass | Plan 40 F |
| 57 | CI cost while private? | Linux for almost everything; Mac only on merges, tags and nightly | Plan 40 H |
| 58 | Published contact address? | A role address on your domain plus GitHub private reporting | Plan 40 I |
| 59 | Professional name search? | Yes, before going public | Plan 40 J |
| 60 | Drop unproven website claims? | Yes | Plan 40 K |

> **What this means:** Answer the first ten if you can; the first five are the most time-sensitive, because Google's calendar depends on them. Everything else has a sensible default and can be changed later.

## 7. Top risks, in plain English

1. **Google takes months.** Until approval, Gmail works for you and up to 100 invited testers behind a warning. *Mitigation:* domain, privacy page and evidence pack start in week 1; the review goes in at week 6; nothing else waits on approval.
2. **Your time is the real bottleneck.** Three threads produce faster than one person can review. *Mitigation:* one batched review per milestone, checklists written ahead, a week-4 pace review.
3. **The Gmail chain slips.** If the store schema (E2a) misses the end of week 3, 0.3.0 slips with it. *Mitigation:* E2a is small, sits on the thread that needs it, and a slip is reported the same day.
4. **The Engine thread is overloaded in weeks 4-8.** *Mitigation:* a fixed order for what waits (the email box's tail first), slack at week 8, and an optional fourth thread.
5. **The stand-in engine and the real one drift apart.** *Mitigation:* one test suite both must pass, and the switch to the real engine at week 6-7, not at the end.
6. **Moving mail into the new database loses or duplicates something.** *Mitigation:* the old file is never touched; the import resumes after a kill; property tests; a rollback drill on your real data.
7. **The first week's file move collides with the Gmail fix.** *Mitigation:* one 0.2.4 branch merged first, a format-aware merge helper, a 24-hour freeze window.
8. **Keys may not work with focus inside an email** (unverified). *Mitigation:* a hand check, and a fallback that relays only scrolling keys.
9. **A second cause hides behind the Gmail 403.** *Mitigation:* 0.2.4 logs Google's exact reason; the Gmail rebuild is accepted only on your real account.
10. **0.2.4 reaches testers while emails still render unsealed.** *Mitigation:* the `srcdoc` stopgap joins 0.2.4 if ready; if not, keep 0.2.4 to yourself until it or 0.3.0 ships.
11. **Going public exposes history or secrets.** *Mitigation:* a fresh curated history, secret scans of every branch, a provenance gate, no ritual secret rotation.
12. **Outlook cannot be tested** without a Microsoft registration. *Mitigation:* built against a faithful fake and kept switched off.

> **What this means:** The biggest risks are outside the code: Google's review and your review time. The plan starts the slow things first, puts a test or a fallback behind every technical risk, and says plainly what waits when time runs short.

## 8. Document map

| File | What it is for |
|---|---|
| `plans/00-roadmap.md` | This file: threads, the unified timeline, branches, your calendar, every decision in one place |
| `plans/ARCHITECTURE.md` | Binding engine architecture: storage, sync, governor, contract, security, ARCH's M0-M10 path; amendments AM-1 to AM-4 (section 16A) |
| `plans/DESIGN.md` | Binding design language (Skypaper), every screen, the keyboard map, voice, enforcement; 7.11-7.12 amended for your onboarding wishes |
| `plans/10-engine-foundation.md` | Engine thread plan: E0-E8, the contract and stand-in engine, the legacy bridge, the freeze window |
| `plans/20-providers-sync.md` | Providers & Sync plan: PV0-PV11, the 0.2.4 Gmail fix, the adapter port, emulators, live checks, Google verification engineering |
| `plans/30-ui-revamp.md` | UI thread plan: U0-U9, data layer, motion, mail frame, onboarding, accessibility and performance |
| `plans/40-platform-quality.md` | Platform plan: Q0-Q8, formatting, CI, hardening, releases, open-source readiness, the Google owner-action calendar |
| `plans/proposals/arch-*.md` | The three competing architecture proposals that ARCH chose between (superseded) |
| `plans/proposals/design-*.md` | The three competing design directions that DESIGN chose between (superseded) |
| `plans/_council/CONTEXT.md` | Shared facts that override research, owner rules, and the plain-English contract |
| `plans/_council/critic-*-sonnet.md` | Critiques of each workstream plan, with revision logs |
| `plans/_council/judge-*.md` | Independent judges' scorecards for the architecture and design choices |
| `plans/_council/task-*.md`, `run-critics.sh`, `*.log` | Briefs and run logs of the planning agents (process records only) |

> **What this means:** Read this roadmap first, then the plan for whichever thread you are checking on. ARCH and DESIGN are the rulebooks; the rest is history of how they were chosen.
