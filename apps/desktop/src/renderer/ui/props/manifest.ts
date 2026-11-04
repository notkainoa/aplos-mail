import type { ButtonProps, KbdProps, TooltipProps } from './buttons-keys';
import type {
  AccountSwitcherProps,
  ConfirmProps,
  DialogProps,
  MenuProps,
  NavHeadProps,
  PageHeadProps,
  PaneProps,
  PopoverProps,
  PuckProps,
  TextProps,
  ToastProps,
  ToastStackProps,
} from './surfaces';
import type {
  ChipProps,
  CommitChipProps,
  CommitEdgeProps,
  EmptyLineProps,
  ErrorLineProps,
  FocusLetterProps,
  FocusSlotProps,
  ListBoxProps,
  ListGroupProps,
  ListRowProps,
  LowBandProps,
  LowSheetProps,
  SectionHeaderProps,
  SummaryProps,
} from './list';
import type {
  LoadingLineProps,
  ReaderActionsProps,
  ReaderHeadProps,
  ReplyStubProps,
  ThreadMessageProps,
  UndoTrayProps,
  WhyProps,
} from './reader';
import type {
  ComposerProps,
  DraftStateProps,
  InlineReplyProps,
  LevelMeterProps,
  RecipientFieldProps,
  SuggestionProps,
} from './compose';
import type {
  AskDockProps,
  AskTurnProps,
  CitationProps,
  OperatorTokenProps,
  PaletteProps,
  ProposalCardProps,
  SearchFieldProps,
  StepLogProps,
} from './ask';
import type {
  CalendarGridProps,
  CalendarListProps,
  DatePresetsProps,
  EventBlockProps,
  EventDetailProps,
  MiniMonthProps,
  NowLineProps,
  PlanOutlineProps,
  ScopeChooserProps,
} from './calendar';
import type { KeyRecorderProps, ProviderTableProps, SettingRowProps } from './settings';
import type {
  FatalScreenProps,
  ProgressSegmentsProps,
  ReconnectSheetProps,
  SpinnerProps,
  StatusSlotProps,
} from './status';
import type {
  CheckboxProps,
  ShortcutSheetProps,
  SwatchPickerProps,
  SwitchProps,
  TextFieldProps,
} from './controls';
import type {
  ChoiceGroupProps,
  ChoiceRowProps,
  ConsentCardProps,
  OnboardingStepProps,
} from './onboarding';

/* ───────────────────────── Manifest ───────────────────────── */

/** Component families; each is a folder under renderer/ui/. */
export type ComponentFamily =
  | 'buttons-keys'
  | 'surfaces'
  | 'list'
  | 'reader'
  | 'compose'
  | 'ask'
  | 'calendar'
  | 'settings'
  | 'status'
  | 'controls'
  | 'onboarding';

/** One planned implementation file. */
export interface ComponentEntry {
  /** Component name, as exported. */
  name: string;
  /** Family folder. */
  family: ComponentFamily;
  /** Repo-relative path of the implementation file. */
  file: string;
}

