import type { ReactNode, Ref } from 'react';
import type {
  CommandAction,
  CommandId,
  CommitKind,
  Density,
  DueInfo,
  IconName,
  IsoDateTime,
  LaterUntil,
  ListboxBinding,
  RejectedWrite,
  SuggestedAction,
  TagColor,
  TriageCommands,
} from './shared';
import type { OperatorTokenProps } from './ask';

/* ───────────────────────── list ───────────────────────── */

/**
 * A quick action that overlays the date column on hover, an icon button with tooltip and key (DESIGN §5 rule 17, §7.4).
 * Inside an `option` it is a pointer duplicate: `tabIndex={-1}` and `aria-hidden`, because every row action has a key
 * and options' children are presentational (DESIGN §11.3; see README Accessibility).
 */
export interface RowAction {
  /** Registry command run on click (passed to onAction). */
  commandId: CommandId;
  /** Icon. */
  icon: IconName;
  /** Accessible name and tooltip, e.g. "Done", "Move to Home". */
  label: string;
}

/** Column layout of a row. 'home' = 148 px sender; 'list' = 152 px sender + date; 'later' = the `laterUntil` chip in the date column; 'done' = fixed stamp column (the date it was finished behind a quiet check) with the hover action to its left (DESIGN §4.4, §7.3, §7.4). */
export type RowLayout = 'home' | 'list' | 'later' | 'done';

/** A mail row: fixed height per density, sender, subject then a muted summary, due chip, date; no avatar (DESIGN §4.1 Rows, §6 ListRow, §7.2–7.4). Hosts the cursor layer, bulk-pick wash, swipe underlay and hover actions. Mockups: home.html, inbox.html, later.html, done.html, search.html, errors.html (row-error). Plain + refines: ui-foundation; used by ui-home, ui-ask (search). */
export interface ListRowProps {
  /** DOM id of the `option`, used by the list's `aria-activedescendant`. */
  id: string;
  /** Column layout. */
  layout: RowLayout;
  /** Fixed row height 48 / 40 / 34. */
  density: Density;
  /** Who column: sender, or recipients on Sent. */
  sender: string;
  /** The tooltip of the who column when it differs from the text, e.g. the full addresses behind "To: Jordan". */
  senderTitle?: string;
  /** Main line: the subject, always (owner decision 2026-11-16). */
  primary: string;
  /** A quiet word before the main line that says what kind of row this is: "Draft" in Drafts, so it never reads as sent mail. */
  tag?: string;
  /** Muted phrase after the subject: a written summary, or a search snippet (DESIGN §4.1 Rows). */
  secondary?: string;
  /** Search terms to bold in `primary` and `secondary` (search.html). */
  highlight?: readonly string[];
  /** Unread: 600 `--ink` sender and a 500 `--ink-2` line; no dot (owner decision 2026-11-13). Screen readers hear "Unread". */
  unread: boolean;
  /** Received (list, home), edited (Drafts) or sent (Sent) time for the date column. */
  date: IsoDateTime;
  /** Due-date chip (D, structured or found), before the date column in every layout. Never the Later date. */
  due?: DueInfo;
  /** 'later' layout only: when it comes back; replaces the date column with a 'laterUntil' Chip (DESIGN §7.3). */
  laterUntil?: LaterUntil;
  /** The row sits under a date group header ("Today", "Yesterday"): a day the header names shows the time, not the word again. */
  dayGrouped?: boolean;
  /** For 'done' layout: when it was finished, drawn as the date in the stamp column. */
  doneAt?: IsoDateTime;
  /** For 'done' layout: `doneAt` is the last message's date, not a finish time (the tooltip must not claim one). */
  doneEstimated?: boolean;
  /** Meta marks before the date: replied, bookmarked, attachment. */
  marks?: { replied?: boolean; bookmarked?: boolean; attachment?: boolean };
  /** The row's account name, shown only in the row tooltip (owner decision 2026-11-13: no account dot on rows). Screens pass it when two or more accounts are connected. */
  account?: { label: string };
  /** Under the keyboard cursor: `--puck` fill + 2 px accent bar (DESIGN §4.1). */
  cursor: boolean;
  /** Bulk-picked: `--accent-wash` (DESIGN §7.4). */
  picked: boolean;
  /** The list has picks, so the pick column shows. */
  picking: boolean;
  /** Hover actions, in order; they overlay the date column (or sit left of the stamp). Empty for remote search results. */
  hoverActions: readonly RowAction[];
  /** What the swipe underlay reveals in each direction; the motion runtime drives it imperatively through `ref` (DESIGN §4.9 Swipe). */
  swipe?: { right: CommitKind; left: CommitKind };
  /** A rejected write: the row is back in place with "Couldn't <op>." and Retry (DESIGN §5 rule 11, §7.15). */
  rejected?: RejectedWrite;
  /** Lifted while dragged (`lift`, `--elev-lift`, DESIGN §7.3). */
  lifted?: boolean;
  /** Click: move the cursor here. */
  onSelect: () => void;
  /** Double-click: open. Return/O are routed by the registry. */
  onOpen: () => void;
  /** A hover action was clicked; the element anchors a Menu or DatePresets (More, Later). */
  onAction: (commandId: CommandId, anchor: HTMLElement) => void;
  /** Element ref for the cursor layer, ghost cloning and swipe (DESIGN §5 rule 3). */
  ref?: Ref<HTMLElement>;
}

