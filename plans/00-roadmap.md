# Aplos revamp: the roadmap

Written 2026-10-27 on branch `revamp`. This is a plan. Nothing in it is built yet, and nothing goes to main until you merge it.

Read down to the "Reference" heading. That takes about ten minutes. Everything after it is for the coding threads.

## In plain English

Today Aplos cannot finish syncing a real Gmail account. It keeps your whole mailbox in memory, it stops when you close the window, and some screens and wording still resemble Avec. The revamp fixes these problems in one coordinated push.

Three AI coding threads work at the same time. The Engine thread builds the new foundation. The Providers & Sync thread makes Gmail, iCloud, Fastmail, calendars and Outlook work. The UI thread builds every screen. A second agent checks each piece of work, and each thread gives you something to try at every step.

There are three releases. 0.2.4 fixes Gmail in about a week. 0.3.0 puts a new engine under today's screens in about six weeks. 0.4.0 adds the new look and everything else in about fourteen weeks, or seventeen to eighteen if reviews and live checks run slow. Google's review of Aplos runs alongside and may take months. Until Google approves, Gmail works for you and up to 100 invited testers.

Your part is eight decisions below, or the defaults if you don't answer. You also set up a few accounts and forms for Google, spend about two hours on Google paperwork, record one short demo video, and try each build by hand where a machine can't judge.

## What the new Aplos will be

- Gmail shows your inbox within seconds and downloads the rest in the background, inside Google's limits even across several Macs.
- iCloud and Fastmail deliver new mail within seconds.
- Calendars sync only what changed and keep meeting links.
- Your mail lives in a database on your Mac that opens in milliseconds, even with 100,000 messages. Restarts no longer reload everything.
- Closing the window leaves Aplos in the menu bar, so new mail, reminders and scheduled sends keep working. ⌘Q quits fully.
- Each email displays in a sealed frame that can't track you. Remote images stay blocked until you allow them for a message or sender.
- Background AI jobs run only after you agree. Groq stays the default.
- The new look is called Skypaper. The email is a paper sheet on a sky-blue background, with ink-blue accents, a serif font for AI text, and one "carried off" animation when you finish an email.
- ⌘K opens a real command palette, and a new onboarding window replaces today's setup.
- Outlook is built but stays switched off until you register an app with Microsoft.

Some things stay the same. No Aplos server holds your mail, and nothing syncs while the Mac sleeps.

## Timeline in plain words

Week 0 is the week of the Gmail fix. Week 1 starts the main work.

| When | Release | What you can try |
|---|---|---|
| End of week 0 or early week 1 | 0.2.4 | Your real Gmail finishes its first sync. The screens and engine are today's. |
| From week 2 | 0.3.0 betas | Early builds of the new engine, for you and invited testers only. Closing the window keeps Aplos in the menu bar. |
| About week 6 | 0.3.0 | Gmail as your daily mail app on the new engine, still with today's screens. |
| Weeks 6 to 13 | 0.3.x betas | The new look, screen by screen, on your real mail from about week 7. iCloud and Fastmail from about week 9. |
| About week 12.5 | Release candidate | One build you use as your only mail app for seven days. |
| About week 14 | 0.4.0 | Everything. This version can go public if you choose. |

If reviews and live checks run slow, 0.4.0 lands around week 17 or 18. Google's approval comes in weeks 10 to 14 at best, and it could take months. It decides when strangers can sign in to Gmail without a warning. It doesn't hold up 0.4.0.

## Top decisions

If you don't answer, the default applies and the threads proceed on it. Decisions 1 to 5 are the most urgent, because Google's calendar depends on them. The numbers match the rest of the plans. All 60 decisions, with their sources, are in section 6.

### 1. Ship the quick Gmail fix, 0.2.4, now?

- (a) Yes, within a week. This is the default.
- (b) No, wait about six weeks for the rebuild.

Option (a) costs a few days of work that the rebuild later replaces, and it logs exactly why Google refuses requests. If loading a conversation's text on open takes more than two days to build, 0.2.4 downloads text for only the newest 25 conversations instead.

### 2. Which domain hosts the website and privacy page?

- (a) A subdomain of a domain you already own. This is the default.
- (b) A new domain for Aplos.
- (c) Wait.

Google accepts a privacy page only on your own domain, so its review can't start without one. Option (a) takes an hour. Option (b) looks cleaner and costs a small yearly fee. Option (c) blocks Google verification, so Gmail stays limited to listed testers.

### 3. Switch the Google project from Testing to Production, unverified, in week 1?

- (a) Yes, in week 1. This is the default.
- (b) Wait for Google's approval.

Option (a) ends the forced Gmail reconnect every 7 days and lets the nightly checks run. Gmail sign-in then shows an "unverified app" screen, and Google caps new users at 100. Option (b) keeps the weekly reconnects for weeks or months.

