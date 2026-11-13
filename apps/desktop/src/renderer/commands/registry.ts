// The CommandRegistry (DESIGN §6; plan 30 §4.2): one table that feeds the key
// handler, the palette, menus, tooltips, the shortcut sheet and toast keycaps.
import { copyProblem } from './copy';
import {
  chordId,
  formatAlternatives,
  formatChord,
  isCharacterChord,
  isTextEditingChord,
  parseChord,
  reservedReason,
} from './keys';
import { resolve } from './resolver';
import {
  SETTING_ID_PREFIX,
  SETTING_SECTIONS,
  settingRoute,
  type SettingEntry,
  type SettingRoute,
  type SettingsTable,
} from './settings';
import { buildStack, canShareStack, isModal } from './stacks';
import type { HoldRelease } from './hold';
import {
  CONTEXT_NAMES,
  DEFAULT_KEY_PREFS,
  PALETTE_GROUPS,
  type Binding,
  type CommandContext,
  type CommandGroup,
  type CommandHandlers,
  type CommandId,
  type CommandSpec,
  type Condition,
  type ContextName,
  type ControlSpec,
  type IconName,
  type KeyChord,
  type KeyInput,
  type KeyPrefs,
  type KeySpec,
  type Keymap,
  type KeymapEntry,
  type PaletteChild,
  type Resolution,
  type TargetSummary,
} from './types';

export type RegistryEntry =
  | { readonly kind: 'command'; readonly spec: CommandSpec; readonly handlers?: CommandHandlers }
  | { readonly kind: 'control'; readonly spec: ControlSpec; readonly handlers?: CommandHandlers };

export interface BindingConflict {
  /** One context for a clash; two for shadowing (the outer, then the inner). */
  readonly contexts: readonly ContextName[];
  /** Display form, e.g. "S". */
  readonly keys: string;
  readonly commandIds: readonly CommandId[];
}

export interface KeymapIssue {
  readonly commandId: CommandId;
  /**
   * unknownCommand / invalidEntry / invalidChord: the remap cannot be read.
   * reserved: the chord edits text (⌘C, ⌘V, ⌘A…). conflict: another command has
   * the chord in the same context. shadowed: a context that sits inside or around
   * this one has the chord, so one of the two could never be reached by key.
   * dropsDefault: a warning, not a refusal; the remap applies but leaves out a default
   * key that only some contexts have or that follows the swipe direction (→ Done on
   * Home), so Settings can say so. List that chord in the remap to keep it as it was.
   */
  readonly reason:
    | 'unknownCommand'
    | 'invalidEntry'
    | 'invalidChord'
    | 'reserved'
    | 'conflict'
    | 'shadowed'
    | 'dropsDefault';
  readonly detail: string;
  /** For 'conflict' and 'shadowed': the other commands that have the chord, for "Already used by Later". */
  readonly with?: readonly CommandId[];
}

export interface PaletteEntry {
  /** A command id, or a setting entry id ("setting.mail.undoSeconds"). */
  readonly id: CommandId;
  readonly label: string;
  readonly icon?: IconName;
  /** The group it is listed under while typing. */
  readonly group: CommandGroup;
  /** Listed under "Suggested" on first open (DESIGN §7.9). */
  readonly suggested: boolean;
  /** Keycaps from the registry, alternatives joined with "or"; '' when the command has no key. */
  readonly keys: string;
  readonly keywords: readonly string[];
  readonly destructive: boolean;
  /** Choosing it opens a nested page (run returns status 'page'); the row shows a chevron. */
  readonly page: boolean;
  /** For a setting entry: its deep link; run returns status 'navigate'. */
  readonly route?: SettingRoute;
  /** Dim text on the right, e.g. a setting's section ("Mail"). */
  readonly detail?: string;
}

