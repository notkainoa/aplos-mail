# Lane card: prov-gov (Providers thread, Linux)

**Goal.** One budget keeper per account and one retry layer, per-account sync actors, and OAuth readiness with the weekly reconnect (plan 20 PV2 and PV5). The first half is built and waiting for a PR; the second half is not started.

**State (pushed to origin).** `rv/prov-gov/engine-sync` at `966da0b`: governor, account actor, `AccountActorHost`, shared no-retry HTTP, 113/113 sync tests; format, lint, CSS lint and owners passed, typecheck and tests not yet re-run. Do not use `rv/prov-gov/actor`, `rv/prov-gov/governor`, or the `wip-pause-1028` branches. Handoff: `plans/providers/HANDOFF.md`.

**Owned paths** (`plans/OWNERS.md` row `prov-gov`): `packages/engine/src/sync/**`, `packages/engine/tests/sync-*.ts`, `packages/engine/tests/sync/**`, `apps/desktop/src/host/providers/{shared,oauth}/**`, `packages/engine/src/methods/{account,sync}.ts`, `apps/desktop/src/main/oauth-config.ts` until it moves, `apps/desktop/scripts/oauth-defines.*`. Not yours: `google/**` (prov-gmail), `packages/engine/src/store/**` (eng-store).

**Read, and only this** (`plans/20-providers-sync.md`; `grep -n '^###' plans/20-providers-sync.md` to re-check lines):
- 128-188: module layout, the adapter port, error mapping.
- 290-307: PV2 deliverables and acceptance.
- 348-371: PV5 (client resolution, scope manifest, granted scopes, weekly reconnect steps 1-6).
- 215-255: Gmail pacing rules the governor must honour.
- 464-491: test rules and the live-runner contract.
Also `plans/providers/port-gaps-day2.md` (G1 `bindConnect`, G10 `progress.read`) and roadmap 5.1a (lines 333-380).

**Jobs, in order.**
1. Worktree from `origin/rv/prov-gov/engine-sync`; `git merge origin/revamp`; run the checks below; open a dependency PR into `revamp` (Integrator merges). Body: governor and actor are tested end to end in the Gmail branch's `e2e*.test.ts`.
2. `host/providers/oauth/**`: client resolution, scope manifest plus its test, granted-scope handling, a `TokenSource` over the vault.
3. `methods/account.ts` (`connect`, `reconnect`, `grantPermissions`, `lease`) and `methods/sync.ts` (`Sync/request`).
4. `sync/lease.ts` (primary-device lease over the workflow channel); this un-todos `gov-stack-attack` 05.

**Done when.** Fake-clock tests cover escalation (60 s, 5 min, 15 min, 1 h), reset after 10 quiet minutes, daily stop, AIMD halve and regrow; scope-manifest test green; reconnect keeps queued changes and causes no resync on the Gmail emulator; `npm run check` exit 0 with the owners check OK.

**Test commands** (repo root, after `npm ci`).
- `npx tsx --test packages/engine/tests/sync-*.ts packages/engine/tests/sync/*.test.ts`
- `npm run typecheck`
- `npx eslint packages/engine/src/sync apps/desktop/src/host/providers`
- `npm run check`, then `npm run owners:check` (lane is inferred from the branch `rv/prov-gov/<slug>`).

**Models.** Sonnet for work and review. Opus only for governor correctness and token handling. Lint of governor or sync code stays on Claude, never the free tier. At most 4 subagents.
