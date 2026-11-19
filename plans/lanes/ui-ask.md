# Lane card: ui-ask (feature 7: Ask, summaries, command palette)

**Goal.** The docked Ask panel with cited answers, the Today tab, the ⌘K palette, the Search page, summaries shown as the big serif block, and the AI consent line, all on demo data and the stand-in engine. Roadmap §12 feature 7. `eng-ai`'s engine side (`Ask/run` frames, citations, provider table) is merged.

**Start from.** `origin/revamp`. Branch `rv/thread/ui-ask`. Earlier work lives on `origin/rv/ui-ask/ask` (3d52cff, 61 commits, based on the pre-freeze base): containers, models, stores, `ask.frames.ts`, preview galleries and tests. Use it as a reference to port from, not a branch to merge; `revamp` has since changed the data API (`renderer/data/data-api.ts`: `ask.run`, `cancel`, `decide`, `suggestions`) and the components (`renderer/ui/ask/**`).

**Owned paths** (`plans/OWNERS.md`). `apps/desktop/src/renderer/screens/{ask,today,palette,search}/**` plus tests next to them. Not ours: `renderer/ui/**` (ui-foundation), `renderer/{data,shell}/**`, `App.tsx` (ui-shell), `packages/contract/**`. Need a change there, post a REQUEST in `plans/STATUS.md`. Known one: the shell keeps `dock` state locally and mounts no dock; ask ui-shell for a `dock` slot (or a `renderDock` prop) and an overlay slot for the palette.

**Read only these.**
- `plans/30-ui-revamp.md` U7 (lines 511-522).
- `plans/DESIGN.md`: 7.7 Ask dock and Today (738), 7.9 palette and search (776), 9 how AI appears, 10 microcopy, 5 input rules (417-455), 7.14 empty states, 7.15 error states.
- `renderer/ui/ask/*` (props and exports), `renderer/data/README.md`, `renderer/commands/` (registry the palette reads).
- `mockups/` Ask, palette and search files; DESIGN.md wins over a mockup.

**Done criteria.**
1. Dock: 360 px second pane, 8 px gap, Ask | Today control, close button, no glyph in the header, closed on first run, opened by the pane header buttons and Space (the AI action). Questions `base` 500, answers serif with numbered citations or "No source", step log, queued follow-ups while streaming, `ProposalCard` owning the filled button, no-provider and provider-error states, stopped partial answer, daily limit line, hold A to dictate.
2. Today tab: the agenda on demo data, a real empty state.
3. Palette: ⌘K is the only overlay, opaque, centred, light scrim; Suggested and Go to on first open; every registry command reachable by name; truthful context line; destructive confirms are two rows defaulting to Cancel; 1-9 picks only while the field is empty.
4. Search page on `/`: heading-size field, operator tokens (including `in:done`), local results as ordinary rows, "Search all mail on Google · Return" (remote only on Return).
5. Summaries: big serif block with the reader's pinned summary pattern; AI consent line before first use, naming provider and model; no key characters anywhere.
6. Both themes, two sizes, no serious axe violation; harness states for every item above; behaviour tests for keys (⌘K, `/`, Esc, Return, 1-9, A hold); a few meaningful tests, not a pile.
7. Real Groq round trip only through the eval harness / `scripts/ask-live.ts`, key from the backend environment, never printed.
8. No sparkle, wand or star glyph. AI text in the Newsreader serif; ink blue only for the one main action. Calm cards option A, no sky gradient.

**Visual loop.** Hill-climb (roadmap 5.1c) before READY-FOR-OWNER: SWE-2 candidates scored by the design lint and axe; Sonnet judges screenshots. Shots light and dark plus a short keyboard walkthrough into `~/.local/share/aplos-mail-review/ui-ask/<sha>/`. Post READY-FOR-OWNER F7 with plain-English what-to-try and stop for approval.

**Tests (repo root).** `npm run check`; `npm run typecheck`; `npm run owners:check`; `cd apps/desktop && npx tsx --test 'src/renderer/screens/{ask,today,palette,search}/**/*.test.ts*'`; `npx playwright test -c tests/visual/playwright.config.ts -g ask` (headless only).

**Models.** SWE-2 (`acpRegistry_devin`, `swe-2-high`, thought high) builds components, wiring, CSS, tests, capture scripts. Sonnet coordinates, judges visuals, does the one review pass. Opus only for security/auth/storage/send/contract (none expected here).
