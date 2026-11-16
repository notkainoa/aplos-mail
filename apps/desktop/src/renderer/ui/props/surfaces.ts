import type { ReactNode, Ref } from 'react';
import type { Anchor, Announce, CommandAction, CommandId, IconName, TagColor } from './shared';
import type { UndoTrayProps } from './reader';

/* ───────────────────────── surfaces ───────────────────────── */

/** One icon tool in the pane header: icon button with tooltip and registry key (DESIGN §7.1). */
export interface PaneTool {
  /** Registry command; passed back on press and supplies the keycap. */
  commandId: CommandId;
  /** Icon. */
  icon: IconName;
  /** Accessible name and tooltip first line, e.g. "Previous email", "More", "New event". */
  label: string;
  /** Tooltip second line, e.g. "bookmark, trash, forward, why it's here" for More. */
  detail?: string;
  /** Toggle state for `aria-pressed`. */
  pressed?: boolean;
  /** Disabled, e.g. Next on the last thread. */
  disabled?: boolean;
}

/** At most three icon tools (DESIGN §7.1); the tuple type enforces the limit. */
export type PaneTools =
  | readonly []
  | readonly [PaneTool]
  | readonly [PaneTool, PaneTool]
  | readonly [PaneTool, PaneTool, PaneTool];

/** The 48 px pane header, structured so a lane cannot add a fourth tool, a page title or move Ask (DESIGN §7.1, §4.4). The hairline after scroll is internal. Mockups: every main-window page (`.toolbar`), reader.html, compose.html, inbox.html (#bulk), calendar-week.html. */
export interface PaneHeaderProps {
  /** Back (chevron, Esc) or close (×, Esc) on deeper views. */
  lead?: {
    /** 'back' = chevron-left; 'close' = ×. */
    kind: 'back' | 'close';
    /** Accessible name and tooltip, e.g. "Back", "Close. The draft is saved." */
    label: string;
    /** Registry command for the keycap (Esc). */
    commandId?: CommandId;
    /** Pressed. */
    onPress: () => void;
  };
  /** The quiet crumb after the lead, e.g. "Home" + "1 of 16", "New message", "Reply to Studio Kettle". Never a page title. */
  crumb?: {
    /** Crumb text. */
    label: string;
    /** Position in `--dim`, e.g. { index: 1, of: 16 } → "1 of 16". */
    position?: { index: number; of: number };
    /** Draw the position centred in the header (over the content column) instead of after the crumb: the one-by-one view. */
    centrePosition?: boolean;
    /** Reader: the thread subject, shown instead of the crumb once `showSubject` is true. */
    subject?: string;
    /** The summary has scrolled out of view, so the crumb shows `subject` (DESIGN §7.1). */
    showSubject?: boolean;
  };
  /** Up to three icon tools for the view, right side, before Ask. */
  tools?: PaneTools;
  /** A tool was pressed; the element is the anchor for its Menu (e.g. More). */
  onTool?: (commandId: CommandId, anchor: HTMLElement) => void;
  /** The Ask button (speech bubble + "Ask", A); always present, after the tools. */
  ask: {
    /** `aria-pressed` while the dock is open. */
    pressed: boolean;
    /** Tooltip wording: 'mail' = "Ask about your mail"; 'thisEmail' = "Ask about this email" (reader). */
    scope: 'mail' | 'thisEmail';
    /** Pressed. */
    onPress: () => void;
  };
  /** The calendar button (tooltip "Today", ⇧A) after Ask; opens the dock's Today tab. */
  today: {
    /** `aria-pressed` while the Today tab is showing. */
    pressed: boolean;
    /** Pressed. */
    onPress: () => void;
  };
  /** Bulk selection replaces the left side: "3 selected · Done · Later · Trash · More · Esc" (DESIGN §7.4). */
  bulk?: {
    /** Picked rows. */
    count: number;
    /** Text verbs in order (Done, Later, Trash), keycaps from the registry with keyHint 'hint'. */
    actions: readonly CommandAction[];
    /** The More icon button; the element anchors its Menu. */
    onMore: (anchor: HTMLElement) => void;
    /** Clear selection (×, Esc). */
    onClear: () => void;
  };
}

/** The white surface on the gray shell: the main pane and the Ask dock (DESIGN §2.2, §4.4, §6 Pane). Mockups: every main-window page. Plain + refines: ui-foundation; used by ui-shell. */
export type PaneProps = {
  /** Accessible region name, e.g. "Home", "Ask". */
  label: string;
  /** Pane content; scrolls inside the pane. */
  children: ReactNode;
  /** Element ref for the motion runtime (`dock` FLIP, DESIGN §4.8). */
  ref?: Ref<HTMLElement>;
} & (
  | {
      /** The content pane. */
      kind: 'main';
      /** The structured 48 px header; omitted only on the FatalScreen. */
      header?: PaneHeaderProps;
    }
  | {
      /** The Ask dock's second pane; AskDock draws its own Ask | Today header inside. */
      kind: 'dock';
    }
);

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

