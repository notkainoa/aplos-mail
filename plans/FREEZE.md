# Contract freeze checklist (Phase 0, day 3)

The integrator runs this on day 3 (2026-10-29), or as soon as the Engine thread posts that F1 to F8 are on `revamp`. It is the gate in roadmap section 1.3 and plan 10 section 4.1. When every box is ticked, the integrator tags `contract-v1` on `revamp`, posts FROZEN in [STATUS.md](STATUS.md) and sends the owner a five-line plain-English note. After that, contract changes are additive within `v:1`, proposed with CONTRACT-CHANGE-PROPOSED and made only by `eng-contract`.

## In plain English

Before 23 lanes start building against the shared rules, three fresh reviewers try to break them. Each finding is fixed or written down as a decision. Only then do the rules freeze.

## 1. Preconditions

- [ ] Restructure steps 1 to 4 are on `revamp` (roadmap 1.1), merged by merge commit and listed in `.git-blame-ignore-revs` where mechanical.
- [ ] `npm run typecheck` and `npm test` pass on `revamp` at the candidate commit, run by the integrator. The baseline before the restructure is recorded in the day-1 STATUS entries.
- [ ] `npm run package` and `verify-release.mjs` pass after step 1 (the `@aplos/*` bundling question in plan 10 section 3).
- [ ] The Providers port proposal (morning of day 2) and the UI-screens gap list (day 2) are posted, so the reviewers can use them.

## 2. Artifacts present (roadmap 1.2)

| # | Artifact | Where | Check | Done |
|---|---|---|---|---|
| F1 | Contract v1 | `packages/contract/src/**` | Every method with zod input and output; frames `state`, `window`, `progress`, `reset`, host channel, with `{dbEpoch, seq}` and receipts; error types and the classified-error record; status vocabulary with `paused(until, reason)`, `backfilling(n of m)`, `reconnectBy`; `Setup/status` shape (plan 10 4.1); Thread row with `partial`; `Mail/frame`; capability flags; `Settings` with `ui` and a provider and model per AI feature (Ask, Summaries, Drafts, Plans, Voice); the logger event catalog. Wire rules of ARCH 9.3 (no tuples, no `Date`/`Map`/`BigInt`, no transforms, open string enums). | [ ] |
| F2 | Generated allowlists and typed client | `packages/contract/generated/**`, `src/client/**` | The registry drives `preload.ts`, `engine-host.ts` and `server.ts`; one source, no hand-kept copies; a host-agreement test. | [ ] |
| F3 | Ports | `packages/engine/src/ports.ts` | `ProviderAdapter` with `CalendarAdapter` and `findSent`, `GovernorPort`, `AccountActorHost`, `SendPort` with `NotSentError`, `DraftSyncPort`, `ProviderPort.openThread`, `Clock`, deadline-source registration, `KeyProvider`, `MailHtml`, `Logger`, `StorePort`, `laneFor`. | [ ] |
| F4 | Schema 0001 and `store.commit` | `packages/engine/src/store/migrations/0001*`, `store/port.ts` | ARCH 3.2 plus plan 20's items: recurrence id on `events`, `message_folders` keyed for IMAP placements, `sync_state`, `governor_state`, token-grant time on the account; a minimal working commit that writes `changes` and bumps `seq`. | [ ] |
| F5 | Dispatch table | `packages/engine/src/methods/index.ts` | Every contract method maps to one `methods/<area>.ts` stub that throws `NotImplemented`; every area file has an owner in OWNERS.md. | [ ] |
| F6 | Stand-in engine and conformance layout | `packages/contract-fixture/**`, `packages/contract/tests/conformance/**` | Answers every method on `empty` and `demo`; `Fixture/control` signatures; conformance suite green on the stand-in; no fixture-only assertions. | [ ] |
| F7 | Logger and redacting sink | `packages/engine/src/diag/log.ts`, `apps/desktop/src/host/logsink.ts` | Redaction test covers addresses, tokens, subjects and bodies. | [ ] |
| F8 | Test mode and Playwright base | `main/lifecycle.ts`, `tests/e2e/playwright.config.ts` | `APLOS_TEST=1` and `APLOS_DATA_DIR`: isolated data, no single-instance lock, no Dock or menu-bar or login item, windows created hidden. | [ ] |
| F9 | Design tokens and UI interfaces | `apps/desktop/src/renderer/{ui,commands,data}/**`, `scripts/design/**`, `tools/lint/design/**`, `.claude/skills/aplos-design/**` | Tokens generated from DESIGN.md; design lint; skill v1; component props; `CommandRegistry`; `useView`, `useRow`, `api`, receipts. | [ ] |
| F10 | Ownership map and check | `plans/OWNERS.md`, `scripts/audit/owners-check.mjs`, `plans/STATUS.md` | The check runs on a PR's changed files and fails on another lane's or an unlisted path. | [ ] |

Plus: the neutral engine with zod measures under 400,000 bytes, and the measured number is recorded in DECISIONS.md. [ ]

## 3. The three reviewers

Each is a fresh Claude Opus agent (`claude-opus-5-5`) run from a Claude Code workflow, with read access to the candidate commit. Each gets the artifacts and the named design and architecture sections, but not the authors' reasoning: no PR descriptions, no thread messages, no DECISIONS entries written during Phase 0. Each answers one question and returns findings as `{id, severity (blocker | gap | nit), artifact, what cannot be expressed or is unsafe, evidence (file:line), suggested additive fix}`. A consolidation agent then merges duplicates and ranks them. The integrator reads every finding before it goes to the Engine thread.

