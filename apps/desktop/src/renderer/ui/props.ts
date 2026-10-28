/**
 * Frozen component props for the Paper component inventory (plans/DESIGN.md §6), artifact F9.
 *
 * Contract rules (see ./README.md):
 * - Data in, events out. Components never fetch; screens pass rows from data hooks.
 * - No raw colour, size, radius, duration or styling-class props. Variants are closed unions tied to DESIGN.
 * - Keycaps come from the CommandRegistry through `commandId`; a literal key is allowed only where DESIGN
 *   requires one (`LiteralKey`). Kbd is never revealed by hover (DESIGN §5 rule 17, §8).
 * - After day 3 changes are additive only: new optional props, new union members, new components. Never a rename.
 *
 * Each interface carries one line: DESIGN section · mockup file(s) · which lane writes the plain version and
 * which refines it. "used by" names the consuming screen lanes.
 */
import type { ReactElement, ReactNode, Ref, RefObject } from 'react';

/* ───────────────────────── Shared vocabulary ───────────────────────── */

/** A CommandRegistry id (DESIGN §6 `CommandRegistry`, §8). Local alias; matches commands/types.ts. */
type CommandId = string;

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

/** Home lane of a thread (DESIGN §7.2): Do now, Important updates, Low importance. */
export type Lane = 'do' | 'update' | 'low';

/** Where a due date came from, in order of trust (DESIGN §7.2). 'ai' shows "from the email" on hover (DESIGN §9 rule 5). */
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
export type SuggestionIcon = 'reply' | 'calendar' | 'link' | 'paperclip' | 'cart' | 'phone' | 'file' | 'check' | 'clock';

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

/** The element a Menu, Popover or Tooltip positions against. */
export type AnchorRef = RefObject<HTMLElement | null>;

/** Ids a screen uses to wire a `listbox` with `aria-activedescendant` (DESIGN §11.3). */
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
  /** Registry command that supplies the keycap and tooltip (DESIGN §8). */
  commandId?: CommandId;
  /** Literal keycap where DESIGN requires one; overrides the registry key. */
  keys?: LiteralKey;
  /** Called on click; key presses are routed by the registry, not the component. */
  onSelect: () => void;
}

