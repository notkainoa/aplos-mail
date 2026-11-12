# Plan 004: Wall-clock test ceilings stretch when the machine is busy

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/improve/README.md` — unless a reviewer dispatched you and told you
> they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 8a254600..HEAD -- packages/mail-html/tests packages/engine/tests packages/emulators/tests apps/desktop/tests apps/desktop/src/renderer`
> Changes elsewhere in those folders are fine; only re-check the exact lines
> listed in the table below. If a listed line moved, find it by its text; if
> its text changed, treat that row as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `8a254600`, 2026-11-11
- **Suggested executor**: Devin SWE-2 or any careful model (mechanical edits, no UI)

## Why this matters

About 26 assertions check that some work finished under a fixed number of
milliseconds. Their purpose is to catch a quadratic blow-up (work that should be
linear taking seconds), not to measure speed. On the shared agent Mac several
threads run checks at once (load averages of 15-60 are recorded in
`plans/STATUS.md`, e.g. the 2026-11-11 providers entry: "2 steps FAIL, both
timing/perf assertions under load"), and these ceilings fail even though nothing
is wrong. Each false red costs a rerun of the full `npm run check` and review
rounds. After this plan, those ceilings are multiplied by a slack factor when
the machine is loaded, so a quadratic blow-up (typically 100x or more) still
fails while normal load noise does not.

## Current state

There is no shared timing helper today; each test hard-codes its ceiling, e.g.
`packages/engine/tests/outbox/drafts.echo.test.ts:376-378`:

```ts
  // A long run of line breaks costs nothing.
  const start = performance.now();
  fingerprintOf(fields({ html: `x${'\r\n'.repeat(500_000)}y` }));
  assert.ok(performance.now() - start < 500);
```

and `packages/mail-html/tests/sanitize.test.ts:678-681`:

```ts
    const deep = `${'<div>'.repeat(100_000)}bottom${'</div>'.repeat(100_000)}`;
    const start = performance.now();
    const result = html(deep);
    assert.ok(performance.now() - start < 1_000);
```

Each workspace's `tsconfig.json` has no `rootDir`, and all of them set
`"include"` to their own `src`/`tests` only, but TypeScript still type-checks a
file imported by relative path from outside, so a helper at the repo root can
be imported from any test.

### Sites to change (scale the ceiling)

These are "bounded work" checks. Wrap the number with `budget(...)`:

| File:line | Today |
|---|---|
| `packages/mail-html/tests/perf.test.ts:102` | `median < MEDIAN_BUDGET_MS` |
| `packages/mail-html/tests/perf.test.ts:108` | `p99 < P99_CEILING_MS` |
| `packages/mail-html/tests/perf.test.ts:163` | `ms < 300` |
| `packages/mail-html/tests/sanitize.test.ts:681` | `< 1_000` |
| `packages/mail-html/tests/css.test.ts:298` | `< 1500` |
| `packages/engine/tests/outbox/drafts.echo.test.ts:378` | `< 500` |
| `packages/engine/tests/outbox/drafts.inline.test.ts:136` | `took < 500` |
| `packages/engine/tests/sync-unsubscribe-facts.test.ts:77` | `< 500` |
| `packages/engine/tests/diag/hostile.test.ts:202` | `< 1000` |
| `packages/engine/tests/calendar-recurrence-hardening.test.ts:48,84,99,204` | `ms < 5000/100/1500/5000` |
| `packages/engine/tests/calendar-recurrence-fuzz.test.ts:879,899` | `ms < 1000` |
| `packages/emulators/tests/live-attack.test.ts:598` | `< 5_000` |
| `apps/desktop/tests/prov-gmail/list-auth.test.ts:142` | `< 200` |
| `apps/desktop/tests/prov-gmail/unsubscribe.test.ts:119` | `< 500` |
| `apps/desktop/tests/eng-contract/payload.test.ts:119,128,144,153,164` | `run.ms < 200/100` |
| `apps/desktop/src/renderer/mailframe/host.test.tsx:81` | `elapsed < 100` |
| `apps/desktop/src/renderer/mailframe/sanitise.test.ts:319,418` | `elapsed < MAX_MS` |

### Sites to leave alone (they check which timeout fired)

These compare a short fake timeout against a long real one; their margins are
already 20-40x and scaling them could hide the very bug they test. Do **not**
change them:

- `apps/desktop/tests/eng-html/proxy-hardening.test.ts:316` (40 ms bound vs 3 s limit)
- `apps/desktop/tests/eng-html/ssrf.test.ts:613` (50 ms timeout vs 2 s)
- `apps/desktop/tests/eng-host/lifecycle.test.ts:87` (3 s drain on a 1/100 timer)
- `packages/emulators/tests/clock.test.ts:20` (fake clock must not sleep for real)
- `apps/desktop/src/renderer/screens/compose/runtime/flushComposeSessions.test.ts:67` (40 ms limit vs 1 s)

## Commands you will need

| Purpose | Command (from the repo root) | Expected on success |
|---|---|---|
| Install | `npm ci` | exit 0 |
| mail-html tests | `npm test -w @aplos/mail-html` | all pass |
| emulator tests | `npm test -w @aplos/emulators` | all pass |
| engine tests | `npm run test:engine` | all pass |
| desktop tests | `npm test -w @aplos/desktop` | all pass |
| Typecheck | `npm run typecheck` | exit 0 |
| Full gate | `npm run check` | exit 0 |

## Scope

**In scope**:
- `tests/support/timing.ts` (create)
- `tests/support/timing.test.ts` (create)
- every file in the "Sites to change" table, only on the listed lines plus one import line each

**Out of scope**:
- The "leave alone" files above.
- `tests/e2e/**`, `tests/visual/**`, `budgets.json`, `scripts/audit/**` (owned by the platform lane; this plan needs none of them).
- Changing what any test measures, its input sizes, or its round counts.

## Git workflow

- Branch from `origin/revamp`: `rv/improve/004-timing-slack`.
- Commit style: `Tests: wall-clock ceilings stretch under machine load (improve 004)`.
- `npm run check` before each commit; author Kainoa Newton <k@kainoa.me>. Never touch `main`.

## Steps

### Step 1: Write the helper

Create `tests/support/timing.ts`:

```ts
import { availableParallelism, loadavg } from 'node:os';

/** How much a wall-clock ceiling stretches: `APLOS_TIMING_SLACK` when set, else 4 on a loaded machine, else 1. */
export function timingSlack(env: NodeJS.ProcessEnv = process.env): number {
  const set = Number(env.APLOS_TIMING_SLACK);
  if (Number.isFinite(set) && set >= 1) return set;
  return loadavg()[0] > availableParallelism() ? 4 : 1;
}

/** A test's wall-clock ceiling in ms, stretched by `timingSlack()`. For bounded-work checks only, never timeout checks. */
export function budget(ms: number): number {
  return ms * timingSlack();
}
```

Create `tests/support/timing.test.ts` with `node:test`:
- `timingSlack({ APLOS_TIMING_SLACK: '3' })` → `3`.
- `timingSlack({ APLOS_TIMING_SLACK: '0.5' })` → `1` or `4` (not `0.5`).
- `budget(100) >= 100`.

**Verify**: `npx tsx --test tests/support/timing.test.ts` → 3 pass.

### Step 2: Change each listed site

For each row in "Sites to change": add one import at the top of the file, with
the right relative path to `tests/support/timing` (count the folders; e.g. from
`packages/engine/tests/outbox/` it is `'../../../../tests/support/timing'`), and
wrap the ceiling: `assert.ok(x < budget(500), ...)`. For named constants
(`MEDIAN_BUDGET_MS`, `P99_CEILING_MS`, `MAX_MS`), wrap at the comparison, not
at the constant's definition.

Do one workspace at a time and run its tests before the next:
mail-html → emulators → engine → desktop.

**Verify** after each workspace: its test command from the table → all pass.

### Step 3: Prove the slack is wired

Run one changed file with an absurd slack and one with none:
`APLOS_TIMING_SLACK=1000 npx tsx --test packages/mail-html/tests/sanitize.test.ts` → pass.

**Verify**: `grep -rn "< budget(" packages/*/tests apps/desktop/tests apps/desktop/src/renderer | wc -l` → 26 (one per row-site in the table; today it is 0).

### Step 4: Full gate

**Verify**: `npm run typecheck && npm run check` → exit 0.

## Test plan

- `tests/support/timing.test.ts` (3 cases, Step 1).
- Every changed test must still pass on a quiet machine with no env var.

## Done criteria

- [ ] `tests/support/timing.ts` and its test exist and pass
- [ ] Every "Sites to change" line uses `budget(`
- [ ] None of the "leave alone" lines changed (`git diff` shows no hunk in those five files)
- [ ] `npm run check` exits 0
- [ ] `plans/improve/README.md` status row updated

## STOP conditions

- A listed line no longer contains the comparison described (drift).
- `npm run typecheck` fails because a workspace cannot resolve `node:os` types
  from `tests/support/timing.ts` (e.g. `packages/mail-html`'s main tsconfig has
  `"types": []`). Report which workspace; do not add `@types` to it.
- `owners:check` rejects the new `tests/support/` folder. Report it; the
  integrator decides where shared test helpers live.
- A test fails on a quiet machine after your change (you changed more than the
  ceiling).

## Maintenance notes

- New bounded-work tests should use `budget(ms)`; timeout-logic tests should not.
- `local-ci.sh` may set `APLOS_TIMING_SLACK` explicitly when it knows it runs in
  parallel; that is a platform-lane decision, not part of this plan.
- Reviewer: check that every changed assertion still has a ceiling at least 10x
  below what a quadratic version of the code would take (i.e. the input sizes
  and round counts did not change).
