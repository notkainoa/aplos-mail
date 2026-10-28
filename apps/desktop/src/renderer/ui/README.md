# renderer/ui: the Paper components

This folder holds the parts every screen is built from (plans/DESIGN.md §6). `props.ts` is the frozen props contract, artifact F9. It covers all 62 components in DESIGN §6. The `CommandRegistry` row of §6 lives in `renderer/commands/`, not here. Implementations come later, one file per component, under the family folders listed in `COMPONENTS` in `props.ts`.

The design spec is `plans/DESIGN.md` ("Paper"). The visual target is `mockups/*.html`. DESIGN wins on rules, numbers and copy.

## Using the props

- **Import from `renderer/ui`.** After the Phase 0 restructure moves today's `ui/index.ts` to `renderer/legacy/`, a new `renderer/ui/index.ts` re-exports `props.ts` and every component. Until then, import types from `renderer/ui/props`.
- **Type each implementation from the map.** `export function ListRow(props: ComponentPropsMap['ListRow']) { … }`, or use the named type (`ListRowProps`). The manifest and the map are checked against each other at compile time.
- **Data in, events out.** Components never fetch, never import `renderer/data`, the engine, `shared/live` or `AppState`. Screens get rows from data hooks and pass them in. Components report what the user did through `on…` callbacks.
- **Times are ISO strings.** Props take `IsoDateTime` / `IsoDate` and components format them with the one shared formatter, so "10:00 AM", "Tuesday", "Oct 23" and "Resuming at 2:14 PM" read the same everywhere. The harness freezes the clock at 2026-10-29T10:00 with the en-US locale.
- **Components write their own fixed copy** where DESIGN gives it. `StatusSlot` maps a status to §7.1's lines, `ErrorLine` maps a kind to §7.15's lines, `UndoTray`, `DraftState`, `Suggestion`, `FatalScreen`, `ProgressSegments` and `DatePresets` do the same. Screens pass the facts (`resumeAt`, `changesWaiting`, `recipient`), not the sentence.

## The closed-variant rule

No component takes a raw colour, size, radius, duration, shadow or a class name for styling. Every visual choice is a closed string union tied to DESIGN:

- `Button` `variant: 'filled' | 'text' | 'icon'`, `size: 'sm' | 'md' | 'lg'` (28 / 32 / 40 px). The icon variant requires `icon` and a `label`.
- `Density`, `TagColor`, `CommitKind`, `ToastKind`, `Chip` `kind`, `RowLayout`, `SectionHeader` `variant` and `tone`.
- Icons come from the closed `IconName` set. AI never gets a glyph. It is marked only by the serif and plain words (DESIGN §9).

Styles use only `var(--token)` names from DESIGN §4, from the generated `ui/generated/tokens.css`. Motion uses the named motions from `ui/generated/motion.ts`. Motion is never a prop. Components that the motion runtime animates (`ListRow`, `FocusSlot`, `ReaderHead`, `CommitChip`, `CommitEdge`, `InlineReply`, `LevelMeter`, `Pane`) take a `ref`, and the runtime drives them imperatively. React never re-renders per frame (DESIGN §5 rule 3).

If a screen seems to need a new variant, colour or size, the screen is wrong (DESIGN §3). If DESIGN really needs it, add a union member here first.

## Compose, don't invent

Build screens from these parts. Never style a control inside a screen, and never add a fourth button style, a new pill or an ornament. None of these exist and none may be added: `PostEdge`, `SkyScene`, `MarginRail`, `Flap`, `Letterhead`, a reader `Avatar`. A few surfaces in the mockups have no component of their own. Screens compose them from existing parts:

| Surface | Compose from |
|---|---|
| Pane header (back, crumb, tools, Ask, calendar button, bulk bar) | `Pane.header` + `Button` (icon, `labelVisible` for Ask) + `Tooltip` |
| Sidebar rows and Settings nav | `Puck` (`kind: 'selection'`, `role: 'navigation'`, vertical) + `NavHead` |
| Account switcher and its menu | `Button` + `Menu` (`swatch`, `detail`, `inlineAction`) |
| Pickers ("Groq ▾", "500 requests ▾") | `Button` (`trailingIcon: 'chevron-down'`, `popup`) + `Menu` (`checkedId`) |
| Theme, density, RSVP | `Puck` (`kind: 'segmented'`) |
| Event detail (day rail, popover) | `Popover` + `Puck` (RSVP) + `Button` |
| Low-importance sheet, "+N" stack | `Menu` or `Dialog` + `ListRow` |
| Message blocks in the thread, mail frame | ui-reader's own screen code (the frame is `renderer/mailframe`) |