/** A due date shown as a Chip (DESIGN §6 Chip, §7.2). */
export interface DueInfo {
  /** The due moment; a date-only due uses midnight local time. */
  at: IsoDateTime;
  /** Overdue or due today: `--stamp-ink` on `--stamp-tint` with a clock (DESIGN §4.1). Computed by the data layer. */
  overdue: boolean;
  /** Provenance; 'ai' adds "from the email" on hover. */
  source: DueSource;
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

/** Registry ids for the triage controls on the focus letter and the reader action row (DESIGN §8 Lists). */
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

/* ───────────────────────── buttons-keys ───────────────────────── */

/** Button heights 28 / 32 / 40 px (DESIGN §4.4 control heights, §6 Button). 'lg' is the onboarding primary. */
export type ButtonSize = 'sm' | 'md' | 'lg';

/** Fields every Button variant shares. */
interface ButtonBase {
  /** Visible text; for the icon variant it is the required accessible name and tooltip label (DESIGN §11.3). */
  label: string;
  /** 28 / 32 / 40 px; default 'md'. */
  size?: ButtonSize;
  /** Leading icon. */
  icon?: IconName;
  /** Trailing disclosure glyph for pickers and "More options". */
  trailingIcon?: 'chevron-down' | 'chevron-right' | 'up-down';
  /** Registry command for the keycap and tooltip. */
  commandId?: CommandId;
  /** Literal keycap where DESIGN requires one (Return, ⇧Return, Esc, Tab). */
  keys?: LiteralKey;
  /** Where the keycap shows; default 'tooltip'. Main actions pass 'always'. */
  keyHint?: KeyHint;
  /** 'danger' uses `--stamp-ink` text (Reconnect in the status slot); never a red fill. */
  tone?: 'default' | 'danger';
  /** Disabled: `--dim` text, `--faint` icon (DESIGN §4.1). */
  disabled?: boolean;
  /** Tooltip explaining why it is disabled, e.g. a key that comes from the environment (DESIGN §7.10). */
  disabledReason?: string;
  /** Working: label stays, Spinner after 150 ms (DESIGN §5 rule 12). */
  busy?: boolean;
  /** Toggle state for `aria-pressed`, e.g. the pane header Ask button while the dock is open. */
  pressed?: boolean;
  /** Popup wiring for menu and picker triggers. */
  popup?: { kind: 'menu' | 'listbox' | 'dialog'; expanded: boolean; controls: string };
  /** Click handler. */
  onPress: () => void;
  /** Form role; default 'button'. */
  type?: 'button' | 'submit';
  /** DOM id. */
  id?: string;
  /** Element ref (anchors, focus return). */
  ref?: Ref<HTMLButtonElement>;
}

/** The three button idioms (DESIGN §4.6, §6 Button): radius 8, press inset; one filled per screen, owned by the topmost surface. Mockups: every page. Plain + refines: ui-foundation; used by all lanes. */
export type ButtonProps =
  | (ButtonBase & {
      /** 'filled' = the one ink-blue action; 'text' = quiet verb. */
      variant: 'filled' | 'text';
    })
  | (ButtonBase & {
      /** Icon-only control. */
      variant: 'icon';
      /** Required for the icon variant. */
      icon: IconName;
      /** Show `label` beside the icon (the pane header "Ask" button, DESIGN §4.7). */
      labelVisible?: boolean;
    });

/** One keycap: 18 px, radius 4, `caption`, `--sunken` (DESIGN §6 Kbd). Mockups: every page (`.kbd`). Plain + refines: ui-foundation. */
export interface KbdProps {
  /** Display chord as one cap, e.g. "E", "⌘↩", "⇧A", "Space", "Return", "⌃1". */
  chord: string;
  /** 'always' = inline cap; 'hint' = only in the "Show all key hints" mode; 'badge' = overlay while ⌘ is held. Never hover. Default 'always'. */
  reveal?: 'always' | 'hint' | 'badge';
}

/** Label plus keycaps from the registry, `reveal`, `--elev-float`; where key hints live (DESIGN §6 Tooltip, §8). Mockups: shell.js `[data-tip]`, reader.html sender hover. Plain + refines: ui-foundation. */
export interface TooltipProps {
  /** First line, e.g. "Done" or "Today". */
  label: string;
  /** Optional second line, e.g. "jordan@parkandpine.co · 14 emails both ways since March" (DESIGN §7.5 sender hover). */
  detail?: string;
  /** Registry command whose keys appear after the label. */
  commandId?: CommandId;
  /** Literal keycap where DESIGN requires one. */
  keys?: LiteralKey;
  /** The trigger element; it must accept a ref and focus/hover handlers. */
  children: ReactElement;
  /** Side of the trigger; default 'below'. */
  placement?: 'below' | 'above';
  /** Suppress, e.g. while a menu from the same trigger is open. */
  disabled?: boolean;
}

/* ───────────────────────── surfaces ───────────────────────── */

/** The white surface on the gray shell: the main pane and the Ask dock (DESIGN §2.2, §4.4, §6 Pane). Mockups: every main-window page. Plain + refines: ui-foundation; used by ui-shell. */
export interface PaneProps {
  /** 'main' = content pane; 'dock' = the Ask dock's second pane. */
  kind: 'main' | 'dock';
  /** Accessible region name, e.g. "Home", "Ask". */
  label: string;
  /** The 48 px pane header (back or close + crumb left; up to three tools, Ask, calendar button right; bulk bar). Hairline only after content scrolls under it (DESIGN §7.1). */
  header?: ReactNode;
  /** Pane content; scrolls inside the pane. */
  children: ReactNode;
  /** Element ref for the motion runtime (`dock` FLIP, DESIGN §4.8). */
  ref?: Ref<HTMLElement>;
}

/** What may sit on the left of a PageHead row. Never a page title or subtitle (DESIGN §7). */
export type PageHeadLead =
  | {
      /** The calendar's date label, a small `title` (DESIGN §7.8). */
      kind: 'dateLabel';
      /** e.g. "October 2026". */
      label: string;
      /** Day range beside it, e.g. "October 25 – 31". */
      range: string;
    }
  | {
      /** A page field, i.e. the Search field (DESIGN §7.9). */
      kind: 'field';
      /** The SearchField element. */
      field: ReactNode;
    };

/** The row for page-level controls, right-aligned; never a title (DESIGN §4.4, §6 PageHead). Mockups: later.html, search.html, calendar-*.html. Plain + refines: ui-foundation; used by ui-home, ui-ask, ui-calendar. */
export interface PageHeadProps {
  /** Optional left side: the calendar date label or the search field. */
  lead?: PageHeadLead;
  /** Right-aligned page controls, e.g. the Later | Bookmarks Puck, Today, previous/next, D | W | M. */
  children?: ReactNode;
}

/** A quiet sidebar group label, `small` `--dim`, e.g. "Mail", "Calendars" (DESIGN §6 NavHead, §7.1). Mockups: shell.js sidebar. Plain + refines: ui-foundation; used by ui-shell. */
export interface NavHeadProps {
  /** Label text. */
  label: string;
  /** DOM id so the group can be `aria-labelledby` it. */
  id?: string;
}

/** One entry in a Menu. */
export type MenuEntry =
  | {
      /** A selectable row, 32 px. */
      kind: 'item';
      /** Stable id passed to onSelect. */
      id: string;
      /** Row text. */
      label: string;
      /** Leading icon. */
      icon?: IconName;
      /** Leading colour mark (accounts, calendars). */
      swatch?: TagColor;
      /** Registry command whose keycap shows on the right. */
      commandId?: CommandId;
      /** Dim right-aligned text, e.g. "6:00 PM" or "Synced". */
      aside?: string;
      /** Second line in `small` `--dim`, e.g. an account's reason "Google needs you to sign in again." */
      detail?: string;
      /** Destructive item (`--stamp-ink`). */
      danger?: boolean;
      /** Disabled item. */
      disabled?: boolean;
      /** One inline text action inside the row, e.g. Reconnect on an account row (errors.html reconnect). */
      inlineAction?: { label: string; tone: 'default' | 'danger'; onSelect: () => void };
    }
  | {
      /** A hairline separator. */
      kind: 'separator';
    }
  | {
      /** A group label, e.g. "Accounts", "Later until". */
      kind: 'label';
      /** Label text. */
      label: string;
    };

/** Opaque `--paper` menu, `--elev-float`, radius 12, 32 px items, at least 220 px wide; 1–9 pick in short menus (DESIGN §6 Menu). Mockups: errors.html (account menu), later-picker.html, calendar-week.html (+N stack), settings.js pickers. Plain + refines: ui-foundation. */
export interface MenuProps {
  /** Whether the menu is shown (`reveal`). */
  open: boolean;
  /** Element the menu opens from. */
  anchor: AnchorRef;
  /** Accessible name. */
  label: string;
  /** Rows, separators and group labels. */
  entries: readonly MenuEntry[];
  /** Item under the keyboard cursor. */
  activeId?: string;
  /** Picker mode: this item shows a check and `aria-checked` (role menuitemradio). */
  checkedId?: string;
  /** Show digits 1–9 and let them pick (short menus only). */
  numbered?: boolean;
  /** Cursor moved by arrow keys or pointer. */
  onActiveChange?: (id: string) => void;
  /** An item was chosen (click, Return or digit). */
  onSelect: (id: string) => void;
  /** Esc, outside click or selection. */
  onClose: () => void;
}

/** Opaque floating panel for rich content: event detail, citation quotes, "Why it's here" (DESIGN §6 Popover). Mockups: calendar-event.html, ask.html (quote pop). Plain + refines: ui-foundation. */
export interface PopoverProps {
  /** Whether it is shown (`reveal`). */
  open: boolean;
  /** Element it opens from. */
  anchor: AnchorRef;
  /** Accessible name. */
  label: string;
  /** 'dialog' for interactive content; 'tooltip' for read-only hover content such as a citation quote. */
  role: 'dialog' | 'tooltip';
  /** Preferred side; it flips to stay inside the pane. Default 'below-start'. */
  placement?: 'below-start' | 'below-end' | 'above-start' | 'left' | 'right';
  /** Content. */
  children: ReactNode;
  /** Esc or outside click. */
  onClose: () => void;
}

/** Modal surface, `--elev-dialog`, `settle`, scrim behind; owns the screen's filled button (DESIGN §4.6, §6 Dialog). Mockups: shortcuts.html. Plain + refines: ui-foundation. */
export interface DialogProps {
  /** Whether it is shown. */
  open: boolean;
  /** Title in `title` type; also the accessible name. */
  title: string;
  /** Optional one-line description under the title (`small` `--dim`). */
  description?: string;
  /** Width class: 'sm' confirmations and the reconnect sheet, 'md' forms, 'lg' the shortcut sheet. */
  size: 'sm' | 'md' | 'lg';
  /** Body. */
  children: ReactNode;
  /** Footer controls (Buttons with Return / Esc keycaps). */
  footer?: ReactNode;
  /** DOM id of the element to focus on open; default the first focusable. */
  initialFocusId?: string;
  /** Esc or scrim click. Focus returns to the opener. */
  onClose: () => void;
}

/** A confirmation as two key rows; destructive ones default to Cancel (Return cancels, ⇧Return confirms) (DESIGN §6 Confirm, §7.9). Mockups: palette.html (confirm). Plain + refines: ui-foundation; used by ui-ask, ui-home. */
export interface ConfirmProps {
  /** The question, e.g. "Delete forever?" */
  question: string;
  /** What will happen and whether it can be undone. */
  consequence: string;
  /** Confirm verb, e.g. "Delete forever". Never "OK" (DESIGN §10). */
  confirmLabel: string;
  /** Cancel verb; default "Cancel". */
  cancelLabel?: string;
  /** Destructive: Cancel is the default row and the confirm row needs ⇧Return. */
  destructive: boolean;
  /** 'dialog' = its own Dialog; 'inline' = a sub-view inside the palette. */
  presentation: 'dialog' | 'inline';
  /** Confirmed. */
  onConfirm: () => void;
  /** Cancelled (Return on a destructive confirm, Esc, or the cancel row). */
  onCancel: () => void;
  /** Announces "Cancel is selected…" on entry (DESIGN §11.3). */
  announce?: Announce;
}

/** One option on a Puck. */
export interface PuckItem {
  /** Stable id. */
  id: string;
  /** Full label; the accessible name and tooltip when `shortLabel` is shown. */
  label: string;
  /** Visible short text, e.g. "D", "W", "M". */
  shortLabel?: string;
  /** Leading icon (sidebar and Settings nav rows). */
  icon?: IconName;
  /** Leading colour swatch. */
  swatch?: TagColor;
  /** Trailing count in `--dim` with the `count` motion; omit to hide (counts hide during first sync, DESIGN §7.1). */
  count?: number;
  /** Registry command for the tooltip keycap, e.g. ⌃1 on Home. */
  commandId?: CommandId;
  /** Disabled option. */
  disabled?: boolean;
}

/** One shared selection indicator per group, moved by `slide` (translate + scaleX, never width) (DESIGN §4.8, §6 Puck). Used by the sidebar, D/W/M, Ask/Today, Settings nav, Later | Bookmarks, RSVP, theme and density. Mockups: shell.js, later.html, ask.html, calendar-*.html, settings.js. Plain + refines: ui-foundation. */
export interface PuckProps {
  /** 'segmented' = a track with a thumb (`--sunken`, `--elev-puck`); 'selection' = list rows with a `--puck` fill (sidebar, Settings nav). */
  kind: 'segmented' | 'selection';
  /** ARIA pattern: 'tabs' (tablist), 'navigation' (nav with aria-current), 'radio' (radiogroup). */
  role: 'tabs' | 'navigation' | 'radio';
  /** Default 'horizontal' for segmented, 'vertical' for selection. */
  orientation?: 'horizontal' | 'vertical';
  /** Accessible name, e.g. "View", "Places". */
  label: string;
  /** Options in order. */
  items: readonly PuckItem[];
  /** Selected option; null shows no thumb (an unanswered RSVP, DESIGN §7.8). */
  selectedId: string | null;
  /** An option was chosen. */
  onSelect: (id: string) => void;
}

/** Icon and tone a toast wears; colour never carries meaning alone (DESIGN §3 principle 7, §7.13). */
export type ToastKind =
  | 'done'
  | 'later'
  | 'trash'
  | 'home'
  | 'bookmark'
  | 'undone'
  | 'pending'
  | 'offline'
  | 'sending'
  | 'tip'
  | 'info';

/** A verb on a toast with its keycap, e.g. "Undo" Z, "Set a date" D. */
export interface ToastAction {
  /** Stable id passed back on select. */
  id: string;
  /** Verb. */
  label: string;
  /** Registry command whose keycap shows inside the toast. */
  commandId?: CommandId;
}

/** One toast's data, worded from the op queue (DESIGN §7.13). */
export interface ToastData {
  /** Stable id. */
  id: string;
  /** Icon and tone. */
  kind: ToastKind;
  /** Plain words, e.g. "Moved to Later", "Archiving…", "Saved here · will sync". */
  message: string;
  /** Up to three verbs. */
  actions?: readonly ToastAction[];
  /** True when one action is Undo: lives 8 s instead of 4 s, then fades over 400 ms. */
  undoable: boolean;
  /** Stays until dismissed (e.g. a pending op until it confirms). */
  persistent?: boolean;
}

/** One opaque toast, `--paper`, `--elev-float`, radius 12, `ui` text, up to 440 px (DESIGN §6 Toast, §7.13). Mockups: toasts.html. Plain + refines: ui-foundation; used by ui-shell. */
export interface ToastProps extends ToastData {
  /** A verb was chosen. */
  onAction: (actionId: string) => void;
  /** Timed out or closed. */
  onDismiss: () => void;
}

/** Up to three toasts bottom-centre of the main pane, never under the dock; hover or focus pauses; polite, never steals focus (DESIGN §6 ToastStack, §7.13). Mockups: toasts.html. Plain + refines: ui-foundation; used by ui-shell. */
export interface ToastStackProps {
  /** Newest last; the stack shows the last three and never silently replaces an Undo toast. */
  toasts: readonly ToastData[];
  /** A toast's verb was chosen. */
  onAction: (toastId: string, actionId: string) => void;
  /** A toast timed out or was closed. */
  onDismiss: (toastId: string) => void;
}

/* ───────────────────────── list ───────────────────────── */

/** A quick action that overlays the date column on hover, an icon button with tooltip and key (DESIGN §5 rule 17, §7.4). */
export interface RowAction {
  /** Registry command run on click (passed to onAction). */
  commandId: CommandId;
  /** Icon. */
  icon: IconName;
  /** Accessible name and tooltip, e.g. "Done", "Move to Home". */
  label: string;
}

/** Column layout of a row. 'home' = 148 px sender; 'list' = 152 px sender + date; 'later' = due chip in the date column; 'done' = fixed "Done 9:41 AM" stamp column with the hover action to its left (DESIGN §4.4, §7.3, §7.4). */
export type RowLayout = 'home' | 'list' | 'later' | 'done';

/** A mail row: fixed height per density, unread dot, sender, summary or subject, due chip, date; no avatar (DESIGN §4.1 Rows, §6 ListRow, §7.2–7.4). Hosts the cursor layer, bulk-pick wash, swipe underlay and hover actions. Mockups: home.html, inbox.html, later.html, done.html, search.html, errors.html (row-error). Plain + refines: ui-foundation; used by ui-home, ui-ask (search). */
export interface ListRowProps {
  /** DOM id of the `option`, used by the list's `aria-activedescendant`. */
  id: string;
  /** Column layout. */
  layout: RowLayout;
  /** Fixed row height 48 / 40 / 34. */
  density: Density;
  /** Who column: sender, or recipients on Sent. */
  sender: string;
  /** Main line: the summary, or the subject with no AI provider (DESIGN §7.2 No AI). */
  primary: string;
  /** Second phrase after the main line, e.g. a search snippet. */
  secondary?: string;
  /** Search terms to bold in `primary` and `secondary` (search.html). */
  highlight?: readonly string[];
  /** Unread: 600 `--ink` sender, `--ink-2` line, 6 px accent dot. */
  unread: boolean;
  /** Received (list, home), edited (Drafts) or sent (Sent) time for the date column. */
  date: IsoDateTime;
  /** Due chip; in 'later' layout it replaces the date. */
  due?: DueInfo;
  /** For 'done' layout: when it was finished ("Done 9:41 AM"). */
  doneAt?: IsoDateTime;
  /** Meta marks before the date: replied, bookmarked, attachment. */
  marks?: { replied?: boolean; bookmarked?: boolean; attachment?: boolean };
  /** The row's account; the 8 px dot renders only when `showAccountDot` (DESIGN decision 16). Always in the row tooltip. */
  account?: { label: string; color: TagColor };
  /** True only when two or more accounts are connected; the screen decides. */
  showAccountDot: boolean;
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
  rejected?: {
    /** Lower-case op phrase, e.g. "move to Later". */
    op: string;
    /** Retry the write. */
    onRetry: () => void;
  };
  /** Lifted while dragged (`lift`, `--elev-lift`, DESIGN §7.3). */
  lifted?: boolean;
  /** Click: move the cursor here. */
  onSelect: () => void;
  /** Double-click: open. Return/O are routed by the registry. */
  onOpen: () => void;
  /** A hover action was clicked. */
  onAction: (commandId: CommandId) => void;
  /** Element ref for the cursor layer, ghost cloning and swipe (DESIGN §5 rule 3). */
  ref?: Ref<HTMLElement>;
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
  /** One quiet `--dim` text action, e.g. "Go one by one" (S), "Clear from Home", "Reset all". */
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
  /** The FocusLetter. */
  children: ReactNode;
  /** Element ref for `deal` and the flight ghost. */
  ref?: Ref<HTMLElement>;
}

/** What a summary slot shows (DESIGN §6 Summary, §9 rules 3, 5, 7). */
export type SummaryContent =
  | {
      /** Waiting: the subject in SF, breathing (`breathe`). */
      state: 'pending';
      /** Shown in SF while pending. */
      subject: string;
    }
  | {
      /** No provider or no summary: the subject in SF, nothing else changes, no error. */
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
};

/** The Home focus letter card (`--elev-card`): meta line, two-line serif summary, action row; no subject line and no bookmark icon (DESIGN §7.2 The focus letter). Mockups: home.html, demo.html. Plain + refines: ui-foundation; used by ui-home. */
export interface FocusLetterProps {
  /** DOM id of the `option` (it is the selected option of the Home listbox). */
  id: string;
  /** Sender in `base` 600. */
  sender: string;
  /** Due chip, if any. */
  due?: DueInfo;
  /** Relative date on the right. */
  date: IsoDateTime;
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
  /** Suggestion button. */
  onSuggestion: () => void;
  /** Later button. */
  onLater: () => void;
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
  /** Number of threads in the band. */
  count: number;
  /** Under the keyboard cursor. */
  cursor: boolean;
  /** Fixed height per density. */
  density: Density;
  /** Click or Return: open the Low-importance sheet. */
  onOpen: () => void;
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
      /** A due date with a clock icon. */
      kind: 'due';
      /** The due date. */
      due: DueInfo;
      /** 'short' = "Tomorrow" / "Sat" / "Nov 4"; 'withTime' = "Today, 5:00 PM" (Later); 'sentence' = "Due tomorrow" (reader). */
      format: 'short' | 'withTime' | 'sentence';
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
  /** The sentence, e.g. "No drafts.", "Your first mail is on its way.", "You handled 12 emails." */
  text: string;
  /** 'line' = one line in the column; 'display' = the calm centred inbox-zero block in `display` type. Default 'line'. */
  size?: 'line' | 'display';
  /** A second dim line, e.g. "Next: Design review at 2:00 PM" or the status slot's reason. */
  detail?: string;
  /** The action, e.g. "Undo last" Z, "Search all mail on Google" Return, "New event" N. */
  action?: CommandAction & { emphasis: 'filled' | 'text' };
  /** Second action for No accounts only ("Try demo mail"). */
  secondaryAction?: CommandAction;
}

/** Actions an ErrorLine can offer. */
export type ErrorLineAction = 'retry' | 'edit' | 'useAnotherProvider' | 'review' | 'replaceKey';

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
};