export type RunResult =
  /** `done` settles with the handler; a failure is also reported to onError. */
  | { readonly status: 'ran'; readonly done: Promise<void> }
  /** The handler threw synchronously; already reported to onError. */
  | { readonly status: 'failed'; readonly error: unknown }
  | { readonly status: 'unknown' | 'unhandled' | 'disabled' }
  /** Show the two-row Confirm; run again with `{confirmed: true}` on ⇧Return. */
  | {
      readonly status: 'confirm';
      readonly title: string;
      readonly prompt: string;
      readonly confirmLabel: string;
      readonly destructive: boolean;
    }
  /** Open a nested palette page: push `title` on the breadcrumb trail and list `items` (run one with runChild). */
  | { readonly status: 'page'; readonly title: string; readonly items: readonly PaletteChild[] }
  /** A setting entry: the shell opens this route and Settings focuses the row. */
  | { readonly status: 'navigate'; readonly route: SettingRoute };

/** A failed command, or a runtime label that breaks DESIGN §10 (the spec label is shown instead). */
export type RegistryErrorHandler = (error: unknown, commandId: CommandId) => void;

export interface RegistryOptions {
  readonly controls?: readonly ControlSpec[];
  /** Commands that are off while a context is on the stack (see DISABLED_IN). */
  readonly disabledIn?: Readonly<Partial<Record<ContextName, readonly CommandId[]>>>;
  readonly prefs?: KeyPrefs;
  /** Where failures go so the toast or inline Retry can show them (DESIGN §5 rule 11). Defaults to console.error. */
  readonly onError?: RegistryErrorHandler;
  /** Settings rows listed in the palette's Settings group; read at call time, so later registrations show. */
  readonly settings?: SettingsTable;
}

export interface Registry {
  /**
   * Attaches a screen's handlers. Attachments stack per command: the newest is
   * active, and detaching it makes the previous one active again (the reader's
   * Done over a list that stays mounted). Returns the detach function.
   */
  attach(id: CommandId, handlers: CommandHandlers): () => void;
  get(id: CommandId): RegistryEntry | undefined;
  /** Palette commands, in catalog order. */
  list(): readonly CommandSpec[];
  controls(): readonly ControlSpec[];
  /** The effective bindings after remapping and the swipe-direction swap. */
  bindings(): readonly Binding[];
  bindingsFor(context: ContextName): readonly Binding[];
  /** One command's bindings, optionally only those active in a context stack. */
  keysFor(id: CommandId, stack?: readonly ContextName[]): readonly Binding[];
  /** For tooltips and toasts: "E", "J or ↓", "Hold R"; '' when unbound. */
  describeKeys(id: CommandId, stack?: readonly ContextName[]): string;
  isEnabled(id: CommandId, ctx: CommandContext): boolean;
  /**
   * The palette's entries for the stack under it, grouped in PALETTE_GROUPS order:
   * commands (not `palette: false`), then the registered Settings rows in the
   * Settings group. On first open the palette shows the `suggested` entries under
   * "Suggested", then Go to; typing filters everything by label and keywords.
   */
  commandsForPalette(ctx: CommandContext): readonly PaletteEntry[];
  /**
   * Tells a hold command's handler that its key came up or the hold ended: pass what `tracker.up`, `tracker.cancel`,
   * `tracker.interrupt` or `tracker.down` returned (null is ignored). Calls the active `release` handler of
   * `release.commandId`; a throw or rejection goes to onError under that id.
   */
  release(release: HoldRelease | null, ctx: CommandContext): RunResult;
  /** Resolves a keydown against ctx.stack, normalized with buildStack. */
  resolve(event: KeyInput, ctx: CommandContext): Resolution | null;
  /**
   * Runs a command, asking for confirmation first when its spec says so. A command
   * whose handler has `children` returns its nested page; a setting entry id
   * returns its route.
   */
  run(id: CommandId, ctx: CommandContext, options?: { readonly confirmed?: boolean }): RunResult;
  /**
   * Runs a row of a nested page: its own page when it has `children`, else its `run`,
   * asking first when the row has `confirm` (run again with `{confirmed: true}` on
   * ⇧Return). Failures go to onError under the row's id.
   */
  runChild(
    child: PaletteChild,
    ctx: CommandContext,
    options?: { readonly confirmed?: boolean },
  ): RunResult;
  /** The registered Settings rows. */
  settings(): readonly SettingEntry[];
  /** Applies new prefs (keymap, swipe direction). Rejected remaps keep their defaults and are reported; a 'dropsDefault' issue is a warning about a remap that applied. */
  configure(prefs: KeyPrefs): readonly KeymapIssue[];
  readonly keymapIssues: readonly KeymapIssue[];
  /** Ids with no attached handler (a sheet key with no handler). */
  missingHandlers(): readonly CommandId[];
}

