# renderer/ui: the Paper components

This folder holds the parts every screen is built from (plans/DESIGN.md §6). `props.ts` is the frozen props contract, artifact F9; it re-exports the per-family modules in `props/`, so imports stay `from "./props"`. It covers every component in DESIGN §6 plus twelve parts the freeze review found DESIGN §7 needs and one the UI-screens gap list asked for (75 in all; see "Added at the freeze review" and "Added for the UI-screens gap list" below). The `CommandRegistry` row of §6 lives in `renderer/commands/`, not here. Implementations come later, one file per component, under the family folders listed in `COMPONENTS` in `props.ts`.

The design spec is `plans/DESIGN.md` ("Paper"). The visual target is `mockups/*.html`. DESIGN wins on rules, numbers and copy.

## Using the props

- **Import from `renderer/ui`.** After the Phase 0 restructure moves today's `ui/index.ts` to `renderer/legacy/`, a new `renderer/ui/index.ts` re-exports `props.ts` and every component. Until then, import types from `renderer/ui/props`.
- **Type each implementation from the map.** `export function ListRow(props: ComponentPropsMap['ListRow']) { … }`, or use the named type (`ListRowProps`). The manifest and the map are checked against each other at compile time.
- **Data in, events out.** Components never fetch, never import `renderer/data`, the engine, `shared/live` or `AppState`. Screens get rows from data hooks and pass them in. Components report what the user did through `on…` callbacks.
- **Times are ISO strings.** Props take `IsoDateTime` / `IsoDate` and components format them with the one shared formatter (`ui/format.ts`, below), so "10:00 AM", "Tuesday", "Oct 23" and "Resuming at 2:14 PM" read the same everywhere. The harness freezes the clock at 2026-10-29T10:00 with the en-US locale.
- **Components write their own fixed copy** where DESIGN gives it. `StatusSlot` maps a status to §7.1's lines, `ErrorLine` maps a kind to §7.15's lines, `UndoTray`, `DraftState`, `Suggestion`, `FatalScreen`, `ProgressSegments`, `DatePresets`, `SearchField` (its operator hint) and `OnboardingStep` (its footer note) do the same. Screens pass the facts (`resumeAt`, `changesWaiting`, `recipient`), not the sentence.
- **One anchor style.** Every trigger that opens a floating surface hands its element to the callback (`onMore(anchor)`, `FocusLetter.onLater(anchor)`, `ListRow.onAction(commandId, anchor)`, `PaneHeaderProps.onTool(commandId, anchor)`). The screen keeps that element in state and passes it as `anchor: Anchor` (`HTMLElement | null`) to `Menu`, `Popover` or `DatePresets`.
- **Text goes through `Text`.** Screens never set type. A title, lede, caption or dim line outside a component uses `Text` with a closed `variant` (DESIGN §4.3). Screens do not use the generated `t-*` classes directly.

## The closed-variant rule

No component takes a raw colour, size, radius, duration, shadow or a class name for styling. Every visual choice is a closed string union tied to DESIGN:

