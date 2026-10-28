# Providers thread: handoff (lean mode, Linux, written 2026-10-28 evening)

> **What this means:** the governor is merged. The Gmail adapter, the OAuth first slice and the live-run guard fixes are all pushed with PRs and waiting on the Integrator. The next building work is blocked on other threads' PRs (#46 runtime seam, #54 real store), so a fresh thread starts by reading STATUS, not by coding.

Older handoff (long Mac version): `plans/providers/HANDOFF-2026-10-28-mac.md`. Lane cards: `plans/lanes/prov-gov.md`, `prov-gmail.md` on revamp. Linux: `source ~/.nvm/nvm.sh && nvm use 24`; worktrees under `~/.t3/worktrees/aplos-mail/` (`rv-prov-gov`, `rv-prov-gmail`, `rv-prov-emu`; make fresh ones from `origin` if they are gone). `check:sqlite` cannot run on Linux (needs the Electron binary): say so in the PR, the Integrator runs it.

## PRs

| PR | Branch @ SHA | State |
|---|---|---|
| #53 prov-gov governor, actor, host, shared HTTP | merged (e037fcc) | Opus review done; deferred findings in the PR comment (extra-budget costs not gated, overlapping block class lost on restart, logger lacks status and `target_changed`, config fix does not wake sleeping actors) |
| #56 prov-gmail adapter, emulator only | `rv/prov-gmail/adapter` @ 3861379 | READY. Sonnet review (9 findings) and fix-check done, all fixed with tests (`apps/desktop/tests/prov-gmail/review2-*.test.ts`). Fails owners:check only because OWNERS.md lacks its rows (requested) |
| #59 prov-gov OAuth first slice | `rv/prov-gov/oauth` | `host/providers/oauth/{scopes,client,grant}.ts`, 11 tests. Same OWNERS gap (`apps/desktop/tests/prov-gov/**`) |
| #38 prov-emu live-run guard | `rv/prov-emu/live` @ a349b7c | READY after the Integrator's 4 Musts and 5 Shoulds (Opus). Waits for its re-review of the fixes. No live run happens before it merges |

## Next actions

1. Read new STATUS lines (`git diff` since 2026-10-28 22:30 on origin/revamp). Answer any Integrator finding on #38 (Opus, security code), #56 or #59.
2. When the OWNERS rows land, re-run `npm run check` on #56 and #59 (merge `origin/revamp` first) and post the result.
3. **prov-gmail on the real store:** when #54 merges, move `google/sync.ts` and friends off the stand-in store onto `store.commit`; keep the quarantine, failure-count (`failures.ts`) and re-seeded backfill behaviour. Known gaps to close then: nothing retries a quarantined message; `SearchResult` has no partial flag (needs an eng-contract change, so an incomplete search throws); Inbox mail fetched after a history reset arrives through backfill and never notifies.
4. **prov-gov rest:** `TokenSource` over the vault (Opus review, token code), `methods/account.ts` and `methods/sync.ts` (needs #46 merged), `sync/lease.ts` (lease over the workflow channel; un-todos `gov-stack-attack` 05). Reconnect acceptance: queued changes survive, zero resync, on the Gmail emulator.
5. **prov-gmail PV3 remainder:** `workflow.ts` (D17, D18), P4 prefetch through `openThread(..., 'prefetch')`, Logger wiring (add `status` and method to `governor.paused`, emit `governor.target_changed`), G10 once eng-contract answers; then PV4 send/drafts/filters, prov-cal GoogleCalendarAdapter, day-2 port gaps (`plans/providers/port-gaps-day2.md` on the thread branch), feature-1 owner loop, the owner's day-9 sign-in, live gates (Mac only, via the Integrator).

## Rules that bit this session

- Lane PRs stacked on an unmerged PR show other lanes' files in owners:check; base them on the lower branch, then retarget.
- Never delete a branch before `gh pr view` says its PR is open: the Integrator squash-merges and deletes branches on its own schedule.
- Pre-commit hooks run ESLint with complexity <= 25; a commit that fails the hook does not happen (check `git log` after committing).
- Sonnet for work and review; Opus only for governor and sync correctness, auth and tokens, the send and live-run guards. Free OpenCode models were not used this session.