/** The one listbox container for every mail list: Home, Later, All mail, Done, Drafts, Sent, Trash, Spam, search results, the Low-importance sheet (DESIGN §11.3). Focusable, owns `aria-activedescendant`; children are ListGroups or options (ListRow, FocusSlot › FocusLetter, LowBand). Mockups: home.html, inbox.html, later.html, done.html, search.html. Plain + refines: ui-foundation; used by ui-home, ui-ask. */
export interface ListBoxProps {
  /** Id, accessible name and active option. */
  binding: ListboxBinding;
  /** Bulk picking is on (`aria-multiselectable`). */
  multiselectable?: boolean;
  /** ListGroups and options only. */
  children: ReactNode;
  /** Element ref so the screen can focus the list. */
  ref?: Ref<HTMLElement>;
}

/** A labelled group inside a ListBox: `role="group"` + `aria-labelledby` its SectionHeader, which renders as a presentational first child (the WAI-ARIA grouped-listbox pattern). Mockups: home.html (Do now, Important updates), later.html, inbox.html and done.html (date groups). Plain + refines: ui-foundation; used by ui-home, ui-ask. */
export interface ListGroupProps {
  /** The group's label; its `id` labels the group. */
  header: SectionHeaderProps;
  /** Options in the group. */
  children: ReactNode;
}

/** A section label: `ui` 600 `--ink` + `--dim` count + one optional quiet text action; Tab / ⇧Tab target; stays, showing 0, until `hold` releases (DESIGN §5 rule 6, §6 SectionHeader). Mockups: home.html, later.html (groups, drag targets), inbox.html and done.html (date groups), search.html, settings.js. Plain + refines: ui-foundation; used by ui-home, ui-ask, ui-settings. */
export interface SectionHeaderProps {
  /** DOM id; the group's heading for `aria-labelledby`. */
  id: string;
  /** e.g. "Do now", "Important updates", "Overdue", "Today", "Accounts". */
  label: string;
  /** 'section' = `ui` 600 label; 'sub' = `small` 500 `--dim` sub-label ("Back from Later"); 'date' = a date group in All mail and Done. */
  variant: 'section' | 'sub' | 'date';
  /** Count in `--dim`; omit for none. While `held` it may be 0. */
  count?: number;
  /** Keep rendering at count 0 because `hold` has not released (DESIGN §5 rule 6). */
  held?: boolean;
  /** 'overdue' adds a clock and `--stamp-ink` text so colour is not the only cue (DESIGN §7.3). */
  tone?: 'default' | 'overdue';
  /** "2 new" beside the label while new mail waits under `hold` (DESIGN §7.2). */
  waitingNew?: number;
  /** One quiet `--dim` text action, e.g. "Go one by one" (S), "Clear from Home", "Reset all", "Unsubscribe" in the Low-importance sheet. Inside a ListBox it is a pointer duplicate of its key. */
  action?: CommandAction;
  /** Drag state while a Later row is lifted; the label names the time it resolves to (DESIGN §7.3). */
  dropTarget?: {
    /** e.g. "Tomorrow, 8:00 AM". */
    label: string;
    /** 'available', 'over' (the row hovers it) or 'unavailable' (Overdue). */
    state: 'available' | 'over' | 'unavailable';
  };
}