- `Button` `variant: 'filled' | 'text' | 'icon'`, `size: 'sm' | 'md' | 'lg'` (28 / 32 / 40 px). The icon variant requires `icon` and a `label`. A Button in a row takes `labelledBy` (the row label's id) or `ariaLabel` (which must contain the visible text, and start with it for voice control, WCAG 2.5.3) so its name keeps the visible text plus the row context.
- `Density`, `TagColor`, `CommitKind`, `ToastKind`, `Chip` `kind`, `RowLayout`, `SectionHeader` `variant` and `tone`.
- Icons come from the closed `IconName` set. AI never gets a glyph. It is marked only by the serif and plain words (DESIGN §9).

Styles use only `var(--token)` names from DESIGN §4, from the generated `ui/generated/tokens.css`. Motion uses the named motions from `ui/generated/motion.ts`. Motion is never a prop. Components that the motion runtime animates (`ListRow`, `FocusSlot`, `ReaderHead`, `CommitChip`, `CommitEdge`, `InlineReply`, `LevelMeter`, `Pane`) take a `ref`, and the runtime drives them imperatively. React never re-renders per frame (DESIGN §5 rule 3).

If a screen seems to need a new variant, colour or size, the screen is wrong (DESIGN §3). If DESIGN really needs it, add a union member here first.

## Compose, don't invent

Build screens from these parts. Never style a control inside a screen, and never add a fourth button style, a new pill or an ornament. None of these exist and none may be added: `PostEdge`, `SkyScene`, `MarginRail`, `Flap`, `Letterhead`, a reader `Avatar`. A few surfaces in the mockups have no component of their own. Screens compose them from existing parts:

| Surface                                                          | Compose from                                                                                                                                                                                                |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pane header (back, crumb, tools, Ask, calendar button, bulk bar) | `Pane` with structured `header: PaneHeaderProps` (no free slot; at most three tools by type)                                                                                                                |
| Sidebar rows and Settings nav                                    | `Puck` (`kind: 'selection'`, `role: 'navigation'`, vertical; `tooltip` for Done's line) + `NavHead`                                                                                                         |
| Account switcher and its menu                                    | `AccountSwitcher` + `Menu` (`swatch` one or several colours, `detail`, `inlineAction`)                                                                                                                      |
| Pickers ("Groq ▾", "500 requests ▾")                             | `Button` (`trailingIcon: 'chevron-down'`, `popup.kind: 'menu'`) + `Menu` (`checkedId`, so items are `menuitemradio`). There is no listbox popup. This is the frozen Select: there is no `Select` component. |
| Theme, density, RSVP                                             | `Puck` (`kind: 'segmented'`)                                                                                                                                                                                |
| Radio rows (the onboarding AI provider choice)                   | `ChoiceGroup` (the radiogroup, roving tabindex, ↑/↓) around `ChoiceRow`s with `role: 'radio'`. Short segmented choices stay a `Puck` (`role: 'radio'`).                                                     |
| Onboarding step dashes ("Step 2 of 4")                           | `OnboardingStep` `footer.dashes {step, of}`. There is no `StepDashes` component.                                                                                                                            |
| The first-sync drill's practice letters                          | `ListBox` + `ListRow` and `FocusSlot` › `FocusLetter` with invented values. Their props are plain strings and callbacks, never engine rows, so the drill makes no data call.                                |
| A Settings row reachable from ⌘K                                 | `SettingRow` with `paletteId` = the id it registered with `registerSetting` (`renderer/commands`)                                                                                                           |
| Account colour                                                   | `SwatchPicker` in a `SettingRow`                                                                                                                                                                            |
| Event detail (day rail, popover)                                 | `EventDetail` (`presentation: 'rail'`, or `'popover'` inside `Popover`)                                                                                                                                     |
| Low-importance sheet                                             | `LowSheet`                                                                                                                                                                                                  |
| "+N" stack                                                       | `Menu`                                                                                                                                                                                                      |
| The thread                                                       | `Text` (`variant: 'label'`, `as: 'h2'`) for the subject line, `EarlierMessages`, `ThreadMessage` (body from `renderer/mailframe`), `LoadingLine`, `ReplyStub`                                               |
| Onboarding steps and first sync                                  | `OnboardingStep` + `ChoiceRow` + `ConsentCard` + `TextField` + `ProgressSegments` (`'waiting'` for the OAuth wait, `'checkpoints'`, `'ready'`) + `Text`                                                     |
| Undo send with no visible thread                                 | `ToastStack.undoSend` (the same `UndoTray`, placement `'toast'`)                                                                                                                                            |
| AI draft text in the editor                                      | Editor data: ui-reader's editor renders the dim text; `Composer.suggestion` / `InlineReply.suggestion` show the hint line                                                                                   |

## Keys

- **Keycaps come from the registry.** Controls that show a key take `commandId` (`CommandId`, exported from `props.ts` and identical to the plain-string type in `renderer/commands/types.ts`; once that file is on this branch, `props.ts` re-exports it from there). The registry supplies the chord and the tooltip label. A literal key (`LiteralKey`: Return, ⇧Return, Esc, Tab) is allowed only where DESIGN requires it: onboarding and dialogs, destructive confirms, suggestions. `Kbd` itself takes the display chord.
- **Never on hover.** `KeyHint` says where a control shows its key: `'always'` for main actions (Space in the mail window, Return in onboarding and dialogs, ⌘↩ on Send), `'hint'` only with "Show all key hints", `'tooltip'` by default. The shell provides `KeyHintsContextValue` (`showKeys: 'tooltips' | 'held' | 'all'`) through a context in `ui/buttons-keys/keyHints.ts`, next to `Kbd`. `Kbd` has one size (18 px), including the onboarding drill. `'held'` shows the overlay badges while ⌘ is down. Nothing a hover does changes layout (DESIGN §5 rule 17). A `ToastAction` with `keysFrom` shows that command's keycap but only calls `onAction(id)`; the command itself never runs.
- **Components don't bind global keys.** List, reader and global keys go through the CommandRegistry and its resolver. Components handle only the keys of their own focused widget, as the WAI-ARIA patterns need: arrows and digits in `Menu`, `Palette` and `DatePresets`, Return / Esc in `Dialog`, `Confirm` and `ProposalCard`, chord capture in `KeyRecorder`, Tab / Esc in `Suggestion`. They are always IME-safe (DESIGN §5 rule 16).

## Accessibility

- Icon buttons, `Switch`, `Checkbox`, `TextField` and `Spinner` require a `label` by type.
- Lists are a `listbox` with `aria-activedescendant` (DESIGN §11.3), always built from `ListBox` (takes `ListboxBinding`) and `ListGroup` (a `role="group"` labelled by its `SectionHeader`, the WAI-ARIA grouped-listbox pattern). A listbox contains only groups and options: `ListRow`, `FocusSlot` › `FocusLetter`, `LowBand`. Rows take an `id`. `Palette`, `RecipientField` and `SearchField` take the ids of their own listboxes.
- **Buttons inside options are pointer duplicates.** Options' children are presentational, so the FocusLetter's Space / Later / Done / ⋯ buttons and ListRow hover actions render with `tabIndex={-1}` and `aria-hidden`. A SectionHeader's text action ("Go one by one") is a real button: the header is a group's label, not inside an option, and a press hands focus back to the listbox. Every one of them has a key, and the option's tooltip and the shortcut sheet name it. (Decision made at the freeze review; to be written into DESIGN §11.3.)
- `ThreadMessage` is an `article` landmark. The reader has one thread cursor id, shared by `EarlierMessages.cursorId` and `ThreadMessage.cursor`.
- One polite live region lives in the shell. Components that must speak take `announce?: Announce`. Toasts are polite and never steal focus.

## AI provenance

- `Summary` takes `provenance: { provider, local }`, so the hover says "Summary by Groq", or "on this Mac" for a local model. A pending summary shows the subject in SF and breathes. An absent one shows the subject. No AI state is ever an error on the mail surface.
- A due date carries `source: 'user' | 'structured' | 'ai'`. The `ai` source adds "from the email" on hover.

## Shared infrastructure (ui-foundation)

| File                                                    | What it is                                                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/renderer/ui/buttons-keys/keyHints.ts` | The key-hints context and provider (`KeyHintsContextValue`), read by `Kbd` and every control with a keycap        |
| `apps/desktop/src/renderer/ui/format.ts`                | The one formatter for every `IsoDateTime` / `IsoDate` prop (relative dates, times, ranges, "Resuming at 2:14 PM") |

## Added at the freeze review

`AccountSwitcher`, `Text` (surfaces); `ListBox`, `ListGroup`, `LowSheet` (list); `ThreadMessage`, `LoadingLine` (reader); `EventDetail` (calendar); `SwatchPicker` (controls); `OnboardingStep`, `ChoiceRow`, `ConsentCard` (onboarding). None is an ornament. Each is a state DESIGN §7 requires that the §6 parts could not express without a screen styling its own control.

## Added for the UI-screens gap list

The UI-screens thread checked every screen it builds against these props (`plans/ui-screens/gap-list.md`, item U10). Everything below is additive:

- `ChoiceGroup` (onboarding): the radiogroup around radio `ChoiceRow`s.
- `ProgressSegments` variant `'segments'` with `ProgressSegment {label, state, value?}`: plain labelled segments.
- `ProgressSegments.live` (`'polite'` default | `'off'`, variants `'checkpoints'`, `'segments'` and `'ready'`): `'off'` drops the part's own `role="status"` (its phase text stays), so a screen showing several accounts owns ONE live region. That wrapper must be `<div aria-live="polite" aria-atomic="false">`, not a bare `role="status"`: status implies `aria-atomic="true"` and would re-read every account whenever one changes.
- `MiniMonth.marks`: days with events.
- `SettingRow.paletteId`: the row's palette entry.
- `PaletteItem.detail` and `PaletteItem.opensPage`: a Settings row's section, and the chevron for nested pages.
- `CitationData.kind` and `eventId`, `CitationProps.onOpenEvent`, `AskTurnProps.onOpenEventCitation`: calendar-event citations (data `Citation` kind `'event'`, F1). For an event, `from` is the calendar, `date` the start, `subject` the title and `threadId` is `''`.
- `AskTurnProps.provenance` (hover-only "Answer by Groq"), the `'paused'` state of `AskTurnProps.state` (the per-model daily limit; shows "Use another provider" when `onUseAnotherProvider` is given) and the `index` argument on `AskTurnProps.onOpenCitation`, `onOpenEventCitation`, `CitationProps.onOpen` and `onOpenEvent`. The callback change is compatible for every handler: a one-argument `(id) => void` still type-checks. An event citation with no `onOpenEvent` is inert.
- `ReconnectSheetProps.mode`: `'grant'` shows the missing-permission copy instead of the weekly reconnect copy.
- `PaletteItem.icon` is now optional, because Settings rows, nested page rows and several commands have no icon. The one loosening in this list: a palette that passes `item.icon` straight to `Icon` must check it first (`Palette.tsx` on `rv/ui-foundation/c-compose-ask`, line 222). `commandId` carries the setting entry id or the page row id for those rows.
- Density stays `'roomy' | 'comfortable' | 'compact'` here. The stored setting uses F1's names (`'compact' | 'default' | 'roomy'`), so screens map `'default'` to `'comfortable'`.
- For props typed `IsoDateTime` or `IsoDate`, convert the data layer's clock with `toIsoDateTime(ms)` and `toIsoDate(ms)` from `renderer/data`. Both are local with an offset, never `toISOString()` (UTC). The harness runs in `America/Los_Angeles`.

Already present, so not added: `Radio` (`Puck` `role: 'radio'`, `ChoiceRow` `role: 'radio'`, `SwatchPicker`), `Select` (Button + Menu, above), `StepDashes` (`OnboardingFooter.dashes`), plain rows for the drill (`ListRow`, `FocusLetter`), `EventBlock` plans and stacks (`PlanOutline`, `EventBlock` `kind: 'stack'`), `SettingRow` hint (`description`), and `CalendarGrid`, `NowLine`, `CalendarList`, `AskTurn`, `Citation`, `StepLog`, `ProposalCard`, `Palette`, `SearchField`, `OperatorToken`, `ProviderTable` and `KeyRecorder`.

## Changing this contract

The contract freezes after day 3. Changes may only be additive: a new optional prop, a new union member, a new component with its manifest entry and map entry. Never rename or remove. The one exception agreed in advance: if the CommandRegistry later narrows `CommandId` to a literal union of catalog ids, that change happens in `renderer/commands/types.ts` and reaches these props through the re-export. Screens already pass catalog ids, so only typos stop compiling. Every exported type and prop keeps a one-line doc comment naming what it is and its DESIGN section.

## Families and lanes

| Family         | Components                                                                                                                                                       | Plain version / refined by                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `buttons-keys` | Button, Kbd, Tooltip                                                                                                                                             | ui-foundation                                  |
| `surfaces`     | Pane, PageHead, NavHead, AccountSwitcher, Text, Menu, Popover, Dialog, Confirm, Puck, Toast, ToastStack                                                          | ui-foundation                                  |
| `list`         | ListBox, ListGroup, ListRow, SectionHeader, FocusSlot, FocusLetter, LowBand, LowSheet, CommitChip, CommitEdge, Chip, EmptyLine, ErrorLine                        | ui-foundation (motion by ui-shell)             |
| `reader`       | ReaderHead, EarlierMessages, ThreadMessage, LoadingLine, ReplyStub, Summary, Why, UndoTray                                                                       | ui-foundation; used by ui-reader               |
| `compose`      | Composer, InlineReply, RecipientField, DraftState, Suggestion, LevelMeter                                                                                        | ui-foundation; used by ui-reader               |
| `ask`          | AskDock, AskTurn, StepLog, Citation, ProposalCard, Palette, SearchField, OperatorToken                                                                           | ui-ask                                         |
| `calendar`     | MiniMonth, CalendarList (plain: ui-foundation), CalendarGrid, EventBlock, PlanOutline, NowLine, EventDetail, DatePresets (plain: ui-foundation, used by ui-home) | ui-calendar                                    |
| `settings`     | SettingRow, ProviderTable, KeyRecorder                                                                                                                           | ui-settings                                    |
| `status`       | StatusSlot, ReconnectSheet, ProgressSegments, FatalScreen, Spinner                                                                                               | ui-foundation; used by ui-shell and ui-onboard |
| `controls`     | Switch, Checkbox, SwatchPicker (refined by ui-settings), TextField, ShortcutSheet                                                                                | ui-foundation                                  |
| `onboarding`   | OnboardingStep, ChoiceRow, ChoiceGroup, ConsentCard                                                                                                              | plain: ui-foundation; refined by ui-onboard    |
