import type { ReactNode, Ref } from 'react';
import type {
  Announce,
  CommandId,
  DictationState,
  IconName,
  IsoDateTime,
  TagColor,
} from './shared';
import type { ConfirmProps } from './surfaces';

/* ───────────────────────── ask ───────────────────────── */

/** A follow-up typed while an answer streams, queued as a small editable card (DESIGN §7.7). */
export interface QueuedFollowUp {
  /** Stable id. */
  id: string;
  /** Editable text. */
  text: string;
}

/** The Ask empty view: three plain suggestions and recent chats with times (DESIGN §7.7 Empty, §7.14). */
export interface AskEmptyData {
  /** Plain suggested questions. */
  suggestions: readonly string[];
  /** Recent chats. */
  recents: readonly { id: string; question: string; at: IsoDateTime }[];
  /** Index under the ↑/↓ cursor across suggestions then recents. */
  cursorIndex?: number;
  /** A suggestion was picked (asks it). */
  onPickSuggestion: (question: string) => void;
  /** A recent chat was opened. */
  onOpenRecent: (id: string) => void;
}

/** The Ask dock: a 360 px second pane with an Ask | Today Puck and close; field placeholder "Ask about your mail or calendar"; input never disabled (DESIGN §6 AskDock, §7.7). Mockups: ask.html (answer, empty, working, no-provider, today). Plain + refines: ui-ask; frame on ui-foundation's Pane. */
export interface AskDockProps {
  /** Active tab. */
  tab: 'ask' | 'today';
  /** Tab changed. */
  onTabChange: (tab: 'ask' | 'today') => void;
  /** Close (⌘J, the close button, or the end of the Esc ladder). */
  onClose: () => void;
  /** User-chosen width, clamped by the component to 300–440 (320 default under 1180 px); state, not styling (DESIGN §4.4). */
  width: number;
  /** Width changed by dragging the edge; the screen remembers it. */
  onWidthChange: (width: number) => void;
  /** No provider: "Add an AI key to ask." and a link above the field, with Ask disabled; no red error. */
  providerReady: boolean;
  /** The Settings link. */
  onOpenSettings: () => void;
  /** The conversation (AskTurn list); omit for the empty view. */
  conversation?: ReactNode;
  /** The empty view when there is no conversation. */
  empty?: AskEmptyData;
  /** The Today tab body (CalendarGrid in 'agenda' view plus "Open Calendar"). */
  today: ReactNode;
  /** Field text. */
  value: string;
  /** Field text changed. */
  onChange: (value: string) => void;
  /** Return asks; ⌘Return searches all mail (DESIGN §8 Ask). */
  onSubmit: (mode: 'ask' | 'searchAll') => void;
  /** An answer is streaming: Esc stops before it clears or closes. */
  working: boolean;
  /** Stop the running answer. */
  onStop: () => void;
  /** Queued follow-ups (⌘Return sends now). */
  queued: readonly QueuedFollowUp[];
  /** A queued card was edited. */
  onQueuedChange: (id: string, text: string) => void;
  /** Send a queued card now. */
  onSendQueuedNow: (id: string) => void;
  /** Dictating to Ask (hold A): the field shows the meter and the Listening line (DESIGN §8 Global). */
  dictation?: DictationState;
  /** Ref to the field so A can focus it. */
  fieldRef?: Ref<HTMLTextAreaElement>;
}

/** One run of answer prose. */
export type AnswerSegment =
  | {
      /** Prose. */
      kind: 'text';
      /** Text. */
      text: string;
      /** The decisive fact, weight 500 (DESIGN §7.7). */
      strong?: boolean;
    }
  | {
      /** A citation chip. */
      kind: 'cite';
      /** 1-based index into the turn's citations. */
      index: number;
    };

/** A paragraph of answer prose. */
export type AnswerParagraph = readonly AnswerSegment[];

/** A source behind a citation: a message (default), or a calendar event when `kind` is 'event' (data `Citation`, F1). */
export interface CitationData {
  /** 1-based number shown as mono "[1]". */
  index: number;
  /** The quoted sentence shown on hover or focus. */
  quote: string;
  /** Sender name; for an event, its calendar's name. */
  from: string;
  /** Message time; for an event, its start. */
  date: IsoDateTime;
  /** Thread subject; for an event, its title. */
  subject: string;
  /** Thread to open on click; '' for an event. */
  threadId: string;
  /** What the source is; absent means 'message'. An 'event' source opens with `eventId`. */
  kind?: 'message' | 'event';
  /** The event to open on click when `kind` is 'event'. */
  eventId?: string;
}

