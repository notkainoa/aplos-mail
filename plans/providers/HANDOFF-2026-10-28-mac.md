# Providers thread: handoff from the Mac to the Linux box

Written 2026-10-28 (day 2) by the Providers thread on `kainoas-macbook-pro`. A new T3 thread on `kainoas-linux-mba` continues the work. It covers lanes `prov-emu`, `prov-gov`, `prov-gmail`, `prov-gmail-write` and `prov-cal`; round 2's IMAP, JMAP and Graph lanes are not built. Read `plans/50-thread-briefs.md` Brief 2, `plans/00-roadmap.md` (including section 5.1a, model routing) and `plans/STATUS.md` first. Then read this file.

## In plain English

The Gmail practice server, the Google Calendar practice server and the repeating-events engine are merged. The live-check runner is one security re-review away from merging. The budget keeper, the per-account sync worker and the Gmail connection are built and tested end to end on the practice server. Each sits on its own clean branch, waiting to be opened as a pull request.

Nothing waits on the owner yet. Around day 9 the owner runs one sign-in for the spare Gmail on the Mac. Live Gmail runs always happen on the Mac, because that account's sign-in lives in the Mac's Keychain. Linux asks the Integrator to run them.

> **What this means:** The next thread can pick up straight away. The first jobs are opening two pull requests and adding the remaining Gmail pieces.

## 1. Lanes, branches and SHAs

All of these are pushed to `origin`. Where a branch has been superseded, it says so.

| Lane | Branch | SHA | State |
|---|---|---|---|
| prov-emu | `rv/prov-emu/gmail` | `0033bda` | **Merged** as #30: Gmail emulator and fault kit. Branch is done |
| prov-emu | `rv/prov-emu/gcal` | `103c598` | **Merged** as #31: Google Calendar emulator. Branch is done |
| prov-emu | `rv/prov-emu/live` | `f302415` | **PR #38**, READY: the live-check runner skeleton, with the security-review fixes in `8cb9aff` |
| prov-cal | `rv/prov-cal/recurrence` | `97a8600` | **Merged** as #39: recurrence module. Branch is done |
| prov-gov | `rv/prov-gov/engine-sync` | `966da0b` | **Ready for a PR** (not opened). Holds the governor on the F3 ports, the account actor and `AccountActorHost`, and the shared no-retry HTTP pieces, built on `revamp` after #28. The lint pass is done. Verified so far: 113/113 sync tests; format, lint, CSS lint and the owners check (34 files, prov-gov) pass. Still to run: typecheck and tests. The full `npm run check` was stopped at the 30-minute background limit because the Mac's load average was about 160 |
| prov-gmail | `rv/prov-gmail/adapter` | `b1d4141` | **Ready for a PR after prov-gov's**; it is stacked on `engine-sync@7f55ebb`. Holds the Gmail adapter (classifier, paced client, P0-P5 window, history, AM-1 open, search on Enter, ops) with its tests in `apps/desktop/tests/prov-gmail/`. 111 tests (109 pass, 2 todo); lint, typecheck and format are clean. It needs `engine-sync@966da0b` (the lint commit) merged in, then `npm run check` |
| prov-gov + prov-gmail | `rv/prov-gov/actor` | `a560d30` | **Superseded** by the two branches above. It was built on the unsquashed Engine commits, so don't open a PR from it |
| prov-gov | `rv/prov-gov/governor` | `826b978` | **Superseded** (day-1 governor core on provisional types) |
| prov-gmail | `rv/prov-gmail/core` | `f8b64e9` | **Superseded** (Gmail core on the draft ports). Everything in it, including the parsing table tests and the group-syntax fix, is in `rv/prov-gmail/adapter` |
| prov-gmail-write | none yet | | Not started (plan: days 6-12) |
| coordination | `rv/thread/providers` | this commit | `plans/providers/`: the port proposal v2, the F3 review, the day-2 port gaps, the test plans, the test.todo stubs and this file |

Worktrees on the Mac (`/Users/knewton/.t3/worktrees/aplos-mail/rv-*`) are clean, apart from local-only `package-lock.json` or `node_modules` noise. On Linux, make your own worktrees from `origin`.

## 2. Open PRs and their review state

- **#38 `rv/prov-emu/live`.**
  - **History:** the independent Opus security review returned MERGE AFTER FIXES (Integrator, STATUS 2026-10-28 08:05). All 8 items are fixed in `8cb9aff`, which also limits `messages.send` bodies to exact keys. Each fix has a test that fails on the unfixed code (20 of the 22 review tests failed in a scratch worktree; the other 2 are controls). 117/117.
  - **Where it stands:** `revamp` is merged in at `f302415`. `npm run check` exits 0 (emulator package 376/376, including 117 runner tests; owners check OK, 25 files). READY was posted in STATUS at 09:2x.
  - **Next:** the Integrator re-runs the reviewer's attack scripts (`/tmp/guardrev/exp` on the Mac), then merges.
  - **Note:** tier M and S-self now refuse any test account signed in without a stored address hash, so the sign-in must be redone with this code. No account has been signed in yet.
