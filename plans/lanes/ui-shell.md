# Lane card: ui-shell (UI-core thread, Linux)

**Goal.** Build the real app shell on the stand-in engine: gray shell, regrouped sidebar, pane header, status slot (including the weekly-reconnect line), toasts and trays, inline errors, `FatalScreen`, empty states. The data layer and motion runtime already exist in #44; this lane finishes the shell and later switches to the real engine (WP5.6, Phase 2, needs `eng-views` conformance green).

**Start from.** `origin/revamp` after #44 merges and `contract-v1` is tagged. Branch `rv/ui-shell/shell`. Read `plans/ui-core/HANDOFF.md` (on `rv/thread/ui-core`) first.

**Owned paths** (`plans/OWNERS.md` line 42). `apps/desktop/src/renderer/{data,shell,motion}/**`, `renderer/{App,main}.tsx`, `renderer/bridge.ts`, `apps/desktop/index.html`. Components come from `renderer/ui/**` (ui-foundation's); do not edit them, send a REQUEST. Shell functions other lanes call (`openSheet`, `useCommandTarget`, `openRoute`) are frozen: additive changes only.

**Read only these.**
- `plans/30-ui-revamp.md`: 4.1 (151-191, data layer), 4.3 (212-225, motion), U2 (361-384), U4 (415-440), U5 (440-485; shell bullet and the status table), 6 (635-683, test strategy).
- `plans/DESIGN.md` by section: 7.1 shell, sidebar, pane header, status slot (509-548); 7.13 toasts and trays (871-890); 7.14 empty states (891-912); 7.15 error states (913-939); 5 input rules (417-455); 4.8 motion tokens (341-395); 10 microcopy (988-1017); 11 accessibility (1018-1037). Do not open the rest of DESIGN.md.
- `apps/desktop/src/renderer/shell/README.md` (the frozen surface) and `renderer/data/README.md` on the branch.
- Mockups: `mockups/index.html`, then the shell, status and toast pages only.

**Done criteria.**
1. Harness states for the shell (sidebar groups, account switcher, pane header, every status row of the U5 table, toasts, trays, errors, empties, reconnect states), both themes, two sizes, no serious axe violation, hover never shifts layout.
2. Status slot maps reason codes to DESIGN 7.15 copy only, never a raw provider error; `reconnectBy` within 24 hours shows the reconnect line; counts hide during first sync.
3. One operation gives one notice; Undo toasts are never replaced; toasts are opaque `--paper` with `--elev-float`.
4. `grep -rn "invoke(" apps/desktop/src/renderer --exclude-dir=legacy` returns only `data/`; no `any` on engine results.
5. Keyboard-only walkthrough (triage 10, defer one, bulk-trash three, undo) passes with ui-home's screens.
6. Evidence posted as HANDOFF-READY and shown to the owner before a PR (roadmap 12). Never copy reference wording or layouts; no sparkle, wand or star glyph.

**Tests (repo root).** `npm run check`; `npm run typecheck`; `npm run owners:check`; `cd apps/desktop && npx tsx --test 'src/renderer/{shell,data,motion}/*.test.ts'`; `npx playwright test -c tests/visual/playwright.config.ts` (headless only; `-g <state>` for one state).

**Models.** Sonnet for all UI work. Opus only for WP5.6 (the engine switch). Free models may not write UI.