/* ───────────────────────── reader ───────────────────────── */

/** The reader's sender, with hover details (DESIGN §7.5 item 1). */
export interface SenderInfo {
  /** Name in `title`. */
  name: string;
  /** Address, shown on hover. */
  address: string;
  /** Receiving account, shown on hover. */
  accountLabel: string;
  /** History with this sender, labelled as history, e.g. "14 emails both ways since March". */
  history?: string;
}

/** The reader's top: sender line, the big serif summary, one action row; no monogram, no card (DESIGN §6 ReaderHead, §7.5 items 1–3). Mockups: reader.html, reply.html, errors.html (send-failed). Plain + refines: ui-foundation; used by ui-reader. */
export interface ReaderHeadProps {
  /** Sender and hover details. */
  sender: SenderInfo;
  /** `--dim` recipients phrase, e.g. "to you and Mina Cho". */
  recipientsLabel: string;
  /** Due chip on the right, sentence format. */
  due?: DueInfo;
  /** Time on the right. */
  date: IsoDateTime;
  /** Summary slot; never clamped here. */
  summary: SummaryContent;
  /** The filled suggestion with Space, then Later and Done. */
  suggestion: SuggestedAction;
  /** Registry ids for the controls (`more` is unused here; ⋯ lives in the pane header). */
  commands: TriageCommands;
  /** The inline reply or another top surface owns the filled button (DESIGN §7.6). */
  demoted: boolean;
  /** Suggestion button. */
  onSuggestion: () => void;
  /** Later button. */
  onLater: () => void;
  /** Done button. */
  onDone: () => void;
  /** Element ref for the reader-column flight ghost (DESIGN §4.9). */
  ref?: Ref<HTMLElement>;
}

/** An earlier message as a 36 px one-liner. */
export interface CollapsedMessage {
  /** Message id. */
  id: string;
  /** Sender name, or "You". */
  from: string;
  /** First line of the message. */
  preview: string;
  /** Sent time. */
  date: IsoDateTime;
}

/** One collapsed line for earlier messages ("3 earlier messages from Jordan, you and Mina"); O expands into 36 px one-liners with a 2 px accent rail on the cursor (DESIGN §6 EarlierMessages, §7.5 item 4). Mockups: reader.html (earlier). Plain + refines: ui-foundation; used by ui-reader. */
export interface EarlierMessagesProps {
  /** Number of earlier messages. */
  count: number;
  /** First names in thread order, "you" for the owner; joined by the component. */
  participants: readonly string[];
  /** Expanded into one-liners. */
  expanded: boolean;
  /** The one-liners shown when expanded. */
  messages: readonly CollapsedMessage[];
  /** Message under the ↑/↓ cursor. */
  cursorId?: string;
  /** Registry id for O. */
  commandId: CommandId;
  /** Expand or collapse. */
  onToggle: () => void;
  /** Open one message. */
  onOpenMessage: (id: string) => void;
}

/** The quiet "Reply to Jordan…" field with an R keycap at the end of the thread (DESIGN §6 ReplyStub, §7.5 item 5). Mockups: reader.html, errors.html. Plain + refines: ui-foundation; used by ui-reader. */
export interface ReplyStubProps {
  /** First name in "Reply to <name>…". */
  recipientName: string;
  /** Registry id for R (always shown). */
  commandId: CommandId;
  /** Opens the inline reply. */
  onOpen: () => void;
}

/** "Why it's here", opened from ⋯ or I: one sentence, a quote from the mail, and the ⌥↑ / ⌥↓ lane corrections (DESIGN §6 Why, §9 rule 4). Shown in a Popover. Mockups: none drawn (described in reader.html's ⋯ tooltip). Plain + refines: ui-foundation; used by ui-home, ui-reader. */
export interface WhyProps {
  /** One plain sentence. */
  reason: string;
  /** A quote from the mail. */
  quote?: string;
  /** Current lane; up is disabled at 'do', down at 'low'. */
  lane: Lane;
  /** Registry ids for ⌥↑ and ⌥↓. */
  commands: { up: CommandId; down: CommandId };
  /** Move one lane; the screen toasts "Moved to … · Always do this for … · Undo". */
  onMove: (direction: 'up' | 'down') => void;
}

/** What the undo-send slot is showing (DESIGN §7.6 Send; plan 30 §4.5 #4). */
export type UndoTrayState =
  | {
      /** "Sending to <recipients> in <n> s · Undo Z · Send now" with the neutral drain. */
      kind: 'sending';
      /** Recipient phrase, e.g. "Jordan" or "Jordan and Mina". */
      recipients: string;
      /** Whole seconds left; drives the reduced-motion text countdown. */
      secondsLeft: number;
      /** The undo window (default 8 s; options 0, 5, 8, 10, 20, 30). */
      totalSeconds: number;
    }
  | {
      /** "We could not confirm this was sent. Check Sent, or Send anyway." */
      kind: 'uncertain';
    }
  | {
      /** "Missed its time while your Mac was off. Send now or Reschedule." */
      kind: 'suspended';
    }
  | {
      /** "Couldn't send until <time>. Your draft is saved." */
      kind: 'deferred';
      /** When sending can resume. */
      until: IsoDateTime;
    };