/** Every component of DESIGN §6 with its planned implementation path, one file per component. */
export const COMPONENTS = [
  {
    name: 'Button',
    family: 'buttons-keys',
    file: 'apps/desktop/src/renderer/ui/buttons-keys/Button.tsx',
  },
  {
    name: 'Kbd',
    family: 'buttons-keys',
    file: 'apps/desktop/src/renderer/ui/buttons-keys/Kbd.tsx',
  },
  {
    name: 'Tooltip',
    family: 'buttons-keys',
    file: 'apps/desktop/src/renderer/ui/buttons-keys/Tooltip.tsx',
  },
  { name: 'Pane', family: 'surfaces', file: 'apps/desktop/src/renderer/ui/surfaces/Pane.tsx' },
  {
    name: 'PageHead',
    family: 'surfaces',
    file: 'apps/desktop/src/renderer/ui/surfaces/PageHead.tsx',
  },
  {
    name: 'NavHead',
    family: 'surfaces',
    file: 'apps/desktop/src/renderer/ui/surfaces/NavHead.tsx',
  },
  {
    name: 'AccountSwitcher',
    family: 'surfaces',
    file: 'apps/desktop/src/renderer/ui/surfaces/AccountSwitcher.tsx',
  },
  { name: 'Text', family: 'surfaces', file: 'apps/desktop/src/renderer/ui/surfaces/Text.tsx' },
  { name: 'Menu', family: 'surfaces', file: 'apps/desktop/src/renderer/ui/surfaces/Menu.tsx' },
  {
    name: 'Popover',
    family: 'surfaces',
    file: 'apps/desktop/src/renderer/ui/surfaces/Popover.tsx',
  },
  { name: 'Dialog', family: 'surfaces', file: 'apps/desktop/src/renderer/ui/surfaces/Dialog.tsx' },
  {
    name: 'Confirm',
    family: 'surfaces',
    file: 'apps/desktop/src/renderer/ui/surfaces/Confirm.tsx',
  },
  { name: 'Puck', family: 'surfaces', file: 'apps/desktop/src/renderer/ui/surfaces/Puck.tsx' },
  { name: 'Toast', family: 'surfaces', file: 'apps/desktop/src/renderer/ui/surfaces/Toast.tsx' },
  {
    name: 'ToastStack',
    family: 'surfaces',
    file: 'apps/desktop/src/renderer/ui/surfaces/ToastStack.tsx',
  },
  { name: 'ListBox', family: 'list', file: 'apps/desktop/src/renderer/ui/list/ListBox.tsx' },
  { name: 'ListGroup', family: 'list', file: 'apps/desktop/src/renderer/ui/list/ListGroup.tsx' },
  { name: 'ListRow', family: 'list', file: 'apps/desktop/src/renderer/ui/list/ListRow.tsx' },
  {
    name: 'SectionHeader',
    family: 'list',
    file: 'apps/desktop/src/renderer/ui/list/SectionHeader.tsx',
  },
  { name: 'FocusSlot', family: 'list', file: 'apps/desktop/src/renderer/ui/list/FocusSlot.tsx' },
  {
    name: 'FocusLetter',
    family: 'list',
    file: 'apps/desktop/src/renderer/ui/list/FocusLetter.tsx',
  },
  { name: 'LowBand', family: 'list', file: 'apps/desktop/src/renderer/ui/list/LowBand.tsx' },
  { name: 'LowSheet', family: 'list', file: 'apps/desktop/src/renderer/ui/list/LowSheet.tsx' },
  { name: 'CommitChip', family: 'list', file: 'apps/desktop/src/renderer/ui/list/CommitChip.tsx' },
  { name: 'CommitEdge', family: 'list', file: 'apps/desktop/src/renderer/ui/list/CommitEdge.tsx' },
  { name: 'Chip', family: 'list', file: 'apps/desktop/src/renderer/ui/list/Chip.tsx' },
  { name: 'EmptyLine', family: 'list', file: 'apps/desktop/src/renderer/ui/list/EmptyLine.tsx' },
  { name: 'ErrorLine', family: 'list', file: 'apps/desktop/src/renderer/ui/list/ErrorLine.tsx' },
  {
    name: 'ReaderHead',
    family: 'reader',
    file: 'apps/desktop/src/renderer/ui/reader/ReaderHead.tsx',
  },
  {
    name: 'ReaderActions',
    family: 'reader',
    file: 'apps/desktop/src/renderer/ui/reader/ReaderActions.tsx',
  },
  {
    name: 'ThreadMessage',
    family: 'reader',
    file: 'apps/desktop/src/renderer/ui/reader/ThreadMessage.tsx',
  },
  {
    name: 'LoadingLine',
    family: 'reader',
    file: 'apps/desktop/src/renderer/ui/reader/LoadingLine.tsx',
  },
  {
    name: 'ReplyStub',
    family: 'reader',
    file: 'apps/desktop/src/renderer/ui/reader/ReplyStub.tsx',
  },
  { name: 'Summary', family: 'reader', file: 'apps/desktop/src/renderer/ui/reader/Summary.tsx' },
  { name: 'Why', family: 'reader', file: 'apps/desktop/src/renderer/ui/reader/Why.tsx' },
  { name: 'UndoTray', family: 'reader', file: 'apps/desktop/src/renderer/ui/reader/UndoTray.tsx' },
  {
    name: 'Composer',
    family: 'compose',
    file: 'apps/desktop/src/renderer/ui/compose/Composer.tsx',
  },
  {
    name: 'InlineReply',
    family: 'compose',
    file: 'apps/desktop/src/renderer/ui/compose/InlineReply.tsx',
  },
  {
    name: 'RecipientField',
    family: 'compose',
    file: 'apps/desktop/src/renderer/ui/compose/RecipientField.tsx',
  },
  {
    name: 'DraftState',
    family: 'compose',
    file: 'apps/desktop/src/renderer/ui/compose/DraftState.tsx',
  },
  {
    name: 'Suggestion',
    family: 'compose',
    file: 'apps/desktop/src/renderer/ui/compose/Suggestion.tsx',
  },
  {
    name: 'LevelMeter',
    family: 'compose',
    file: 'apps/desktop/src/renderer/ui/compose/LevelMeter.tsx',
  },
  { name: 'AskDock', family: 'ask', file: 'apps/desktop/src/renderer/ui/ask/AskDock.tsx' },
  { name: 'AskTurn', family: 'ask', file: 'apps/desktop/src/renderer/ui/ask/AskTurn.tsx' },
  { name: 'StepLog', family: 'ask', file: 'apps/desktop/src/renderer/ui/ask/StepLog.tsx' },
  { name: 'Citation', family: 'ask', file: 'apps/desktop/src/renderer/ui/ask/Citation.tsx' },
  {
    name: 'ProposalCard',
    family: 'ask',
    file: 'apps/desktop/src/renderer/ui/ask/ProposalCard.tsx',
  },
  { name: 'Palette', family: 'ask', file: 'apps/desktop/src/renderer/ui/ask/Palette.tsx' },
  { name: 'SearchField', family: 'ask', file: 'apps/desktop/src/renderer/ui/ask/SearchField.tsx' },
  {
    name: 'OperatorToken',
    family: 'ask',
    file: 'apps/desktop/src/renderer/ui/ask/OperatorToken.tsx',
  },
  {
    name: 'MiniMonth',
    family: 'calendar',
    file: 'apps/desktop/src/renderer/ui/calendar/MiniMonth.tsx',
  },
  {
    name: 'CalendarList',
    family: 'calendar',
    file: 'apps/desktop/src/renderer/ui/calendar/CalendarList.tsx',
  },
  {
    name: 'CalendarGrid',
    family: 'calendar',
    file: 'apps/desktop/src/renderer/ui/calendar/CalendarGrid.tsx',
  },
  {
    name: 'EventBlock',
    family: 'calendar',
    file: 'apps/desktop/src/renderer/ui/calendar/EventBlock.tsx',
  },
  {
    name: 'PlanOutline',
    family: 'calendar',
    file: 'apps/desktop/src/renderer/ui/calendar/PlanOutline.tsx',
  },
  {
    name: 'NowLine',
    family: 'calendar',
    file: 'apps/desktop/src/renderer/ui/calendar/NowLine.tsx',
  },
  {
    name: 'EventDetail',
    family: 'calendar',
    file: 'apps/desktop/src/renderer/ui/calendar/EventDetail.tsx',
  },
  {
    name: 'ScopeChooser',
    family: 'calendar',
    file: 'apps/desktop/src/renderer/ui/calendar/ScopeChooser.tsx',
  },
  {
    name: 'DatePresets',
    family: 'calendar',
    file: 'apps/desktop/src/renderer/ui/calendar/DatePresets.tsx',
  },
  {
    name: 'SettingRow',
    family: 'settings',
    file: 'apps/desktop/src/renderer/ui/settings/SettingRow.tsx',
  },
  {
    name: 'ProviderTable',
    family: 'settings',
    file: 'apps/desktop/src/renderer/ui/settings/ProviderTable.tsx',
  },
  {
    name: 'KeyRecorder',
    family: 'settings',
    file: 'apps/desktop/src/renderer/ui/settings/KeyRecorder.tsx',
  },
  {
    name: 'StatusSlot',
    family: 'status',
    file: 'apps/desktop/src/renderer/ui/status/StatusSlot.tsx',
  },
  {
    name: 'ReconnectSheet',
    family: 'status',
    file: 'apps/desktop/src/renderer/ui/status/ReconnectSheet.tsx',
  },
  {
    name: 'ProgressSegments',
    family: 'status',
    file: 'apps/desktop/src/renderer/ui/status/ProgressSegments.tsx',
  },
  {
    name: 'FatalScreen',
    family: 'status',
    file: 'apps/desktop/src/renderer/ui/status/FatalScreen.tsx',
  },
  { name: 'Spinner', family: 'status', file: 'apps/desktop/src/renderer/ui/status/Spinner.tsx' },
  { name: 'Switch', family: 'controls', file: 'apps/desktop/src/renderer/ui/controls/Switch.tsx' },
  {
    name: 'Checkbox',
    family: 'controls',
    file: 'apps/desktop/src/renderer/ui/controls/Checkbox.tsx',
  },
  {
    name: 'SwatchPicker',
    family: 'controls',
    file: 'apps/desktop/src/renderer/ui/controls/SwatchPicker.tsx',
  },
  {
    name: 'TextField',
    family: 'controls',
    file: 'apps/desktop/src/renderer/ui/controls/TextField.tsx',
  },
  {
    name: 'ShortcutSheet',
    family: 'controls',
    file: 'apps/desktop/src/renderer/ui/controls/ShortcutSheet.tsx',
  },
  {
    name: 'OnboardingStep',
    family: 'onboarding',
    file: 'apps/desktop/src/renderer/ui/onboarding/OnboardingStep.tsx',
  },
  {
    name: 'ChoiceRow',
    family: 'onboarding',
    file: 'apps/desktop/src/renderer/ui/onboarding/ChoiceRow.tsx',
  },
  {
    name: 'ConsentCard',
    family: 'onboarding',
    file: 'apps/desktop/src/renderer/ui/onboarding/ConsentCard.tsx',
  },
  {
    name: 'ChoiceGroup',
    family: 'onboarding',
    file: 'apps/desktop/src/renderer/ui/onboarding/ChoiceGroup.tsx',
  },
] as const satisfies readonly ComponentEntry[];

