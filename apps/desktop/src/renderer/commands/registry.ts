// The CommandRegistry (DESIGN §6; plan 30 §4.2): one table that feeds the key
// handler, the palette, menus, tooltips, the shortcut sheet and toast keycaps.
import { chordId, formatAlternatives, formatChord, parseChord } from './keys';
import { resolve } from './resolver';
import {
  CONTEXT_NAMES,
  DEFAULT_KEY_PREFS,
  PALETTE_GROUPS,
  type Binding,
  type CommandContext,
  type CommandHandlers,
  type CommandId,
  type CommandSpec,
  type ContextName,
  type ControlSpec,
  type IconName,
  type KeyInput,
  type KeyPrefs,
  type KeySpec,
  type Keymap,
  type PaletteGroup,
  type Resolution,
  type TargetSummary,
} from './types';

export type RegistryEntry =
  | { readonly kind: 'command'; readonly spec: CommandSpec; readonly handlers?: CommandHandlers }
  | { readonly kind: 'control'; readonly spec: ControlSpec; readonly handlers?: CommandHandlers };

export interface BindingConflict {
  readonly context: ContextName;
  /** Display form, e.g. "S". */
  readonly keys: string;
  readonly commandIds: readonly (CommandId | null)[];
}

export interface KeymapIssue {
  readonly commandId: CommandId;
  readonly reason: 'unknownCommand' | 'invalidChord' | 'conflict';
  readonly detail: string;
}

export interface PaletteEntry {
  readonly id: CommandId;
  readonly label: string;
  readonly icon?: IconName;
  readonly group: PaletteGroup;
  /** Keycaps from the registry, alternatives joined with "or"; '' when the command has no key. */
  readonly keys: string;
  readonly keywords: readonly string[];
  readonly destructive: boolean;
}

export type RunResult =
  | { readonly status: 'ran' }
  | { readonly status: 'unknown' | 'unhandled' | 'disabled' }
  | { readonly status: 'confirm'; readonly prompt: string; readonly destructive: boolean };

export interface RegistryOptions {
  readonly controls?: readonly ControlSpec[];
  /** Chords that do nothing in a context (see CONTEXT_BLOCKS). */
  readonly blocks?: Readonly<Partial<Record<ContextName, readonly string[]>>>;
  readonly prefs?: KeyPrefs;
}

export interface Registry {
  /** Attaches the screen's handlers. Returns a detach function. */
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
  /** The palette's commands for the stack under it, grouped in PALETTE_GROUPS order. */
  commandsForPalette(ctx: CommandContext): readonly PaletteEntry[];
  resolve(event: KeyInput, ctx: CommandContext): Resolution | null;
  /** Runs a command, asking for confirmation first when its spec says so. */
  run(id: CommandId, ctx: CommandContext, options?: { readonly confirmed?: boolean }): RunResult;
  /** Applies new prefs (keymap, swipe direction). Rejected remaps keep their defaults and are reported. */
  configure(prefs: KeyPrefs): readonly KeymapIssue[];
  readonly keymapIssues: readonly KeymapIssue[];
  /** Ids with keys or palette presence but no attached handler (a sheet key with no handler). */
  missingHandlers(): readonly CommandId[];
}

/** Contexts that sit on top of the target and never define what a command acts on. */
const TRANSIENT_CONTEXTS: readonly ContextName[] = ['palette', 'menu', 'datePicker', 'dialog'];

interface Owner {
  readonly id: CommandId;
  readonly contexts: readonly ContextName[];
  readonly guarded: boolean;
  readonly repeat: boolean;
}

function assertContexts(id: CommandId, contexts: readonly ContextName[]): void {
  for (const c of contexts) {
    if (!CONTEXT_NAMES.includes(c)) throw new Error(`${id}: unknown context "${c}"`);
  }
}

/** Expands one command's key specs into flat bindings. Throws on a bad chord string. */
export function expandKeys(owner: Owner, keys: readonly KeySpec[]): Binding[] {
  const out: Binding[] = [];
  for (const spec of keys) {
    const entry = typeof spec === 'string' ? { chord: spec } : spec;
    const contexts = entry.contexts ?? owner.contexts;
    assertContexts(owner.id, contexts);
    let chord;
    try {
      chord = parseChord(entry.chord);
    } catch (error) {
      throw new Error(`${owner.id}: ${(error as Error).message}`);
    }
    for (const context of contexts) {
      out.push({
        commandId: owner.id,
        chord,
        context,
        phase: entry.phase ?? 'tap',
        inTextField: entry.inTextField ?? false,
        repeat: owner.repeat,
        guarded: owner.guarded,
        followsSwipe: entry.followsSwipe ?? false,
      });
    }
  }
  return out;
}

