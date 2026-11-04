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
  palette's "Ask about “x”" row handoff; the dock host should subscribe and ask it.

## ui-foundation

- **`SearchOperator`**: add `'is'` to the union in `ui/props/ask.ts` so `is:unread` (and read/flagged/bookmarked,
  all in the contract's `SearchQuery.is`) can render as an `OperatorToken` pill. Today the pill renders via a
  one-place cast in `search.model.ts` (`FIELD_OPERATOR`); the parse, token and `query.is` path is already built.