interface Owner {
  readonly id: CommandId;
  readonly contexts: readonly ContextName[];
  readonly onlyWhen?: Condition;
  readonly holdFor?: CommandId;
  readonly repeat: boolean;
}

interface Slot {
  readonly handlers: CommandHandlers;
}

function assertContexts(id: CommandId, contexts: readonly ContextName[]): void {
  for (const c of contexts) {
    if (!CONTEXT_NAMES.includes(c)) throw new Error(`${id}: unknown context "${c}"`);
  }
}

function parseFor(id: CommandId, text: string): KeyChord {
  try {
    return parseChord(text);
  } catch (error) {
    throw new Error(`${id}: ${(error as Error).message}`);
  }
}

function makeBinding(
  owner: Owner,
  chord: KeyChord,
  context: ContextName,
  rest: Pick<Binding, 'phase' | 'inTextField' | 'followsSwipe' | 'quiet'>,
): Binding {
  const binding: Binding = { commandId: owner.id, chord, context, repeat: owner.repeat, ...rest };
  return {
    ...binding,
    ...(owner.onlyWhen ? { onlyWhen: owner.onlyWhen } : {}),
    ...(owner.holdFor && rest.phase === 'hold' ? { holdFor: owner.holdFor } : {}),
  };
}

/** Expands one command's catalog key specs into flat bindings. Throws on a bad chord string. */
export function expandKeys(owner: Owner, keys: readonly KeySpec[]): Binding[] {
  const out: Binding[] = [];
  for (const spec of keys) {
    const entry = typeof spec === 'string' ? { chord: spec } : spec;
    const contexts = entry.contexts ?? owner.contexts;
    assertContexts(owner.id, contexts);
    const chord = parseFor(owner.id, entry.chord);
    for (const context of contexts) {
      out.push(
        makeBinding(owner, chord, context, {
          phase: entry.phase ?? 'tap',
          inTextField: entry.inTextField ?? false,
          followsSwipe: entry.followsSwipe ?? false,
          ...(entry.quiet ? { quiet: true } : {}),
        }),
      );
    }
  }
  return out;
}

/** Thrown for a keymap entry the registry refuses; `reason` becomes the issue's reason. */
class KeymapRefusal extends Error {
  readonly reason: KeymapIssue['reason'];

