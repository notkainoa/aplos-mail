# Lane card: ui-foundation (#44 fixes only)

**Goal.** Get PR #44 (`rv/ui-foundation/f9`, `aed3782`) green and merged so `contract-v1` can be tagged. After the merge this lane is additive-only maintenance for components other lanes request.

**Owned paths** (`plans/OWNERS.md` line 41). `renderer/{ui,commands}/**`, `scripts/design/**`, `tools/lint/design/**`, `.claude/skills/aplos-design/**`, `tests/{visual,perf}/**`, `assets/fonts/**`, contrast check, stylelint config. Changes to F9 props are additive and announced with HANDOFF-READY.

**Read only.** `plans/ui-core/HANDOFF.md`, the PR #44 comments and checks (`gh pr view 44 --comments`), the failing file itself. Nothing else unless a fix needs a DESIGN section (name it from `plans/DESIGN.md` headings).

**Open items.** The Integrator must apply `lane-approved:integrator` for the AGENTS.md design rule. Optional: low-severity hygiene findings in `renderer/data/` (ui-shell's); skip unless asked. A prov-emu `clock.test.ts` failure under load is not ours.

**Done.** `npm run check` green on the PR head; Integrator merges; `contract-v1` tagged and FROZEN posted.

**Tests.** `npm run check`; `npm run owners:check -- --pr 44`; visual harness `npx playwright test -c tests/visual/playwright.config.ts`. Sonnet only.