/** The fixed-height Home slot that holds the focus letter: 196 / 180 / 164 px, never animates height; `deal` plays inside it (DESIGN §4.4, §4.8 `deal`, §6 FocusSlot). Mockups: home.html. Plain + refines: ui-foundation; used by ui-home. */
export interface FocusSlotProps {
  /** Sets the fixed height. */
  density: Density;
  /** 'fixed' (default) holds the density's height for a card with a summary or its placeholder; 'content' fits a card with no summary coming (owner decision 2026-11-13). */
  fit?: 'fixed' | 'content';
  /** The FocusLetter. */
  children: ReactNode;
  /** Element ref for `deal` and the flight ghost. */
  ref?: Ref<HTMLElement>;
}

/** What a summary slot shows (DESIGN §6 Summary, §9 rules 3, 5, 7). */
export type SummaryContent =
  | {
      /** Waiting: the focus card shows the quiet "Summarizing…" placeholder in the summary's space (owner decision 2026-11-13). */
      state: 'pending';
      /** The accessible name of the card's text while pending; not drawn on the card. */
      subject: string;
    }
  | {
      /** No provider, Summaries off, the account excluded, or no summary will come (failed, timed out): the subject in SF, the space collapses, no error. */
      state: 'absent';
      /** Shown in SF. */
      subject: string;
    }
  | {
      /** The serif `summary` line. */
      state: 'ready';
      /** Summary text. */
      text: string;
      /** Kept for accessibility and the reader crumb. */
      subject: string;
      /** Hover: "Summary by Groq"; a local model adds "on this Mac". */
      provenance: { provider: string; local: boolean };
    };

/** The one big line, Newsreader `summary` 21/31 when ready, identical on Home and in the reader (DESIGN §4.3, §6 Summary). Mockups: home.html, reader.html (pending, no-ai). Plain + refines: ui-foundation; used by ui-home, ui-reader. */
export type SummaryProps = SummaryContent & {
  /** Home cuts at two lines; the reader never cuts (DESIGN decision 11). Default 'none'. */
  clamp?: 'two-lines' | 'none';
  /** DOM id for the reader's summary landmark (DESIGN §11.3). */
  id?: string;
  /** A chip that leads the line, inline before the text: the Home card puts its Later or due chip here, where a list row puts it before the subject. */
  lead?: ReactNode;
};