- No other Providers PRs are open. #30, #31 and #39 are merged.

## 3. Unfinished workflows and how to resume

No agent workflow is running. Two things were left in progress:

- **`npm run check` on `rv/prov-gov/engine-sync` stopped at its time limit.** Resume on Linux (section 7):
  1. `git merge origin/revamp`.
  2. Run `npm run check` (or at least the typecheck and the sync tests).
  3. Open the dependency PR.
- **`rv/prov-gmail/adapter`:**
  1. `git merge origin/rv/prov-gov/engine-sync`, then `git merge origin/revamp`.
  2. Run `npm run check`.
  3. Open the dependency PR once prov-gov's is open. Base it on `revamp`, or on prov-gov's branch until that merges.

The workflow scripts used on the Mac live under `~/.claude/projects/...` on that Mac, so they can't be resumed from Linux. Each lane's brief is captured in this file, the plans and the commit messages.

## 4. Open requests (from this thread, in STATUS)

- **To eng-contract, eng-store, eng-views and eng-time (STATUS 2026-10-28 ~10:00):** 15 additive port gaps, each with a stand-in already in place (`plans/providers/port-gaps-day2.md`). The two that matter most:
  - G1: `GovernorPort.bindConnect`, the agreed B1 behaviour, which has no port method yet.
  - V-a: the ops payload shape that `Thread/act` must write, `OpPayload {remoteId, change}` (in `packages/engine/src/sync/ops.ts`).

  G10 is also open: is `progress.read` a per-step increment or a running total? Today the actor sums it while Gmail reports a running total. Fix whichever side eng-contract chooses.
- **To eng-contract (00:41):** the day-1 Gmail port gaps: `partialThreads`, `messageDates`, `messagePlacements`, `knownFolders`. They overlap S-a in the day-2 list.
- **Answered, nothing pending:** EX13 and EX14 were added to plan 20 section 5.5; the OWNERS rows for the engine test paths are done; lockfile approval came with #30.

## 5. Decisions in flight or recently recorded (all in STATUS as DECIDED)

