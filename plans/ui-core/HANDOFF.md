# UI-core handoff (paused 2026-10-28 20:05 UTC; continues on kainoas-linux-mba)

Old thread (read-only, small reads): `mcp:aa2b408f-0841-47bb-a530-5ee96e45cf80`. It stopped on the owner's pause, with nothing running. Lean mode (roadmap 5.1a) applies: Sonnet by default, Opus only for named cases, and only the sections named in the lane cards.

## Open PR
- **#44** `rv/ui-foundation/f9` at `aed3782`: F9 freeze artifacts, contract swap, ui-screens component requests, data layer, motion runtime, api members, visual harness, hygiene pass. It is MERGEABLE (the Integrator already merged revamp in), with `lane-approved:ui-shell` applied. Still needed: `lane-approved:integrator` for the AGENTS.md design rule, then the Integrator's check, merge and `contract-v1` tag (neither exists yet).
- Last results on the PR head: typecheck green, tests green except prov-emu `clock.test.ts`, which is timing-flaky under load and passes alone.
- Optional low and informational findings from the ui-shell logic hygiene review were never fixed (the fix agent hit the usage limit). They do not block #44. Fix them only if the Integrator asks.

## Lanes (every branch below is pushed and contained in #44, unless noted)
| Lane | State | Branch / SHA |
|---|---|---|
| ui-foundation | F9 done: tokens, design lint, skill, 75 components, commands, harness with goldens, timing spike | `rv/ui-foundation/f9` aed3782 (parts: tokens 8fa28db, lint 0855ac1, skill 1e5185c, props 461cf57, commands 8ac151b, harness 3b075dd, hygiene-ui 8d26cf0, timing-spike 537d819) |
| ui-shell | Data layer, stand-in engine wiring, motion runtime, shell entry (`App.tsx`, `main.tsx`) and the frozen shell surface (sheets, command target, routes) are in #44. Real sidebar, pane header, status slot, toasts and states are NOT built | data-layer 00e96cc, motion a17d021, phase1-integration a0995c1, api-gaps 794a9cb, contract-swap 1da5496 |
| ui-home | Not started (no `renderer/screens/` yet) | none |
| ui-reader | Not started | none |
| mockups | Merged into revamp | `rv/ui/mockups` 3e5ed9d (Mac-local only, no remote, nothing to recover) |
| Integrator scratch | `rv/ui-foundation/integrator-check-44` 12eb6df is Mac-local; it carries no unique content, so ignore it | |

## Preserved uncommitted work (Mac only, left untouched)
- `rv-ui-lintcheck` (detached at 6ddceb9, 43 uncommitted entries): untracked renderer trees (`App.tsx`, `ui/`, `shell/`, `screens/`, `commands/`, `data/`), `packages/contract-fixture/`, contract and engine sources, and 2 modified `package.json` files. It looks like a scratch checkout that mixes in other lanes' work. It was NOT committed; the Mac owner or orchestrator decides whether to snapshot it. Do not build on it.
- Every other ui-core worktree was clean. No wip-pause branch was needed.

## Next 5 actions
1. Watch #44. If the Integrator reports red checks or review comments, fix them on `rv/ui-foundation/f9` (card `plans/lanes/ui-foundation.md`), push, and post HANDOFF-READY. Do not start new lanes on top of an unmerged contract.
2. After `contract-v1` is tagged, rebase new lane branches on `origin/revamp`. Start `ui-shell` (`plans/lanes/ui-shell.md`): sidebar, pane header, status slot, toasts, errors, empties. Branch `rv/ui-shell/shell`.
3. In parallel, start `ui-home` (`plans/lanes/ui-home.md`): Home first, then Later, lists, Done. Branch `rv/ui-home/home`. Both run on the stand-in engine. Cap at 4 concurrent subagents.
4. Use `eng-ai`'s #47 (heuristic Home lanes) for Home's lane and importance data once merged; until then the stand-in emulates it. Status values and `reconnectBy` come from `Fixture/control`.
5. Post HANDOFF-READY per lane with harness evidence (about 35 states, both themes, two sizes). The owner approves visuals per feature (roadmap section 12) before any PR. Leave `ui-reader` parked until Home and the shell are approved.

## Running things (Linux, repo root)
- Always: `npm run check` before commit; `npm run typecheck`; `npm test`; `npm run owners:check`.
- Renderer unit tests: `cd apps/desktop && npx tsx --test 'src/renderer/shell/*.test.ts'` (same shape for `data`, `motion`).
- Visual harness (headless Chromium, never headed): `npx playwright test -c tests/visual/playwright.config.ts` (add `--project 1440x900`, `hover.spec`, or `-g <state>`); look at shots with `node tests/visual/contact-sheet.mjs 1440x900 0 4`. See `tests/visual/README.md`.

## Needs macOS or Electron (route to the Mac via REQUEST to the Integrator)
- Packaged-app timing numbers (Event Timing, LoAF) and the owner's feel check of triage motion (U4 acceptance 6 and 7).
- WP5.6 switch to the real engine on real mail; live Gmail runs (Keychain).
- Playwright Electron with `APLOS_TEST=1` and a temp `APLOS_DATA_DIR`. The Linux harness uses the browser gallery only.

## Decisions in flight
- None open. Standing choices: one dependency PR for F9 plus the base (accepted 06:34); `no-descending-specificity` is off for the new renderer tree; ReconnectSheet in grant mode says "Grant access for <address>".
