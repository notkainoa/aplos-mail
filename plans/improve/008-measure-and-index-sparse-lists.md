# Plan 008: Measure the sidebar counts and sparse lists at 100k threads, then index what is slow

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/improve/README.md` — unless a reviewer dispatched you and told you
> they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 8a254600..HEAD -- packages/engine/src/views packages/engine/src/store/migrations packages/engine/tests/views/explain.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M (Part A is S and may end the plan)
- **Risk**: MED (a schema migration; engine core byte budget is nearly full)
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `8a254600`, 2026-11-11
- **Suggested executor**: Claude Sonnet 5.5 for Part A; Part B only after the
  owner or integrator reads Part A's numbers. Consider Opus for Part B (schema
  plus engine budget trade-offs).

## Why this matters

Three read paths in the new engine scale with the **whole mailbox** rather than
with what they show, all on the engine's single writer process:

1. **Sidebar counts.** `Counts/get` recomputes the full Home layout once for
   every account and once more for "all accounts", on every call, with no
   cache. Every count is a `count(*)` over Home's cursors.
2. **Bookmarks and "needs reply" / "awaiting reply" lists.** They filter
   `thread_workflow` on `bookmarked` or `reply_status`, columns no index covers,
   and the cursor is forced onto the `wf_status` index (`INDEXED BY`). A list
   that holds 10 bookmarked threads walks every thread in each status range to
   find them, for each page and again for the layout count.
3. **Starred**, the same pattern with an `EXISTS` probe into `threads.flagged`.

The existing query-plan test (`explain.test.ts`) passes because these are index
**range** walks, not table scans, so nothing flags them. Whether they are slow
enough to matter at the owner's size is unmeasured, so Part A measures first,
and Part B only runs if the numbers say so.

## Current state

- `packages/engine/src/views/counts.ts:61-70` and `:116-122`:

```ts
function block(q: StoreReader, env: ViewEnv, accountId?: string): CountsBlock {
  const home = compileView({ kind: 'home', accountId }, env).layout(q).sections;
  // ...
}