/** The sidebar's account switcher: the app's one monogram (ink on `--raised`), the account name and a chevron; tooltip "Switch account"; opens the account Menu (DESIGN §7.1, §4.2). Mockups: shell.js sidebar (`.acct-switch`), errors.html (reconnect, menu open). Plain + refines: ui-foundation; used by ui-shell. */
export interface AccountSwitcherProps {
  /** Visible name, e.g. "All accounts" or "alex.moreno@gmail.com". */
  label: string;
  /** One or two letters, e.g. "A" for All accounts. */
  monogram: string;
  /** The account Menu is open (`aria-expanded`). */
  open: boolean;
  /** DOM id of the Menu it controls (`aria-controls`). */
  menuId: string;
  /** Pressed; the element anchors the account Menu. */
  onOpen: (anchor: HTMLElement) => void;
}

/** The DESIGN §4.3 type roles a screen may set on plain text, plus two compositions the mockups use: 'lede' (`base` `--dim`, onboarding) and 'label' (`small` 500 `--dim`, field captions and the reader's subject line). Never 'summary' or 'answer': those belong to Summary and AskTurn. */
export type TextVariant = 'display' | 'heading' | 'title' | 'lede' | 'label' | 'small' | 'caption';

/** Closed text primitive so screens never set type themselves (DESIGN §4.3, §12.2): onboarding titles and ledes, the Welcome display line, the reader's subject line, the Today header, the drill heading, "Esc opens Aplos", lock lines. Mockups: onboarding-*.html, reader.html (`.r-subject`), ask.html (`.today-head`). Plain + refines: ui-foundation; used by ui-onboard, ui-reader, ui-ask. */
export interface TextProps {
  /** Type role. */
  variant: TextVariant;
  /** Element; default 'p' ('h1' for display and heading). Headings keep the document outline. */
  as?: 'h1' | 'h2' | 'h3' | 'p' | 'span' | 'div';
  /** Ink; default per variant (heading/title/display `--ink`, lede/label/small/caption `--dim`). */
  tone?: 'ink' | 'ink-2' | 'dim';
  /** Leading 14 px icon, e.g. `lock` on "Saved in Keychain on this Mac. Never shown again." */
  icon?: IconName;
  /** DOM id, e.g. a step title that labels the window body. */
  id?: string;
  /** Text, optionally with a Kbd ("Esc opens Aplos"). */
  children: ReactNode;
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
      /** Leading colour mark (accounts, calendars); several overlap as stacked dots, e.g. the "All accounts" row (errors.html reconnect). */
      swatch?: TagColor | readonly TagColor[];
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
  /** DOM id of the `menu` element, so its trigger's `aria-controls` can point at it (e.g. AccountSwitcher `menuId`). */
  id?: string;
  /** Whether the menu is shown (`reveal`). */
  open: boolean;
  /** Element the menu opens from (the trigger callback's element). */
  anchor: Anchor;
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
  /** Element it opens from (the trigger callback's element). */
  anchor: Anchor;
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
  /** The question, e.g. "Discard this draft?" */
  question: string;
  /** What will happen and whether it can be undone. */
  consequence: string;
  /** Confirm verb, e.g. "Discard". Never "OK" (DESIGN §10). */
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
  /** Tooltip second line, e.g. Done's "Mail you finished. Press H to move one back to Home." (DESIGN §7.4). */
  tooltip?: string;
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
  | 'tip'
  | 'info'
  | 'error';

/** A verb on a toast with its keycap, e.g. "Undo" Z, "Set a date" D. */
export interface ToastAction {
  /** Stable id passed back on select. */
  id: string;
  /** Verb. */
  label: string;
  /** Registry command whose keycap shows inside the toast. */
  commandId?: CommandId;
  /** Display-only: shows that command's keycap while selecting the action calls only `onAction(id)` and never runs the command. For a verb whose click runs its own callback (Undo Z, Remind R, Set a date D). `commandId` takes precedence if both are set. */
  keysFrom?: CommandId;
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
  /** Stays until dismissed (e.g. a pending op until it confirms). An `error` toast is not persistent: it lives 8 s, can be closed with ×, and the shell keeps what needs the owner somewhere calmer. */
  persistent?: boolean;
}

/** One opaque toast, `--paper`, `--elev-float`, radius 12, `ui` text, up to 440 px (DESIGN §6 Toast, §7.13). Mockups: toasts.html. Plain + refines: ui-foundation; used by ui-shell. */
export interface ToastProps extends ToastData {
  /** A verb was chosen. */
  onAction: (actionId: string) => void;
  /** Timed out or closed. */
  onDismiss: () => void;
}

/** Up to three toasts bottom-centre of the main pane, never under the dock; hover or focus pauses; polite, never steals focus (DESIGN §6 ToastStack, §7.13). Mockups: toasts.html, compose.html (send with no thread). Plain + refines: ui-foundation; used by ui-shell. */
export interface ToastStackProps {
  /** Newest last; the stack shows the last three and never silently replaces an Undo toast. */
  toasts: readonly ToastData[];
  /** The undo-send notice when no thread showing the message is visible (DESIGN §7.6 "one notice per send"): rendered as an UndoTray with placement 'toast' inside the stack, counted in the three and never replaced. ui-reader owns the send state; ui-shell passes it here. */
  undoSend?: Omit<UndoTrayProps, 'placement'>;
  /** A toast's verb was chosen. */
  onAction: (toastId: string, actionId: string) => void;
  /** A toast timed out or was closed. */
  onDismiss: (toastId: string) => void;
}