## Keys

- **Keycaps come from the registry.** Controls that show a key take `commandId` (a `CommandId` from `renderer/commands/types.ts`). The registry supplies the chord and the tooltip label. A literal key (`LiteralKey`: Return, ⇧Return, Esc, Tab) is allowed only where DESIGN requires it: onboarding and dialogs, destructive confirms, suggestions. `Kbd` itself takes the display chord.
- **Never on hover.** `KeyHint` says where a control shows its key: `'always'` for main actions (Space in the mail window, Return in onboarding and dialogs, ⌘↩ on Send), `'hint'` only with "Show all key hints", `'tooltip'` by default. The shell provides `KeyHintsContextValue` (`showKeys: 'tooltips' | 'held' | 'all'`) through a context that lives next to `Kbd`. `'held'` shows the overlay badges while ⌘ is down. Nothing a hover does changes layout (DESIGN §5 rule 17).
- **Components don't bind global keys.** List, reader and global keys go through the CommandRegistry and its resolver. Components handle only the keys of their own focused widget, as the WAI-ARIA patterns need: arrows and digits in `Menu`, `Palette` and `DatePresets`, Return / Esc in `Dialog`, `Confirm` and `ProposalCard`, chord capture in `KeyRecorder`, Tab / Esc in `Suggestion`. They are always IME-safe (DESIGN §5 rule 16).

## Accessibility

- Icon buttons, `Switch`, `Checkbox`, `TextField` and `Spinner` require a `label` by type.
- Lists are a `listbox` with `aria-activedescendant` (DESIGN §11.3). Rows take an `id`. The screen owns the listbox element and wires it with `ListboxBinding`. `Palette`, `RecipientField` and `SearchField` take the ids of their own listboxes.
- One polite live region lives in the shell. Components that must speak take `announce?: Announce`. Toasts are polite and never steal focus.

## AI provenance

- `Summary` takes `provenance: { provider, local }`, so the hover says "Summary by Groq", or "on this Mac" for a local model. A pending summary shows the subject in SF and breathes. An absent one shows the subject. No AI state is ever an error on the mail surface.
- A due date carries `source: 'user' | 'structured' | 'ai'`. The `ai` source adds "from the email" on hover.

## Changing this contract

The contract freezes after day 3. Changes may only be additive: a new optional prop, a new union member, a new component with its manifest entry and map entry. Never rename or remove. Every exported type and prop keeps a one-line doc comment naming what it is and its DESIGN section.

## Families and lanes

| Family | Components | Plain version / refined by |
|---|---|---|
| `buttons-keys` | Button, Kbd, Tooltip | ui-foundation |
| `surfaces` | Pane, PageHead, NavHead, Menu, Popover, Dialog, Confirm, Puck, Toast, ToastStack | ui-foundation |
| `list` | ListRow, SectionHeader, FocusSlot, FocusLetter, LowBand, CommitChip, CommitEdge, Chip, EmptyLine, ErrorLine | ui-foundation (motion by ui-shell) |
| `reader` | ReaderHead, EarlierMessages, ReplyStub, Summary, Why, UndoTray | ui-foundation; used by ui-reader |
| `compose` | Composer, InlineReply, RecipientField, DraftState, Suggestion, LevelMeter | ui-foundation; used by ui-reader |
| `ask` | AskDock, AskTurn, StepLog, Citation, ProposalCard, Palette, SearchField, OperatorToken | ui-ask |
| `calendar` | MiniMonth, CalendarList (plain: ui-foundation), CalendarGrid, EventBlock, PlanOutline, NowLine, DatePresets (plain: ui-foundation, used by ui-home) | ui-calendar |
| `settings` | SettingRow, ProviderTable, KeyRecorder | ui-settings |
| `status` | StatusSlot, ReconnectSheet, ProgressSegments, FatalScreen, Spinner | ui-foundation; used by ui-shell and ui-onboard |
| `controls` | Switch, Checkbox, TextField, ShortcutSheet | ui-foundation |