/** The Home focus letter card (`--elev-card`): meta line, two-line serif summary, action row; no subject line and no bookmark icon (DESIGN §7.2 The focus letter). Mockups: home.html, demo.html. Plain + refines: ui-foundation; used by ui-home. */
export interface FocusLetterProps {
  /** DOM id of the `option` (it is the selected option of the Home listbox). */
  id: string;
  /** Sender in `base` 600. */
  sender: string;
  /** Due chip, if any: it leads the summary line (before the words), like a row's chip before the subject. */
  due?: DueInfo;
  /** Relative date on the right. */
  date: IsoDateTime;
  /** The row's own marks (bookmarked, attachment), kept when a row is promoted to the card. */
  marks?: { replied?: boolean; bookmarked?: boolean; attachment?: boolean };
  /** Summary slot; clamped to two lines here. */
  summary: SummaryContent;
  /** The suggestion as the filled button with Space; Later and Done as text buttons; then ⋯. */
  suggestion: SuggestedAction;
  /** Registry ids for the four controls. */
  commands: TriageCommands;
  /** Another surface owns the filled button (composer, palette, dialog, proposal): the suggestion becomes a text button (DESIGN §4.6). */
  demoted: boolean;
  /** Pane under 700 px: labels drop, the Space verb stays (DESIGN §7.2 Narrow). */
  narrow?: boolean;
  /** Bulk-picked: the card takes `--accent-wash` like a picked row (DESIGN §7.4); the cursor row is the letter, so X must show on it. */
  picked?: boolean;
  /** The write on this item was rejected: "Couldn't <op>." with Retry on the card (DESIGN §5 rule 11). */
  rejected?: RejectedWrite;
  /** Suggestion button. Buttons on the card are pointer duplicates of their keys inside the option (README Accessibility). */
  onSuggestion: () => void;
  /** Later button; the element anchors DatePresets (later-picker.html). */
  onLater: (anchor: HTMLElement) => void;
  /** Done button. */
  onDone: () => void;
  /** ⋯ button; the screen opens a Menu at this anchor (bookmark, trash, "Why it's here"). */
  onMore: (anchor: HTMLElement) => void;
}

/** The one-line low-importance band on `--raised`: label, up to three senders and "and N more" in `--dim`, plain count right; no left badge (DESIGN §7.2). Mockups: home.html. Plain + refines: ui-foundation; used by ui-home. */
export interface LowBandProps {
  /** DOM id of the `option`. */
  id: string;
  /** Sender names; the band shows the first three. */
  senders: readonly string[];
  /** Senders beyond those in `senders`, when the caller passes only the first few: they add to "and N more" after the names. Default 0. */
  moreSenders?: number;
  /** Number of threads in the band. */
  count: number;
  /** Under the keyboard cursor. */
  cursor: boolean;
  /** Fixed height per density. */
  density: Density;
  /** Registry command for the tooltip "Open low importance" and its key (Return). Absent: the band is click-only (no cursor, as at a count of 0) and the tooltip names no key. */
  commandId?: CommandId;
  /** Click or Return: open the Low-importance sheet. */
  onOpen: () => void;
}

/** One sender group in the Low-importance sheet. */
export interface LowSheetGroup {
  /** Stable id; also the group header's DOM id. */
  id: string;
  /** Sender name, the group label. */
  sender: string;
  /** The sender's rows (layout 'list'). */
  rows: readonly ListRowProps[];
  /** Per-sender Unsubscribe, present only once List-Unsubscribe lands for this sender (DESIGN §7.2). */
  onUnsubscribe?: () => void;
}

/** The Low-importance sheet opened from the LowBand: grouped by sender (a header for every sender, even a single row), hover preview in the bar, per-sender Unsubscribe. The Done key: a tap marks the cursor row done, holding it for 600 ms marks everything done (the button fills while it is held). Empty: "No low-importance mail." with "Back to Home" (DESIGN §7.2, §7.14). Not drawn in the mockups. Plain + refines: ui-foundation; used by ui-home. */
export interface LowSheetProps {
  /** Whether it is shown (a Dialog, size 'md'). */
  open: boolean;
  /** Listbox wiring for the rows. */
  binding: ListboxBinding;
  /** Sender groups; empty shows the empty line. */
  groups: readonly LowSheetGroup[];
  /**
   * Every low-importance thread (the view's total), for the count in the header and the mark-all copy. The window
   * may show fewer rows than exist, so it is never counted from `groups`; absent, the groups' rows are summed.
   */
  total?: number;
  /** Registry command for the Done key (its keycap on the button, and which arrow the sheet listens for). */
  markAllCommandId: CommandId;
  /** Row whose preview shows on hover, with its text from the data hook. */
  preview?: { rowId: string; text: string };
  /** Pointer entered or left a row; the screen loads the preview text. */
  onPreview?: (rowId: string | null) => void;
  /** A tap of the Done key: mark the row under the cursor done (the cursor moves to the next row). */
  onDoneCursor: () => void;
  /** The Done key held, or a click on the button: mark everything done. */
  onCommitAll: () => void;
  /** Esc or "Back to Home". */
  onClose: () => void;
}

