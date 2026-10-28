# Providers thread: handoff for the fresh Linux thread (lean mode, 2026-10-28 pause)

Written at the 20:05 UTC pause. This is the one-page version. The long Mac-to-Linux handoff (live-run procedure, full test notes, port gaps, decisions) is `plans/providers/HANDOFF-2026-10-28-mac.md`; read its sections 4, 5, 7 and 8 only when you need them. Old thread (read-only, small reads): `mcp:3cc38f80-9a34-4d39-a8d0-e53827aeb18d`.

> **What this means:** the Gmail and Calendar practice servers and the recurrence module are merged. The live-check guard has all its security fixes and is waiting for the Integrator. The budget keeper and the Gmail connection are built and pushed but have no pull requests yet. Nothing is lost and nothing waits on the owner.

Everything below is on `origin`; use only these branches and SHAs. Work on Linux: make worktrees from `origin`, run `npm ci`, merge `origin/revamp` before `npm run check`.

## Lane state

| Lane | Branch (origin) | SHA | State |
|---|---|---|---|
| prov-emu | `rv/prov-emu/live` | `f302415` | PR #38 OPEN, mergeable, READY since 09:19; all 8 security-review fixes in `8cb9aff`; `npm run check` green. Integrator re-runs the attack scripts, then merges |
| prov-emu | gmail / gcal emulators | merged | #30, #31 |
| prov-cal | recurrence | merged | #39. Open follow-up: restore `RDATE;VALUE=PERIOD` |
| prov-gov | `rv/prov-gov/engine-sync` | `966da0b` | Governor, account actor, host, shared HTTP; 113/113 sync tests; format, lint, CSS lint, owners passed; typecheck, tests and PR still to do |
| prov-gmail | `rv/prov-gmail/adapter` | `b1d4141` | Stacked on engine-sync (`7f55ebb`); adapter and tests in `apps/desktop/tests/prov-gmail/` (109 pass, 2 todo); needs engine-sync merged in, `npm run check`, PR |
| prov-gmail-write | none | | Not started (PV4) |
| superseded | `rv/prov-gov/actor` `a560d30`, `rv/prov-gov/governor` `826b978`, `rv/prov-gmail/core` `f8b64e9` | | Do not open PRs from these |

## Preserved uncommitted work (pause salvage)

Both were only `package-lock.json` drift (a `packages/emulators` workspace entry from `npm install` on an older branch). Nothing else was uncommitted in any providers worktree. Do not build on it.
- `rv/prov-gmail/wip-pause-1028` at `1e1aacb` (from `core`)
- `rv/prov-gov/wip-pause-1028` at `8f7f7a1` (from `actor`)

## Open PRs

- #38 as above. No other Providers PR is open. `revamp` has moved since: #28 (freeze), #41, #42 and others are in; open PRs #44, #46, #47 touch contract and engine seams, so re-merge `origin/revamp` before every `npm run check`.

## Next 5 actions

1. **#38:** nothing to fix (RESUME.md's "needs fixes" is out of date; the fixes are in). Only answer new Integrator findings, on Opus (security code). No lane card; the guard code is `apps/desktop/scripts/live/**` and `packages/emulators/**`.
2. **prov-gov PR:** on a worktree of `rv/prov-gov/engine-sync`, merge `origin/revamp`, run typecheck, `npx tsx --test packages/engine/tests/sync-*.ts`, then `npm run check`; open a dependency PR into `revamp`. Then the PV2/PV5 remainder: `host/providers/oauth/**`, `methods/{account,sync}.ts`, `sync/lease.ts`. Card: `plans/lanes/prov-gov.md`.
3. **prov-gmail PR:** merge `origin/rv/prov-gov/engine-sync` then `origin/revamp`, `npm run check`, open the PR after prov-gov's. Then move it onto the real store (`packages/engine/src/store`, `store.commit` with replay and fence; check the Engine thread's status first) and finish PV3: `workflow.ts`, P4 prefetch, Logger wiring, G10. Card: `plans/lanes/prov-gmail.md`.
4. **Day-2 port gaps** (`plans/providers/port-gaps-day2.md`, G1 `bindConnect` and V-a op payload matter most): check STATUS for eng-contract answers before coding stand-ins.
5. **Then in order:** prov-cal GoogleCalendarAdapter (PV9), prov-gmail-write (PV4), feature-1 owner loop with `ui-onboard`, the owner's day-9 sign-in (ask in plain English, exact command in the Mac handoff section 8), live gates.

## Rules that matter here

- Live Gmail runs only on the Mac (Keychain). Post `REQUEST | prov-emu | to integrator: live-run` in STATUS with the command, SHA and duration. Never print the test account's address or keys.
- Model routing (roadmap 5.1a): Sonnet default; Opus only for the send and live-run guard, auth and tokens, governor and sync correctness; governor and sync lint stay on Claude, never the free tier; one Sonnet review per PR of the diff; at most 4 subagents.
- Never merge to main; the Integrator merges. Commits as Kainoa Newton, ending with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Mocked or emulated Google never counts as live acceptance.