function blockBindings(blocks: RegistryOptions['blocks']): Binding[] {
  const out: Binding[] = [];
  for (const context of CONTEXT_NAMES) {
    for (const text of blocks?.[context] ?? []) {
      out.push({
        commandId: null,
        chord: parseChord(text),
        context,
        phase: 'tap',
        inTextField: false,
        repeat: true,
        guarded: false,
        followsSwipe: false,
      });
    }
  }
  return out;
}

/**
 * Two bindings conflict when they share a chord, a phase and a context, unless
 * they are told apart by distinct `onlyWhen` conditions with at most one
 * unguarded. A block (null) conflicts with any binding beside it.
 */
export function findConflicts(
  bindings: readonly Binding[],
  guardOf: (id: CommandId) => string | undefined,
): BindingConflict[] {
  const groups = new Map<string, Binding[]>();
  for (const b of bindings) {
    const key = `${b.context}|${b.phase}|${chordId(b.chord)}`;
    const group = groups.get(key) ?? [];
    if (!group.some((g) => g.commandId === b.commandId)) group.push(b);
    groups.set(key, group);
  }
  const conflicts: BindingConflict[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const hasBlock = group.some((b) => b.commandId === null);
    const guards = group.map((b) => (b.commandId === null ? undefined : guardOf(b.commandId)));
    const unguarded = guards.filter((g) => g === undefined).length;
    const named = guards.filter((g): g is string => g !== undefined);
    const repeatedGuard = new Set(named).size !== named.length;
    if (hasBlock || unguarded > 1 || repeatedGuard) {
      const first = group[0];
      const prefix = first.phase === 'hold' ? 'Hold ' : '';
      conflicts.push({
        context: first.context,
        keys: `${prefix}${formatChord(first.chord)}`,
        commandIds: group.map((b) => b.commandId),
      });
    }
  }
  return conflicts;
}

function describeConflicts(conflicts: readonly BindingConflict[]): string {
  return conflicts.map((c) => `${c.keys} in ${c.context}: ${c.commandIds.map((id) => id ?? '(blocked)').join(', ')}`).join('; ');
}