### 4. Start Google's review, and pay for its security assessment?

- (a) Start the brand check now, submit the full review around week 6, and pay about $540 to $4,500 a year for the CASA security assessment. This is the default.
- (b) Never verify, and stay capped at 100 users.
- (c) Try for a local-only exemption first.

Option (a) lets strangers eventually sign in without a warning. Option (b) suits a private app for you and a few testers. Option (c) has likely failed for others and may lose weeks.

### 5. Keep the permission that lets Aplos create Gmail filters?

- (a) Yes, so Block and "skip Inbox" rules keep working while your Mac sleeps. This is the default. Aplos never asks for the broader permission that can delete all your email.
- (b) Ask per rule.
- (c) No, and drop that permission.

Option (c) shrinks Google's review, but rules then act only while Aplos runs. Answer this before about week 6, because the permissions can't change once the review is submitted.

### 6. Where do downloads and updates come from while the code is private?

- (a) A separate public repository that holds only releases. This is the default.
- (b) Make the code public now.
- (c) Host the files yourself.

Option (a) works for anyone and exposes no code. Its name is permanent, because every installed copy remembers it. Option (b) exposes history nobody has audited. Option (c) costs money and setup work.

### 7. Which mailboxes may the automatic live checks use?

- (a) Throwaway test accounts for small read-only checks in the cloud each night, plus checks on your own account that you run by hand on your Mac. This is the default.
- (b) Only checks you run by hand on your Mac.
- (c) Fakes only.

Your real mailbox is never used in the cloud. Option (a) catches a Google or Apple change within a day. Option (b) keeps all secrets off the cloud, but problems show up later. Option (c) can't catch a real-world change, and results from fakes never count as proof.

### 10. Ink blue, and a serif font for AI text?

- (a) Ink blue `#0b5394`, and the Newsreader serif for summaries and Ask, after a one-day look test you judge in week 3.5. This is the default.
- (b) Keep today's blue.
- (c) No serif, and mark AI text by colour instead.

Option (a) separates Aplos most clearly from Avec. Option (b) leaves the main colour close to Avec's. Either way, the colour or font is one setting to change later. If you don't judge the look test within two days, the threads use Newsreader.

Decisions 8 (three threads or four) and 9 (one big 0.4.0, with betas in between) and decisions 11 to 60 all have defaults in section 6.

## What you need to do, and when

Most items take minutes. Google's steps have long waits, so they come first.

- [ ] Day 1 or 2: answer the decisions above, or let the defaults stand.
- [ ] Day 1 or 2: pick a domain and point it at the website.
- [ ] Day 1: create the public `aplos-mail-releases` repository and a fine-grained token named `RELEASES_REPO_TOKEN`. This takes about 30 minutes.
- [ ] Day 1: check which branch Vercel publishes as production.
- [ ] Week 0: confirm in the Google Cloud console that the limit is 6,000 units a minute per user. This takes about 10 minutes.
- [ ] Week 0 or 1: run the live check on your own Gmail, then merge, tag and publish 0.2.4.
- [ ] Week 1: switch the Google project to Production, verify the domain in Search Console, and add it to the consent screen.
- [ ] Week 1: create a throwaway Gmail test account and a separate Groq key for the nightly checks, and register a Microsoft Entra app for Outlook.
- [ ] Week 1: close the lid for a minute on a packaged build.
- [ ] Week 1 or 2: fill in the consent-screen branding, with the name, final icon, contacts and a role contact address.

Later steps, which the threads will remind you about when they come up:

- [ ] Week 3.5: judge the serif look test.
- [ ] Week 6: submit Google's review, then merge and tag 0.3.0. Pay a CASA lab between weeks 6 and 10.
- [ ] Weeks 7 to 9: try the new screens on your real mail and run a few live checks by hand.
- [ ] Weeks 12.5 to 13.5: use the release candidate as your only mail app for a week.
- [ ] Week 14: sign off, merge `revamp`, and publish 0.4.0.

The full calendar, with every small check, is in section 5.

Agents never merge to main, publish a release, send external mail, change repository visibility or rotate a credential. Those stay with you.

## Top risks

- Google may take months. Until it approves, Gmail works only for you and up to 100 invited testers, behind a warning. The domain, privacy page and evidence pack start in week 1, the review goes in at week 6, and nothing else waits on approval.
- Three threads produce work faster than one person can review it. Each milestone gets one batched review with a checklist written ahead, and a week-4 review checks the pace.
- If the new mail database isn't ready by the end of week 3, 0.3.0 slips by the same amount. The thread that needs it builds it and reports any slip the same day.
- Moving your mail into the new database could lose or duplicate messages. The import never touches the old file, resumes after a crash, and gets a rollback rehearsal on your real data.
- 0.2.4 could reach testers before emails display in the sealed frame. If the stopgap misses 0.2.4, keep 0.2.4 to yourself until the stopgap or 0.3.0 ships.