/** Name of every component in the manifest. */
export type ComponentName = (typeof COMPONENTS)[number]['name'];

/** Props type for each component name; implementations type themselves as `(props: ComponentPropsMap['X']) => ReactNode`. */
export interface ComponentPropsMap {
  Button: ButtonProps;
  Kbd: KbdProps;
  Tooltip: TooltipProps;
  Pane: PaneProps;
  PageHead: PageHeadProps;
  NavHead: NavHeadProps;
  AccountSwitcher: AccountSwitcherProps;
  Text: TextProps;
  Menu: MenuProps;
  Popover: PopoverProps;
  Dialog: DialogProps;
  Confirm: ConfirmProps;
  Puck: PuckProps;
  Toast: ToastProps;
  ToastStack: ToastStackProps;
  ListBox: ListBoxProps;
  ListGroup: ListGroupProps;
  ListRow: ListRowProps;
  SectionHeader: SectionHeaderProps;
  FocusSlot: FocusSlotProps;
  FocusLetter: FocusLetterProps;
  LowBand: LowBandProps;
  LowSheet: LowSheetProps;
  CommitChip: CommitChipProps;
  CommitEdge: CommitEdgeProps;
  Chip: ChipProps;
  EmptyLine: EmptyLineProps;
  ErrorLine: ErrorLineProps;
  ReaderHead: ReaderHeadProps;
  ReaderActions: ReaderActionsProps;
  ThreadMessage: ThreadMessageProps;
  LoadingLine: LoadingLineProps;
  ReplyStub: ReplyStubProps;
  Summary: SummaryProps;
  Why: WhyProps;
  UndoTray: UndoTrayProps;
  Composer: ComposerProps;
  InlineReply: InlineReplyProps;
  RecipientField: RecipientFieldProps;
  DraftState: DraftStateProps;
  Suggestion: SuggestionProps;
  LevelMeter: LevelMeterProps;
  AskDock: AskDockProps;
  AskTurn: AskTurnProps;
  StepLog: StepLogProps;
  Citation: CitationProps;
  ProposalCard: ProposalCardProps;
  Palette: PaletteProps;
  SearchField: SearchFieldProps;
  OperatorToken: OperatorTokenProps;
  MiniMonth: MiniMonthProps;
  CalendarList: CalendarListProps;
  CalendarGrid: CalendarGridProps;
  EventBlock: EventBlockProps;
  PlanOutline: PlanOutlineProps;
  NowLine: NowLineProps;
  EventDetail: EventDetailProps;
  ScopeChooser: ScopeChooserProps;
  DatePresets: DatePresetsProps;
  SettingRow: SettingRowProps;
  ProviderTable: ProviderTableProps;
  KeyRecorder: KeyRecorderProps;
  StatusSlot: StatusSlotProps;
  ReconnectSheet: ReconnectSheetProps;
  ProgressSegments: ProgressSegmentsProps;
  FatalScreen: FatalScreenProps;
  Spinner: SpinnerProps;
  Switch: SwitchProps;
  Checkbox: CheckboxProps;
  SwatchPicker: SwatchPickerProps;
  TextField: TextFieldProps;
  ShortcutSheet: ShortcutSheetProps;
  OnboardingStep: OnboardingStepProps;
  ChoiceRow: ChoiceRowProps;
  ConsentCard: ConsentCardProps;
  ChoiceGroup: ChoiceGroupProps;
}

/** Compile-time guard: resolves to `never` while the manifest and the props map name exactly the same components. */
type AssertNever<T extends never> = T;

/** Fails to compile if a manifest component has no entry in `ComponentPropsMap`. */
export type ManifestComponentsWithoutProps = AssertNever<
  Exclude<ComponentName, keyof ComponentPropsMap>
>;

/** Fails to compile if `ComponentPropsMap` names a component the manifest lacks. */
export type PropsWithoutManifestComponent = AssertNever<
  Exclude<keyof ComponentPropsMap, ComponentName>
>;
