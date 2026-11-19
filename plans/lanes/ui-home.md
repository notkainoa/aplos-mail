# Lane card: ui-home (UI-core thread, Linux)

**Goal.** Build the daily-driver triage screens on `useView`, on the stand-in engine: Home (Do now, Important updates, Low importance band, Follow up), Later with drag to reschedule, one shared list for All mail, Drafts, Sent, Trash, Spam and labels, the Done place, one-by-one view and empty states.

**Start from.** `origin/revamp` after #44 merges and `contract-v1` is tagged. Branch `rv/ui-home/home`. `renderer/screens/` does not exist yet; create `screens/{home,later,lists,done}/`. Read `plans/ui-core/HANDOFF.md` (on `rv/thread/ui-core`) first.

**Owned paths** (`plans/OWNERS.md` line 43). `apps/desktop/src/renderer/screens/{home,later,lists,done}/**` only. Components in `renderer/ui/**` (ui-foundation), data hooks in `renderer/data/**` and the shell (ui-shell) are consumed through their frozen props and signatures; need a change, post a REQUEST. Lane and importance data come from `eng-ai` (#47, `laneFor`); the stand-in emulates it until then.

**Read only these.**
- `plans/30-ui-revamp.md`: U5 (440-485, Home, Later, lists and Done bullets, acceptance 1-4), 4.1 (151-191, `useView`, `useRow`), 4.3 (212-225), 6 (635-683).
- `plans/DESIGN.md` by section: 7.2 Home (549-641); 7.3 Later (642-654); 7.4 lists and Done (655-671); 5 input rules (417-455); 6 component inventory (456-504); 8 keyboard map (940-970); 7.14 empty states (891-912); 10 microcopy (988-1017). Do not open the rest of DESIGN.md.
- `mockups/index.html`, then the Home, Later, list and Done pages. DESIGN.md wins over a mockup; raise any difference.
- `apps/desktop/src/renderer/ui/props.ts` and `renderer/data/README.md` on the branch.

**Done criteria.**
1. About 20 harness states for these screens (Home full and empty, Low sheet, Later groups and drag, each list, Done, one-by-one), both themes, two sizes, no serious axe violation, hover never shifts layout.
2. Home order and sorting per DESIGN 7.2 (Do now by due band, importance, due date, newest; Back from Later at its bottom; empty sections hidden; fixed 180 px `FocusSlot`); Tab and Shift-Tab jump sections.
3. Behaviour tests: Done on mail needing a reply leaves Home and offers the Remind toast; arrows on All mail move the cursor and archive nothing; Option-Down and Option-Up move a thread one lane with Undo; Space on a Follow up row opens the nudge or an empty reply with AI off; Done rows read "Done 9:41 AM" with E and L inactive.
4. Fuzz: mail arriving during a triage burst never moves the row under the cursor. Run `break-ui` worst-case data on every list.
5. Show owner-ready visuals (demo mail only) before any PR (roadmap 12). No sparkle, wand or star glyph; AI text in the Newsreader serif; ink blue only for the one main action.

**Tests (repo root).** `npm run check`; `npm run typecheck`; `npm run owners:check`; `cd apps/desktop && npx tsx --test 'src/renderer/screens/**/*.test.ts'`; `npx playwright test -c tests/visual/playwright.config.ts -g home` (headless only).

**Models.** Sonnet for all UI work; Opus allowed for Home itself (WP5.1, the screen the owner judges). Free models may not write UI.