/** Verbs the undo tray can offer. */
export type UndoTrayAction = 'undo' | 'sendNow' | 'checkSent' | 'sendAnyway' | 'reschedule';

/** A `--raised` line under a sent message with the neutral 2 px `undo-send` drain; one notice per send (DESIGN §6 UndoTray, §7.6). Mockups: reply.html (sent). Plain + refines: ui-foundation; used by ui-reader. */
export interface UndoTrayProps {
  /** What it says. */
  state: UndoTrayState;
  /** Reduced motion: no drain, a static text countdown instead (DESIGN §4.8 `undo-send`). */
  reducedMotion: boolean;
  /** 'thread' = under the message; 'toast' = the same words as a toast when no thread is visible. */
  placement: 'thread' | 'toast';
  /** Registry id for Undo (Z). */
  undoCommandId: CommandId;
  /** A verb was chosen. */
  onAction: (action: UndoTrayAction) => void;
  /** Announces the countdown start and the outcome (DESIGN §11.3). */
  announce?: Announce;
}

/* ───────────────────────── compose ───────────────────────── */

/** Draft save state, one line (DESIGN §7.6 Draft state). */
export type DraftStateKind = 'saving' | 'saved' | 'failed';

/** "This draft changed on another device." with Keep mine · Take theirs · Keep both (plan 30 §4.5 #5). */
export interface DraftConflict {
  /** Keep the local text. */
  onKeepMine: () => void;
  /** Take the other device's text. */
  onTakeTheirs: () => void;
  /** Keep both as separate drafts. */
  onKeepBoth: () => void;
}

/** A blocked send outlines the field and explains in one sentence; no shake (DESIGN §7.6). */
export interface BlockedSend {
  /** Which field is outlined. */
  field: 'to' | 'subject' | 'body';
  /** One plain sentence. */
  message: string;
}

/** Registry ids for composer controls (DESIGN §8 Compose). */
export interface ComposeCommands {
  /** ⌘↩ Send (always shown on the button). */
  send: CommandId;
  /** ⌘⇧A Attach. */
  attach: CommandId;
  /** ⌘/ Format menu, or ⋯ in the inline reply. */
  more: CommandId;
  /** ⌘⇧C Cc/Bcc. */
  cc: CommandId;
}

/** New message as a page in the pane (640 px), non-modal: To row, `heading` subject, `read` body, footer with Send, draft state, attach, format (DESIGN §6 Composer, §7.6). The pane header (close, "New message", ⋯, Ask) belongs to the screen. Mockups: compose.html (new, ai-draft, polish, follow-up). Plain + refines: ui-foundation; used by ui-reader. */
export interface ComposerProps {
  /** RecipientField rows (To, and Cc/Bcc when shown). */
  recipients: ReactNode;
  /** Subject value. */
  subject: string;
  /** Subject edited. */
  onSubjectChange: (value: string) => void;
  /** The body editor, `read` type (owned by ui-reader). */
  editor: ReactNode;
  /** A Suggestion hint under the body. */
  suggestion?: ReactNode;
  /** The Polish bar: "Polish suggests <n> changes. Yours stays until you choose." Use these (Return) · Keep mine (Esc). */
  polish?: { changes: number; onUse: () => void; onKeep: () => void };
  /** Draft save state. */
  draftState: DraftStateKind;
  /** Retry after "Couldn't save". */
  onRetrySave: () => void;
  /** A blocked send. */
  blocked?: BlockedSend;
  /** The draft changed on another device. */
  conflict?: DraftConflict;
  /** Registry ids for the footer. */
  commands: ComposeCommands;
  /** Send. */
  onSend: () => void;
  /** Attach a file. */
  onAttach: () => void;
  /** Format menu. */
  onFormat: (anchor: HTMLElement) => void;
}

/** Dictation state shown in the composer footer: a `--stamp` LevelMeter and "Listening. Release R to keep, Esc to cancel." (DESIGN §7.6 Dictation). */
export interface DictationState {
  /** The held key named in the line. */
  holdKey: 'R' | 'Space';
  /** Input level 0–1 for the meter. */
  level: number;
}

/** The inline reply card under the message (`--elev-card`, `settle`): To line with Cc and Pop out, `read` text, Send (⌘↩), draft state, attach and ⋯; owns the filled button while open (DESIGN §6 InlineReply, §7.6). Mockups: reply.html (reply, reply-all, dictating). Plain + refines: ui-foundation; used by ui-reader. */
export interface InlineReplyProps {
  /** RecipientField rows. */
  recipients: ReactNode;
  /** Cc/Bcc rows are shown. */
  ccVisible: boolean;
  /** Show Cc/Bcc. */
  onShowCc: () => void;
  /** Move the reply to the compose page. */
  onPopOut: () => void;
  /** The body editor (owned by ui-reader). */
  editor: ReactNode;
  /** A Suggestion hint under the body. */
  suggestion?: ReactNode;
  /** Draft save state. */
  draftState: DraftStateKind;
  /** Retry after "Couldn't save". */
  onRetrySave: () => void;
  /** Dictating: the footer shows the meter and the Listening line. */
  dictation?: DictationState;
  /** A blocked send. */
  blocked?: BlockedSend;
  /** The draft changed on another device. */
  conflict?: DraftConflict;
  /** Registry ids for the controls. */
  commands: ComposeCommands;
  /** Send. */
  onSend: () => void;
  /** Attach a file. */
  onAttach: () => void;
  /** ⋯ (format, schedule, discard). */
  onMore: (anchor: HTMLElement) => void;
  /** Element ref for `settle` in and out. */
  ref?: Ref<HTMLElement>;
}

/** A person in a recipient field. */
export interface Recipient {
  /** Stable id. */
  id: string;
  /** Display name. */
  name?: string;
  /** Address (mono in popovers). */
  address: string;
}

/** Recipients as removable names with type-ahead (DESIGN §6 RecipientField, §7.6). Mockups: reply.html, compose.html. Plain + refines: ui-foundation; used by ui-reader. */
export interface RecipientFieldProps {
  /** Row label. */
  label: 'To' | 'Cc' | 'Bcc';
  /** Current recipients. */
  recipients: readonly Recipient[];
  /** Typed text not yet committed. */
  query: string;
  /** Typed text changed. */
  onQueryChange: (value: string) => void;
  /** Return, comma or blur commits the query as a recipient. */
  onCommit: (text: string) => void;
  /** Remove one (Backspace on an empty query removes the last). */
  onRemove: (id: string) => void;
  /** Type-ahead matches; shown as a listbox. */
  suggestions?: readonly Recipient[];
  /** Highlighted suggestion. */
  activeSuggestionId?: string;
  /** A suggestion was picked. */
  onPickSuggestion?: (id: string) => void;
  /** DOM id of the suggestions listbox (combobox wiring, DESIGN §11.3). */
  listboxId: string;
  /** Recipients that failed validation (outlined). */
  invalidIds?: readonly string[];
  /** Show the "Cc" text button on this row (To only). */
  ccButton?: { onSelect: () => void; commandId: CommandId };
  /** Focus on mount. */
  autoFocus?: boolean;
}

/** One line: "Saving…", "Draft saved", "Couldn't save · Retry" (DESIGN §6 DraftState, §7.6). Mockups: reply.html, compose.html. Plain + refines: ui-foundation; used by ui-reader. */
export interface DraftStateProps {
  /** Which line. */
  state: DraftStateKind;
  /** Retry after a failure. */
  onRetry?: () => void;
}

/** Dim, editable AI text with Tab to keep and Esc to dismiss; carries AI drafts and the follow-up nudge (DESIGN §6 Suggestion, §9 rule 6). Mockups: compose.html (ai-draft, follow-up). Plain + refines: ui-foundation; used by ui-reader. */
export interface SuggestionProps {
  /** 'draft' = "The grey sentence is a suggestion."; 'followUp' = "Aplos drafted this follow-up from your last email." */
  kind: 'draft' | 'followUp';
  /** 'text' = the dim suggested text inline in the editor flow; 'hint' = the line under the body with Tab keep, Esc dismiss. */
  part: 'text' | 'hint';
  /** The suggested text (part 'text'). */
  text?: string;
  /** Tab: keep it as ordinary text. */
  onKeep: () => void;
  /** Esc: remove it. */
  onDismiss: () => void;
}

/** A small `--stamp` bar meter for dictation; the breathing ring is removed (DESIGN §6 LevelMeter). Mockups: reply.html (dictating). Plain + refines: ui-foundation; used by ui-reader, ui-ask. */
export interface LevelMeterProps {
  /** Input level 0–1. The voice hook may instead drive it per frame through `ref` to avoid React renders (DESIGN §5 rule 3). */
  level: number;
  /** Accessible name, e.g. "Listening". */
  label: string;
  /** Element ref for imperative level updates. */
  ref?: Ref<HTMLElement>;
}

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
  /** No provider: "Ask needs a provider. Choose one in Settings." plus a link; no red error. */
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

/** A source behind a citation. */
export interface CitationData {
  /** 1-based number shown as mono "[1]". */
  index: number;
  /** The quoted sentence shown on hover or focus. */
  quote: string;
  /** Sender name. */
  from: string;
  /** Message time. */
  date: IsoDateTime;
  /** Thread subject. */
  subject: string;
  /** Thread to open on click. */
  threadId: string;
}