function swapArrows(bindings: readonly Binding[]): Binding[] {
  return bindings.map((b) => {
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

export function createRegistry(commands: readonly CommandSpec[], options: RegistryOptions = {}): Registry {
  const controls = options.controls ?? [];
  const entries = new Map<CommandId, RegistryEntry>();
  for (const spec of commands) {
    if (entries.has(spec.id)) throw new Error(`Duplicate command id ${spec.id}`);
    assertContexts(spec.id, spec.contexts);
    entries.set(spec.id, { kind: 'command', spec });
  }
  for (const spec of controls) {
    if (entries.has(spec.id)) throw new Error(`Duplicate command id ${spec.id}`);
    assertContexts(spec.id, spec.contexts);
    entries.set(spec.id, { kind: 'control', spec });
  }
  const order = [...entries.keys()];
  const guardOf = (id: CommandId) => entries.get(id)?.spec.onlyWhen;

  function ownerOf(id: CommandId): Owner {
    const spec = entries.get(id)!.spec;
    return { id, contexts: spec.contexts, guarded: spec.onlyWhen !== undefined, repeat: spec.repeat ?? false };
  }

  const defaults = new Map<CommandId, Binding[]>();
  for (const id of order) defaults.set(id, expandKeys(ownerOf(id), entries.get(id)!.spec.keys));
  const blocks = blockBindings(options.blocks);

  const initialConflicts = findConflicts([...[...defaults.values()].flat(), ...blocks], guardOf);
  if (initialConflicts.length > 0) {
    throw new Error(`Duplicate key bindings: ${describeConflicts(initialConflicts)}`);
  }

  let effective: Binding[] = [];
  let issues: KeymapIssue[] = [];

  function applyKeymap(keymap: Keymap): { bindings: Map<CommandId, Binding[]>; issues: KeymapIssue[] } {
    const found: KeymapIssue[] = [];
    const overrides = new Map<CommandId, Binding[]>();
    for (const [id, keys] of Object.entries(keymap)) {
      if (!entries.has(id)) {
        found.push({ commandId: id, reason: 'unknownCommand', detail: `No command ${id}` });
        continue;
      }
      try {
        overrides.set(id, expandKeys(ownerOf(id), keys));
      } catch (error) {
        found.push({ commandId: id, reason: 'invalidChord', detail: (error as Error).message });
      }
    }
    const rejected = new Map<CommandId, string>();
    for (;;) {
      const table = new Map<CommandId, Binding[]>();
      for (const id of order) {
        const override = overrides.get(id);
        table.set(id, override && !rejected.has(id) ? override : defaults.get(id)!);
      }
      const conflicts = findConflicts([...[...table.values()].flat(), ...blocks], guardOf);
      let progressed = false;
      for (const conflict of conflicts) {
        for (const id of conflict.commandIds) {
          if (id === null || !overrides.has(id) || rejected.has(id)) continue;
          rejected.set(id, describeConflicts([conflict]));
          progressed = true;
        }
      }
      if (!progressed) {
        for (const [id, clash] of rejected) {
          found.push({ commandId: id, reason: 'conflict', detail: `Kept the default keys. The new keys clash: ${clash}` });
        }
        return { bindings: table, issues: found };
      }
    }
  }

  function configure(prefs: KeyPrefs): readonly KeymapIssue[] {
    const result = applyKeymap(prefs.keymap);
    const flat = [...[...result.bindings.values()].flat(), ...blocks];
    effective = prefs.swapTriageArrows ? swapArrows(flat) : flat;
    issues = result.issues;
    return issues;
  }

  configure(options.prefs ?? DEFAULT_KEY_PREFS);

  function isEnabled(id: CommandId, ctx: CommandContext): boolean {
    const entry = entries.get(id);
    if (!entry?.handlers) return false;
    const guard = entry.spec.onlyWhen;
    if (guard && ctx.conditions[guard] !== true) return false;
    return entry.handlers.when ? entry.handlers.when(ctx) : true;
  }

  function keysFor(id: CommandId, stack?: readonly ContextName[]): readonly Binding[] {
    return effective.filter((b) => b.commandId === id && (!stack || stack.includes(b.context)));
  }

  function describeKeys(id: CommandId, stack?: readonly ContextName[]): string {
    return formatAlternatives(keysFor(id, stack));
  }

  function targetStack(stack: readonly ContextName[]): readonly ContextName[] {
    return stack.filter((c) => !TRANSIENT_CONTEXTS.includes(c));
  }

  function commandsForPalette(ctx: CommandContext): readonly PaletteEntry[] {
    const stack = targetStack(ctx.stack);
    const out: PaletteEntry[] = [];
    for (const group of PALETTE_GROUPS) {
      for (const spec of commands) {
        if (spec.group !== group) continue;
        if (!spec.contexts.some((c) => stack.includes(c))) continue;
        if (!isEnabled(spec.id, ctx)) continue;
        const handlers = entries.get(spec.id)?.handlers;
        out.push({
          id: spec.id,
          label: handlers?.labelFor?.(ctx) ?? spec.label,
          icon: spec.icon,
          group,
          keys: describeKeys(spec.id, stack),
          keywords: spec.keywords ?? [],
          destructive: spec.confirm?.destructive ?? false,
        });
      }
    }
    return out;
  }

  function run(id: CommandId, ctx: CommandContext, runOptions: { readonly confirmed?: boolean } = {}): RunResult {
    const entry = entries.get(id);
    if (!entry) return { status: 'unknown' };
    if (!entry.handlers) return { status: 'unhandled' };
    if (!isEnabled(id, ctx)) return { status: 'disabled' };
    const confirm = entry.kind === 'command' ? entry.spec.confirm : undefined;
    const needsConfirm = confirm && (confirm.scope !== 'bulk' || ctx.selection.length > 1);
    if (confirm && needsConfirm && !runOptions.confirmed) {
      return { status: 'confirm', prompt: confirm.prompt, destructive: confirm.destructive };
    }
    void entry.handlers.run(ctx);
    return { status: 'ran' };
  }

  return {
    attach(id, handlers) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`No command ${id}`);
      entries.set(id, { ...entry, handlers } as RegistryEntry);
      return () => {
        const current = entries.get(id);
        if (current?.handlers === handlers) entries.set(id, { ...current, handlers: undefined } as RegistryEntry);
      };
    },
    get: (id) => entries.get(id),
    list: () => commands,
    controls: () => controls,
    bindings: () => effective,
    bindingsFor: (context) => effective.filter((b) => b.context === context),
    keysFor,
    describeKeys,
    isEnabled,
    commandsForPalette,
    resolve(event, ctx) {
      return resolve(event, ctx.stack, effective, ctx.prefs, {
        focus: ctx.focus,
        isEnabled: (id) => isEnabled(id, ctx),
      });
    },
    run,
    configure,
    get keymapIssues() {
      return issues;
    },
    missingHandlers: () => order.filter((id) => !entries.get(id)?.handlers),
  };
}