/** One question and its answer: the question as a `base` 500 line (no bubble), serif `answer` prose, citations, step log, an optional proposal (DESIGN §6 AskTurn, §7.7). Mockups: ask.html (answer, working). Plain + refines: ui-ask. */
export interface AskTurnProps {
  /** Stable id. */
  id: string;
  /** The question. */
  question: string;
  /** 'working' = steady step line; 'streaming' = one thin non-blinking caret; 'answered'; 'stopped' = "Stopped."; 'failed' = ErrorLine askFailed; 'paused' = the model's daily limit is reached: "Paused for today. Resumes tomorrow." (a quiet line, never red; shows "Use another provider" when `onUseAnotherProvider` is given; the plan 30 §4.5 phrase is reused for Ask's per-model daily limit, ARCH §8.4); 'excluded' = the draft's account is left out of AI: "This account is turned off for AI." (a quiet line like 'paused'; shows "Open Settings" when `onOpenSettings` is given). */
  state: 'working' | 'streaming' | 'answered' | 'stopped' | 'failed' | 'paused' | 'excluded';
  /** The step log (live line while working, dim fold after). */
  steps?: StepLogProps;
  /** Answer prose. */
  answer?: readonly AnswerParagraph[];
  /** Sources; every answer cites or says "No source in your mail". */
  citations: readonly CitationData[];
  /** Provider display name for "<Provider> didn't answer." */
  provider?: string;
  /** Who wrote the answer, shown only on hover of the answer (DESIGN §9 rule 5): "Answer by Groq", "Answer by Ollama on this Mac". */
  provenance?: { provider: string; local: boolean };
  /** The turn's one proposal card. */
  proposal?: ProposalCardProps;
  /** Open a cited thread; `index` is the citation's number ([1] = 1) so the screen can scroll to or mark it. */
  onOpenCitation: (threadId: string, index: number) => void;
  /** Open a cited calendar event (a citation with `kind: 'event'`); `index` as above. */
  onOpenEventCitation?: (eventId: string, index: number) => void;
  /** Retry after a failure. */
  onRetry?: () => void;
  /** "Use another provider" after a failure or when the state is 'paused'. */
  onUseAnotherProvider?: () => void;
  /** "Open Settings" when the state is 'excluded' (the account's AI toggle lives in Settings → AI). */
  onOpenSettings?: () => void;
}

/** One steady line naming the real step ("Reading 14 emails from Jordan") that folds into a dim, expandable step log (DESIGN §6 StepLog, §7.7). Mockups: ask.html (answer, working). Plain + refines: ui-ask. */
export interface StepLogProps {
  /** The live step while working; absent once folded. */
  current?: string;
  /** Fold summary, e.g. "Read 14 emails from Jordan · 3 steps". */
  summary: string;
  /** Finished steps in order. */
  steps: readonly string[];
  /** Fold is open. */
  expanded: boolean;
  /** Open or close the fold. */
  onToggle: () => void;
}

/** A mono "[1]" chip that shows the quoted sentence on hover or focus and opens the source on click (DESIGN §6 Citation, §7.7). Mockups: ask.html. Plain + refines: ui-ask. */
export interface CitationProps extends CitationData {
  /** Open the source thread, with the chip's number. */
  onOpen: (threadId: string, index: number) => void;
  /** Open the source event when `kind` is 'event' (calls this with `eventId` instead of `onOpen`), with the chip's number. */
  onOpenEvent?: (eventId: string, index: number) => void;
}

/** The dock's one card; owns the filled button; a consequence line and two key rows (Return / Esc); nothing applies without confirmation (DESIGN §6 ProposalCard, §7.7, §9 rule 6). Mockups: ask.html (answer). Plain + refines: ui-ask. */
export interface ProposalCardProps {
  /** What it does, e.g. "Add to Calendar". */
  kicker: string;
  /** The item, e.g. "Design review". */
  title: string;
  /** Consequence line, e.g. "Thu 2:00–2:30 PM · Hollow Creek". */
  consequence: string;
  /** Calendar colour mark beside the title. */
  color?: TagColor;
  /** Confirm verb on the filled button, e.g. "Add". */
  confirmLabel: string;
  /** 'pending' shows the card; 'applied' shows one check line; 'dismissed' renders nothing. */
  state: 'pending' | 'applied' | 'dismissed';
  /** The applied line, e.g. "Added to Calendar · Thu 2:00–2:30 PM · Hollow Creek". */
  appliedText?: string;
  /** Return. */
  onConfirm: () => void;
  /** Esc, "Not now". */
  onDismiss: () => void;
}

