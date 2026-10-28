// The CommandRegistry vocabulary (DESIGN §6 CommandRegistry, §8; plan 30 §4.2).
// Static descriptors (CommandSpec, ControlSpec) are declared once in catalog.ts;
// screens attach runtime handlers (CommandHandlers) to them through the registry.

export type CommandId = string;

/**
 * Key contexts, outer to inner. The shell collects the route's contexts plus
 * `data-keyctx` on the focused element's ancestors, and the registry normalizes
 * them with buildStack (stacks.ts), so the reader always sits on 'list'.
 * - global: every window surface (DESIGN §8 Global)
 * - list: Home, Later, All mail, Done, Drafts, Sent, Trash, Spam, search results
 * - home: Home only (adds arrow triage)
 * - oneByOne: "Go one by one", the reader stepping through Do now (adds arrow triage)
 * - done: the Done place (H, and E/L do nothing)
 * - reader: an open email (adds arrow triage, message keys)
 * - compose: inline reply or the compose page
 * - ask: the Ask dock
 * - calendar: the calendar page
 * - palette, menu, datePicker, dialog: focus-scoped modal transients (DESIGN §8 last row)
 * - lowImportance: the Low-importance sheet over Home, with → → to mark everything done
 *   (DESIGN §7.2); a modal transient like a dialog. Added because §8 has no row for it.
 * - onboarding: the separate setup window and first-sync screen (DESIGN §7.11, §7.12)
 * - settings: Settings; owns no keys yet, the key recorder bypasses the resolver
 */
export type ContextName =
  | 'global'
  | 'list'
  | 'home'
  | 'oneByOne'
  | 'done'
  | 'reader'
  | 'compose'
  | 'ask'
  | 'calendar'
  | 'palette'
  | 'menu'
  | 'datePicker'
  | 'dialog'
  | 'lowImportance'
  | 'onboarding'
  | 'settings';

export const CONTEXT_NAMES: readonly ContextName[] = [
  'global',
  'list',
  'home',
  'oneByOne',
  'done',
  'reader',
  'compose',
  'ask',
  'calendar',
  'palette',
  'menu',
  'datePicker',
  'dialog',
  'lowImportance',
  'onboarding',
  'settings',
];

/**
 * Outer to inner, e.g. ['global', 'list', 'reader']. The last entry wins.
 * Normalized shapes (buildStack): 'global' first (except onboarding, its own
 * window); home, done and reader sit on 'list'; oneByOne sits on 'list' and
 * 'reader'; modal transients come last.
 */
export type ContextStack = readonly ContextName[];

/**
 * A normalized chord. `key` is canonical: a lower-case letter, a digit, the
 * symbol itself ('?', '#', '/', '[', '.', ','), or a named key
 * ('Space', 'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowUp', ...).
 * `shift` is only meaningful for letters and named keys; a symbol already
 * encodes it ('?' is never shift+'/').
 */
