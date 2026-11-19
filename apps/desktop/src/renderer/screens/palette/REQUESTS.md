# Requests from screens/{palette,search} to other lanes

Additive asks, in priority order. Until each lands the screens mount in their own preview harness
(`screens/palette/preview/`).

## ui-shell

- **Overlay slot for the palette** (already posted in plans/STATUS.md 2026-11-04): mount
  `<PaletteHost open={…} onClose={…} />` beside `SheetHost`. The shell owns `open` and attaches `app.palette` (⌘K)
  to toggle it; Esc/⌘K inside the panel and a scrim click call `onClose`.
- **Palette open requests**: subscribe `onPaletteOpenRequest(query => openPalette())` from
  `screens/palette/paletteStore.ts` so Search's `>` opens the palette with the field seeded (the host consumes the
  pending query via `consumePaletteQuery` when `open` turns true).
- **Search on the route**: render `<SearchScreen />` from `screens/search` for the `{ label: 'Search' }` screen
  (`nav.search`, `/`). The screen sets its own `search` + `list` key layer, cursor target and scope.
- **Stylesheet**: add `@import url('./search/search.css');` to `screens/screens.css` (Search's page layout wrappers).
- **Ask dock wiring** (with ui-ask): `onAskRequest(question => …)` in `screens/palette/askRequests.ts` is the
  palette's "Ask about “x”" row handoff; the dock host should subscribe and ask it. Until then the host falls back
  to `askStore.ask(question)`, which carries the question and opens the dock itself.
- **`ctx.trigger` for `palette.pickNumber`**: `palette.pickNumber` (1–9) is declared in `commands/catalog/controls.ts`
  and the host registers every other `palette.*` control, but a digit handler cannot learn which digit ran it:
  `shellKeyContext` never sets `CommandContext.trigger`, so `run(ctx)` has no chord. Either the dispatch passes
  `resolution.chord` into the run context (the `CommandContext.trigger` field already exists for menus' digits) or
  the key stays with the component's own `onKeyDown`, which has it. Registered: next, previous, choose,
  confirmDestructive, back — no double-fire, because the panel's keydown `preventDefault`s every key it handles and
  the dispatcher skips prevented events.

## ui-home

- **Search's list layer keeps dead keys advertised**: `useShellKeyLayer({ contexts: ['search', 'list'] })` activates
  every `list` binding, but Search registers only down/up, open, suggested (Space → open), done, later, trash,
  bookmark and toggleRead plus `search.remote`. Skipped on purpose and now dead on the results list: reply (r),
  reply all (⇧R), forward (f) — compose lane; set a date (d) — the date picker; why (i), ⌥↓/⌥↑ — Home concepts;
  x/⇧X/⌘A/./clearSelection — the bulk pick; Tab/⇧Tab — section jumps (the results have two groups and could adopt
  them later); s — one by one is a Home concept. Narrowing the layer to a subset of `list` commands needs either a
  per-screen `disabledIn` or a smaller context in the catalog.

## data

- **Search windows collide**: `data/optimistic.ts`'s `specKey` drops the nested `search` query, so two different
  searches share one window and local results do not update as you type (already REQUESTed). `search.test.ts`
  carries a `test.todo` documenting the expected behaviour; remove it when the data lane lands the fix.

## ui-foundation

- **`SearchOperator`**: add `'is'` to the union in `ui/props/ask.ts` so `is:unread` (and read/flagged/bookmarked,
  all in the contract's `SearchQuery.is`) can render as an `OperatorToken` pill. Today the pill renders via a
  one-place cast in `search.model.ts` (`FIELD_OPERATOR`); the parse, token and `query.is` path is already built.
