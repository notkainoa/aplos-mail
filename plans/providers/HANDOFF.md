# Providers thread: handoff (lean mode, Linux, written 2026-10-29 ~04:30)

> **What this means:** the second Linux session built the whole prov-gov second half and the prov-gmail real-store/workflow work. Everything is either merged, open with the Integrator, or committed locally in a worktree waiting for a push and PR. A fresh thread starts by reading new STATUS lines, then finishes the open items below.

Linux: `source ~/.nvm/nvm.sh && nvm use 24`. Worktrees under `~/.t3/worktrees/aplos-mail/` (a new worktree needs `cp -a ../rv-prov-gov/node_modules ./node_modules`; copying keeps the relative workspace links). **STATUS posting:** `/tmp/status-post.sh "<line>"` appends to origin/revamp from the throwaway worktree `rv-prov-status` (recreate: `git worktree add --detach ../rv-prov-status origin/revamp`, then fetch/checkout/append/commit/`git push origin HEAD:revamp`). Full `npm run check` takes 10-25 min on this box when it is loaded: run it in the background with `timeout: 3600000` and wait with an `until grep -q '^exit' log` loop (`t3_background_wait` returns at once). `check:sqlite` cannot run on Linux. The wake-up notices from background agents arrive as task notifications.

## PRs

| PR | Branch | State |
|---|---|---|
| #53 governor, #56 Gmail adapter, #59 OAuth first slice, #38 live-run guard, #65 Sync/request, #67 guard follow-ups, #70 Gmail on the real store | | merged |
| #69 GoogleTokenSource over the vault | `rv/prov-gov/token-source` | open, READY; token code, needs the Integrator's Opus review |
| #73 Gmail workflow channel | `rv/prov-gmail/workflow` | open, READY; sync+crypto code, Opus review |
| #72 Google sign-in flow (PKCE loopback, id_token, vault after checks) | `rv/prov-gov/oauth-flow` | open, READY, stacked on #69 (retarget to revamp after #69 merges); OAuth code, Opus review |
| #71 Account/* handlers | `rv/prov-gov/account` | open, READY; only blocked by the engine-size budget (engine moves it to a minified measure in #66) |

## Local only (committed, not pushed, no PR yet)

- (done) workflow channel is PR #73 (open, READY). The lease branch below is based on it.
- `rv/prov-gov/lease` in `rv-prov-lease` (Opus agent a49d5fd5 was running): `packages/engine/src/sync/lease.ts` (`decideLease` pure, `createLeaseController`), tests `packages/engine/tests/sync-lease.test.ts`, un-todo `gov-stack-attack` 05. Based on the workflow branch, so its PR must wait for the workflow PR (stack, base `rv/prov-gmail/workflow`, retarget later). Needs a Sonnet review of the diff, then an Opus final review by the Integrator (sync correctness).

## Integrator findings in flight (answered by agents at 2026-10-29 ~05:30; verify they landed)