/** One palette result. */
export interface PaletteItem {
  /** Stable option id (DOM id for `aria-activedescendant`). */
  id: string;
  /** Registry command it runs; supplies the keycap. For a Settings row it is the setting entry id ("setting.mail.undoSeconds"), for a nested page row the row's id; neither has a keycap. */
  commandId: CommandId;
  /** Command label. */
  label: string;
  /** Command icon; absent for commands without one, Settings rows and most nested page rows (the row keeps its icon column empty). */
  icon?: IconName;
  /** Character indices of `label` to bold for the match. */
  matches?: readonly number[];
  /** Group name shown on the right while filtering, e.g. "Actions". */
  group?: string;
  /** Destructive: running it opens the Confirm sub-view. */
  destructive?: boolean;
  /** Dim text on the right: a Settings row's section ("Mail"), a nested page row's detail. */
  detail?: string;
  /** Running it opens a nested page (registry status 'page'): the row shows a chevron and the title joins `trail`. */
  opensPage?: boolean;
}

/** A labelled group of palette results. */
export interface PaletteSection {
  /** Stable id. */
  id: string;
  /** "Suggested", "Go to", "Actions", "Ask", "Settings". */
  label: string;
  /** Results in order. */
  items: readonly PaletteItem[];
}

/** ⌘K, the only overlay: opaque `--paper`, `--elev-float`, 600 px, light scrim, `settle`; a context line, sections with keycaps, 1–9 while the field is empty, Esc up a level then close (DESIGN §6 Palette, §7.9). Mockups: palette.html (commands, filtered, confirm). Plain + refines: ui-ask. */
export interface PaletteProps {
  /** Whether it is shown. */
  open: boolean;
  /** Field text. */
  query: string;
  /** Field text changed. */
  onQueryChange: (value: string) => void;
  /** The target, shown as "For: <context>", e.g. "Drew Bell · October illustrations". One line: a long one ends in an ellipsis and carries the full text as its tooltip. */
  context?: string;
  /** Breadcrumbs for nested pages. */
  trail?: readonly string[];
  /** Result sections; flat (one section) while filtering; empty shows "No commands match '<query>'." */
  sections: readonly PaletteSection[];
  /** Option under the cursor. */
  activeId?: string;
  /** Cursor moved. */
  onActiveChange: (id: string) => void;
  /** Run a result (Return, click, or digit 1–9 with an empty field). */
  onRun: (id: string) => void;
  /** The destructive confirm sub-view, presentation 'inline'. */
  confirm?: ConfirmProps;
  /** DOM id of the results listbox (combobox wiring). */
  listboxId: string;
  /** Esc: up a level (confirm → list, nested → parent). */
  onBack: () => void;
  /** Esc at the top level, ⌘K again, or scrim click. */
  onClose: () => void;
  /** Announcements (DESIGN §11.3). */
  announce?: Announce;
}

/** Recognised search operators (DESIGN §7.9). */
export type SearchOperator = 'from' | 'to' | 'subject' | 'has' | 'before' | 'after' | 'in';

/** A removable pill token for a recognised operator, e.g. "from: jordan" (DESIGN §6 SearchField + OperatorToken, §4.5 pill). Mockups: search.html (results). Plain + refines: ui-ask. */
export interface OperatorTokenProps {
  /** Operator. */
  operator: SearchOperator;
  /** Value, e.g. "jordan", "attachment", "done". */
  value: string;
  /** Remove the token. */
  onRemove: () => void;
}

/** The Search page field at `heading` size in the PageHead row, with a 2 px accent underline while focused; tokens under it, or with no tokens the fixed hint "Narrow with from:, to:, subject:, has:attachment, before:, after:, in:done"; remote Gmail search only on Return (DESIGN §6 SearchField, §7.9). Mockups: search.html (results, no-match). Plain + refines: ui-ask. */
export interface SearchFieldProps {
  /** Free text (placeholder "Search mail"). */
  value: string;
  /** Free text changed; the screen turns "from:x " into a token. */
  onChange: (value: string) => void;
  /** Recognised operators as tokens. */
  tokens: readonly { operator: SearchOperator; value: string }[];
  /** Remove a token by index (also Backspace on an empty field removes the last). */
  onRemoveToken: (index: number) => void;
  /** Return: search all mail on Google. */
  onSubmit: () => void;
  /** Scope label on the right, e.g. "All accounts". */
  scopeLabel: string;
  /** Open the scope picker. */
  onScope?: (anchor: HTMLElement) => void;
  /** DOM id of the results listbox (`aria-controls`). */
  resultsId: string;
  /** ↓ / ↑ hands the keyboard to the results list. */
  onLeaveToList: (edge: 'first' | 'last') => void;
  /** Ref so / can focus the field. */
  inputRef?: Ref<HTMLInputElement>;
}
