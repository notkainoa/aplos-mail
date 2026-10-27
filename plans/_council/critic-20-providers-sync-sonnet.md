# Critique: plans/20-providers-sync.md (Sonnet 5.5)

Checked against ARCHITECTURE.md, DESIGN.md, plans 10/30/40, `RC/protocols/proto-google.md` §9 (D1-D25), `RC/protocols/proto-others.md` §6-§7 (M/I/J/C/X), and Aplos main `72095ff` (`apps/desktop/src/main/google.ts`, `src/engine/{gate,provider,service}.ts`, `tests/integrations.test.ts`). The §2 code claims are accurate; the problems are PV0's design, the package layout, sequencing and cross-plan seams.

## Blockers

1. **blocker. PV0 is not metadata-first, lazy-body or paced, and would likely re-fail.** It fetches 40 threads as `format=full` (4,800 units), concurrency 1, with only a 60 s pause on refusal.
   - `service.ts:584-586` re-runs `provider.sync` up to 3 times on `StaleSync`, so the window can be re-spent: about 14,400 units inside a minute, and a 403 again.
   - There is no quota-aware pacer, and workflow rounds go through the same unpaced `api()`.
   - The old model has no open-thread hook (`MailProvider` has no body fetch, `Message.text` is required). Lazy bodies need one new engine method added to three allowlists (`preload.ts:8`, `electron.ts:20`, `server.ts:15`) and a Reader call. The plan does not scope it.
   - `gate.ready(key, manual=true)` returns true during backoff, so a manual Sync during a pause hits Google again.
   - D3 (a 2,000-thread archive elsewhere costs about 240,000 units) is deferred to PV3, but it hits the owner's real mailbox minutes after the first sync.
   - D4 needs `service.ts` to set `connected:false` (it never does today). D2 needs the `App.tsx:179` debounce changed. The sync error copy "Reconnect the account or try again" (`service.ts:678`) is wrong for throttling. None of these is in PV0's touch list.
   - `tests/integrations.test.ts:190` asserts the PR #23 retry and must be inverted.
   - **Fix:** rewrite PV0 as: a unit-priced pacer (50% of 6,000), a metadata window with a per-run memo, a lazy `thread.open`, the D3 INBOX-gain rule, throttle/daily/reauth classes, a gate that honours `retryAfterMs` for manual runs, the search and copy changes, and the test inversion. Add a stated fallback.