export interface KeyChord {
  readonly key: string;
  readonly meta: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export type Phase = 'tap' | 'hold';

/** What has keyboard focus, as far as shortcuts care. */
export type FocusKind = 'none' | 'text' | 'control';

/**
 * Runtime conditions a command may require (`onlyWhen`). Two commands may
 * share a chord in one context only when they are told apart by these.
 */
export type Condition =
  | 'selection' // bulk selection is active
  | 'invite' // an unanswered calendar invite is open (Y / M / N answer it)
  | 'suggestion' // dim suggestion text is showing in compose
  | 'emptyBody' // the compose body is empty (hold Space dictates)
  | 'emptyField' // the palette field is empty (1–9 run results)
  | 'streaming' // Ask is answering
  | 'askText' // Ask's field has text
  | 'proposal' // an Ask proposal card has focus
  | 'queued' // Ask has a queued follow-up
  | 'remindOffer' // a "Remind me if no reply · R" toast is showing
  | 'welcome' // onboarding's Welcome step is showing (Esc skips setup)
  | 'firstSync'; // the first-sync screen is showing

export type ConditionState = Readonly<Partial<Record<Condition, boolean>>>;

/**
 * When several guarded bindings for one chord are live in one context, the
 * earlier condition wins (a focused proposal's Esc is "Not now" even while
 * Ask streams). Unguarded bindings come after all of these.
 */
export const CONDITION_PRIORITY: readonly Condition[] = [
  'proposal',
  'streaming',
  'queued',
  'askText',
  'suggestion',
  'emptyBody',
  'emptyField',
  'invite',
  'remindOffer',
  'selection',
  'welcome',
  'firstSync',
];

export type PaletteGroup = 'Suggested' | 'Actions' | 'Go to' | 'Ask' | 'Settings';

export const PALETTE_GROUPS: readonly PaletteGroup[] = ['Suggested', 'Actions', 'Go to', 'Ask', 'Settings'];

/**
 * Approved icon names (SF Symbols, DESIGN §4.7). A banned glyph cannot be
 * named here, so it cannot type-check in a spec.
 */
export type IconName =
  | 'checkmark'
  | 'checkmark.circle'
  | 'clock'
  | 'bookmark'
  | 'trash'
  | 'square.and.pencil'
  | 'text.bubble'
  | 'calendar'
  | 'arrowshape.turn.up.left'
  | 'arrowshape.turn.up.left.2'
  | 'arrowshape.turn.up.right'
  | 'magnifyingglass'
  | 'paperclip'
  | 'link'
  | 'cart'
  | 'phone'
  | 'doc'
  | 'gearshape'
  | 'house'
  | 'keyboard';

/**
 * A key as written in a spec: "e", "shift+r", "meta+k", "ctrl+1", "alt+ArrowDown",
 * "meta+alt+l", "?", "#", "Space", "Enter", "Escape". Modifiers are explicit
 * (meta, ctrl, alt, shift); there is no "mod".
 */
export type KeySpec =
  | string
  | {
      readonly chord: string;
      /** Defaults to the command's contexts. */
      readonly contexts?: readonly ContextName[];
      /** Defaults to 'tap'. */
      readonly phase?: Phase;
      /** The binding owns this key even inside the focused field (palette ↑/↓, ⌘Return Send). */
      readonly inTextField?: boolean;
      /** ← / → swap with the swipe-direction setting (DESIGN §8 Home and one by one). */
      readonly followsSwipe?: boolean;
    };

export interface UndoSpec {
  /** The confirmed toast text before "· Undo Z", e.g. "Moved to Later". */
  readonly label: string;
}

export interface ConfirmSpec {
  readonly destructive: boolean;
  readonly prompt: string;
  /** 'bulk' asks only when more than one item is selected. Defaults to 'always'. */
  readonly scope?: 'always' | 'bulk';
}

/** The static half of a command: declared once in catalog.ts. */
export interface CommandSpec {
  readonly id: CommandId;
  /** A plain phrase in DESIGN §10's voice; the palette, tooltips, menus and the sheet show it. */
  readonly label: string;
  readonly icon?: IconName;
  readonly keys: readonly KeySpec[];
  /** Where the palette offers it; also the default contexts of its keys. */
  readonly contexts: readonly ContextName[];
  readonly group: PaletteGroup;
  /** Extra words the palette matches on ("archive" for Done). */
  readonly keywords?: readonly string[];
  readonly onlyWhen?: Condition;
  /** For a hold command: the tap it upgrades (mail.dictateReply upgrades mail.reply). */
  readonly holdFor?: CommandId;
  /** Auto-repeat keydowns run it again (movement only). */
  readonly repeat?: boolean;
  readonly undo?: UndoSpec;
  readonly confirm?: ConfirmSpec;
  /** Every command is palette-reachable (DESIGN §7.9 acceptance). */
  readonly paletteHidden?: never;
}

/**
 * Keys that operate a focus-scoped widget itself (the palette's ↑/↓, a menu's
 * 1–9, a dialog's Return, onboarding's Return/Esc). They are declared, checked
 * for conflicts, resolved and listed in the sheet like commands, but they are
 * not palette commands, because they act on the palette or a window without one.
 */
export interface ControlSpec {
  readonly id: CommandId;
  readonly label: string;
  readonly keys: readonly KeySpec[];
  readonly contexts: readonly ContextName[];
  readonly onlyWhen?: Condition;
  readonly repeat?: boolean;
}

/** One flattened binding: one chord in one context. */
export interface Binding {
  readonly commandId: CommandId;
  readonly chord: KeyChord;
  readonly context: ContextName;
  readonly phase: Phase;
  readonly inTextField: boolean;
  readonly repeat: boolean;
  /** The owner's `onlyWhen`; a guarded binding may share the chord with an unguarded one. */
  readonly onlyWhen?: Condition;
  /** The owner's `holdFor`. */
  readonly holdFor?: CommandId;
  readonly followsSwipe: boolean;
}

/**
 * One remapped key. Only the chord and phase are the owner's to choose; contexts,
 * the text-field rule and the swipe swap always come from the catalog.
 */
export type KeymapEntry = string | { readonly chord: string; readonly phase?: Phase };

/** Remapped keys, by command id. A command listed here loses all its default keys. */
export type Keymap = Readonly<Record<CommandId, readonly KeymapEntry[]>>;

export interface KeyPrefs {
  /** WCAG 2.1.4: unmodified character keys can be switched off. */
  readonly singleKeyShortcuts: boolean;
  /** One threshold for every hold key (plan 30 decision 7). */
  readonly holdThresholdMs: number;
  /** The swipe-direction setting: → Later and ← Done when true. */
  readonly swapTriageArrows: boolean;
  readonly keymap: Keymap;
}

export const DEFAULT_KEY_PREFS: KeyPrefs = {
  singleKeyShortcuts: true,
  holdThresholdMs: 250,
  swapTriageArrows: false,
  keymap: {},
};

/** What the palette's context line names, e.g. { title: 'Drew Bell', detail: 'October illustrations' }. */
export interface TargetSummary {
  readonly title: string;
  readonly detail?: string;
}

export interface CommandContext {
  readonly stack: ContextStack;
  readonly target: TargetSummary | null;
  /** Ids of bulk-selected items; empty when nothing is selected. */
  readonly selection: readonly string[];
  readonly conditions: ConditionState;
  readonly prefs: KeyPrefs;
  readonly focus: FocusKind;
  /** The chord that ran the command, when a key ran it (menus read the digit). */
  readonly trigger?: { readonly chord: KeyChord; readonly phase: Phase };
}

/** The runtime half, attached by the screen that owns the command. */
export interface CommandHandlers {
  when?(ctx: CommandContext): boolean;
  run(ctx: CommandContext): void | Promise<void>;
  /** A label for this moment, e.g. "View invoice" for the suggested action. */
  labelFor?(ctx: CommandContext): string | undefined;
}

export type Command = CommandSpec & CommandHandlers;

/** The subset of KeyboardEvent the key logic reads. A real KeyboardEvent satisfies it. */
export interface KeyInput {
  readonly key: string;
  readonly code?: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  readonly repeat?: boolean;
}

/**
 * What the shell does with an answer (null: let the key through untouched).
 * - Before resolving, ask the HoldTracker: while a hold is armed,
 *   `tracker.swallows(event)` is true for the armed key's auto-repeats; prevent
 *   them, so a held R or A never types "rrr" into the field the tap focused.
 * - phase 'tap': run `commandId` now and prevent the default. If `holdCommandId`
 *   is set, also `tracker.down(event, holdCommandId, at)`; a hold upgrades the tap
 *   (R opens the reply, the hold dictates into it).
 * - phase 'hold': nothing runs now and the keydown goes through, so in a field it
 *   types one character. Arm with `tracker.down(event, commandId, at, { typed })`.
 *   If the hold completes, the upgrade says `removeTyped`: delete that one
 *   character, then run `commandId` (hold A in Ask's field, hold Space in an
 *   empty body, which must stay empty).
 */
export interface Resolution {
  readonly commandId: CommandId;
  readonly phase: Phase;
  readonly holdCommandId?: CommandId;
  readonly context: ContextName;
  readonly chord: KeyChord;
}
