// The CommandRegistry vocabulary (DESIGN §6 CommandRegistry, §8; plan 30 §4.2).
// Static descriptors (CommandSpec, ControlSpec) are declared once in catalog.ts;
// screens attach runtime handlers (CommandHandlers) to them through the registry.

import type { HoldRelease } from './hold';

export type CommandId = string;

/**
 * Key contexts, outer to inner. The shell collects the route's contexts plus
 * `data-keyctx` on the focused element's ancestors, and the registry normalizes
 * them with buildStack (stacks.ts), so the reader always sits on 'list'.
 * - global: every window surface (DESIGN §8 Global)
 * - search: the Search page (DESIGN §7.9); its results list sits inside it as 'list'
 * - list: Home, Later, All mail, Done, Drafts, Sent, Trash, Spam, search results
 * - home: Home only (adds arrow triage)
 * - oneByOne: "Go one by one", the reader stepping through Do now (adds arrow triage)
 * - done: the Done place (H, and E/L do nothing)
 * - reader: an open email (adds arrow triage, message keys)
 * - compose: inline reply or the compose page
 * - ask: the Ask dock
 * - calendar: the calendar page
 * - palette, menu, datePicker, dialog: focus-scoped modal transients (DESIGN §8 last row)
 * - sheet: the reconnect or consent sheet the shell hosts (shell/index.ts openSheet); a
 *   modal transient, so its Esc cancels and nothing behind it answers
 * - lowImportance: the Low-importance sheet over Home, with → to mark the row done (hold → for all)
 *   (DESIGN §7.2); a modal transient like a dialog. Added because §8 has no row for it.
 * - onboarding: the separate setup window (DESIGN §7.11); it has no 'global'
 * - firstSync: the first-sync screen, the onboarding window's last step (DESIGN §7.12);
 *   sits on 'onboarding' and owns Esc in every state ("Esc opens Aplos", [F8])
 * - drill: "Try the keys while you wait", a mode of the first-sync screen; sits on
 *   'firstSync' so Esc still opens Aplos. Its letters drive practice letters only: the
 *   onboarding window has no 'global' or 'list', so a triage key never reaches real mail
 * - settings: Settings; owns no keys yet, the key recorder bypasses the resolver
 */
export type ContextName =
  | 'global'
  | 'search'
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
  | 'sheet'
  | 'lowImportance'
  | 'onboarding'
  | 'firstSync'
  | 'drill'
  | 'settings';

/** Every context, outer to inner (a shadow report names the outer one first). */
export const CONTEXT_NAMES: readonly ContextName[] = [
  'global',
  'search',
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
  'sheet',
  'lowImportance',
  'onboarding',
  'firstSync',
  'drill',
  'settings',
];

/**
 * Outer to inner, e.g. ['global', 'list', 'reader']. The last entry wins.
 * Normalized shapes (buildStack): 'global' first (except the onboarding window:
 * onboarding, firstSync, drill); home, done and reader sit on 'list'; oneByOne
 * sits on 'list' and 'reader'; firstSync sits on 'onboarding' and drill on
 * 'firstSync'; modal transients come last.
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
  | 'welcome'; // onboarding's Welcome step is showing (Esc skips setup); the first-sync screen is the 'firstSync' context

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
];

/**
 * The palette's sections, in order (DESIGN §7.9). 'Suggested' is filled on first
 * open from commands marked `suggested` (spec or handler); the others come from
 * each command's own `group`.
 */
export type PaletteGroup = 'Suggested' | 'Actions' | 'Go to' | 'Ask' | 'Settings';

export const PALETTE_GROUPS: readonly PaletteGroup[] = [
  'Suggested',
  'Actions',
  'Go to',
  'Ask',
  'Settings',
];

/** The group a command is filed under while typing; 'Suggested' is a first-open section, never a command's own group. */
export type CommandGroup = Exclude<PaletteGroup, 'Suggested'>;

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
  | 'arrow.right'
  | 'magnifyingglass'
  | 'paperclip'
  | 'link'
  | 'cart'
  | 'phone'
  | 'doc'
  | 'gearshape'
  | 'house'
  | 'tray'
  | 'paperplane'
  | 'shield'
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
      /** A second way to press the command that works but is never named in tooltips, toasts or the palette (⌘Z beside Z). */
      readonly quiet?: boolean;
    };

export interface UndoSpec {
  /** The confirmed toast text before "· Undo Z", e.g. "Moved to Later". */
  readonly label: string;
}

/**
 * The two-row confirmation (DESIGN §6 Confirm, §7.9): a title, the prompt under it,
 * then "Cancel · Return" (the default) and "<confirmLabel> · ⇧Return".
 */
