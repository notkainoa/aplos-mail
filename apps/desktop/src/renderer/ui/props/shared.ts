import type { CommandId } from '../../commands/types';

/* ───────────────────────── Shared vocabulary ───────────────────────── */

/**
 * A CommandRegistry id (DESIGN §6 `CommandRegistry`, §8), re-exported from renderer/commands/types.ts so screens
 * can import it from here. If the registry narrows it to a literal union of catalog ids, these props follow.
 */
export type { CommandId };

/** ISO 8601 date-time with offset, e.g. "2026-10-29T10:00:00-07:00". Components format it with the shared formatter (en-US in the harness, frozen clock). */
export type IsoDateTime = string;

/** ISO 8601 calendar date, e.g. "2026-10-29". */
export type IsoDate = string;

/** ISO 8601 year-month, e.g. "2026-10". */
export type IsoYearMonth = string;

/** 24-hour wall-clock time "HH:MM", e.g. "08:00". */
export type IsoTime = string;

/** Row and focus-letter density from Settings → General (DESIGN §4.4): rows 48 / 40 / 34, focus letter 196 / 180 / 164. */
export type Density = 'roomy' | 'comfortable' | 'compact';

/** The six account, label and calendar colours (DESIGN §4.2). Maps to `--tag-*`. */
export type TagColor = 'sky' | 'hill' | 'stamp' | 'dusk' | 'sand' | 'ember';

/** A triage commit that carries a letter off (DESIGN §4.9): hill + check, dusk + clock, stamp + trash. */
export type CommitKind = 'done' | 'later' | 'trash';

/**
 * Home lane of a thread (DESIGN §7.2): Do now, Important updates, Low importance. Closed on purpose: the contract's
 * `Lane` is open (a newer engine may add a value), so the screen narrows `row.rank.lane` to one of these three and
 * draws no lane controls for any other value. `renderer/data`'s tests check these are exactly the contract's known
 * values.
 */
export type Lane = 'do' | 'update' | 'low';

/**
 * Where a due date came from, in order of trust (DESIGN §7.2). 'ai' shows "from the email" on hover (DESIGN §9 rule 5).
 * Closed like `Lane`: the screen narrows the contract's open `DueSource` (an unknown source is shown as 'ai', the
 * least trusted). `renderer/data`'s tests check these are exactly the contract's known values.
 */
export type DueSource = 'user' | 'structured' | 'ai';

/**
 * The closed icon set (DESIGN §4.7): monoline, SF Symbols with a Lucide fallback.
 * AI has no glyph (DESIGN §3 principle 9, §9 rule 8); the banned names of §4.7 can never join this union.
 * Bookmark is always `bookmark`.
 */
export type IconName =
  | 'home'
  | 'clock'
  | 'calendar'
  | 'today'
  | 'tray'
  | 'file'
  | 'file-text'
  | 'file-image'
  | 'file-archive'
  | 'file-sheet'
  | 'send'
  | 'trash'
  | 'spam'
  | 'settings'
  | 'help'
  | 'compose'
  | 'search'
  | 'bubble'
  | 'bookmark'
  | 'more'
  | 'check'
  | 'check-circle'
  | 'circle'
  | 'reply'
  | 'reply-all'
  | 'forward'
  | 'paperclip'
  | 'link'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-up'
  | 'chevron-down'
  | 'up-down'
  | 'close'
  | 'menu'
  | 'arrow-right'
  | 'arrow-up'
  | 'refresh'
  | 'mic'
  | 'cloud-off'
  | 'alert'
  | 'plus'
  | 'minus'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'key'
  | 'server'
  | 'laptop'
  | 'lock'
  | 'cart'
  | 'phone'
  | 'undo'
  | 'bell'
  | 'bell-off'
  | 'keyboard'
  | 'user'
  | 'users'
  | 'globe'
  | 'mail'
  | 'at'
  | 'external'
  | 'pin'
  | 'video'
  | 'download'
  | 'pause'
  | 'type'
  | 'sidebar'
  | 'tag'
  | 'eye'
  | 'hourglass'
  | 'grip'
  | 'pop-out'
  | 'repeat';

/** Icons an AI suggestion may wear: its action's icon, never an AI mark (DESIGN §4.7, §9 rule 2). */
export type SuggestionIcon =
  'reply' | 'calendar' | 'link' | 'paperclip' | 'cart' | 'phone' | 'file' | 'check' | 'clock';

/** Literal keycaps DESIGN requires on specific controls (§8 Discoverability): Return in onboarding and dialogs, ⇧Return on destructive confirms, Esc, Tab on suggestions. Everything else comes from `commandId`. */
export type LiteralKey = 'Return' | '⇧Return' | 'Esc' | 'Tab';

/**
 * Where a control shows its keycap (DESIGN §8, decision 8).
 * 'always' = inline Kbd always (main actions: Space in the mail window, Return in onboarding and dialogs, ⌘↩ on Send);
 * 'hint' = inline Kbd only in the "Show all key hints" mode;
 * 'tooltip' = only in the tooltip and the ⌘-held badge (the default).
 */
export type KeyHint = 'always' | 'hint' | 'tooltip';

