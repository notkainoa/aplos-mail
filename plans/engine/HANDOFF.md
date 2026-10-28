# Engine thread handoff (written 2026-10-28 23:30, second lean thread; context past 150k)

Fresh Sonnet thread: read this, then `plans/lanes/eng-views.md`, roadmap 5.1a, and new STATUS lines only. Routing is unchanged (explicit model on every subagent, Opus only for the store commit path / window and undo correctness review, free OpenCode models for mechanical work with a Sonnet diff review). Never merge to main; push STATUS lines straight to `revamp` (pull first, check for conflict markers with `grep -E '^(<<<<|====|>>>>)'`; BSD sed needs `sed -i ''`).

## PR state (2026-10-29 02:45; all into `revamp`, the Integrator merges)

Merged: #46 runtime seam, #54 store, #57 views-1, #58 views-2, #47 eng-ai laneFor, #43 eng-host quit fix.

| PR | What | Branch @ head | State |
|---|---|---|---|
| #64 | frame filter follow-ups (a to d from the #46 review) | `rv/eng-contract/frame-follow-ups` | READY, check exit 0. Worktree `../rv-thread-engine-seam`. |
| #66 | views-3: Thread/act, receipts, Operation/undo\|get\|retry, Thread/get\|why\|open | `rv/eng-views/commands` | READY; revamp (squashed #58) merged in; Opus review done, fixed. Needs label `lane-approved:eng-contract` (edits tests/methods.test.ts and raises the portability budget to 450,000 unminified, recorded in DECISIONS.md); the label does not exist, REQUEST to integrator is in STATUS. |
| #68 | views-4: sender rules | `rv/eng-views/senders` @ 5942bf2 | READY, stacked on #66; Sonnet review done, fixed. Also edits tests/runtime.modules.test.ts (eng-contract, same label). |

Worktrees: `rv-thread-engine` (this dir, branch `rv/thread/engine`), `rv-thread-engine-views` (views branches; check out the one you need), `rv-thread-engine-seam`, `rv-thread-engine-win`, `rv-thread-engine-ai` (leftovers, may be removed with `git worktree remove`). Gaps found in views-4 for eng-store: `sender_rules` needs `lane`, `created_at`, `rev` columns, a unique key on `(account_id, address_or_domain)` and a `hidden_by` marker on `thread_workflow` (mail the ingest hook hid after a block stays hidden after unblock); also from views-3: no write for `last_read_at` (Thread/open), `reminderIfNoReply` has no column, nothing emits `operation` frames on provider settle (providers).

## Next actions

1. Answer any Integrator REQUEST on #46/#54/#57/#58 first (read new STATUS lines).
2. views-3 and views-4 are done and in PRs (#66, #68). Merge `revamp` into them as the stack lands (stacked branches conflict add/add on squash merges: take the revamp side for files a merged PR owns, keep ours for later additions, then rerun `npm run check`).
3. views-5 (conformance burn-down and E3 budgets) once the real-engine conformance runner and `expected-fail.engine.json` land on revamp (not there yet; the Integrator or Platform owns the runner). Meanwhile `Thread/open` remote path needs the provider port's `openThread` exposed through the runtime services.
4. Known gaps handed to others: the runtime has no commit subscription (views polls `store.seq()` every 50 ms; `services.views.committed()` is ready for `observeCommits`) and no connection-close hook (windows capped at 64 per connection); the frame bus and `eng-time` should wire both.
5. Parked lanes, resume in this order after their PR merges and a slot frees: eng-ai (ai-2 Demo, Setup/*; branch `rv/eng-ai/heuristic-lanes` merged, `rv/eng-ai/demo-data` local only), eng-time (fix the 10 clock-loop defects on `rv/eng-time/clock-loop`, then time-2 on `rv/eng-time/submissions`), eng-html (finish the sanitizer on `rv/eng-html/wip-pause-1028`, Opus security review), eng-host (host-1 to host-3; PRs on `rv/eng-host/*`). See the 2026-10-28 handoff table in git history (`git show 59e6470:plans/engine/HANDOFF.md`) for those SHAs.
6. Optional follow-ups from reviews, not blocking: raise the replay property test default from 80 to 1000 sequences if the CI budget allows (22 s); `lowSenders` sections can pass 150 KB near 2,000 senders; `events` view range validation is latent until prov-cal registers it.

## Open REQUESTs from Providers to engine (additive, within v:1; do these first, in a fresh thread)

STATUS 2026-10-28 23:56 (full text there): (1) `AccountActorHost.connect` / `ConnectRequest` need an `AbortSignal` so `Account/cancelConnect` stops the host's browser/loopback flow; (2) a way to discard a credential the host already stored when the engine refuses the result (`AccountActorHost.discardCredential(ref)` or a commit/rollback callback); (3) a `StepResult` field that clears a `sync_failures` row after a successful retry (store supports `failure: null`; the `sync/facts.ts` mapping is Providers'); (4) eng-store `AccountWrite`: colour tag, notifications switch, `accounts.settings`, an account-removal write kind; (5) `SearchResult` partial. Contract/ports.ts changes are eng-contract rules (Opus review for contract changes); `AccountWrite`/migrations are eng-store.
Also: #64 and #66/#68 were updated 2026-10-29 for the Integrator's second requests (windows get parked/appearance/clock host events, unknown frames withheld from everyone, minified bundle budget kept at 400,000 and printed; DECISIONS records 253,443/254,894 minified vs 426,360 unminified). Heads: #64 `ba0a223`, #66 `9120d53`, #68 `80e045f`.
