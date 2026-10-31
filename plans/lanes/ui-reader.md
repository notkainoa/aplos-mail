# Lane card: ui-reader (UI-core thread, Linux)

**Goal.** Build the reader, the mail frame host, the inline reply, compose and the send states on the stand-in engine, in the approved design. The reader must be complete before the real frame exists: it renders through the scriptless `srcdoc` frame against the stand-in engine first (`eng-html` is parked), behind the same props the sandboxed `aplos-mail` frame will use later.

**Start from.** `origin/revamp` after #96, #97 and #98 merge. Branch `rv/ui-reader/reader`. Read `plans/ui-core/HANDOFF.md` first, then the merged `renderer/ui/props.ts` and `renderer/data/README.md`.

**Owned paths** (`plans/OWNERS.md` line 44). `apps/desktop/src/renderer/screens/{reader,compose}/**` and `apps/desktop/src/renderer/mailframe/**`, including `LevelMeter` and the dictation hook. Components in `renderer/ui/**`, data hooks in `renderer/data/**`, the shell and Home are consumed through their frozen props and signatures; need a change, post a REQUEST. The reporter protocol document is shared with `eng-html`; while `eng-html` is parked, write the host side only and mark the protocol "proposed".

**Read only these.**
- `plans/30-ui-revamp.md`: U6 (485-510), 4.4 the email HTML frame (226-243), 4.1 `useView`, `useRow` (151-191), 6 (635-683).
- `plans/DESIGN.md` by section: 7.5 Reader (672-712); 7.6 Compose and inline reply (713-737); 7.13 toasts and trays (871-890); 7.15 error states (913-939); 5 input rules (417-455); 8 keyboard map (940-970); 9 how AI appears (971-987); 10 microcopy (988-1017). Do not open the rest of DESIGN.md.
- `mockups/reader.html`, `mockups/reply.html`, `mockups/compose.html`, `mockups/toasts.html`. DESIGN.md wins over a mockup; raise any difference.
- `RC/gaps/electron-email-html-isolation.md` sections 1, 7 and 9 for the hostile-HTML vectors and host duties.

**Done criteria.**
1. Every DESIGN 7.5 and 7.6 state in the harness (reader with summary, no summary, plain text, long thread, earlier messages collapsed and expanded, attachments and an attachment failure, image blocked and "N trackers removed", find; inline reply, compose, schedule, discard; each send state with its sentence and actions), both themes, two sizes, no serious axe violation, hover never shifts layout. The reader shows its four parts in order (sender line, summary, action row, thread) and no margin column.
2. **No blank sheet.** A fuzz of 500 J and K moves with body latency random in 0 to 2.5 s never shows an empty paper; after 1.5 s the 12 px loading line appears. The previous letter stays until the new one reports.
3. **Frame host tests.** Spoofed `postMessage` (wrong source, origin or token; `h` of NaN, negative or 1e9) is rejected; height clamps to 1-200,000; a `bg` parse failure falls back to light paper. The `srcdoc` frame has no scripts and an inner meta CSP.
4. **Hostile-HTML corpus** (inline script, `onerror`, meta refresh, `<link>` prefetch, `url()` trackers, forms, plus CSS `@import`, SVG `<use>`, `<base>`, `<meta http-equiv>`, `javascript:` links, giant tables, deeply nested divs): zero outbound requests in the Playwright log, and the frame cannot reach `window.aplos`. Sanitiser and host get a Sonnet adversarial review, with an Opus review of the host.
5. Submission states render from the stand-in engine and survive a reload. A fuzz interleaving send, undo and stand-in restart never shows a duplicate tray or loses a draft.
6. Behaviour tests: J and K swap threads; E, L, Space and R work from the reader; O expands earlier messages; the filled button belongs to an open composer; dictation shows the level meter and "Listening. Release R to keep, Esc to cancel."; the AI draft is dim text accepted with Tab.
7. Show owner-ready visuals (demo mail only) before any PR (roadmap 12). Hill-climb (roadmap 5.1c) the visual work before READY-FOR-OWNER, not after. No sparkle, wand or star glyph; AI text in the Newsreader serif; ink blue only for the one main action.

**Not in this lane.** The real `aplos-mail` frame and the keys-with-focus-inside-the-frame check (needs `eng-html` and a Mac, recorded as a live run); the one real send to an owner-controlled address (live run, owner present). Post both as REQUESTs for the Integrator's live-run list when the stand-in version is done.

**Tests (repo root).** `npm run check`; `npm run typecheck`; `npm run owners:check`; `cd apps/desktop && npx tsx --test 'src/renderer/{screens,mailframe}/**/*.test.ts'`; `npx playwright test -c tests/visual/playwright.config.ts -g reader` (headless only).

**Models.** Sonnet for UI work and the routine components. Opus for `MailFrame` and the key relay (security), the composer, and prefetch with the double buffer. SWE-2 only for the hostile-HTML corpus generation and test scaffolding, never for UI. Every PR gets the Sonnet review; the frame host gets an Opus review.