/** Solid hill / dusk / stamp commit chip, 26 px, `--radius-sm`, icon + word; static, drawn on the ghost (DESIGN §4.9, §6 CommitChip). Mockups: home.html, reader.html (commit). Plain + refines: ui-foundation; motion by ui-shell. */
export interface CommitChipProps {
  /** Done (check), Later (clock) or Trash. */
  kind: CommitKind;
  /** Element ref for the `commit` motion. */
  ref?: Ref<HTMLElement>;
}

/** The 3 px commit edge on the leaving edge (right for Done and Trash, left for Later) (DESIGN §4.9, §6 CommitEdge). Mockups: home.html. Plain + refines: ui-foundation; motion by ui-shell. */
export interface CommitEdgeProps {
  /** Colour and side. */
  kind: CommitKind;
  /** Element ref for the `commit` motion (scaleY 0→1). */
  ref?: Ref<HTMLElement>;
}

/** Due, label, attachment and operator chips: 24 px, radius 6, `--raised`; overdue on `--stamp-tint`; pill only for operator tokens (DESIGN §6 Chip). Mockups: home.html, reader.html (due, attachments), later.html, search.html (operators). Plain + refines: ui-foundation; operator kind delegates to OperatorToken. */
export type ChipProps =
  | {
      /** A due date with a calendar icon; the clock belongs to Later and return times. */
      kind: 'due';
      /** The due date. */
      due: DueInfo;
      /** 'short' = "Due tomorrow" / "Due Sat" / "Due Nov 4"; 'withTime' = "Today, 5:00 PM"; 'sentence' = "Due tomorrow" (reader). */
      format: 'short' | 'withTime' | 'sentence';
    }
  | {
      /** When a Later item comes back, with a clock: "Back yesterday", "Back Tue, Oct 27", "Back today, 5:00 PM", "Back someday" (later.html). */
      kind: 'laterUntil';
      /** The Later date. */
      until: LaterUntil;
    }
  | {
      /** A mail label. */
      kind: 'label';
      /** Label name. */
      text: string;
      /** Outline colour (DESIGN §4.2). */
      color?: TagColor;
    }
  | {
      /** An attachment under a message; failed turns `--stamp-ink` with "Couldn't download." (DESIGN §7.5, §7.15). */
      kind: 'attachment';
      /** File name. */
      name: string;
      /** Size in bytes; formatted by the component. */
      sizeBytes: number;
      /** Download state. */
      state: 'ready' | 'downloading' | 'failed';
      /** The file's kind as an icon (`file-text` PDF, `file-image`, `file-archive`, `file-sheet`, `calendar`, `file`); default `file-text`. A failed chip shows `alert`. */
      icon?: IconName;
      /** Open or download. */
      onOpen: () => void;
      /** Try again after a failure. */
      onRetry?: () => void;
    }
  | ({
      /** A search operator token (pill). */
      kind: 'operator';
    } & OperatorTokenProps);

/** An empty state: one plain sentence plus at most one action (two only for No accounts); no icon in a circle (DESIGN §6 EmptyLine, §7.14). Mockups: empty.html, search.html (no-match), calendar-day.html (empty), ask.html (no-provider). Plain + refines: ui-foundation; used by ui-home, ui-ask, ui-calendar. */
export interface EmptyLineProps {
  /** The sentence, e.g. "No drafts", "Your first mail is on its way", "You handled 12 emails". No trailing period. */
  text: string;
  /** 'line' = one line in the column; 'display' = the `display` type size of inbox zero; it does not centre (that is `placement='pane'`). Default 'line'. */
  size?: 'line' | 'display';
  /** 'pane' = fills the pane body and centres the line both ways (list and screen empties); 'inline' = a compact line in flow (sheets, settings rows, under a field). Default 'inline'. */
  placement?: 'inline' | 'pane';
  /** One small muted mark above the line — the place's own glyph, e.g. 'trash' for Trash. Never in a circle. */
  icon?: IconName;
  /** A second dim line, e.g. "Next: Design review at 2:00 PM" or the status slot's reason. */
  detail?: string;
  /** The action, e.g. "Undo last" Z, "Search all mail on Google" Return, "New event" N, "Add an account" with `plus`. */
  action?: CommandAction & { emphasis: 'filled' | 'text' };
  /** Second action for No accounts only ("Try demo mail"). */
  secondaryAction?: CommandAction;
}