- **Escalation:** throttle cooldowns step 60 s, 5 min, 15 min, then 1 h, and reset after 10 quiet minutes.
- **Search:** 25 results per page, per ARCH 3.4.
- **P1:** uses `messages.get` metadata (20 units) per listed Inbox message, with `threads.get` metadata only for new multi-message threads. Every listed Inbox message is stored (D8).
- **Agent account, tier M:**
  - never `drafts.delete` or `messages.delete`;
  - run-scoped calendar events only (the orchestrator's decision): no guests, tagged `extendedProperties.private.aplosLiveRun`.
- **PR route:** the governor, actor and Gmail adapter go to `revamp` as dependency PRs (the Integrator accepted this at 08:23). Feature 1's owner review happens on the first-sync screen running on the real engine against the emulator, with screenshots plus a units-per-minute chart.
- **Lint on safety code:** governor and sync lint goes to Claude, never the free tier. Free-tier lint on the recurrence code once changed behaviour, and the review caught it.

## 6. Next actions, in order

1. **#38:** after the Integrator's re-run, answer any new findings with Opus; nothing else is pending.
2. **Open the prov-gov dependency PR** from `rv/prov-gov/engine-sync` (section 3). In the body, say the governor and actor are tested end to end in the Gmail branch's `e2e*.test.ts`.
3. **Open the prov-gmail dependency PR** from `rv/prov-gmail/adapter` (section 3).
4. **prov-gov remaining** (plan 20 PV2 and PV5; days 4-9):
   - `host/providers/oauth/**`: client resolution from `oauth-config.ts`, the scope manifest and its test, granted-scope handling, and a `TokenSource` over the vault;
   - `methods/account.ts` (`Account/connect`, `reconnect`, `grantPermissions`, `lease`) and `methods/sync.ts` (`Sync/request`);
   - `sync/lease.ts` (the primary-device lease over the workflow channel). This un-todos `gov-stack-attack` 05.
5. **prov-gmail remaining** (PV3):
   - the workflow channel `google/workflow.ts` (D17, D18), which the lease rides on;
   - P4 prefetch, engine-driven through `openThread(..., 'prefetch')`;
   - Logger catalog wiring;
   - fix G10 once eng-contract answers.
6. **prov-cal:** the Google Calendar `CalendarAdapter` (PV9: sync tokens, patch with `If-Match`, 410 per calendar, RSVP by patching the self attendee, `forbiddenForNonOrganizer`), on the gcal emulator from #31. Also restore `RDATE;VALUE=PERIOD` in the recurrence module; it was dropped to fit the old size budget, which no longer counts legacy code.
7. **prov-gmail-write** (PV4, days 6-12):
   - drafts with `revision` and fingerprint;
   - send through `/upload` (never retried);
   - `findSent` returning found or absent, with a recheck after 60 s;
   - the filters mirror;
   - the List-Unsubscribe capture and one-click executor, under eng-html's SSRF rules.

   Test rows are in `plans/providers/stubs/prov-gmail-write.todo.test.ts`.
8. **Feature 1 owner loop** (roadmap 12.3), with `ui-onboard`. Once the first-sync screen runs on the real engine:
   - screenshots of the `rate-limited` and `backfilling` states;
   - a chart of Gmail units per minute against the limit;
   - a READY-FOR-OWNER post.
9. **About day 9, the owner's one sign-in on the Mac** (section 8). Ask in plain English and give the exact command.
10. **Days 12-16, live gates** (Gmail tier R then M, Google Calendar run-scoped). Days 15-25: PV11 hardening and soak.

## 7. How to run tests (Linux and Mac alike)

- **Setup:** from the repo root, `npm ci` (or `npm install --ignore-scripts` when a branch adds a workspace).
- **Pre-PR rule:** merge `revamp` into the branch first, then run `npm run check`. The owners check infers the lane from `rv/<lane>/<slug>`.
- **Targeted suites:**
  - Emulators and the live runner: `npx tsx --test packages/emulators/tests/*.test.ts`
  - Engine, including sync and calendar (flat folder): `npx tsx --test packages/engine/tests/*.test.ts`
  - Gmail adapter: `npx tsx --test 'apps/desktop/tests/prov-gmail/*.test.ts'`. The e2e files are slow, about 45 s alone.
  - Typecheck: `npm run typecheck`, or `(cd packages/engine && npx tsc --noEmit)` and `(cd apps/desktop && npx tsc --noEmit)`
  - Lint on your paths: `npx eslint <paths>`. No `eslint-disable` without a one-line reason; the one current exception is the 0.2.3 gate tests' legacy import.
- **Portability:** everything above is Node-only with no window, and nothing depends on macOS. The fake clock uses `process.getActiveResourcesInfo`, which is Node and portable. The only macOS-specific code is the live runner's Keychain helper (`security`), and it runs only on the Mac.
- **Model routing (roadmap 5.1a):**
  - Free OpenCode models for fixtures, test cases from the plans and suite summaries;
  - Claude Sonnet or Opus for adapters, the governor, sync and every security fix;
  - every non-Claude diff is reviewed by Claude.

  A specific lesson: when code is split into helpers, check that state the caller relied on is still set before any statement that can throw.

## 8. The live-run procedure (always on the Mac)

The agent test account's refresh token sits in the Mac's Keychain, and its metadata (grant time, salted address hash, never the address) is in `~/Library/Application Support/Aplos Mail Live/accounts.json`. Linux never holds a Google token.

- **Asking for a run (Linux):** post `REQUEST | prov-emu | to integrator: live-run` in STATUS with the exact command, the branch and SHA to run it from, and the expected duration. Keep runs under 3,000 Gmail units a minute, schedule them clear of `eng-ai`'s live evals on the same account, and check that `reconnectBy` isn't inside the run.
- **One-time sign-in.** The owner runs this on the Mac from a checkout of the merged #38 code: they pick the spare account and click Allow, and the token goes to the Keychain. Never ask for passwords or tokens in chat.

  ```
  APLOS_GOOGLE_CLIENT_ID=<from the repo-root .env or the bundled client> APLOS_GOOGLE_CLIENT_SECRET=<same> \
    npx tsx apps/desktop/scripts/live/signin.ts --provider gmail --label agent
  ```

  `APLOS_LIVE_LOGIN_HINT` may preselect the account. The client values come from the owner's local `.env`; nobody prints them.
- **Runs** (the Integrator, on the Mac):

  ```
  npx tsx apps/desktop/scripts/live/run.ts --provider gmail --tier R --account agent [--dry-run]
  npx tsx apps/desktop/scripts/live/run.ts --provider gmail --tier M --account agent --confirm-mutating
  npx tsx apps/desktop/scripts/live/run.ts --provider gcal  --tier M --account agent --confirm-mutating
  ```

- **Rules the runner enforces:**
  - tier S doesn't exist; S-self sends only to the account itself;
  - tiers M and S-self check the signed-in address against the stored hash;
  - a run whose token expires within its window is skipped with a plain message.
- **Evidence:** each run writes a content-free file to `verification/live/<date>-<provider>.md`. Live acceptance items in PROGRESS.md are checked only against that file. Mocked or emulated Google never counts as live acceptance.

## 9. Owner-facing promises still open

- Feature 1 (Gmail sync and the first-sync screen) is "done pending live check" until the evidence files and the owner's hand checks on days 14-16 exist.
- The owner has been told nothing yet needs them. The day-9 sign-in request is the next owner touch.