export interface ConfirmSpec {
  /** Stamp ink on the confirm row; Return cancels (DESIGN §7.9). */
  readonly destructive: boolean;
  /** The question, e.g. "Discard this draft?". */
  readonly title: string;
  /** One sentence under the title; a handler's `promptFor(ctx)` may name the target instead. */
  readonly prompt: string;
  /** The confirm row's verb, e.g. "Discard"; never "OK" (DESIGN §10). */
  readonly confirmLabel: string;
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
  /** The palette group it is listed under while typing. */
  readonly group: CommandGroup;
  /** Extra words the palette matches on ("archive" for Done). */
  readonly keywords?: readonly string[];
  /** Listed under "Suggested" on the palette's first open; a handler's `suggested(ctx)` overrides it. */
  readonly suggested?: boolean;
  /**
   * `false` keeps a pure movement command (J/K rows, ↑/↓ messages) out of the palette;
   * it stays in the sheet. Allowed only with `repeat: true`, so every action stays
   * palette-reachable (DESIGN §7.9 acceptance). Defaults to listed.
   */
  readonly palette?: false;
  /** Choosing it opens a nested palette page (its handler's `children`); the label ends with "…". */
  readonly page?: true;
  readonly onlyWhen?: Condition;
  /** Listed in the palette only while this condition holds (the key still works without it); for actions whose label is wrong otherwise. */
  readonly paletteWhen?: Condition;
  /** For a hold command: the tap it upgrades (mail.dictateReply upgrades mail.reply). */
  readonly holdFor?: CommandId;
  /** Auto-repeat keydowns run it again (movement only). */
  readonly repeat?: boolean;
  readonly undo?: UndoSpec;
  readonly confirm?: ConfirmSpec;
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
  /** Works, but key hints leave it out (see `KeySpec.quiet`). */
  readonly quiet?: boolean;
}

/**
 * One remapped key (stored as F1's `KeyBinding {chord, phase?}`; a bare chord string
 * is also read). Only the chord and phase are the owner's to choose. A chord and
 * phase equal to one of the command's default keys keeps that default as it is
 * (contexts, text-field rule, swipe swap); any other chord gets the command's
 * contexts, and never follows the swipe direction.
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

/**
 * What a command target is (DESIGN §7.9 context line): a plan found in mail and
 * focused on the calendar is a 'plan' (its id is a plan id, not an event id); a
 * 'calendar' is one calendar in the sidebar; a 'provider' is a Settings → AI row.
 */
export type TargetKind =
  | 'thread'
  | 'event'
  | 'plan'
  | 'calendar'
  | 'account'
  | 'draft'
  | 'setting'
  | 'provider'
  | 'conversation';

/**
 * The focused screen's target, set through the shell's `useCommandTarget` and read
 * by `when`, `run` and the palette's context line ("For: Drew Bell · October
 * illustrations"). The line's label is `title`, then " · detail" when present.
 */
export interface TargetSummary {
  /** What it is. */
  readonly kind: TargetKind;
  /** Its id: a thread, event, plan, calendar, account, draft, setting entry, provider or conversation id. */
  readonly id: string;
  /** The label's first part: a sender's display name, an event title, an address. */
  readonly title: string;
  /** The label's second part: a subject, a time, a section. */
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

/**
 * One row on a nested palette page ("Move to label…" lists each label; "Later
 * until…" lists the presets and "Pick a date…"). The palette shows the trail of
 * page titles as breadcrumbs, and Esc goes up one page (DESIGN §7.9).
 */
export interface PaletteChild {
  /** Unique within its page. */
  readonly id: string;
  /** A plain phrase in DESIGN §10's voice. */
  readonly label: string;
  readonly icon?: IconName;
  /** Extra words to match on. */
  readonly keywords?: readonly string[];
  /** Dim text on the right, e.g. a label's account or a preset's resolved time. */
  readonly detail?: string;
  /** Ask first with the two-row Confirm (a destructive pick on "Remove account…"); `runChild` returns status 'confirm' until run with `{confirmed: true}`. */
  readonly confirm?: ConfirmSpec;
  /** Runs the row; ignored when `children` is set. */
  run?(ctx: CommandContext): void | Promise<void>;
  /** A further page under this row; its breadcrumb is this row's label. */
  children?(ctx: CommandContext): readonly PaletteChild[];
}

/** The runtime half, attached by the screen that owns the command. */
export interface CommandHandlers {
  when?(ctx: CommandContext): boolean;
  run(ctx: CommandContext): void | Promise<void>;
  /** A label for this moment, e.g. "View invoice" for the suggested action. */
  labelFor?(ctx: CommandContext): string | undefined;
  /** Whether it belongs under "Suggested" right now (Reply, Done, Later, Ask about this email); overrides the spec's `suggested`. */
  suggested?(ctx: CommandContext): boolean;
  /** For a `page` command: the rows of its nested page. When set, choosing the command opens the page and `run` is not called. */
  children?(ctx: CommandContext): readonly PaletteChild[];
  /** The confirm prompt for this target ("“Invoice #0412” will be removed from your account."); falls back to the spec's prompt. */
  promptFor?(ctx: CommandContext): string | undefined;
  /**
   * For a hold command (the one the HoldTracker upgrades to): the key came up, or the hold ended (another key, Esc, blur).
   * The shell passes every HoldRelease the tracker returns to `registry.release`, so a dictation handler learns when to
   * stop and whether to keep what it heard. Keep it only when `release.upgraded && release.ended === 'up'` (the key came
   * up: "Release R to keep"); discard it for 'cancel' (Esc, blur, hide), 'interrupt' and 'down' ("Esc to cancel"). Do not
   * use `release.phase`: it is by duration alone. Called for every release of that command once a handler is attached,
   * taps included, so check `upgraded` before treating it as a running hold.
   */
  release?(ctx: CommandContext, release: HoldRelease): void | Promise<void>;
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