2. **blocker. `quotaExceeded` handling is stated but not specified.** PV0 says "never retried" but does not say what happens instead.
   - `google.ts:110-133` retries up to 5 times and caps `Retry-After` at 30 s with integer-only parsing.
   - `dailyLimitExceeded` is never surfaced as a stop.
   - **Fix:** a three-class PV0 table (throttle pauses, daily/quota stops until a stated time with Google's own words shown, send_limit and reauth never retried), with the regex edit named.

3. **blocker. Package layout contradicts ADR-19 and plan 10.** The plan creates `packages/providers` and `packages/emulators`.
   - ARCH ADR-19 names three packages (contract, engine, mail-html).
   - Plan 10 §3 already added a fourth and says provider files stay in `src/main`, and its portability rule forbids `node:` in `packages/engine`.
   - **Fix:** adapters under `packages/engine/src/providers/<kind>/` as a separate entry point outside the 400 KB core budget. The `node:` allowlist is scoped to IMAP and SMTP only. Emulators go under `packages/engine/testkit/`. List the two edits plan 10 must accept.

4. **blocker. Dependencies on plan 10 use ARCH M-numbers, not E-numbers.** "Plan 10 M1/M2/M4/M6/M10" do not exist in plan 10 (E0-E8; M4 is split E3 and E4).
   - Plan 10's E0 (logger, branch `hotfix/0.2.4-log`) and PV0's "redacted rotating log" are the same deliverable on two hotfix branches.
   - Plan 30's U0 `srcdoc` stopgap and plan 40's Q0 also target 0.2.4.
   - **Fix:** an explicit E-number column and a "Needs from plan 10" line on every PV. One 0.2.4 train: E0 first, then PV0.

## Majors

5. **major. The lease and workflow channel are in PV4 but ARCH §15 M3 puts the lease in M3.** PV3 would ship 0.3.0 with every device acting as primary: three Macs at 4,500 is 13,500 against 6,000. Workflow rounds (31 + 100·N units, D17/D18) also contend with PV3's "zero refusals" claim. **Fix:** move lease and D17/D18 into PV3.

6. **major. PV1 is over-scoped and on PV3's critical path.** It holds five emulators, an IMAP personality server, a Docker conformance tier, the kit, the port and the harness, in 2 weeks. PV3 needs only the Gmail emulator and the kit. PV3 starts in week 3 but "depends on PV2", which ends in week 4.5. **Fix:** split PV1a (Gmail emulator, kit, port, harness skeleton; gates PV2 and PV3) from PV1b (IMAP, Graph, JMAP/DAV fakes and conformance, landing just before PV6, PV7, PV8 and PV10). Let PV3 start against a pass-through `GovernorPort` stub.

7. **major. The ARCH §5.1 conflict is left as "plan 10 reviewers should confirm".** The cost arithmetic is not shown. Learning the count costs 40 units (`threads.get` minimal) to save 60, which is a net loss on multi-message threads. **Fix:** an explicit ARCH amendment A1 (open = `threads.get` full, 120) with the arithmetic and a DECISIONS.md entry.

8. **major. The live harness collides with plan 40.** Plan 40's `scripts/smoke/` runs a nightly Gmail check from CI with a stored token (§6 Layer 2). Plan 20 says "never in CI" and "CI secrets kept out". **Fix:** tier R is shared through plan 40's `SmokeProbe` on throwaway accounts only; tiers M and S never run in CI. Flag it for plan 40.

9. **major. No capacity check.** About 115-125 agent-days sit on the S thread, which also owns E2 (weeks 2-3), with four milestones in parallel in weeks 7-9. The "Multi-provider daily-driver gate" is attached to PV11, but ARCH puts it at M7. **Fix:** an agent-days column, an honest critical path, a cut order, and the gate moved to PV6/PV7.

10. **major. Defect coverage gaps** against the two defect lists.
    - D15 is in the table but has no PV3 deliverable.
    - M8 is mapped to PV10 but delivered in PV9; M10 is not delivered anywhere.
    - I8 (Yahoo periodic resync despite IDLE), C4's residue (VTODO, alarms, free/busy) and I9 (ESEARCH, LIST-STATUS, IMAP server search) are unaddressed.
    - D3 is only partly covered by PV0.

11. **major. Contract names the plan uses do not exist** in ARCH §9.1 or plan 10: `Account/connect`, `Unsubscribe/run`, `Event/*`. `ProviderAdapter` is not in plan 10's §7.1 ports table, and `SendPort`/`DraftSyncPort` overlap `ProviderAdapter.send/saveDraft`. **Fix:** map the names, and list what plan 10 must add.

12. **major. PV5's scope freeze versus Decision 4.** `gmail.settings.basic` is a restricted scope that is needed only to write filters; sendAs reads are covered by `gmail.modify` [I, verify against the sendAs.list doc]. If filters are declined, dropping the scope shrinks the review. Decision 4 must be settled before submission. **Fix:** add the sequencing note.

## Minors

13. Section 5 jumps from "Layers" to 5.4 and 5.5. Renumber.
14. "External prerequisites" has no "What this means" line.
15. PV0 is gated "only after Decision 1 is answered yes", which contradicts "defaults apply" and the urgency. Start on the default and let the owner veto.
16. No Decision covers the PV0 fallback (a smaller first window if the lazy-body hook is too big for a hotfix).
17. RSVP on Google: `sendUpdates` is not specified, so the organizer may not be told [U, test with a second account].
18. The plain-English section (318 words) does not say what 0.2.4 will do: subjects first, text on open, pacing.

## Verified, no change needed

The rest of the defect table is complete (every other D, M, I, J, C and X id has a home). The cost table, AIMD numbers, batch curve, iCloud 2+1+1 count and CASA figures match the research.

## Revision log

Changes made to `plans/20-providers-sync.md` in place (about 10,100 words became about 14,400; no technical depth removed).

- **Blocker 1, PV0 rewritten.**
  - Now metadata-first (50 threads, `threads.get` metadata, about 2,000 units), with a unit-priced pacer at 50% of 6,000 (`GMAIL_COSTS` table, one request in flight), a per-run memo against `StaleSync` re-spend, and lazy bodies via an optional `MailProvider.openThread` plus an engine `thread.open` added to the three allowlists.
  - The D3 INBOX-gain rule and a 150-fetch cap, search on Enter, the granted-scope store, and the gate honouring `retryAfterMs` for manual syncs.
  - Real touch list and live and emulator acceptance, including the inversion of `tests/integrations.test.ts:190`.
  - Estimate 5-7 days. Decision 7 adds an owner-visible fallback (25 threads with text).
- **Blocker 2, `quotaExceeded`.** A four-class table in PV0 (throttle, daily, send limit, reauth). `quotaExceeded` leaves the retry regex and becomes "stop and surface until the next midnight Pacific" (Calendar: 3 hours). Pause state is in memory in 0.2.4 and persisted in PV2.
- **Blocker 3, package layout.** `packages/providers` and `packages/emulators` are removed. Adapters live under `packages/engine/src/providers/` as a second entry point outside the 400 KB core budget. `node:` is allowed only in `providers/imap/**`. Emulators live in `packages/engine/testkit/`. The plan names today's `src/main` files and how they move.
- **Blocker 4, E-numbers.**
  - The §4 table has a "Needs from plan 10" column in E0-E8 terms, and every PV has an explicit Depends line.
  - PV0 is on one 0.2.4 train with E0 first. Experiments were renamed EX1-EX11 to stop clashing with E-numbers.
  - §1 and §3.1 state the E and M mapping.
- **Major 5.** The lease and the D17/D18 workflow channel moved from PV4 to PV3, with a two-Mac acceptance. PV2 takes a `role` input.
- **Major 6.** PV1 split into PV1a (Gmail emulator, kit, port, harness; gates PV2 and PV3) and PV1b (other fakes, just in time). PV3 starts on a pass-through governor stub.
- **Major 7.** The ARCH §5.1 conflict is now amendment A1 with the arithmetic, a rule, and a request to record it in DECISIONS.md. Open and prefetch use `threads.get` full.
- **Major 8.** The live harness aligned with plan 40's `smoke:live` and `SmokeProbe`: tier R is shared on throwaway accounts only, and tiers M and S never run in CI.
- **Major 9.** Added an agent-days column (about 120-127), a capacity paragraph, the critical path, a cut order, and moved the "multi-provider gate" to PV6 plus PV7 (ARCH M7). PV11 is the hardening gate.
- **Major 10.**
  - D15 added to PV3.
  - M8 remapped to PV9 and M10 added to PV10.
  - I8 noted under PV6.
  - The C4 residue and I9's ESEARCH and LIST-STATUS are explicit non-goals.
  - D3 and D7 rows updated for PV0.
- **Major 11.** The port is related to plan 10's ports. Missing contract methods and plan 10's edits are listed in §7.
- **Major 12.** PV5 now settles Decision 4 before the scope freeze, and says `gmail.settings.basic` may be droppable. One CASA folder is split with plan 40.
- **Minors.**
  - §5 renumbered to 5.1-5.5.
  - "What this means" added after External prerequisites.
  - PV0 starts on the default, with owner veto.
  - Decision 7 added.
  - RSVP `sendUpdates` added, with experiment EX11.
  - The plain-English section now describes 0.2.4 (355 words including headings).
- **Extra finding.** Git cannot hold both `revamp` and `revamp/...` branches (verified). Plan 20 now uses `revamp-pv<N>-...`.

**Remaining edits to OTHER plans:**
1. Plan 10 §3 and E1: path-scope the portability rule (`node:` allowed only under `packages/engine/src/providers/imap/**`), replace "provider files in `src/main`" with `packages/engine/src/providers/` as a second entry point, and add `packages/engine/testkit/`.
2. Plan 10 §7.1 and E1 freeze: add `ProviderAdapter` (with `findSent`) to the ports table.
3. Plan 10 contract: define `Account/connect|reconnect|grantPermissions`, `Unsubscribe/run`, `Event/set {scope}` and `Event/rsvp`.
4. Plans 10, 30 and 40: rename branches from `revamp/...` to a non-nested form such as `revamp-e1-...`.
5. Plans 10, 30 and 40: join one `hotfix/0.2.4` train (E0, then PV0, then the plan 30 `srcdoc` change, then optional Q0) instead of separate hotfix branches.
6. Plan 40 Layer 2: drop any CI-stored token for a real account, run the nightly Gmail smoke on a throwaway account only, and consume plan 20's per-provider probes.
7. Plan 40 §6.8 and plan 20 PV5: split `docs/security/casa/` so Google-specific documents are plan 20's and scans are plan 40's.
8. ARCH §5.1 (owner of ARCH): accept amendment A1 and record it in DECISIONS.md.