Section 7 lists all twelve risks.

---

# Reference

Everything below is reference. You don't need to read it.

The integrator wrote this roadmap after the four workstream plans were critiqued, revised and reconciled with each other. PR #21 stays unmerged. This file schedules the work. The binding decisions live in `plans/ARCHITECTURE.md` (ARCH) and `plans/DESIGN.md` (DESIGN), and the detail lives in plans 10, 20, 30 and 40. Section numbers match the references in the other plans.

**Names used below.** Engine milestones are E0-E8 (plan 10), provider milestones PV0-PV11 (plan 20), UI milestones U0-U9 (plan 30), and platform milestones Q0-Q8 (plan 40). ARCH's own milestones are M0-M10, and plan 10 section 4.0 and plan 20 section 4 map them. Week 0 is the 0.2.4 hotfix week. Week 1 starts with the engine's file move.

## 1. What each release contains

- **0.2.4, end of week 0 or early week 1.** Real Gmail finishes a first sync. Aplos paces itself under Google's limit of 6,000 units a minute, so Google stops refusing it and making it start over. It downloads subjects first and fetches a conversation's text when you open it. When Google reports the daily limit, Aplos stops instead of retrying, and it logs Google's exact reason for any refusal. The screens and engine stay as they are.
- **0.3.0, about week 6.** A new engine runs under today's screens. Mail lives in a real database that opens in milliseconds at any size, and restarts no longer reload everything. Closing the window keeps Aplos in the menu bar, so mail, reminders and scheduled sends keep working. The rebuilt Gmail connection shows the inbox in seconds and fills in the rest in the background. A shared budget keeps several Macs within Google's allowance together. U0 removes the Avec-like wording, and Electron's security fuses are on.
- **Weeks 6-13, on beta builds you choose to install.** The new look arrives screen by screen, on real mail from about week 7. Then come the sealed email frame, an AI queue that runs only after you agree, scheduled sends and undo that never send twice, iCloud and Fastmail with instant new mail (about week 9), calendars that sync only what changed, a new onboarding window with an accurate first-sync screen, and Outlook, built but switched off until Microsoft gives Aplos an app ID.
- **0.4.0, about week 14.** Everything together, after a seven-day stress run of the engine and your own seven-day dogfood week on the same build.

No Aplos server holds your mail, Groq stays the default AI, and nothing syncs while the Mac sleeps.

## 2. The execution threads

You asked for one UI thread and one or two architecture threads. The plan uses three threads, two for architecture (ARCH section 15 calls them P and S) and one for the UI. Plan 40's platform work is split between the Engine thread (tooling, CI, security, releases) and the UI thread (website). A fourth thread runs only if the week-4 review finds the Engine thread behind (plan 10 Decision 11, plan 40 decision L).

Each thread is one long-lived T3 Code thread with its own worktree. It splits each milestone into Claude Code work packages, each with one agent and one worktree. An agent that did not write a result checks it. Each milestone opens one pull request into `revamp` with evidence attached. Models follow your rule. Claude does all UI work (Opus for complex screens, Sonnet for routine ones), Opus does hard or security-sensitive work, and cheaper models do searches, test runs and mechanical edits.

| Thread | ARCH name | Owns | Milestones (each mapped to exactly one thread) | Agent-days |
|---|---|---|---|---|
| Engine | P | Contract, store import and legacy bridge, live windows, email HTML, AI queue, outbox and timers, local doorway, hardening; plus tooling, CI, Electron hardening, releases, open-source readiness | E0, E1, E2b, E3, E4, E5, E6, E7, E8; Q0-main, Q0, Q1a, Q1b, Q2, Q3, Q4, Q6, Q7a, Q7b, Q8 | about 97-126 |
| Providers & Sync | S | Store schema, governor, account actors, every provider adapter, emulators, OAuth readiness, Google verification engineering | PV0 (and the 0.2.4 train), E2a, PV1a, PV1b, PV2, PV3, PV4, PV5, PV6, PV7, PV8, PV9, PV10, PV11 | about 125-133 |
| UI | (UI) | Every screen, tokens, lint rules, the design skill, the screenshot harness, onboarding, and the website copy | `srcdoc` slice (ARCH M0 stopgap), U0, U1, U2, U3, U4, U5, U6, U7, U8, U9; Q5A-main, Q5A, Q5B | about 69-100 |

E2a sits on Providers & Sync because it is the store schema and write path that plan 20's Gmail rebuild (PV3) needs by the end of week 3. The thread that uses it builds it (plan 10 section 4.0). Everything else in plan 10 belongs to the Engine thread.

Agent-days are not the limit. Your review time, the live checks and Google's calendar are.

## 3. One unified timeline

### 3.1 Week by week (nominal)

Weeks are elapsed time. "Owner" is what needs you that week. Section 5 has the full list.