- #69 (Opus review, FIX): non-JSON error bodies must not feed providerMessage (form-encoded secret echo), #private token fields, test-only tokenUrl. Agent aa018c23 (Opus) in `rv-prov-token`; then merge `rv/prov-gov/token-source` into `rv/prov-gov/oauth-flow` (#72).
- #71 (Opus auth review): refuse a grant missing gmail.modify in all three accept paths (`permission.mailModify`), emit `waiting` inside the try, cap 3 sign-ins + 10-minute engine deadline, retried new account records the grant on the old id. Agent af63b7fa (Sonnet) in `rv-prov-account`.
- BINDING for the host Google connect wiring PR (will not merge without them): the host keeps the credential pending and saves it only after the engine accepts the identity (or compares `req.address` when there is no expectedSubject), and the `AbortSignal` reaches the loopback/browser flow through the port (needs the engine REQUEST at 2026-10-28 23:56).
- Lease PR: `rv/prov-gov/lease` @ 5df4372 (stacked on #73, `Lane-Approved: prov-gmail` trailer for the un-todo of gov-stack-attack 05); Sonnet review agent a6eab3c4 was running; push, PR (base `rv/prov-gmail/workflow`), READY after its fixes.

## Open items, in order

1. Finish the two local branches above (check, push, PR, Sonnet review for lease, READY in STATUS).
2. Answer Integrator findings on #69, #71, #72 at once (token/OAuth fixes go to Opus).
3. **Wire connect into the adapter** (`google/adapter.ts`, prov-gmail-owned): `connect?: GoogleConnect` in `GoogleProviderOptions`, fall back to the NotInThisLaneError stub; the host must pass `governor.bindConnect(account)` and a `grantedScopes(accountId)` dep. `connect.ts` has a copy of the test rig's capabilities; replace with the adapter's real set.
4. Workflow wiring: the adapter planner does not schedule workflow rounds yet; workflow facts are not committed (a round result has no field for them, engine must commit); lease.ts must call the channel. Open design item: each Mac has its own data key, so two Macs cannot read each other's sealed copies; `Workflow/enable` pairing must share a key (engine `methods/workflow.ts`, prov-gmail owns it).
5. Live checks (Mac only, via the Integrator, `plans/LIVE-RUNS.md`, tier R first): the workflow insert endpoint (`TODO(live)` on `INSERT_PATH`: `/messages/insert` vs `POST users/me/messages`), the prompt=consent behaviour on reconnect.
6. When the engine thread lands the additive port changes (posted as REQUEST in STATUS at 2026-10-28 23:56: `AbortSignal` on `AccountActorHost.connect`, `discardCredential`, `StepResult` clear-failure plus my mapping in `sync/facts.ts`, `AccountWrite` colour/notifications/settings/removal, `SearchResult` partial flag), finish: remove the `TODO(port)` marks in `sync/account-connect.ts` / `connect-sessions.ts`, implement `Account/set` colour+notifications and the data removal in `Account/disconnect`, un-todo test `RV-4` in prov-gmail, call `disposeConnectSessions` from the prov-gov module `stop`.
7. PV3 rest: P4 prefetch through `openThread(..., 'prefetch')`, Logger wiring (`status` and method on `governor.paused`, `governor.target_changed`, a catalog event for skipped workflow copies), G10 `progress.read` once eng-contract answers; then PV4 send/drafts/filters, prov-cal GoogleCalendarAdapter, day-2 port gaps (`plans/providers/port-gaps-day2.md`), feature-1 owner loop, the owner's day-9 sign-in.
8. Deferred findings worth knowing: #53's list (extra-budget costs not gated, overlapping block class lost on restart, logger lacks status, config fix does not wake sleeping actors); `main/vault.ts` restores the old value when a write fails and can overwrite a reconnect that landed in between (needs compare-and-set; plan 10 / platform); workflow view has one uncapped per-process map; stale doc comments in `provider.ts` (`loginHint` says select_account; `ConnectResult.grant` says reconnectBy = grant+7d but `grant.ts` subtracts an 18 h margin).

## Decisions made this session (also in DECISIONS.md or the PRs)

- Reconnect and new connect always send `prompt=consent access_type=offline` (Integrator's #59 review); a bundled Desktop-client secret is allowed, API keys are not.
- `reconnectBy` carries an 18 h margin (at most half the lifetime).
- Workflow retention: 180 days for cleared thread records and old lease records.
- Engine budget: engine thread moved the portability test to the minified bundle (400,000 minified).

## Rules that bit

- Subagent worktrees have no node_modules: copy it from `rv-prov-gov` before they start.
- Never `sleep` in the shell (blocked); wait with `until <cond>; do sleep N; done` in a foreground command under 600 s or in the background.
- `git revert -q` can fail silently; check `git log`.
- Routing used: Opus for token, OAuth, guard, sync-correctness fixes, workflow, lease; Sonnet for Sync/request, Account handlers, Gmail real store and every review. No free OpenCode models were used.