/** Actions an ErrorLine can offer. */
export type ErrorLineAction =
  'retry' | 'edit' | 'useAnotherProvider' | 'review' | 'replaceKey' | 'openSettings';

/** What went wrong; the component writes DESIGN §7.15's copy: what happened, what is safe, what to do; no exclamation marks. */
export type ErrorLineKind =
  | {
      /** "Couldn't <op>." with Retry (write rejected, on a row). */
      kind: 'writeRejected';
      /** Lower-case op phrase, e.g. "move to Later". */
      op: string;
    }
  | {
      /** "Couldn't send to <name>. Your draft is saved." with Try again · Edit. */
      kind: 'sendFailed';
      /** First name or label of the recipients. */
      recipient: string;
    }
  | {
      /** "Couldn't load this email." with Try again. */
      kind: 'bodyFailed';
    }
  | {
      /** "<Provider> didn't answer." with Retry · Use another provider. */
      kind: 'askFailed';
      /** Provider display name, e.g. "Groq". */
      provider: string;
    }
  | {
      /** "Background summaries are paused until you agree to the new provider." with Review (plan 30 §4.5 #1). */
      kind: 'consentNeeded';
    }
  | {
      /** "<Provider> refused the saved key, so nothing was sent. …" with Replace key (settings-ai.html testing). */
      kind: 'keyRefused';
      /** Provider display name. */
      provider: string;
      /** Where to get a fresh key, shown as plain text. */
      keyPage?: string;
    }
  | {
      /** First-sync sorting failed: "Couldn't sort with <Provider>: the key was refused. Mail is ready; sorting will retry." with Open Settings (DESIGN §7.12). 'unreachable' = "<Provider> didn't answer"; 'cap' = "today's AI limit is reached". */
      kind: 'sortFailed';
      /** Provider display name, e.g. "Groq". */
      provider: string;
      /** Why. */
      cause: 'keyRefused' | 'unreachable' | 'cap';
    }
  | {
      /** "Couldn't load this list." with Try again (a mail list's first load or refresh failed; DESIGN §7.15 pattern of Body failed). */
      kind: 'listFailed';
    }
  | {
      /** A plain reason sentence from the engine, already in DESIGN §10's voice (first-sync failures). */
      kind: 'reason';
      /** The sentence. */
      text: string;
      /** Whether Try again is offered. */
      retryable: boolean;
    };

/** One inline error line with an icon in `--stamp-ink` and the sentence in ink (DESIGN §6 ErrorLine, §7.15). Mockups: errors.html (row-error, send-failed), settings-ai.html (testing), onboarding-sync.html (failed). Plain + refines: ui-foundation; used by ui-home, ui-reader, ui-ask, ui-settings, ui-onboard. */
export type ErrorLineProps = ErrorLineKind & {
  /** Layout context: inside a row, in the reader column, in the dock, under a settings row, in a sync checklist. */
  placement: 'row' | 'column' | 'dock' | 'settings' | 'checklist';
  /** An offered action was chosen. */
  onAction: (action: ErrorLineAction) => void;
  /** Registry id for Edit's keycap (send failed). */
  editCommandId?: CommandId;
  /** The screen's one main action (DESIGN §3 rule 6, plan 30 §4.5 #1): the consentNeeded "Review" renders filled instead of as a text button. Pass it only when no other filled button is on screen. */
  mainAction?: boolean;
};