| Week | Engine thread | Providers & Sync thread | UI thread | Releases and handoffs |
|---|---|---|---|---|
| **0** | E0 logger (2-3 d); Q0-main releases-home switch (1 d); Q1a prep (`format-merge.mjs`) | **PV0** Gmail fix on `hotfix/0.2.4` (5-7 d) | `srcdoc` slice (about 1 d); Q5A-main site truth and privacy page (1-2 d) | 0.2.4 train: PV0, plus E0, `srcdoc`, Q0-main and Q5A-main only if ready. Owner: decisions, domain, releases repo, 6,000-unit check |
| **1** | **Freeze window** (days 1-2): main merged, engine rename, Q1a format, contract skeleton, codemod, Q1b. Then E1 (resident mode, registry, fixture); Q0 rest; Q2 hardening; Q3 starts | PV0 live check and tail; PV1a Gmail emulator starts; joins E1 after the move | U0 trust fixes (from about 1.2); U1 foundations (from 1.5) | **0.2.4** tagged from main. **C0 contract preview** on E1 day 5. Owner: Production switch, Search Console, branding |
| **2** | E1 finishes; Q2; Q3 | **E2a** store schema and write path; PV1a | U0; U1 | **C1 contract freeze** (end of week 2): fixture engine, conformance suite, ports including `ProviderAdapter`. First beta (fuses and resident mode) |
| **3** | **E2b** importer, legacy bridge, bodies, search; E4 spikes; Q4; Q6 (CASA pack first) | **E2a hard date** (end of week 3); PV2 governor; **PV3** Gmail rebuild starts on a stub governor | U1 ends; **U2** typed client and data layer (from 2.5) | Store API handed to PV3 |
| **4** | E2b ends (4.5); **E3** live windows; E4 sealed email box; Q7a | PV2; PV3 | U2 ends; **U3** identity (from 3.5) | **Week-4 review** of thread load (extra thread or not) |
| **5** | E3; E4; E5 AI queue starts (5.5) | PV2 merges; PV3 live work; PV1b fakes as needed | U3 ends (5.5); serif look test; **U4** motion | Owner: PV3 live Gmail checks, demo video, scope justifications |
| **6** | **E3 acceptance** (about 6-6.5); E4; E5; **E6** outbox and timers | **PV3 Gmail daily-driver gate**; PV4 Gmail writes; PV6 IMAP and iCloud | U4; **U5** shell and Home | **0.3.0** (ARCH M3) tagged from main after you merge `revamp`. Google review submitted |
| **7** | E4 ends (7.5); E5 ends (7.5); E6; Q7b | PV4; PV6; PV7 JMAP; PV8 recurrence and CalDAV | U4 ends; **WP5.6 flip to the real engine** (6-7); **U8** onboarding (from 7); U6 reader (from 7.5) | Flip: the "renderer on windows" report unblocks E8's clean-up |
| **8** | E6 ends; slack week (catch-up) | PV6; PV7; PV8; PV9 calendars; PV10 Outlook (dark) | U5 ends (8.5); U8; U6 | Owner: one real send with a mid-send kill (E6) |
| **9** | **E7** local doorway and diagnostics; Q5B handed to UI | **PV6 + PV7 multi-provider gate**; PV9; PV10 | U8 ends; U6; **U7** palette, Ask, Settings, Calendar | Owner: iCloud and Fastmail live; real Google onboarding check |
| **10** | E7; **E8** hardening starts; Q8 gate prep | PV9 and PV10 end; **PV11** hardening | U6 ends; U7; Q5B claims | CASA lab and fixes run (weeks 6-12) |
| **11** | E8 (rehearsal soak, faults, shim removal) | PV11 | U7 ends (11.5) | Engine's own work done (about 11.5) |
| **12** | E8 ends; Q8 | PV11 ends | **U9** clean-up, accessibility, performance (from 11.5) | **0.4.0 release candidate** cut (about 12.5) |
| **13** | Release soak on the candidate; Q8 checklist | Soak with real test accounts | Dogfood week; VoiceOver and IME checks | Owner: dogfood week, sleep and wake cycles, second-Mac update |
| **14** | Fixes only | Fixes only | Fixes only | **0.4.0** tagged from main after you merge `revamp` |

### 3.2 Critical path and handoff points

There are two critical chains. They meet at the 0.4.0 release candidate.

1. **Gmail on the new engine, to 0.3.0.** The chain runs PV0, the freeze window, E1's move, E2a by the end of week 3, PV2 and PV3, PV3's live Gmail gate (week 5-6), and then 0.3.0. A slip in E2a moves 0.3.0 by the same amount, so the thread reports it the same day.
2. **The new screens, to 0.4.0.** The chain runs the freeze window, C1 (end of week 2), U2, U3, U4, U5, the flip after E3 (week 6-7), U8, U6 and U7, U9, the shared release candidate, and then 0.4.0. This chain is the longest. The UI trails the engine by two to three weeks.