export function readCounts(q: StoreReader, env: ViewEnv): Counts {
  const accounts: Record<string, CountsBlock> = {};
  for (const id of accountIds(q)) accounts[id] = block(q, env, id);
  const folders: Record<string, number> = {};
  for (const f of readFolders(q)) folders[f.id] = f.unread;
  return { all: block(q, env), accounts, folders };
}
```

- `packages/engine/src/views/windows.ts:496` — `counts: () => store.read(q => readCounts(q, viewEnv(q, clock.now(), zone))),` (no memo; the renderer re-reads on every `Counts` change type in a `state` frame: `apps/desktop/src/renderer/data/session.ts:119-129`).
- `packages/engine/src/views/lists.ts:40-51` — every workflow list cursor uses `INDEXED BY wf_status`:

```ts
export function wfCursor(preds: Pred[], key: KeyCol[] = NEWEST_WF, index = 'wf_status'): CursorDef {
  return {
    from: 'thread_workflow w',
    index,
    // ...
```

- `packages/engine/src/views/lists.ts:170-177`:

```ts
      case 'bookmarks':
        return [statusRun([['w.bookmarked = 1'], shown], spec.accountId)];
      case 'replyState':
        return [statusRun([['w.reply_status = ?', spec.status], shown], spec.accountId)];
```

- Indexes on `thread_workflow` today (`packages/engine/src/store/migrations/0001_initial.ts:88-91`,
  `0004_reminder_index.ts:9`): `home`, `wf_status(status, last_date DESC, thread_id)`,
  `wf_later`, `timers_wf`, `reminders_wf`. None on `bookmarked` or `reply_status`.
- Migration pattern to copy (`packages/engine/src/store/migrations/0004_reminder_index.ts`):

```ts
import type { Migration } from '../migrate';

/*
 * `mail.db` schema 0004, additive (0001 to 0003 are frozen). ...
 */
const statements: string[] = [
  `CREATE INDEX IF NOT EXISTS reminders_wf ON thread_workflow(reminder_at) WHERE reminder_at IS NOT NULL`,
];

export const migration0004: Migration = {
  version: 4,
  name: 'reminder-index',
  sql: statements.join(';\n') + ';\n',
};
```

  and register it in `packages/engine/src/store/migrations/index.ts` (append only).
- The benchmark harness: `packages/engine/tests/views/explain.test.ts` builds a
  100,000-thread database (`populate` in `tests/views/big.ts`) and, with
  `APLOS_VIEWS_TIMINGS=1`, prints first-page and layout timings for every spec
  in `BENCH_SPECS` (`packages/engine/src/views/registry.ts:109-134`, which
  includes `bookmarks`, both `replyState`s and `mailbox starred`). It asserts
  no table scan and prints timings without asserting them.
- **Engine core byte budget.** `budgets.json` (`size.engine-bundle`) caps the
  engine core at 470,000 bytes; `plans/STATUS.md` (integrator, 2026-11-11, #480)
  records 469,026 used, **974 bytes left**, and "no core-bound PR merges unless
  it is lazy or the owner raises the limit". Migrations and `views/` are core.
  `packages/engine/tests/portability.test.ts` enforces it.

## Commands you will need

| Purpose | Command (from the repo root) | Expected on success |
|---|---|---|
| Install | `npm ci` | exit 0 |
| Timings (≈30 s) | `APLOS_VIEWS_TIMINGS=1 node scripts/audit/electron-node.mjs --import tsx --test packages/engine/tests/views/explain.test.ts` | pass; prints one line per spec |
| Views tests | `node scripts/audit/electron-node.mjs --import tsx --test 'packages/engine/tests/views/*.test.ts'` | all pass |
| Core budget | `node scripts/audit/electron-node.mjs --import tsx --test packages/engine/tests/portability.test.ts` | pass |
| Engine suite | `npm run test:engine` | all pass |
| Full gate | `npm run check` | exit 0 |

## Scope

**Part A in scope**: `packages/engine/tests/views/explain.test.ts` (add a
printed `Counts` timing inside the opt-in test only); a results file
`plans/improve/results/008-timings.md` (create).

**Part B in scope** (only if Step 3 says go):
- `packages/engine/src/store/migrations/0008_sparse_list_indexes.ts` (create)
- `packages/engine/src/store/migrations/index.ts` (append one entry)
- `packages/engine/src/views/lists.ts` (pass the new index name to `wfCursor` for the two kinds)
- `packages/engine/src/store/SCHEMA.md` (document the indexes)

**Out of scope**: caching `Counts/get` (needs a design call on invalidation;
record numbers only), Starred (needs a schema change to `thread_workflow`),
anything in `apps/desktop`, raising the byte budget.

## Git workflow

- Branch from `origin/revamp`: `rv/improve/008-sparse-list-indexes`.
- Commit style: `Views: measure counts and sparse lists at 100k (improve 008)`; Part B: `Store: partial indexes for Bookmarks and reply-state lists (improve 008)`.
- `npm run check` before each commit; author Kainoa Newton <k@kainoa.me>. Never touch `main`.

## Steps

### Part A — measure

#### Step 1: Add a Counts timing to the opt-in benchmark

In the `APLOS_VIEWS_TIMINGS` test in `explain.test.ts`, after the spec loop,
time `readCounts(q, ENV)` (import from `../../src/views/counts`) 5 times and
print the median with the same `console.log` style. Add nothing that runs
without `APLOS_VIEWS_TIMINGS`.

**Verify**: the Views tests command → all pass (the opt-in test is skipped).

#### Step 2: Run it on a quiet machine

Check the load first: `uptime`. If the 1-minute load average is above the
number of cores (`sysctl -n hw.ncpu` on macOS), wait or say so in the results.
Run the Timings command three times. Write
`plans/improve/results/008-timings.md` with: machine, load average, and for each
of `home`, `bookmarks`, `replyState needsReply`, `replyState awaitingReply`,
`mailbox starred`, `mailbox inbox` (as a baseline), and `Counts`, the median
page and layout times across the three runs.

**Verify**: the file exists and has those 7 rows.

#### Step 3: Decide

Go to Part B only if `bookmarks` or either `replyState` has a layout or page
median above **20 ms** at 100,000 threads, **or** above 5x the `mailbox inbox`
baseline. Otherwise mark this plan DONE in the index with the numbers ("measured,
not worth indexing") and stop.

Report the `Counts` median either way. If it is above 50 ms, say so in the
report: that is the case for a follow-up caching plan, which needs the
owner's or integrator's call.

### Part B — index (only if Step 3 says go)

#### Step 4: Check the budget first

Run the Core budget command and read the printed core size. If fewer than
**400 bytes** remain, STOP (see STOP conditions).

#### Step 5: Add migration 0008

Create `0008_sparse_list_indexes.ts` following `0004_reminder_index.ts`:

```ts
const statements: string[] = [
  `CREATE INDEX IF NOT EXISTS wf_bookmarked ON thread_workflow(status, last_date DESC, thread_id) WHERE bookmarked = 1`,
  `CREATE INDEX IF NOT EXISTS wf_reply ON thread_workflow(status, reply_status, last_date DESC, thread_id) WHERE reply_status IS NOT NULL`,
];
export const migration0008: Migration = { version: 8, name: 'sparse-list-indexes', sql: statements.join(';\n') + ';\n' };
```

Append `migration0008` to `MIGRATIONS` in `index.ts`.

**Verify**: `node scripts/audit/electron-node.mjs --import tsx --test 'packages/engine/tests/store/*.test.ts'` → all pass.

#### Step 6: Point the two list kinds at the new indexes

In `lists.ts`, `statusRun` builds cursors with `wfCursor(preds, key)`. Give
`statusRun` an optional `index` parameter passed through to `wfCursor`, and
call it with `'wf_bookmarked'` for `bookmarks` and `'wf_reply'` for
`replyState`. For `wf_reply`, the predicate order must let SQLite use
`(status, reply_status, ...)`: keep `w.status = ?` and add `w.reply_status = ?`
as today.

**Verify**: Views tests → all pass, including `explain.test.ts` (no SCAN).

#### Step 7: Re-measure and check the budget

Re-run Step 2 once and append "after" numbers to the results file. Run the Core
budget command.

**Verify**: bookmarks/replyState layout and page medians dropped; the budget
test passes.

#### Step 8: Document and gate

Add the two indexes to `packages/engine/src/store/SCHEMA.md` next to the other
`thread_workflow` indexes, with one line each on why.

**Verify**: `npm run test:engine && npm run check` → exit 0.

## Test plan

- Part A: the opt-in timing (printed, not asserted, matching the file's rule
  "Timings are printed for the record, not asserted").
- Part B: the existing `explain.test.ts` no-scan check covers the new plans;
  existing views tests cover results staying the same.

## Done criteria

- [ ] `plans/improve/results/008-timings.md` has the 7 rows (and "after" rows if Part B ran)
- [ ] Part B only: migration 0008 registered; `grep -n "wf_bookmarked\|wf_reply" packages/engine/src/views/lists.ts` finds both
- [ ] `npm run test:engine` and `npm run check` exit 0; portability (budget) test passes
- [ ] `plans/improve/README.md` status row updated with the decision and numbers

## STOP conditions

- Excerpts no longer match (drift).
- Fewer than 400 bytes of engine core budget remain at Step 4, or the budget
  test fails at Step 7. Report the numbers; a raise is an owner decision.
- The new indexes are not used (`EXPLAIN QUERY PLAN` still shows `wf_status`)
  even with `INDEXED BY`: report the plan output.
- Any views test changes its expected rows (the indexes must not change what a
  list shows).
- The machine is loaded during every run and the numbers vary by more than 3x
  between runs: report them as unreliable and stop at Step 3.

## Maintenance notes

- `Counts/get` caching (memo on `store.seq()` plus the minute) is the likely
  bigger win if Step 3 shows a high Counts time; it was deliberately left out
  because invalidation interacts with the window layer's throttles
  (`packages/engine/src/views/windows.ts:34-36`).
- Starred needs `flagged` on `thread_workflow` (or a different cursor) to be
  indexable; out of scope.
- Every extra index costs a little on each write to `thread_workflow`; partial
  indexes keep that to the few rows that match.