| Reviewer | Question | Inputs |
|---|---|---|
| 1. UI | Which behaviour in the mockups and DESIGN cannot be expressed through this contract and these data hooks? | F1, F2, F6, F9; every screen in `mockups/`; DESIGN sections 5 and 7; ARCH 9.2; plan 10 section 4.1 and its table of plan 30's twelve asks; plan 30 section 8.1; the UI-screens gap list. Must answer each of the twelve asks with pass or gap. |
| 2. Providers | Can Gmail, IMAP, JMAP, Graph and CalDAV each be written against these ports and schema 0001 without changing anything frozen? | F1 (status vocabulary, account facts), F3, F4, F5; ARCH 3, 5, 6 (including 6.4, the weekly reconnect) and 12.5; plan 20 sections 2 and 3; the Providers port proposal. Must walk all five providers on paper, including the weekly reconnect (grant time, `reconnectBy`, `login_hint`, no resync, queued changes kept) and the primary-device lease. Round 2 providers are walked even though they are not built this round. |
| 3. Security and platform | Are the scopes, transports, frame, logs and budget safe and within limits? | F1 (registry tags and scopes, `Mail/frame`, log catalog), F2, F7, F8; ARCH 9.4, 10, 11 and 12; plan 40's security sections; the measured engine bundle size. Must check every method's scope tag, the token and Origin rules per transport, the frame token and CSP, every log event against the redaction rules, and the 400,000-byte budget. |

## 4. Findings

Every finding ends as **fixed** (with the commit) or **decided** (a DECIDED entry in STATUS.md and a DECISIONS.md line, with the reason). A blocker cannot be decided away without the owner. Round 1 ran on 2026-10-27 at 22:5x on PR #28 (214f052) plus F9 at 98dfc61: 36 findings (9 blockers, 25 gaps, 2 nits), all confirmed in the code, none dropped. The full list, with evidence and suggested fixes, is [freeze/findings.md](freeze/findings.md). Outcomes are recorded here as they land. Round 2 (2026-10-28, on 9ec6518 plus F9 at 1da5496) is [freeze/round2.md](freeze/round2.md): 30 fixed, 6 partly fixed, 24 new items (2 blockers, one found twice), with the must-fix list for the tag at its top. Round 3 (2026-10-28, on a4a2a88) is [freeze/round3.md](freeze/round3.md): the must-fix list holds except one new blocker, NB-1 (an operation must record the scope the call actually needed); R2H-1 and R2H-4 leftovers are host code, gated on the release candidate.

| ID | Severity | Owner | Outcome | Commit or decision |
|---|---|---|---|---|
| FR-1 | blocker | ui-foundation | fixed (round 2) | PR #28 9ec6518 |
| FR-2 | blocker | eng-contract | fixed (round 2; remainder deferred, DECISIONS.md 2026-10-28 freeze sign-off) | PR #28 9ec6518 |
| FR-3 | blocker | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-4 | blocker | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-5 | blocker | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-6 | blocker | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-7 | blocker | eng-contract | fixed (round 2; remainder deferred, DECISIONS.md 2026-10-28 freeze sign-off) | PR #28 9ec6518 |
| FR-8 | blocker | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-9 | blocker | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-10 | gap | eng-store | fixed (round 2) | PR #28 9ec6518 |
| FR-11 | gap | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-12 | gap | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-13 | gap | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-14 | gap | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-15 | gap | eng-store | fixed (round 2) | PR #28 9ec6518 |
| FR-16 | gap | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-17 | gap | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-18 | gap | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-19 | gap | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-20 | gap | eng-contract | fixed (round 2; remainder deferred, DECISIONS.md 2026-10-28 freeze sign-off) | PR #28 9ec6518 |
| FR-21 | gap | eng-contract + ui-foundation | fixed (round 2) | PR #28 9ec6518 |
| FR-22 | gap | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-23 | gap | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-24 | gap | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-25 | gap | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-26 | gap | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-27 | gap | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-28 | gap | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-29 | gap | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-30 | gap | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-31 | gap | eng-store | fixed (round 2; remainder deferred, DECISIONS.md 2026-10-28 freeze sign-off) | PR #28 9ec6518 |
| FR-32 | gap | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-33 | gap | eng-contract | fixed (round 2) | PR #28 9ec6518 |
| FR-34 | gap | eng-contract | fixed (round 2; remainder deferred, DECISIONS.md 2026-10-28 freeze sign-off) | PR #28 9ec6518 |
| FR-35 | nit | eng-contract | fixed (round 2; remainder deferred, DECISIONS.md 2026-10-28 freeze sign-off) | PR #28 9ec6518 |
| FR-36 | nit | eng-contract | fixed (round 2) | PR #28 9ec6518 |

## 5. Exit

- [ ] Every finding above is fixed or decided; no open blocker.
- [ ] The integrator re-runs typecheck, tests and the stand-in conformance suite at the final commit.
- [ ] `git tag -a contract-v1 <commit> -m "Contract v1 frozen"` and `git push origin contract-v1`. This is a coordination tag on `revamp`, not a release tag.
- [ ] FROZEN posted in STATUS.md with the commit.
- [ ] Five-line note to the owner, in plain English: what froze, how many findings and how they were settled, the engine size against its budget, what starts tomorrow, and that nothing needs them.