/**
 * The app-wide key-hint mode, provided once by the shell through a context next to Kbd (never by hover).
 * 'tooltips' = default; 'held' = ⌘ is down, badges show; 'all' = the "Show all key hints" setting is on.
 */
export type ShowKeysMode = 'tooltips' | 'held' | 'all';

/** Value of the key-hints context the shell provides (DESIGN §8 Discoverability). */
export interface KeyHintsContextValue {
  /** Current mode; Kbd and every control with a keycap read it. */
  showKeys: ShowKeysMode;
}

/** Polite live-region announcement, supplied by the shell's single `role="status"` region (DESIGN §11.3). */
export type Announce = (message: string) => void;

/**
 * The element a Menu, Popover or DatePresets positions against. The one anchor style: every trigger callback that
 * opens a floating surface hands over its element (`onMore(anchor)`, `onLater(anchor)`, `onAction(id, anchor)`),
 * and the screen passes that element straight to the surface. Null while nothing is open.
 */
export type Anchor = HTMLElement | null;

/** Ids the `ListBox` container uses to wire a `listbox` with `aria-activedescendant` (DESIGN §11.3). */
export interface ListboxBinding {
  /** DOM id of the listbox element. */
  id: string;
  /** Accessible name, e.g. "Home" or "Search results". */
  label: string;
  /** DOM id of the option under the cursor. */
  activeDescendantId?: string;
}

/** One action shown as a button with its key from the registry. */
export interface CommandAction {
  /** Visible verb in plain words (DESIGN §10). */
  label: string;
  /** Leading icon, e.g. `plus` on "Add an account" (empty.html no-accounts). */
  icon?: IconName;
  /** Registry command that supplies the keycap and tooltip (DESIGN §8). */
  commandId?: CommandId;
  /** Literal keycap where DESIGN requires one; overrides the registry key. */
  keys?: LiteralKey;
  /** Called on click; key presses are routed by the registry, not the component. */
  onSelect: () => void;
}

/** A due date shown as a Chip: only the date set with D, found in structured data or found by AI (DESIGN §6 Chip, §7.2). Never the Later date; that is `LaterUntil`. */
export interface DueInfo {
  /** The due moment; a date-only due uses midnight local time. */
  at: IsoDateTime;
  /** Overdue or due today: `--stamp-ink` on `--stamp-tint` with a clock (DESIGN §4.1). Computed by the data layer. */
  overdue: boolean;
  /** Provenance; 'ai' adds "from the email" on hover. */
  source: DueSource;
}

/**
 * When a Later item comes back (DESIGN §7.3; DatePresets purpose 'later'). Separate from `DueInfo`: a Later item can
 * have both. Rendered as a 'laterUntil' Chip: "Yesterday", "Tue, Oct 27", "Today, 5:00 PM", "Someday".
 */
export type LaterUntil =
  | {
      /** A set moment. */
      kind: 'at';
      /** The moment it returns to Home. */
      at: IsoDateTime;
      /** The moment has passed (the Overdue group): `--stamp-ink` on `--stamp-tint` with a clock. Computed by the data layer. */
      overdue: boolean;
    }
  | {
      /** No date: the chip reads "Someday". */
      kind: 'someday';
    };

/** A rejected write on a row or the focus letter: back in place with "Couldn't <op>." and Retry (DESIGN §5 rule 11, §7.15). */
export interface RejectedWrite {
  /** Lower-case op phrase, e.g. "move to Later". */
  op: string;
  /** Retry the write. */
  onRetry: () => void;
}

/** The suggested action, the one filled button with the Space keycap (DESIGN §7.2 focus letter, §7.5). */
export interface SuggestedAction {
  /** Literal verb, e.g. "Reply", "View invoice", "Add to calendar", "Reply with a nudge" (DESIGN §9 rule 2). */
  verb: string;
  /** The action's own icon. */
  icon: SuggestionIcon;
  /** True when the suggestion is Done; the separate Done button is then omitted. */
  isDone: boolean;
}

/** Registry ids for the triage controls on the focus letter and the reader action row (DESIGN §8 Lists). The reader uses `ReaderTriageCommands`. */
export interface TriageCommands {
  /** Space: run the suggestion. */
  suggest: CommandId;
  /** L: Later. */
  later: CommandId;
  /** E: Done. */
  done: CommandId;
  /** ".": the ⋯ menu (bookmark, trash, "Why it's here"). */
  more: CommandId;
}

/** The reader action row's keys: no ⋯ there, it lives in the pane header (DESIGN §7.5). */
export type ReaderTriageCommands = Pick<TriageCommands, 'suggest' | 'later' | 'done'>;

/**
 * Hold-to-dictate state (DESIGN §7.6 Dictation, §8): a small `--stamp` LevelMeter and one line the component writes,
 * "Listening. Release <key> to keep, Esc to cancel." Used by Composer, InlineReply and AskDock.
 */
export interface DictationState {
  /** The held key named in the line: Space in an empty compose body, R from the reader, A for Ask. */
  holdKey: 'A' | 'R' | 'Space';
  /** Input level 0–1 for the meter (or drive the LevelMeter imperatively through its ref). */
  level: number;
}