  constructor(reason: KeymapIssue['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}

function readEntry(id: CommandId, entry: KeymapEntry): { chord: string; phase: 'tap' | 'hold' } {
  if (typeof entry === 'string') return { chord: entry, phase: 'tap' };
  if (!entry || typeof entry !== 'object' || typeof entry.chord !== 'string') {
    throw new KeymapRefusal('invalidEntry', `${id}: a remap is a chord string or { chord, phase }`);
  }
  const extra = Object.keys(entry).filter(k => k !== 'chord' && k !== 'phase');
  if (extra.length > 0) {
    throw new KeymapRefusal(
      'invalidEntry',
      `${id}: a remap may set only chord and phase, not ${extra.join(', ')}`,
    );
  }
  const phase = entry.phase ?? 'tap';
  if (phase !== 'tap' && phase !== 'hold')
    throw new KeymapRefusal('invalidEntry', `${id}: unknown phase "${String(phase)}"`);
  return { chord: entry.chord, phase };
}

/** Groups a command's bindings by phase and chord: one default key, with all its contexts. */
function byKey(bindings: readonly Binding[]): Map<string, Binding[]> {
  const out = new Map<string, Binding[]>();
  for (const b of bindings) {
    const key = `${b.phase}|${chordId(b.chord)}`;
    out.set(key, [...(out.get(key) ?? []), b]);
  }
  return out;
}

/**
 * Expands a user remap. A chord and phase equal to one of the command's own
 * default keys keeps that default exactly (its contexts, text-field rule and
 * swipe swap), so listing ArrowRight for Done keeps → on Home, one by one and the
 * reader. Any other chord gets the command's contexts; the text-field rule is
 * inherited from the command's default keys in that context, except for chords
 * that type (single keys, outside focused widgets) or edit text.
 */
export function expandKeymapEntries(
  owner: Owner,
  entries: readonly KeymapEntry[],
  defaults: readonly Binding[],
): Binding[] {
  const out: Binding[] = [];
  const defaultKeys = byKey(defaults);
  for (const raw of entries) {
    const entry = readEntry(owner.id, raw);
    let chord: KeyChord;
    try {
      chord = parseFor(owner.id, entry.chord);
    } catch (error) {
      throw new KeymapRefusal('invalidChord', (error as Error).message);
    }
    const kept = defaultKeys.get(`${entry.phase}|${chordId(chord)}`);
    if (kept) {
      out.push(...kept.filter(k => !out.includes(k)));
      continue;
    }
    const ownDefault = defaults.some(d => chordId(d.chord) === chordId(chord));
    const reserved = reservedReason(chord);
    if (reserved && !ownDefault) {
      const why =
        reserved === 'text'
          ? 'edits text'
          : reserved === 'system'
            ? 'belongs to macOS'
            : 'moves focus between regions';
      throw new KeymapRefusal(
        'reserved',
        `${formatChord(chord)} ${why}, so it can’t run ${owner.id}`,
      );
    }
    for (const context of owner.contexts) {
      const fieldOwner = defaults.some(d => d.inTextField && d.context === context);
      const types = isCharacterChord(chord) && !isModal(context);
      out.push(
        makeBinding(owner, chord, context, {
          phase: entry.phase,
          inTextField: fieldOwner && !types && !isTextEditingChord(chord),
          followsSwipe: false,
        }),
      );
    }
  }
  return out;
}

/**
 * The default keys a remap leaves out that only some of the command's contexts
 * have, or that follow the swipe direction: dropping them is easy to miss.
 */
function droppedScopedDefaults(
  owner: Owner,
  defaults: readonly Binding[],
  remapped: readonly Binding[],
): Binding[][] {
  const kept = byKey(remapped);
  const all = [...owner.contexts].sort().join(',');
  const out: Binding[][] = [];
  for (const [key, group] of byKey(defaults)) {
    if (kept.has(key)) continue;
    const contexts = group
      .map(b => b.context)
      .sort()
      .join(',');
    if (contexts !== all || group.some(b => b.followsSwipe)) out.push(group);
  }
  return out;
}

function bindingSignature(bindings: readonly Binding[]): string {
  return bindings
    .map(b => `${b.context}|${b.phase}|${chordId(b.chord)}`)
    .sort()
    .join(',');
}

function keyText(b: Binding): string {
  return `${b.phase === 'hold' ? 'Hold ' : ''}${formatChord(b.chord)}`;
}

/**
 * Two bindings conflict when they share a chord, a phase and a context, unless
 * they are told apart by distinct `onlyWhen` conditions with at most one unguarded.
 */
export function findConflicts(bindings: readonly Binding[]): BindingConflict[] {
  const groups = new Map<string, Binding[]>();
  for (const b of bindings) {
    const key = `${b.context}|${b.phase}|${chordId(b.chord)}`;
    const group = groups.get(key) ?? [];
    if (!group.some(g => g.commandId === b.commandId)) group.push(b);
    groups.set(key, group);
  }
  const conflicts: BindingConflict[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const named = group.map(b => b.onlyWhen).filter((g): g is Condition => g !== undefined);
    const unguarded = group.length - named.length;
    const repeatedGuard = new Set(named).size !== named.length;
    if (unguarded > 1 || repeatedGuard) {
      conflicts.push({
        contexts: [group[0].context],
        keys: keyText(group[0]),
        commandIds: group.map(b => b.commandId),
      });
    }
  }
  return conflicts;
}

/**
 * Pairs where one context's binding hides another's because the two contexts
 * can share a stack (nav.search on J in global, under list.down on J in list).
 * Only pairs touching `isRemapped` count: the catalog's own overrides are by design.
 */
export function findShadows(
  bindings: readonly Binding[],
  isRemapped: (id: CommandId) => boolean,
): BindingConflict[] {
  const byChord = new Map<string, Binding[]>();
  for (const b of bindings) {
    const key = chordId(b.chord);
    byChord.set(key, [...(byChord.get(key) ?? []), b]);
  }
  const out: BindingConflict[] = [];
  const seen = new Set<string>();
  for (const group of byChord.values()) {
    for (const a of group) {
      for (const b of group) {
        if (a.commandId === b.commandId || !canShareStack(a.context, b.context)) continue;
        if (!isRemapped(a.commandId) && !isRemapped(b.commandId)) continue;
        const [outer, inner] =
          CONTEXT_NAMES.indexOf(a.context) < CONTEXT_NAMES.indexOf(b.context) ? [a, b] : [b, a];
        const key = `${outer.commandId}@${outer.context}|${inner.commandId}@${inner.context}|${chordId(a.chord)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          contexts: [outer.context, inner.context],
          keys: keyText(a),
          commandIds: [outer.commandId, inner.commandId],
        });
      }
    }
  }
  return out;
}

function describeConflicts(conflicts: readonly BindingConflict[]): string {
  return conflicts
    .map(c => `${c.keys} in ${c.contexts.join(' and ')}: ${c.commandIds.join(', ')}`)
    .join('; ');
}

function swapArrows(bindings: readonly Binding[]): Binding[] {
  return bindings.map(b => {
    if (!b.followsSwipe) return b;
    if (b.chord.key === 'ArrowLeft') return { ...b, chord: { ...b.chord, key: 'ArrowRight' } };
    if (b.chord.key === 'ArrowRight') return { ...b, chord: { ...b.chord, key: 'ArrowLeft' } };
    return b;
  });
}

/** "For: Drew Bell · October illustrations", or "For: 3 selected". */
export function contextLine(target: TargetSummary | null, selectionCount = 0): string {
  if (selectionCount > 1) return `For: ${selectionCount} selected`;
  if (!target) return '';
  return target.detail ? `For: ${target.title} · ${target.detail}` : `For: ${target.title}`;
}

/** The error's `name` (or its wire `type`): enough to see what failed, nothing a message could carry (it may hold mail text). */
function errorKind(error: unknown): string {
  if (error instanceof Error) return error.name;
  const type = (error as { type?: unknown } | null)?.type;
  return typeof type === 'string' ? type : typeof error;
}

function defaultOnError(error: unknown, commandId: CommandId): void {
  console.error(`Command ${commandId} failed (${errorKind(error)})`);
}

type SpecEntry = { kind: 'command'; spec: CommandSpec } | { kind: 'control'; spec: ControlSpec };

/** Validates the specs and `disabledIn`, and returns every spec by id in declaration order. */
function buildSpecTable(
  commands: readonly CommandSpec[],
  controls: readonly ControlSpec[],
  disabledIn: NonNullable<RegistryOptions['disabledIn']>,
): Map<CommandId, SpecEntry> {
  const specs = new Map<CommandId, SpecEntry>();
  for (const spec of commands) {
    if (specs.has(spec.id)) throw new Error(`Duplicate command id ${spec.id}`);
    assertContexts(spec.id, spec.contexts);
    if (spec.palette === false && !spec.repeat)
      throw new Error(`${spec.id}: only movement (repeat) commands may leave the palette`);
    if (spec.page && !spec.label.endsWith('…'))
      throw new Error(`${spec.id}: a command that opens a page ends its label with "…"`);
    specs.set(spec.id, { kind: 'command', spec });
  }
  for (const spec of controls) {
    if (specs.has(spec.id)) throw new Error(`Duplicate command id ${spec.id}`);
    assertContexts(spec.id, spec.contexts);
    specs.set(spec.id, { kind: 'control', spec });
  }
  for (const id of specs.keys()) {
    if (id.startsWith(SETTING_ID_PREFIX))
      throw new Error(`${id}: "${SETTING_ID_PREFIX}" ids belong to setting entries`);
  }
  for (const [context, ids] of Object.entries(disabledIn)) {
    assertContexts('disabledIn', [context as ContextName]);
    for (const id of ids ?? [])
      if (!specs.has(id)) throw new Error(`disabledIn.${context}: no command ${id}`);
  }
  for (const { spec } of specs.values()) {
    const holdFor = 'holdFor' in spec ? spec.holdFor : undefined;
    if (holdFor && !specs.has(holdFor))
      throw new Error(`${spec.id}: holdFor names no command ${holdFor}`);
  }
  return specs;
}

export function createRegistry(
  commands: readonly CommandSpec[],
  options: RegistryOptions = {},
): Registry {
  const controls = options.controls ?? [];
  const onError = options.onError ?? defaultOnError;
  const settingsTable = options.settings;
  const disabledIn = options.disabledIn ?? {};
  const specs = buildSpecTable(commands, controls, disabledIn);
  const order = [...specs.keys()];
  const slots = new Map<CommandId, Slot[]>();

  function ownerOf(id: CommandId): Owner {
    const spec = specs.get(id)!.spec;
    return {
      id,
      contexts: spec.contexts,
      onlyWhen: spec.onlyWhen,
      holdFor: 'holdFor' in spec ? spec.holdFor : undefined,
      repeat: spec.repeat ?? false,
    };
  }

  function activeHandlers(id: CommandId): CommandHandlers | undefined {
    const stack = slots.get(id);
    return stack?.[stack.length - 1]?.handlers;
  }

  const defaults = new Map<CommandId, Binding[]>();
  for (const id of order) defaults.set(id, expandKeys(ownerOf(id), specs.get(id)!.spec.keys));

  const initialConflicts = findConflicts([...defaults.values()].flat());
  if (initialConflicts.length > 0) {
    throw new Error(`Duplicate key bindings: ${describeConflicts(initialConflicts)}`);
  }

  let effective: Binding[] = [];
  let issues: KeymapIssue[] = [];

  function applyKeymap(keymap: Keymap): { bindings: Binding[]; issues: KeymapIssue[] } {
    const found: KeymapIssue[] = [];
    const overrides = new Map<CommandId, Binding[]>();
    for (const [id, entries] of Object.entries(keymap)) {
      if (!specs.has(id)) {
        found.push({ commandId: id, reason: 'unknownCommand', detail: `No command ${id}` });
        continue;
      }
      try {
        const expanded = expandKeymapEntries(ownerOf(id), entries, defaults.get(id)!);
        if (bindingSignature(expanded) !== bindingSignature(defaults.get(id)!))
          overrides.set(id, expanded);
      } catch (error) {
        const reason = error instanceof KeymapRefusal ? error.reason : 'invalidEntry';
        found.push({ commandId: id, reason, detail: (error as Error).message });
      }
    }
    const rejected = new Map<
      CommandId,
      { reason: 'conflict' | 'shadowed'; detail: string; with: readonly CommandId[] }
    >();
    const isRemapped = (id: CommandId) => overrides.has(id) && !rejected.has(id);
    for (;;) {
      const table = order.flatMap(id => (isRemapped(id) ? overrides.get(id)! : defaults.get(id)!));
      const clashes = [
        ...findConflicts(table).map(c => ({ c, reason: 'conflict' as const })),
        ...findShadows(table, isRemapped).map(c => ({ c, reason: 'shadowed' as const })),
      ];
      let progressed = false;
      for (const { c, reason } of clashes) {
        for (const id of c.commandIds) {
          if (!isRemapped(id)) continue;
          rejected.set(id, {
            reason,
            detail: describeConflicts([c]),
            with: c.commandIds.filter(other => other !== id),
          });
          progressed = true;
        }
      }
      if (!progressed) {
        for (const [id, { reason, detail, with: others }] of rejected) {
          found.push({
            commandId: id,
            reason,
            detail: `Kept the default keys. The new keys clash: ${detail}`,
            with: others,
          });
        }
        for (const id of order) {
          if (!isRemapped(id)) continue;
          for (const group of droppedScopedDefaults(
            ownerOf(id),
            defaults.get(id)!,
            overrides.get(id)!,
          )) {
            const where = group.map(b => b.context).join(', ');
            const swipe = group.some(b => b.followsSwipe) ? ', following the swipe direction' : '';
            found.push({
              commandId: id,
              reason: 'dropsDefault',
              detail: `${keyText(group[0])} no longer runs ${id} in ${where}${swipe}`,
            });
          }
        }
        return { bindings: table, issues: found };
      }
    }
  }

  function configure(prefs: KeyPrefs): readonly KeymapIssue[] {
    const result = applyKeymap(prefs.keymap);
    effective = prefs.swapTriageArrows ? swapArrows(result.bindings) : result.bindings;
    issues = result.issues;
    return issues;
  }

  configure(options.prefs ?? DEFAULT_KEY_PREFS);

  function disabledHere(id: CommandId, stack: readonly ContextName[]): boolean {
    return buildStack(stack).some(c => disabledIn[c]?.includes(id) ?? false);
  }

  function isEnabled(id: CommandId, ctx: CommandContext): boolean {
    const entry = specs.get(id);
    const handlers = activeHandlers(id);
    if (!entry || !handlers) return false;
    const guard = entry.spec.onlyWhen;
    if (guard && ctx.conditions[guard] !== true) return false;
    if (disabledHere(id, ctx.stack)) return false;
    return handlers.when ? handlers.when(ctx) : true;
  }

  function keysFor(id: CommandId, stack?: readonly ContextName[]): readonly Binding[] {
    const contexts = stack ? buildStack(stack) : undefined;
    return effective.filter(b => b.commandId === id && (!contexts || contexts.includes(b.context)));
  }

  function describeKeys(id: CommandId, stack?: readonly ContextName[]): string {
    if (stack && disabledHere(id, stack)) return '';
    return formatAlternatives(keysFor(id, stack).filter(b => !b.quiet));
  }

  function labelOf(id: CommandId, spec: CommandSpec, ctx: CommandContext): string {
    const label = activeHandlers(id)?.labelFor?.(ctx);
    if (label === undefined) return spec.label;
    const problem = copyProblem(label);
    if (!problem) return label;
    onError(new Error(`labelFor: ${problem}`), id);
    return spec.label;
  }

  function suggestedNow(id: CommandId, spec: CommandSpec, ctx: CommandContext): boolean {
    const handler = activeHandlers(id)?.suggested;
    if (!handler) return spec.suggested ?? false;
    try {
      return handler(ctx);
    } catch (error) {
      onError(error, id);
      return spec.suggested ?? false;
    }
  }

  function settingEntries(stack: readonly ContextName[]): PaletteEntry[] {
    if (!settingsTable || !stack.includes('global')) return [];
    return settingsTable
      .list()
      .filter(s => s.available?.() !== false)
      .map(s => ({
        id: s.id,
        label: s.label,
        group: 'Settings' as const,
        suggested: false,
        keys: '',
        keywords: s.keywords ?? [],
        destructive: false,
        page: false,
        route: settingRoute(s),
        detail: SETTING_SECTIONS.find(section => section.id === s.section)?.label,
      }));
  }

  function commandsForPalette(ctx: CommandContext): readonly PaletteEntry[] {
    const stack = buildStack(ctx.stack).filter(c => !isModal(c));
    const out: PaletteEntry[] = [];
    for (const group of PALETTE_GROUPS) {
      for (const spec of commands) {
        if (spec.group !== group || spec.palette === false) continue;
        if (spec.paletteWhen !== undefined && ctx.conditions[spec.paletteWhen] !== true) continue;
        if (!spec.contexts.some(c => stack.includes(c))) continue;
        if (!isEnabled(spec.id, ctx)) continue;
        out.push({
          id: spec.id,
          label: labelOf(spec.id, spec, ctx),
          icon: spec.icon,
          group: spec.group,
          suggested: suggestedNow(spec.id, spec, ctx),
          keys: describeKeys(spec.id, stack),
          keywords: spec.keywords ?? [],
          destructive: spec.confirm?.destructive ?? false,
          page: spec.page ?? false,
        });
      }
      if (group === 'Settings') out.push(...settingEntries(stack));
    }
    return out;
  }

  /** Calls a run function, reporting a synchronous throw or a rejection to onError under `reportAs`. */
  function invoke(reportAs: string, fn: () => void | Promise<void>): RunResult {
    let outcome: void | Promise<void>;
    try {
      outcome = fn();
    } catch (error) {
      onError(error, reportAs);
      return { status: 'failed', error };
    }
    const done = Promise.resolve(outcome);
    done.catch((error: unknown) => onError(error, reportAs));
    return { status: 'ran', done };
  }

  /** Builds a nested page, reporting a throwing `children` as a failure. */
  function page(
    reportAs: string,
    title: string,
    children: () => readonly PaletteChild[],
  ): RunResult {
    try {
      return { status: 'page', title: title.replace(/…$/, ''), items: children() };
    } catch (error) {
      onError(error, reportAs);
      return { status: 'failed', error };
    }
  }

  function run(
    id: CommandId,
    ctx: CommandContext,
    runOptions: { readonly confirmed?: boolean } = {},
  ): RunResult {
    const setting = settingsTable?.get(id);
    if (setting) return { status: 'navigate', route: settingRoute(setting) };
    const entry = specs.get(id);
    if (!entry) return { status: 'unknown' };
    const handlers = activeHandlers(id);
    if (!handlers) return { status: 'unhandled' };
    if (!isEnabled(id, ctx)) return { status: 'disabled' };
    const confirm = entry.kind === 'command' ? entry.spec.confirm : undefined;
    const needsConfirm = confirm && (confirm.scope !== 'bulk' || ctx.selection.length > 1);
    if (confirm && needsConfirm && !runOptions.confirmed) {
      let prompt = confirm.prompt;
      const custom = handlers.promptFor?.(ctx);
      if (custom !== undefined) {
        const problem = copyProblem(custom);
        if (problem) onError(new Error(`promptFor: ${problem}`), id);
        else prompt = custom;
      }
      return {
        status: 'confirm',
        title: confirm.title,
        prompt,
        confirmLabel: confirm.confirmLabel,
        destructive: confirm.destructive,
      };
    }
    const children = handlers.children;
    if (children) return page(id, entry.spec.label, () => children(ctx));
    return invoke(id, () => handlers.run(ctx));
  }

  function runChild(
    child: PaletteChild,
    ctx: CommandContext,
    runOptions: { readonly confirmed?: boolean } = {},
  ): RunResult {
    const confirm = child.confirm;
    if (
      confirm &&
      (confirm.scope !== 'bulk' || ctx.selection.length > 1) &&
      !runOptions.confirmed
    ) {
      return {
        status: 'confirm',
        title: confirm.title,
        prompt: confirm.prompt,
        confirmLabel: confirm.confirmLabel,
        destructive: confirm.destructive,
      };
    }
    const children = child.children;
    if (children) return page(child.id, child.label, () => children(ctx));
    const runRow = child.run;
    if (!runRow) return { status: 'unhandled' };
    return invoke(child.id, () => runRow(ctx));
  }

  return {
    attach(id, handlers) {
      const entry = specs.get(id);
      if (!entry) throw new Error(`No command ${id}`);
      // The palette's chevron and "…" come from the spec, so the spec and the handler must agree.
      const isPage = entry.kind === 'command' && entry.spec.page === true;
      if (handlers.children && !isPage)
        throw new Error(`${id}: only a command with page: true may have children`);
      if (isPage && !handlers.children) throw new Error(`${id}: a page command needs children`);
      const slot: Slot = { handlers };
      slots.set(id, [...(slots.get(id) ?? []), slot]);
      return () => {
        slots.set(
          id,
          (slots.get(id) ?? []).filter(s => s !== slot),
        );
      };
    },
    release(release, ctx) {
      if (!release) return { status: 'unhandled' };
      const handler = activeHandlers(release.commandId)?.release;
      if (!handler) return { status: specs.has(release.commandId) ? 'unhandled' : 'unknown' };
      return invoke(release.commandId, () =>
        handler.call(activeHandlers(release.commandId), ctx, release),
      );
    },
    get(id) {
      const entry = specs.get(id);
      if (!entry) return undefined;
      return { ...entry, handlers: activeHandlers(id) } as RegistryEntry;
    },
    list: () => commands,
    controls: () => controls,
    bindings: () => effective,
    bindingsFor: context => effective.filter(b => b.context === context),
    keysFor,
    describeKeys,
    isEnabled,
    commandsForPalette,
    resolve(event, ctx) {
      return resolve(event, buildStack(ctx.stack), effective, ctx.prefs, {
        focus: ctx.focus,
        isEnabled: id => isEnabled(id, ctx),
      });
    },
    run,
    runChild,
    settings: () => settingsTable?.list() ?? [],
    configure,
    get keymapIssues() {
      return issues;
    },
    missingHandlers: () => order.filter(id => !activeHandlers(id)),
  };
}