/** One question and its answer: the question as a `base` 500 line (no bubble), serif `answer` prose, citations, step log, an optional proposal (DESIGN §6 AskTurn, §7.7). Mockups: ask.html (answer, working). Plain + refines: ui-ask. */
export interface AskTurnProps {
  /** Stable id. */
  id: string;
  /** The question. */
  question: string;
  /** 'working' = steady step line; 'streaming' = one thin non-blinking caret; 'answered'; 'stopped'; 'failed' = ErrorLine askFailed. */
  state: 'working' | 'streaming' | 'answered' | 'stopped' | 'failed';
  /** The step log (live line while working, dim fold after). */
  steps?: StepLogProps;
  /** Answer prose. */
  answer?: readonly AnswerParagraph[];
  /** Sources; every answer cites or says "No source in your mail". */
  citations: readonly CitationData[];
  /** Provider display name for "<Provider> didn't answer." */
  provider?: string;
  /** The turn's one proposal card. */
  proposal?: ProposalCardProps;
  /** Open a cited thread. */
  onOpenCitation: (threadId: string) => void;
  /** Retry after a failure. */
  onRetry?: () => void;
  /** "Use another provider" after a failure. */
  onUseAnotherProvider?: () => void;
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
  /** Open the source thread. */
  onOpen: (threadId: string) => void;
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
  /** Registry command it runs; supplies the keycap. */
  commandId: CommandId;
  /** Command label. */
  label: string;
  /** Command icon. */
  icon: IconName;
  /** Character indices of `label` to bold for the match. */
  matches?: readonly number[];
  /** Group name shown on the right while filtering, e.g. "Actions". */
  group?: string;
  /** Destructive: running it opens the Confirm sub-view. */
  destructive?: boolean;
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
  /** The target, shown as "For: <context>", e.g. "Drew Bell · October illustrations". */
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

/** The Search page field at `heading` size in the PageHead row, with a 2 px accent underline while focused; tokens under it; remote Gmail search only on Return (DESIGN §6 SearchField, §7.9). Mockups: search.html (results, no-match). Plain + refines: ui-ask. */
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

/* ───────────────────────── calendar ───────────────────────── */

/** The five fixed presets, digits 1–5 (DESIGN §7.3). */
export type DatePresetId = 'evening' | 'tomorrow' | 'weekend' | 'nextWeek' | 'someday';

/** One preset with the moment it resolves to. */
export interface DatePresetOption {
  /** Which preset; its label ("Today evening", "Tomorrow", "This weekend", "Next week", "Someday") is fixed copy. */
  id: DatePresetId;
  /** Resolved moment shown dim on the right; absent for Someday. */
  at?: IsoDateTime;
}

/** Presets 1–5 with digits always visible, "Pick a date…" with a month calendar and time, Return to confirm (DESIGN §6 DatePresets, §7.3). Shown in a Menu-like popover. Mockups: later-picker.html (default, calendar). Plain: ui-foundation; refines: ui-calendar; used by ui-home. */
export interface DatePresetsProps {
  /** Whether it is shown (`reveal`). */
  open: boolean;
  /** Element it opens from, e.g. the focus letter's Later button. */
  anchor: AnchorRef;
  /** 'later' titles it "Later until"; 'due' sets a due date (D). */
  purpose: 'later' | 'due';
  /** The five presets in order. */
  presets: readonly DatePresetOption[];
  /** Highlighted entry: a preset or the date picker. */
  activeId: DatePresetId | 'date';
  /** Highlight moved. */
  onActiveChange: (id: DatePresetId | 'date') => void;
  /** A preset was chosen (digit, Return or click). */
  onPick: (id: DatePresetId) => void;
  /** The calendar under "Pick a date…" is open. */
  calendarOpen: boolean;
  /** Month the calendar shows. */
  month: IsoYearMonth;
  /** Month changed. */
  onMonthChange: (month: IsoYearMonth) => void;
  /** Picked day. */
  pickedDate?: IsoDate;
  /** Day picked (arrows or click). */
  onPickDate: (date: IsoDate) => void;
  /** Picked time, default "08:00". */
  pickedTime: IsoTime;
  /** Time changed. */
  onTimeChange: (time: IsoTime) => void;
  /** Return on the picked date. */
  onConfirmDate: () => void;
  /** Esc or outside click. */
  onClose: () => void;
}

/** A calendar's identity. */
export interface CalendarInfo {
  /** Stable id. */
  id: string;
  /** Name, e.g. "Work". */
  name: string;
  /** Swatch colour (DESIGN §4.2). */
  color: TagColor;
  /** Shown on the grid. */
  visible: boolean;
}

/** A small month in the sidebar on Calendar; out-of-month days `--dim`; today a filled accent badge (DESIGN §6 MiniMonth, §7.8). Mockups: calendar-*.html (shell.js miniMonth). Plain: ui-foundation; refines: ui-calendar. */
export interface MiniMonthProps {
  /** Month shown. */
  month: IsoYearMonth;
  /** Today. */
  today: IsoDate;
  /** The range the grid shows (a week band, or one day). */
  range?: { start: IsoDate; end: IsoDate };
  /** First weekday from the locale: 0 Sunday, 1 Monday. */
  weekStartsOn: 0 | 1;
  /** Previous / next month. */
  onMonthChange: (month: IsoYearMonth) => void;
  /** A day was picked. */
  onPick: (date: IsoDate) => void;
}

/** The "Calendars" list with colour swatches, the calendar legend; ⌥-click shows one alone (DESIGN §6 CalendarList, §7.1, §7.8). Mockups: calendar-*.html (shell.js). Plain: ui-foundation; refines: ui-calendar. */
export interface CalendarListProps {
  /** Calendars in order. */
  calendars: readonly CalendarInfo[];
  /** Show or hide one. */
  onToggle: (id: string) => void;
  /** ⌥-click: show this one alone. */
  onSolo: (id: string) => void;
}

/** A calendar entry from the data layer. */
export interface CalendarEventData {
  /** Stable id. */
  id: string;
  /** Title. */
  title: string;
  /** Start. */
  start: IsoDateTime;
  /** End. */
  end: IsoDateTime;
  /** All-day event. */
  allDay?: boolean;
  /** Its calendar. */
  calendar: Pick<CalendarInfo, 'id' | 'name' | 'color'>;
  /** Place, shown in wide day columns. */
  place?: string;
  /** 'event' = on a calendar; 'plan' = found in mail, not added yet (PlanOutline). */
  kind: 'event' | 'plan';
  /** An invite still waiting for your answer (Y/M/N apply). */
  unanswered?: boolean;
  /** Saved on the server; Delete appears only on persisted events (DESIGN §7.8 Fixes). */
  persisted: boolean;
  /** For plans: the mail it came from. */
  source?: { from: string; subject: string; threadId: string };
}

/** Views of the grid; 'agenda' is the narrow-pane list and the Today tab (DESIGN §7.7 Today, §7.8 Narrow). */
export type CalendarView = 'day' | 'week' | 'month' | 'agenda';

/** The calendar grid: `--line` hairlines, 56 px per hour (8 AM–8 PM in view), today column `--today-tint`, now-line, overlap lanes with a "+N" stack, drag to create, move or resize with `lift` and `snap` (DESIGN §6 CalendarGrid, §7.8). Mockups: calendar-week.html (default, overlap), calendar-day.html (default, empty), calendar-event.html, ask.html (today). Plain + refines: ui-calendar. */
export interface CalendarGridProps {
  /** View. */
  view: CalendarView;
  /** First day shown (or the month's first day for 'month'). */
  start: IsoDate;
  /** Entries in range. */
  events: readonly CalendarEventData[];
  /** Now, for the now-line and today column. */
  now: IsoDateTime;
  /** First weekday from the locale. */
  weekStartsOn: 0 | 1;
  /** Selected entry. */
  selectedId?: string;
  /** Click or ↑/↓: select. */
  onSelect: (id: string) => void;
  /** Double-click or Return: open the detail. */
  onOpen: (id: string, anchor: HTMLElement) => void;
  /** Drag on empty grid: create. */
  onCreate: (range: { start: IsoDateTime; end: IsoDateTime }) => void;
  /** Drag an entry to a new time. */
  onMove: (id: string, range: { start: IsoDateTime; end: IsoDateTime }) => void;
  /** Drag an entry's end. */
  onResize: (id: string, end: IsoDateTime) => void;
  /** A "+N" stack was opened; the screen shows a Menu of these ids. */
  onOpenStack: (ids: readonly string[], anchor: HTMLElement) => void;
  /** Empty day: "Nothing scheduled." with this action (New event · N, DESIGN §7.14). */
  emptyAction?: CommandAction;
  /** Accessible name for the `grid`, e.g. "Week of October 25, 2026". */
  label: string;
  /** Announces range and selection changes (DESIGN §11.3). */
  announce?: Announce;
}

/** Where the grid placed an entry among overlapping lanes; lanes are never under 44 px (DESIGN §7.8). */
export interface EventPlacement {
  /** 0-based lane. */
  lane: number;
  /** Lanes in this overlap cluster. */
  lanes: number;
  /** A wide day column: the time line adds the place. */
  wide: boolean;
}

/** One entry on the grid: radius 6, a 2 px leading rule in the calendar colour, the §4.2 fill, title `small` 500, time `--dim` (dark `--ink-2`); under 30 minutes is one line; or the "+N" stack (DESIGN §6 EventBlock, §7.8). Rendered by CalendarGrid. Mockups: calendar-week.html, calendar-day.html. Plain + refines: ui-calendar. */
export type EventBlockProps =
  | {
      /** A single event. */
      kind: 'event';
      /** The event (kind 'event'). */
      event: CalendarEventData;
      /** Lane placement. */
      placement: EventPlacement;
      /** Selected (`aria-pressed`). */
      selected: boolean;
      /** Select. */
      onSelect: () => void;
      /** Open the detail. */
      onOpen: (anchor: HTMLElement) => void;
    }
  | {
      /** The "+N" stack for the third and later overlapping events. */
      kind: 'stack';
      /** Ids folded into the stack. */
      ids: readonly string[];
      /** Earliest start in the stack. */
      start: IsoDateTime;
      /** Latest end in the stack. */
      end: IsoDateTime;
      /** Colour of the first folded event. */
      color: TagColor;
      /** Open the stack menu. */
      onOpen: (anchor: HTMLElement) => void;
    };

/** A plan found in mail on the grid: dashed 1 px outline and a "From mail" label until confirmed (DESIGN §6 PlanOutline, §7.8, §11.1). Rendered by CalendarGrid. Mockups: calendar-week.html (launch prep). Plain + refines: ui-calendar. */
export interface PlanOutlineProps {
  /** The plan (kind 'plan', with `source`). */
  plan: CalendarEventData;
  /** Lane placement. */
  placement: EventPlacement;
  /** Selected. */
  selected: boolean;
  /** Select. */
  onSelect: () => void;
  /** Open the detail (which offers confirm and the source email). */
  onOpen: (anchor: HTMLElement) => void;
}

/** The now-line: 1 px `--stamp` with a 5 px cap; it may cross event text (DESIGN §6 NowLine, §7.8). Mockups: calendar-week.html, calendar-day.html, ask.html (today agenda). Plain + refines: ui-calendar. */
export interface NowLineProps {
  /** Now. */
  now: IsoDateTime;
  /** 'grid' = across the today column; 'agenda' = a row with the time label (Today tab). */
  variant: 'grid' | 'agenda';
}

/* ───────────────────────── settings ───────────────────────── */

/** A settings row: 40 px, or 48 px with a one-line description of what it does; hairline separators; a fixed control column (DESIGN §6 SettingRow, §7.10). Mockups: settings-*.html (settings.js row, disclosure). Plain + refines: ui-settings. */
export interface SettingRowProps {
  /** DOM id; the control is labelled by it. */
  id: string;
  /** Setting name. */
  label: string;
  /** What the setting does, `small` `--dim`. */
  description?: string;
  /** 'attention' shows the description with an alert icon in `--stamp-ink` (an account that needs reconnecting). */
  descriptionTone?: 'default' | 'attention';
  /** Quiet tag after the label, e.g. "Default". */
  tag?: string;
  /** Leading colour mark (account rows). */
  mark?: TagColor;
  /** Dim text after the label, e.g. the provider "Google". */
  meta?: string;
  /** The control: Switch, Puck, picker Button, TextField or Buttons. */
  control?: ReactNode;
  /** A folded row whose long text opens beneath it ("How your mail is used"). */
  disclosure?: { expanded: boolean; onToggle: () => void; content: ReactNode };
  /** A line under the row, e.g. an ErrorLine with placement 'settings'. */
  below?: ReactNode;
}

/** AI features with a provider and model each (DESIGN §7.10 AI). */
export type AiFeature = 'ask' | 'summaries' | 'drafts' | 'plans' | 'voice';

/** Providers; display names are fixed copy: Groq, OpenAI, Claude, Gemini, OpenRouter, OpenCode Go, Ollama, LM Studio, Custom server (AGENTS.md). */
export type ProviderId = 'groq' | 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'opencode' | 'ollama' | 'lmstudio' | 'custom';

/** Where a provider's key comes from; key characters are never shown (DESIGN §7.10). */
export type KeySource =
  | {
      /** "From environment: GROQ_API_KEY"; Remove is disabled with the reason in a tooltip. */
      kind: 'environment';
      /** Variable name. */
      variable: string;
    }
  | {
      /** "Saved in Keychain". */
      kind: 'keychain';
    }
  | {
      /** "Not set · reads ANTHROPIC_API_KEY"; the row offers "Add key". */
      kind: 'none';
      /** Variable the engine would read. */
      variable: string;
    }
  | {
      /** A model on this Mac: no key needed. */
      kind: 'local';
    };

/** A hosted provider's test status. */
export type ProviderStatus =
  | { kind: 'ready' }
  | { kind: 'needsKey' }
  | { kind: 'testing' }
  | {
      /** "Works · 0.4 s". */
      kind: 'works';
      /** Round trip in milliseconds; formatted by the component. */
      latencyMs: number;
    }
  | { kind: 'refused' }
  | { kind: 'unreachable' };

/** Actions on a provider row. */
export type ProviderAction = 'test' | 'remove' | 'addKey' | 'replaceKey';

/** The Settings → AI tables: Features first, then hosted providers, then "On this Mac and custom" (DESIGN §6 ProviderTable, §7.10). Mockups: settings-ai.html (default, testing). Plain + refines: ui-settings. */
export type ProviderTableProps =
  | {
      /** Ask, Summaries, Drafts, Plans, Voice, each with provider and model pickers; Voice lists only speech-to-text providers. */
      kind: 'features';
      /** One row per feature. */
      rows: readonly {
        feature: AiFeature;
        provider: ProviderId;
        model: string;
        providerOptions: readonly ProviderId[];
        modelOptions: readonly string[];
      }[];
      /** A picker changed. */
      onChange: (feature: AiFeature, choice: { provider: ProviderId; model: string }) => void;
    }
  | {
      /** Hosted providers with status, key source, Test and Remove or Add key; a refused key adds an ErrorLine below. */
      kind: 'hosted';
      /** One row per provider. */
      rows: readonly { provider: ProviderId; isDefault: boolean; keySource: KeySource; status: ProviderStatus }[];
      /** A row action. */
      onAction: (provider: ProviderId, action: ProviderAction) => void;
    }
  | {
      /** Ollama, LM Studio and a custom server, each with an editable address and its default port. */
      kind: 'local';
      /** One row per server. */
      rows: readonly { provider: 'ollama' | 'lmstudio' | 'custom'; address: string; defaultAddress: string; running?: boolean }[];
      /** Address edited. */
      onAddressChange: (provider: 'ollama' | 'lmstudio' | 'custom', address: string) => void;
    };

/** One remappable shortcut row: keycaps, conflict marks, recording with Replace / Cancel, Reset when changed (DESIGN §6 KeyRecorder, §7.10 Keyboard, §11.4). Mockups: settings-keyboard.html (default, recording). Plain + refines: ui-settings. */
export interface KeyRecorderProps {
  /** Command being edited. */
  commandId: CommandId;
  /** Its label, e.g. "Done". */
  label: string;
  /** Current chords. */
  chords: readonly string[];
  /** Differs from the default: Reset shows. */
  changed: boolean;
  /** 'idle'; 'recording' = "Press the new keys · Esc to cancel"; 'conflict' = the pressed chord is taken. */
  state: 'idle' | 'recording' | 'conflict';
  /** The chord just pressed (conflict state). */
  pendingChord?: string;
  /** Who already uses the pending chord ("Already used by Later"), or an existing clash at rest ("Same keys as …"). */
  conflictWith?: { commandId: CommandId; label: string };
  /** Start recording (click on the keys). */
  onStart: () => void;
  /** A chord was captured (IME-safe, `event.key`, modifiers alone ignored, DESIGN §5 rule 16). */
  onChord: (chord: string) => void;
  /** Replace the other command's binding. */
  onReplace: () => void;
  /** Esc or Cancel. */
  onCancel: () => void;
  /** Back to the default. */
  onReset: () => void;
  /** Announces recording and conflicts (DESIGN §11.3). */
  announce?: Announce;
}

/* ───────────────────────── status ───────────────────────── */

/** One account's sync state in ARCH §6.4's vocabulary, plus the demo account (DESIGN §7.1 status table). */
export type SyncStatus =
  | {
      /** "Starting…", only after 150 ms. */
      kind: 'starting';
    }
  | {
      /** "Syncing…", only after 150 ms. */
      kind: 'syncing';
      /** First window still reading: "Reading your newest mail · 24 of 50" (mockup empty.html first-mail; see README open question). */
      firstWindow?: { read: number; of: number };
    }
  | {
      /** Nothing shown; "Synced 2 min ago" on hover. */
      kind: 'ok';
      /** Last successful sync, for the hover line. */
      lastSyncedAt?: IsoDateTime;
      /** Token expiry; within 24 hours shows "Gmail will ask you to reconnect tomorrow at 9:00 AM." with Reconnect now. */
      reconnectBy?: IsoDateTime;
    }
  | {
      /** "Importing 214 of 500" with a neutral track. */
      kind: 'backfilling';
      /** Imported so far. */
      done: number;
      /** Total to import. */
      of: number;
    }
  | {
      /** Throttle: "Google asked us to slow down. Resuming at 2:14 PM." with Retry now. Daily limit: "Google's daily limit is reached. Resuming tomorrow." */
      kind: 'paused';
      /** Why it paused. */
      reason: 'throttle' | 'dailyLimit';
      /** When it resumes, if known. */
      resumeAt?: IsoDateTime;
    }
  | {
      /** "Google needs you to sign in again." with Reconnect. */
      kind: 'needsReauth';
    }
  | {
      /** "Aplos needs permission to read your Gmail." with Reconnect. */
      kind: 'needsPermission';
    }
  | {
      /** "Your organisation has blocked Aplos. Ask your administrator." */
      kind: 'needsAdmin';
    }
  | {
      /** "Google sign-in isn't set up in this build." with Copy diagnostics. */
      kind: 'misconfigured';
    }
  | {
      /** "Offline · 2 changes waiting"; drains automatically. */
      kind: 'offline';
      /** Queued local changes. */
      changesWaiting: number;
    }
  | {
      /** "Sync hit a problem." with View details. */
      kind: 'error';
    }
  | {
      /** "Demo mail. Remove it in Settings." */
      kind: 'demo';
    };

/** Verbs the status slot offers; Reconnect opens the ReconnectSheet. */
export type StatusAction = 'reconnect' | 'retry' | 'copyDiagnostics' | 'viewDetails';

/** The sidebar footer's sync state, the only place sync status lives in the main window; two short lines of about 28 characters; never a banner (DESIGN §6 StatusSlot, §7.1). Mockups: errors.html (reconnect, quota, offline), empty.html (first-mail), demo.html, shell.js STATUS. Plain + refines: ui-foundation; used by ui-shell. */
export interface StatusSlotProps {
  /** The state to show; the component writes DESIGN §7.1's copy. */
  status: SyncStatus;
  /** The offered action was chosen. */
  onAction: (action: StatusAction) => void;
}

/** The weekly Gmail reconnect sheet (`--elev-dialog`): opens Google in the browser with the address filled in, "Waiting for Google in your browser…" with Cancel; closes with a "Reconnected" toast; nothing resyncs (DESIGN §6 ReconnectSheet, §7.1). Mockups: settings-accounts.html (reconnect), onboarding-accounts.html (waiting). Plain + refines: ui-foundation; used by ui-onboard, ui-shell, ui-settings. */
export interface ReconnectSheetProps {
  /** Whether it is shown. */
  open: boolean;
  /** The account address (`login_hint`). */
  address: string;
  /** 'waiting' for the browser, or 'failed' with a reason and Try again. */
  state: 'waiting' | 'failed';
  /** Plain reason when failed. */
  reason?: string;
  /** Cancel (Esc). */
  onCancel: () => void;
  /** Try again after a failure. */
  onRetry: () => void;
}

/** State of one first-sync checkpoint (DESIGN §7.12): done `--ink-2`, paused `--dusk`, failed `--stamp`; 'current' carries the `status` motion; 'partial' = a capped pass. */
export type SegmentState = 'pending' | 'current' | 'done' | 'paused' | 'partial' | 'failed';

/** One engine checkpoint; the component writes the checklist copy ("Found about 214 recent emails", "Reading your newest mail · 24 of 50", "Sorted 12 of 40. The rest continue in the background."). */
export type SyncCheckpoint =
  | {
      /** Connect. */
      step: 'connect';
      /** State. */
      state: SegmentState;
    }
  | {
      /** Find recent mail; a count only as "about N" when the provider estimates, else an indeterminate bar. */
      step: 'find';
      /** State. */
      state: SegmentState;
      /** Provider's estimate, if any. */
      estimate?: number;
    }
  | {
      /** Read your newest mail: n of the first window, never the mailbox total. */
      step: 'read';
      /** State. */
      state: SegmentState;
      /** Read so far. */
      read: number;
      /** Size of the first window (about 50). */
      of: number;
    }
  | {
      /** Sort what matters; omitted with no AI provider. */
      step: 'sort';
      /** State. */
      state: SegmentState;
      /** Summaries done. */
      sorted: number;
      /** Summaries planned (at most 40). */
      of: number;
    };

/** The account a progress row belongs to. */
export interface SyncAccount {
  /** Address; also the progress bar's label "<address> sync" (DESIGN §7.12 Accessibility). */
  address: string;
  /** Account colour dot. */
  color: TagColor;
}

/** Checkpoint progress for first sync, "Account connected" and "Importing N of M"; neutral colours; never a fake percentage (DESIGN §6 ProgressSegments, §7.12). Mockups: onboarding-sync.html (progress, paused, ready, partial, failed), onboarding-drill.html, shell.js (importing). Plain + refines: ui-foundation; used by ui-onboard, ui-shell. */
export type ProgressSegmentsProps =
  | {
      /** One account's segments plus its checklist. */
      variant: 'checkpoints';
      /** The account. */
      account: SyncAccount;
      /** Checkpoints in order: connect, find, read, sort (sort omitted with no AI). */
      checkpoints: readonly SyncCheckpoint[];
      /** Paused until, for "Paused until 2:14 PM". */
      pausedUntil?: IsoDateTime;
      /** Plain failure reason for the failed step, shown as an ErrorLine in the checklist. */
      failureReason?: string;
      /** "Not connected · Try again" or Try again after a failure. */
      onRetry?: () => void;
      /** Only the segments and status, no checklist (the drill keeps progress visible this way). */
      compact?: boolean;
    }
  | {
      /** The status slot's "Importing N of M" track. */
      variant: 'importing';
      /** The account. */
      account: SyncAccount;
      /** Imported so far. */
      done: number;
      /** Total to import. */
      of: number;
    }
  | {
      /** The drawn 40 px check (static under reduced motion). */
      variant: 'ready';
      /** 'ready' = "Your mail is ready"; 'connected' = "Account connected". */
      label: 'ready' | 'connected';
      /** Per-account result lines, e.g. "Newest 50 read · sorted 40 of 40". */
      accounts?: readonly (SyncAccount & { result: string })[];
    };

/** The whole-pane fatal error: sans `display` "Aplos can't reach its mail engine." + "Your mail is safe on this Mac." (DESIGN §6 FatalScreen, §7.15; plan 30 §4.5 #3). Mockups: fatal.html. Plain + refines: ui-foundation; used by ui-shell. */
export interface FatalScreenProps {
  /** 'unreachable' = Restart engine · Copy diagnostics; 'parked' = the parked engine, Try again · Export diagnostics. */
  kind: 'unreachable' | 'parked';
  /** Restart in progress: the button reads "Restarting…" and is disabled. */
  restarting: boolean;
  /** Restart engine / Try again (Return). */
  onRestart: () => void;
  /** Copy or export the content-free diagnostics. */
  onDiagnostics: () => void;
}

/** A quiet indicator that appears only after 150 ms; never for local reads (DESIGN §5 rule 12, §6 Spinner). Mockups: onboarding-sync.html, onboarding-drill.html. Plain + refines: ui-foundation. */
export interface SpinnerProps {
  /** Accessible name, e.g. "Searching Google". */
  label: string;
  /** 12 px for 12 px lines and chips, 16 px elsewhere. Default 'md'. */
  size?: 'sm' | 'md';
}

/* ───────────────────────── controls ───────────────────────── */

/** On/off switch, 30 × 18, thumb on `--spring-thumb` (DESIGN §6 Switch). Mockups: settings-*.html, onboarding-permissions.html. Plain + refines: ui-foundation. */
export interface SwitchProps {
  /** On. */
  checked: boolean;
  /** Toggled. */
  onChange: (checked: boolean) => void;
  /** Required accessible name (DESIGN §11.3); or set `labelledBy`. */
  label: string;
  /** DOM id of a visible label (a SettingRow's label); overrides `label` as the name. */
  labelledBy?: string;
  /** Disabled. */
  disabled?: boolean;
  /** Tooltip explaining why it is disabled. */
  disabledReason?: string;
}

/** Checkbox with a `--control-edge` ring (DESIGN §4.1, §6 Checkbox). Mockups: inbox.html (bulk pick mark). Plain + refines: ui-foundation. */
export interface CheckboxProps {
  /** Checked, unchecked or mixed. */
  checked: boolean | 'mixed';
  /** Toggled. */
  onChange: (checked: boolean) => void;
  /** Required accessible name. */
  label: string;
  /** Show the label beside the box. Default true. */
  labelVisible?: boolean;
  /** Disabled. */
  disabled?: boolean;
}

/** A text field: `--sunken` fill, calm `--line-strong` ring at rest (decision 20), `--control-edge` under Increase Contrast (DESIGN §6 TextField, §11.1). Mockups: onboarding-accounts.html, onboarding-ai.html, settings-ai.html, shortcuts.html (filter). Plain + refines: ui-foundation. */
export interface TextFieldProps {
  /** DOM id. */
  id: string;
  /** Value. */
  value: string;
  /** Value changed. */
  onChange: (value: string) => void;
  /** Required accessible name. */
  label: string;
  /** Show the label above the field. Default false (placeholder-led fields keep the name for assistive tech). */
  labelVisible?: boolean;
  /** Placeholder in `--dim`. */
  placeholder?: string;
  /** Input type; 'password' for keys and app passwords (characters never shown back). */
  type?: 'text' | 'email' | 'password' | 'url' | 'search';
  /** 'md' 32 px; 'lg' 40 px (onboarding). Default 'md'. */
  size?: 'md' | 'lg';
  /** Leading icon. */
  icon?: IconName;
  /** Trailing literal keycap, e.g. Return on the onboarding address field. */
  trailingKeys?: LiteralKey;
  /** Mono text for addresses and server URLs (DESIGN §4.3). */
  mono?: boolean;
  /** One plain sentence under the field; also sets `aria-invalid`. */
  error?: string;
  /** Disabled. */
  disabled?: boolean;
  /** Read-only. */
  readOnly?: boolean;
  /** Return pressed (not during IME composition). */
  onSubmit?: () => void;
  /** Focus on mount. */
  autoFocus?: boolean;
  /** Element ref. */
  ref?: Ref<HTMLInputElement>;
}

/** One alternative chord in the sheet; `hold` renders the plain word "hold" before it. */
export interface ShortcutChord {
  /** Display chord, e.g. "J", "⌘K". */
  chord: string;
  /** "hold R". */
  hold?: boolean;
}

/** One sheet entry, generated from the registry. */
export interface ShortcutEntry {
  /** Command. */
  commandId: CommandId;
  /** Label. */
  label: string;
  /** Alternatives, joined with "or". */
  alternatives: readonly ShortcutChord[];
}

/** One context block, e.g. "Global", "Lists". */
export interface ShortcutGroup {
  /** Stable id. */
  id: string;
  /** Context label. */
  label: string;
  /** Entries. */
  entries: readonly ShortcutEntry[];
}

/** The shortcut sheet: generated from the registry; three columns at a fixed height that scrolls; alternatives joined with "or"; columns keep their places while filtering (DESIGN §6 ShortcutSheet, §8). In a Dialog. Mockups: shortcuts.html (default, filtered). Plain + refines: ui-foundation. */
export interface ShortcutSheetProps {
  /** Whether it is shown. */
  open: boolean;
  /** All groups. */
  groups: readonly ShortcutGroup[];
  /** Group ids per column, three columns. */
  columns: readonly [readonly string[], readonly string[], readonly string[]];
  /** Filter text. */
  query: string;
  /** Filter changed. */
  onQueryChange: (value: string) => void;
  /** Esc (clears the filter first), ? again, close button or scrim. */
  onClose: () => void;
}

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
  | 'controls';

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
  { name: 'Button', family: 'buttons-keys', file: 'apps/desktop/src/renderer/ui/buttons-keys/Button.tsx' },
  { name: 'Kbd', family: 'buttons-keys', file: 'apps/desktop/src/renderer/ui/buttons-keys/Kbd.tsx' },
  { name: 'Tooltip', family: 'buttons-keys', file: 'apps/desktop/src/renderer/ui/buttons-keys/Tooltip.tsx' },
  { name: 'Pane', family: 'surfaces', file: 'apps/desktop/src/renderer/ui/surfaces/Pane.tsx' },
  { name: 'PageHead', family: 'surfaces', file: 'apps/desktop/src/renderer/ui/surfaces/PageHead.tsx' },
  { name: 'NavHead', family: 'surfaces', file: 'apps/desktop/src/renderer/ui/surfaces/NavHead.tsx' },
  { name: 'Menu', family: 'surfaces', file: 'apps/desktop/src/renderer/ui/surfaces/Menu.tsx' },
  { name: 'Popover', family: 'surfaces', file: 'apps/desktop/src/renderer/ui/surfaces/Popover.tsx' },
  { name: 'Dialog', family: 'surfaces', file: 'apps/desktop/src/renderer/ui/surfaces/Dialog.tsx' },
  { name: 'Confirm', family: 'surfaces', file: 'apps/desktop/src/renderer/ui/surfaces/Confirm.tsx' },
  { name: 'Puck', family: 'surfaces', file: 'apps/desktop/src/renderer/ui/surfaces/Puck.tsx' },
  { name: 'Toast', family: 'surfaces', file: 'apps/desktop/src/renderer/ui/surfaces/Toast.tsx' },
  { name: 'ToastStack', family: 'surfaces', file: 'apps/desktop/src/renderer/ui/surfaces/ToastStack.tsx' },
  { name: 'ListRow', family: 'list', file: 'apps/desktop/src/renderer/ui/list/ListRow.tsx' },
  { name: 'SectionHeader', family: 'list', file: 'apps/desktop/src/renderer/ui/list/SectionHeader.tsx' },
  { name: 'FocusSlot', family: 'list', file: 'apps/desktop/src/renderer/ui/list/FocusSlot.tsx' },
  { name: 'FocusLetter', family: 'list', file: 'apps/desktop/src/renderer/ui/list/FocusLetter.tsx' },
  { name: 'LowBand', family: 'list', file: 'apps/desktop/src/renderer/ui/list/LowBand.tsx' },
  { name: 'CommitChip', family: 'list', file: 'apps/desktop/src/renderer/ui/list/CommitChip.tsx' },
  { name: 'CommitEdge', family: 'list', file: 'apps/desktop/src/renderer/ui/list/CommitEdge.tsx' },
  { name: 'Chip', family: 'list', file: 'apps/desktop/src/renderer/ui/list/Chip.tsx' },
  { name: 'EmptyLine', family: 'list', file: 'apps/desktop/src/renderer/ui/list/EmptyLine.tsx' },
  { name: 'ErrorLine', family: 'list', file: 'apps/desktop/src/renderer/ui/list/ErrorLine.tsx' },
  { name: 'ReaderHead', family: 'reader', file: 'apps/desktop/src/renderer/ui/reader/ReaderHead.tsx' },
  { name: 'EarlierMessages', family: 'reader', file: 'apps/desktop/src/renderer/ui/reader/EarlierMessages.tsx' },
  { name: 'ReplyStub', family: 'reader', file: 'apps/desktop/src/renderer/ui/reader/ReplyStub.tsx' },
  { name: 'Summary', family: 'reader', file: 'apps/desktop/src/renderer/ui/reader/Summary.tsx' },
  { name: 'Why', family: 'reader', file: 'apps/desktop/src/renderer/ui/reader/Why.tsx' },
  { name: 'UndoTray', family: 'reader', file: 'apps/desktop/src/renderer/ui/reader/UndoTray.tsx' },
  { name: 'Composer', family: 'compose', file: 'apps/desktop/src/renderer/ui/compose/Composer.tsx' },
  { name: 'InlineReply', family: 'compose', file: 'apps/desktop/src/renderer/ui/compose/InlineReply.tsx' },
  { name: 'RecipientField', family: 'compose', file: 'apps/desktop/src/renderer/ui/compose/RecipientField.tsx' },
  { name: 'DraftState', family: 'compose', file: 'apps/desktop/src/renderer/ui/compose/DraftState.tsx' },
  { name: 'Suggestion', family: 'compose', file: 'apps/desktop/src/renderer/ui/compose/Suggestion.tsx' },
  { name: 'LevelMeter', family: 'compose', file: 'apps/desktop/src/renderer/ui/compose/LevelMeter.tsx' },
  { name: 'AskDock', family: 'ask', file: 'apps/desktop/src/renderer/ui/ask/AskDock.tsx' },
  { name: 'AskTurn', family: 'ask', file: 'apps/desktop/src/renderer/ui/ask/AskTurn.tsx' },
  { name: 'StepLog', family: 'ask', file: 'apps/desktop/src/renderer/ui/ask/StepLog.tsx' },
  { name: 'Citation', family: 'ask', file: 'apps/desktop/src/renderer/ui/ask/Citation.tsx' },
  { name: 'ProposalCard', family: 'ask', file: 'apps/desktop/src/renderer/ui/ask/ProposalCard.tsx' },
  { name: 'Palette', family: 'ask', file: 'apps/desktop/src/renderer/ui/ask/Palette.tsx' },
  { name: 'SearchField', family: 'ask', file: 'apps/desktop/src/renderer/ui/ask/SearchField.tsx' },
  { name: 'OperatorToken', family: 'ask', file: 'apps/desktop/src/renderer/ui/ask/OperatorToken.tsx' },
  { name: 'MiniMonth', family: 'calendar', file: 'apps/desktop/src/renderer/ui/calendar/MiniMonth.tsx' },
  { name: 'CalendarList', family: 'calendar', file: 'apps/desktop/src/renderer/ui/calendar/CalendarList.tsx' },
  { name: 'CalendarGrid', family: 'calendar', file: 'apps/desktop/src/renderer/ui/calendar/CalendarGrid.tsx' },
  { name: 'EventBlock', family: 'calendar', file: 'apps/desktop/src/renderer/ui/calendar/EventBlock.tsx' },
  { name: 'PlanOutline', family: 'calendar', file: 'apps/desktop/src/renderer/ui/calendar/PlanOutline.tsx' },
  { name: 'NowLine', family: 'calendar', file: 'apps/desktop/src/renderer/ui/calendar/NowLine.tsx' },
  { name: 'DatePresets', family: 'calendar', file: 'apps/desktop/src/renderer/ui/calendar/DatePresets.tsx' },
  { name: 'SettingRow', family: 'settings', file: 'apps/desktop/src/renderer/ui/settings/SettingRow.tsx' },
  { name: 'ProviderTable', family: 'settings', file: 'apps/desktop/src/renderer/ui/settings/ProviderTable.tsx' },
  { name: 'KeyRecorder', family: 'settings', file: 'apps/desktop/src/renderer/ui/settings/KeyRecorder.tsx' },
  { name: 'StatusSlot', family: 'status', file: 'apps/desktop/src/renderer/ui/status/StatusSlot.tsx' },
  { name: 'ReconnectSheet', family: 'status', file: 'apps/desktop/src/renderer/ui/status/ReconnectSheet.tsx' },
  { name: 'ProgressSegments', family: 'status', file: 'apps/desktop/src/renderer/ui/status/ProgressSegments.tsx' },
  { name: 'FatalScreen', family: 'status', file: 'apps/desktop/src/renderer/ui/status/FatalScreen.tsx' },
  { name: 'Spinner', family: 'status', file: 'apps/desktop/src/renderer/ui/status/Spinner.tsx' },
  { name: 'Switch', family: 'controls', file: 'apps/desktop/src/renderer/ui/controls/Switch.tsx' },
  { name: 'Checkbox', family: 'controls', file: 'apps/desktop/src/renderer/ui/controls/Checkbox.tsx' },
  { name: 'TextField', family: 'controls', file: 'apps/desktop/src/renderer/ui/controls/TextField.tsx' },
  { name: 'ShortcutSheet', family: 'controls', file: 'apps/desktop/src/renderer/ui/controls/ShortcutSheet.tsx' },
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
  Menu: MenuProps;
  Popover: PopoverProps;
  Dialog: DialogProps;
  Confirm: ConfirmProps;
  Puck: PuckProps;
  Toast: ToastProps;
  ToastStack: ToastStackProps;
  ListRow: ListRowProps;
  SectionHeader: SectionHeaderProps;
  FocusSlot: FocusSlotProps;
  FocusLetter: FocusLetterProps;
  LowBand: LowBandProps;
  CommitChip: CommitChipProps;
  CommitEdge: CommitEdgeProps;
  Chip: ChipProps;
  EmptyLine: EmptyLineProps;
  ErrorLine: ErrorLineProps;
  ReaderHead: ReaderHeadProps;
  EarlierMessages: EarlierMessagesProps;
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
  TextField: TextFieldProps;
  ShortcutSheet: ShortcutSheetProps;
}

/** Compile-time guard: the manifest and the props map name exactly the same components. */
type AssertNever<T extends never> = T;
type _ManifestHasProps = AssertNever<Exclude<ComponentName, keyof ComponentPropsMap>>;
type _PropsInManifest = AssertNever<Exclude<keyof ComponentPropsMap, ComponentName>>;