Google's calendar is outside our control. It runs through the domain, the brand check, the video, submission (week 6), CASA (weeks 6-12) and approval (week 10-14 at best). It decides when strangers can sign in to Gmail without a warning. It does not gate 0.4.0.

| Handoff | When | From and to | What passes |
|---|---|---|---|
| 0.2.4 train | Week 0-1 | Providers & Sync to main | PV0, plus any ready slice (E0, `srcdoc`, Q0-main, Q5A-main); PV0 never waits |
| Freeze window | Week 1, days 1-2 | Engine to everyone | Step 0 merges main into `revamp`; rename and imports; Q1a format; contract skeleton; codemod (the only rewrite of renderer call sites); Q1b; then the `service.ts` split |
| C0 preview | E1 day 5 | Engine to UI | Method names, schemas, typed client, fixture serving three calls |
| C1 freeze | E1 day 10 (end of week 2) | Engine to UI and Providers | Full contract, fixture engine with every scenario, conformance suite, ports including `ProviderAdapter`, status vocabulary |
| E2a store | End of week 3 | Providers (E2a) to Providers (PV3) | Schema, `store.commit`, change log |
| E2b bridge | Week 4.5 | Engine to everyone | Today's screens and older providers running on the new database (reads and writes) |
| 0.3.0 | About week 6 | All to main | E1, E2a, E2b, PV3; today's screens on the bridge |
| E3 to flip | Weeks 6-7 | Engine to UI (WP5.6) | Real live windows pass the same tests as the fixture; dev builds switch by one flag |
| Flip to E8 | Week 7 | UI to Engine | "Renderer on windows" report; E8 can remove the old bridge |
| E4, E5, E6 | Weeks 7.5-8 | Engine to UI and Providers | Sealed frame (U6), real `Setup/*`, consent and demo calls (U8, by week 9), submissions and drafts (PV4, U6) |
| Release candidate | About week 12.5 | All to owner | One build for the engine soak and your dogfood week |

### 3.3 Release train

| Release | Week | Branch | Contents |
|---|---|---|---|
| 0.2.4 | 0-1 | `hotfix/0.2.4`, merged to main | Gmail paced and lazy; plus ready slices |
| 0.3.0-beta.N | 2 onward | tagged from `revamp` | Fuses, resident mode, the new engine as it lands; for you and invited testers only |
| 0.3.0 | about 6 | `revamp` merged to main | ARCH M3: new store, Gmail rebuild, U0 wording fixes, hardening |
| 0.3.x-beta.N | 6-13 | tagged from `revamp` | New screens after the flip, providers as they pass; a stable 0.3.x only if you ask |
| 0.4.0 | about 14 | `revamp` merged to main | Everything; one candidate passed both the seven-day soak and the dogfood week |

### 3.4 Totals

