// Shared helpers for this folder's tests. Not exported from index.ts.
import { COMMANDS, CONTROLS, createAppRegistry } from './catalog';
import type { Registry } from './registry';
import {
  DEFAULT_KEY_PREFS,
  type CommandContext,
  type ConditionState,
  type ContextName,
  type FocusKind,
  type KeyInput,
  type KeyPrefs,
  type Keymap,
} from './types';

/** The full catalog with a no-op handler on every command and control (an empty page for page commands). */
export function wiredRegistry(prefs: KeyPrefs = DEFAULT_KEY_PREFS): Registry {
  const registry = createAppRegistry(prefs);
  for (const spec of [...COMMANDS, ...CONTROLS]) {
    const page = 'page' in spec && spec.page === true;
    registry.attach(
      spec.id,
      page ? { run: () => undefined, children: () => [] } : { run: () => undefined },
    );
  }
  return registry;
}

/** The [command, reason] pairs configuring the whole catalog with this keymap reports. */
export function issuesFor(keymap: Keymap) {
  return wiredRegistry()
    .configure({ ...DEFAULT_KEY_PREFS, keymap })
    .map(i => [i.commandId, i.reason]);
}

export function context(
  stack: readonly ContextName[],
  options: {
    focus?: FocusKind;
    conditions?: ConditionState;
    prefs?: KeyPrefs;
    selection?: readonly string[];
  } = {},
): CommandContext {
  return {
    stack,
    target: null,
    selection: options.selection ?? [],
    conditions: options.conditions ?? {},
    prefs: options.prefs ?? DEFAULT_KEY_PREFS,
    focus: options.focus ?? 'none',
  };
}

/** A keydown as the browser reports it. */
export function keydown(key: string, mods: Partial<KeyInput> = {}): KeyInput {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
}

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