- The nominal plan takes about 14 weeks from the start of week 1 to 0.4.0, plus the 0.2.4 week before it.
- The pessimistic plan takes about 17-18 weeks. It assumes about two days of review wait per milestone, one failed live check, a serif or motion rework, and the Engine thread running 1.5 weeks late in weeks 4-8, which plan 10 already allows for.
- Gmail becomes a daily driver in week 5 nominally, and likely week 6. iCloud and Fastmail arrive about week 9 (ARCH says 8; plan 20's estimate is 9).
- Google approval is outside our control. It comes in weeks 10-14 at best and could take months.
- Total effort is about 290-360 agent-days across the three threads.

## 4. Branch and merge strategy

**The branches.**

- `main` holds only released code. Only you merge into it. Stable releases (0.2.4, 0.3.0, 0.4.0) are tagged from main (RELEASING.md).
- `hotfix/0.2.4` is the one 0.2.4 train, cut from main at `72095ff` and owned by plan 20's PV0. Each slice is built on its own short branch from main and joins by pull request. The slices are `hotfix/0.2.4-gmail` (PV0), `hotfix/0.2.4-log` (E0), `hotfix/0.2.4-srcdoc` (UI), `hotfix/0.2.4-releases-home` (Q0-main) and `hotfix/0.2.4-site` (Q5A-main). PV0 never waits for a slice. A slice that misses the train ships later or lands only on `revamp`. The website slice may go to main on its own, because it changes no app code.
- `revamp` is the integration branch. Every work pull request targets it.
- Work branches are `rv/<workstream>/<slug>`, meaning `rv/engine/...`, `rv/providers/...` and `rv/ui/...`. Examples are `rv/engine/e1-move`, `rv/providers/pv3-gmail`, `rv/ui/u3-identity` and `rv/engine/q1a-format`. The prefix is not `revamp/...` because Git stores branches like folders, so a branch called `revamp` cannot also have branches inside it. The same rule applies one level down. A branch name is never a folder of another, so work packages are siblings with hyphens (`rv/engine/e1-wp1.1-move`), never `rv/engine/e1-move/wp1.1`.

**How work merges.**

- Each work package has its own git worktree. Work-package pull requests target their milestone branch. The milestone branch opens one pull request into `revamp` once its evidence is attached. Evidence means test output, benchmarks, and headless screenshots attached with `gh pr create --attach`, never committed.
- Mechanical commits (the rename, the format commit) merge by merge commit or fast-forward and are listed in `.git-blame-ignore-revs`. Everything else squashes.
- After each main release, `revamp` absorbs main. Anything cut from main before the format commit comes back through plan 40's `scripts/audit/format-merge.mjs`. Each thread merges `revamp` into its open branch at the start of each milestone. Long-lived branches use merges, not rebases.
- The freeze window (week 1, days 1-2, about 24 hours) is the only time the threads stop. Nothing else touches `src/engine`, `src/main`, `src/shared` or renderer call sites while it runs.
- Each milestone gets one batched review after local checks pass. Nobody re-triggers Cubic after every fix.
- Commits are authored as Kainoa Newton <k@kainoa.me>. Threads flag any other `git config user.email` before committing. PR #21 is never merged. The UI absorbs its screens by path in U8, and you close it as superseded.

**What goes to main, and when.**

| When | What | How |
|---|---|---|
| Week 0-1 | The 0.2.4 train | Pull request from `hotfix/0.2.4`; you merge and tag |
| About week 6 | 0.3.0 | You merge `revamp` into main; tag from main |
| Weeks 6-13 | Nothing, unless you ask for a stable 0.3.x | Urgent fixes for 0.3.0 users go on a `hotfix/0.3.x` branch off main, then back to `revamp` |
| About week 14 | 0.4.0 | You merge `revamp`; tag from main |

**Beta tags.** Threads may cut `vX.Y.Z-beta.N` tags from `revamp` with `scripts/release.mjs --allow-branch`. Each one goes to the public releases repository as a prerelease, only on your go-ahead, and never touches the stable feed. Nobody has verified whether electron-updater 6.8.9 treats `-beta.N` as a prerelease. Q0 checks it.

**One release rule.** Until the UI flips to the real engine (week 6-7), screens that run only on the stand-in engine stay behind a development flag. Any beta or stable build before the flip, 0.3.0 included, uses today's screens on the legacy bridge. A release never shows demo mail in place of your mail.

> **What this means:** Main changes only three times, each when you merge: 0.2.4, 0.3.0 and 0.4.0. Betas let you try work in progress without touching the stable app.

## 5. Owner actions, full calendar

The checklist near the top is the short version. This table adds why each action matters and where it comes from. Sources are plan 40 sections 4A and External prerequisites, plan 20 External prerequisites, ARCH External prerequisites, and each plan's owner-run checks.

| When | Action | Why, and what it unblocks | Source |
|---|---|---|---|
| Day 1-2 | Answer the top decisions (silence means the defaults) | Everything starts on the defaults | All |
| Day 1-2 | Pick a domain and point it at the website (decision 2, plan 40 decision M) | Google only accepts a privacy page on your own domain; starts the review clock | Plan 40 §4A row 1 |
| Day 1 | Create the public `aplos-mail-releases` repository and a fine-grained token, `RELEASES_REPO_TOKEN` (about 30 min) | Downloads and auto-update work for anyone while the code stays private | Plan 40 Q0 |
| Day 1 | Check which branch Vercel publishes as production | Decides whether site fixes must go to main | Plan 40 Q5A [U] |
| Week 0 | Confirm 6,000 units a minute per user in the Google Cloud console (10 min) | PV0's pacing assumes it | ARCH M0; plan 20 PV0 |
| Week 0-1 | Run PV0's live check on your own Gmail (local, by hand); merge the 0.2.4 train and tag it; publish the draft | 0.2.4 ships | Plan 20 PV0 |
| Week 1 | Switch the Google project from Testing to Production, unverified (ARCH Decision 2) | Ends 7-day token expiry; shows the "unverified" screen; caps new users at 100 | Plan 40 §4A row 4 |
| Week 1 | Verify the domain in Search Console; add it on the consent screen | Needed for the brand check | Plan 40 §4A row 2 |
| Week 1-2 | Consent-screen branding (name, final icon, contacts); a role contact address (plan 40 decision I) | Brand verification (2-3 business days) | Plan 40 §4A rows 5-6 |
| Week 1 | Create a throwaway Gmail test account and a separate Groq key, stored as GitHub environment secrets (plan 40 decision G); check your plan's CI minutes (plan 40 decision H) | Nightly read-only checks without touching your mailbox or AI allowance | Plan 40 Q4 |
| Week 1 | Register a Microsoft Entra app (plan 20 Decision 2) | Outlook can be tested within a day; otherwise it stays dark | Plan 20 PV10 |
| Any time before inviting others | Request a Fastmail OAuth client | Fastmail sign-in for people other than you | Plan 20 |
| Week 1 | Close the lid for a minute on a packaged build | Checks wake handling (E1) | Plan 10 E1 |
| Week 3.5 | Serif look test (Newsreader against the system font; Newsreader if no answer in two days) | Locks the AI voice | Plan 30 U3; DESIGN Decision 3 |
| Week 5-6 | Live Gmail checks for PV3, with an agent beside you | The Gmail daily-driver gate | Plan 20 PV3 |
| Week 5-6 | Settle the filter permission (decision 5); record the unlisted demo video from an agent's shot list; approve scope justifications | Nothing can change after submission | Plan 40 §4A row 7 |
| Week 6 | Submit Google's restricted-scope review; approve the 0.3.0 merge and tag; fill update-matrix rows on two Macs | Google's clock starts; 0.3.0 ships | Plan 40 §4A row 8; Q7a |
| Weeks 6-10 | Choose and pay a CASA lab; the threads fix its findings (weeks 8-12) | Required for restricted Gmail scopes | Plan 40 §4A rows 9-10 |
| Week 7 | Feel the motion on a packaged build (U4); try the new screens on real mail after the flip | Only you can judge feel | Plan 30 |
| Week 7.5 | Hand-check keys with focus inside an email (packaged app) | Unknown until checked; a fallback exists | Plan 10 E4; plan 30 U6 |
| Week 8 | One real send to yourself, with a mid-send kill, on Gmail and iCloud | Proves no double send | Plan 10 E6 |
| Week 9 | iCloud and Fastmail live checks; connect a real Google account through the new onboarding | Multi-provider gate; onboarding honesty | Plan 20 PV6-PV7; plan 30 U8 |
| Weeks 12.5-13.5 | Dogfood week on the release candidate; sleep and battery cycles; VoiceOver and one IME check; update from 0.3.x to 0.4.0 on the second Mac | The final gate | Plans 10 E8, 30 U9, 40 Q8 |
| Week 14 | Sign the release gate; merge `revamp`; tag and publish 0.4.0 | Release | Plan 40 Q8 |
| After 0.4.0 (your choice) | Licence, public history, contributor terms, public flip; professional name search first | Open source, if and when you want it | Plan 40 C-F, J; Q6, Q8 |
| Yearly | CASA renewal | Keeps Gmail verified | Plan 40 §4A row 12 |

Agents never drive visible windows, send external mail, change repository visibility, publish a release or rotate a credential.

## 6. Decisions for you

The six documents hold about seventy decisions. Many repeat each other, so this section merges them. If you do not answer, every recommended default applies, and the plans already proceed on them. The top part of this file explains decisions 1-7 and 10 in full.

### 6.1 Decisions 1-10

| # | Question | Default | Source |
|---|---|---|---|
| 1 | Ship the quick Gmail fix, 0.2.4, now? | Yes, within a week | ARCH Decision 1; plan 20 Decision 7 |
| 2 | Which domain hosts the website and privacy page? | A subdomain of a domain you already own | Plan 40 decision M |
| 3 | Move the Google project from Testing to Production (unverified) now? | Yes, in week 1 | ARCH Decision 2 |
| 4 | Start Google's review, and pay for CASA? | Brand check now, full review about week 6, about $540-$4,500 a year for CASA | Plan 20 Decision 1; plan 40 §4A |
| 5 | Keep the permission that lets Aplos create Gmail filters? | Yes; keep today's Gmail permission level and never ask for the broader "delete all your email" one. Answer before about week 6 | Plan 20 Decision 4; ARCH Decision 3 |
| 6 | Where do downloads and updates come from while the code is private? | A separate public releases-only repository | ARCH Decision 11; plan 40 decision B |
| 7 | Which mailboxes may automatic live checks use? | Throwaway test accounts in the cloud for small read-only nightly checks, plus owner-run checks on your own account; your real mailbox is never used in CI | Plan 20 Decision 3; plan 40 decision G |
| 8 | How many threads? | Three (Engine, Providers & Sync, UI), revisited at the week-4 review | Plan 40 decision L; plan 10 Decision 11 |
| 9 | One big 0.4.0 around week 14, with betas in between? | Yes | Plan 30 Decisions 3 and 12; plan 10 Decision 9; this roadmap |
| 10 | The look: ink blue, and a serif voice for the AI? | Ink blue `#0b5394`, and Newsreader for summaries and Ask after a one-day look test at week 3.5; Newsreader if no answer within two days | DESIGN Decisions 2 and 3; plan 30 Decision 2 |

**Decision 8, how many threads.** The options are (a) three threads, revisited at the week-4 review, (b) four, with a separate platform and quality thread, or (c) four, with an extra engine thread for the email box and local doorway. Option (a) keeps merge traffic and your review load lowest. Options (b) and (c) finish some pieces about two weeks sooner, at the cost of more parallel reviews and more colliding edits.

**Decision 9, one big 0.4.0.** In option (a), the screens start on a stand-in engine in week 2 and switch to the real one around week 6-7. 0.4.0 ships once the engine soak and your dogfood week pass on one build, about week 14, with betas in between and a stable 0.3.x only if you ask. Option (b) ships 0.4.0 at week 11 with unfinished screens. Option (c) also ships stable 0.3.x releases as each engine piece lands. Option (a) ships one coherent release. Option (b) is earlier but ships a half-new look. Option (c) gets features to stable users sooner but shows a half-changed design.

### 6.2 Decisions 11-60 (defaults apply)

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

## 7. All risks

| # | Risk | What the plan does about it |
|---|---|---|
| 1 | Google takes months. Until approval, Gmail works for you and up to 100 invited testers behind a warning. | The domain, privacy page and evidence pack start in week 1; the review goes in at week 6; nothing else waits on approval. |
| 2 | Your time is the real limit. Three threads produce faster than one person can review. | One batched review per milestone, checklists written ahead, a week-4 pace review. |
| 3 | The Gmail chain slips. If the store schema (E2a) misses the end of week 3, 0.3.0 slips with it. | E2a is small and sits on the thread that needs it, and that thread reports a slip the same day. |
| 4 | The Engine thread is overloaded in weeks 4-8. | A fixed order for what waits (the email box's tail first), slack at week 8, and an optional fourth thread. |
| 5 | The stand-in engine and the real one drift apart. | One test suite both must pass, and the switch to the real engine at week 6-7, not at the end. |
| 6 | Moving mail into the new database loses or duplicates something. | The import never touches the old file and resumes after a kill; property tests; a rollback drill on your real data. |
| 7 | The first week's file move collides with the Gmail fix. | One 0.2.4 branch merged first, a format-aware merge helper, a 24-hour freeze window. |
| 8 | Keys may not work with focus inside an email (unverified). | A hand check, and a fallback that relays only scrolling keys. |
| 9 | A second cause hides behind the Gmail 403. | 0.2.4 logs Google's exact reason; the Gmail rebuild passes only on your real account. |
| 10 | 0.2.4 reaches testers while emails still render unsealed. | The `srcdoc` stopgap joins 0.2.4 if ready; if not, keep 0.2.4 to yourself until it or 0.3.0 ships. |
| 11 | Going public exposes history or secrets. | A fresh curated history, secret scans of every branch, a provenance gate, no ritual secret rotation. |
| 12 | Outlook cannot be tested without a Microsoft registration. | The thread builds it against a faithful fake and keeps it switched off. |

## 8. Document map

| File | What it is for |
|---|---|
| `plans/README.md` | The start page and reading path |
| `plans/overview.html` | Visual overview: timeline, how the parts fit, the look |
| `plans/00-roadmap.md` | This file: your decisions and calendar on top; threads, the unified timeline, branches and every decision below |
| `plans/ARCHITECTURE.md` | Binding engine architecture: storage, sync, governor, contract, security, ARCH's M0-M10 path; amendments AM-1 to AM-4 (section 16A) |
| `plans/DESIGN.md` | Binding design language (Skypaper), every screen, the keyboard map, voice, enforcement; 7.11-7.12 amended for your onboarding wishes |
| `plans/10-engine-foundation.md` | Engine thread plan: E0-E8, the contract and stand-in engine, the legacy bridge, the freeze window |
| `plans/20-providers-sync.md` | Providers & Sync plan: PV0-PV11, the 0.2.4 Gmail fix, the adapter port, emulators, live checks, Google verification engineering |
| `plans/30-ui-revamp.md` | UI thread plan: U0-U9, data layer, motion, mail frame, onboarding, accessibility and performance |
| `plans/40-platform-quality.md` | Platform plan: Q0-Q8, formatting, CI, hardening, releases, open-source readiness, the Google owner-action calendar |
| `plans/50-thread-briefs.md` | The launch messages for the three threads, the launch checklist and launch decisions |
| `plans/proposals/arch-*.md` | The three competing architecture proposals that ARCH chose between (superseded) |
| `plans/proposals/design-*.md` | The three competing design directions that DESIGN chose between (superseded) |
| `plans/_council/CONTEXT.md` | Shared facts that override research, owner rules, and the plain-English contract |
| `plans/_council/critic-*-sonnet.md` | Critiques of each workstream plan, with revision logs |
| `plans/_council/judge-*.md` | Independent judges' scorecards for the architecture and design choices |
| `plans/_council/task-*.md`, `run-critics.sh`, `*.log` | Briefs and run logs of the planning agents (process records only) |
