// Seeded property test (plan 30 WP1.4): random key sequences across contexts,
// IME composition, focus and prefs, checked against an independent oracle.
// The oracle never calls keys.ts: each generated key carries its canonical
// chord id by construction, and the oracle applies DESIGN §5 rule 16 and §8
// directly to the binding table.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DISABLED_IN } from './catalog';
import { createHoldTracker } from './hold';
import { createKeyQueue } from './keyQueue';
import { chordId } from './keys';
import { context, prng, wiredRegistry } from './testing';
import {
  CONDITION_PRIORITY,
  DEFAULT_KEY_PREFS,
  type Binding,
  type CommandContext,
  type Condition,
  type ContextName,
  type FocusKind,
  type KeyInput,
  type KeyPrefs,
} from './types';

const SEED = 20261027;
const SEQUENCES = 2500;
const SEQUENCE_LENGTH = 12;

interface GenKey {
  readonly event: KeyInput;
  /** The canonical chord id the event must normalize to. */
  readonly id: string;
  /** A character key with no ⌘, ⌃ or ⌥; shift allowed (WCAG 2.1.4 single-key). */
  readonly character: boolean;
}

function plain(key: string, id: string, extra: Partial<KeyInput> = {}): GenKey {
  const event = { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra };
  const character = [...id.replace(/^shift\+/, '')].length === 1;
  return { event, id, character };
}

const KEY_POOL: readonly GenKey[] = [
  ...'abcdefhijklmnorstuwxyz'.split('').map(k => plain(k, k)),
  ...'aejlrsx'.split('').map(k => plain(k.toUpperCase(), k)), // Caps Lock on
  ...'arx'.split('').map(k => plain(k.toUpperCase(), `shift+${k}`, { shiftKey: true })),
  ...'12345679'.split('').map(d => plain(d, d)),
  plain('?', '?', { shiftKey: true, code: 'Slash' }),
  plain('#', '#', { shiftKey: true, code: 'Digit3' }),
  plain('/', '/'),
  plain('[', '['),
  plain('.', '.'),
  plain(' ', 'Space'),
  plain('Enter', 'Enter'),
  plain('Enter', 'shift+Enter', { shiftKey: true }),
  plain('Escape', 'Escape'),
  plain('Tab', 'Tab'),
  plain('Tab', 'shift+Tab', { shiftKey: true }),
  plain('Backspace', 'Backspace'),
  plain('ArrowUp', 'ArrowUp'),
  plain('ArrowDown', 'ArrowDown'),
  plain('ArrowLeft', 'ArrowLeft'),
  plain('ArrowRight', 'ArrowRight'),
  plain('ArrowDown', 'alt+ArrowDown', { altKey: true }),
  plain('ArrowUp', 'alt+ArrowUp', { altKey: true }),
  plain('k', 'meta+k', { metaKey: true }),
  plain('a', 'meta+a', { metaKey: true }),
  plain('j', 'meta+j', { metaKey: true }),
  plain(',', 'meta+,', { metaKey: true }),
  plain('/', 'meta+/', { metaKey: true }),
  plain('f', 'meta+f', { metaKey: true }),
  plain('n', 'meta+n', { metaKey: true }),
  plain('Enter', 'meta+Enter', { metaKey: true }),
  plain('Enter', 'shift+meta+Enter', { metaKey: true, shiftKey: true }),
  plain('¬', 'alt+meta+l', { metaKey: true, altKey: true, code: 'KeyL' }),
  plain('®', 'alt+meta+r', { metaKey: true, altKey: true, code: 'KeyR' }),
  ...'12345678'.split('').map(d => plain(d, `ctrl+${d}`, { ctrlKey: true })),
];

const STACKS: readonly (readonly ContextName[])[] = [
  ['global'],
  ['global', 'list'],
  ['global', 'list', 'home'],
  ['global', 'list', 'done'],
  ['global', 'list', 'reader'],
  ['global', 'list', 'reader', 'oneByOne'],
  ['global', 'list', 'reader', 'compose'],
  ['global', 'compose'],
  ['global', 'ask'],
  ['global', 'calendar'],
  ['global', 'list', 'home', 'palette'],
  ['global', 'list', 'home', 'menu'],
  ['global', 'list', 'datePicker'],
  ['global', 'calendar', 'dialog'],
  ['global', 'list', 'reader', 'compose', 'palette'],
  ['global', 'list', 'reader', 'dialog'],
  ['global', 'list', 'home', 'lowImportance'],
  ['global', 'list', 'done', 'reader'],
  ['global', 'list', 'home', 'reader', 'oneByOne'],
  ['onboarding'],
  ['onboarding', 'dialog'],
  ['onboarding', 'firstSync'],
  ['onboarding', 'firstSync', 'drill'],
  ['onboarding', 'firstSync', 'drill', 'dialog'],
  ['global', 'search'],
  ['global', 'search', 'list'],
  ['global', 'search', 'list', 'palette'],
  ['global', 'list', 'home', 'sheet'],
  ['global', 'settings', 'sheet'],
  ['global', 'settings'],
];

/** The onboarding window: no app command may answer there (DESIGN §7.11, §7.12). */
const ONBOARDING_WINDOW = new Set<ContextName>(['onboarding', 'firstSync', 'drill']);

const CONDITIONS: readonly Condition[] = [
  'selection',
  'invite',
  'suggestion',
  'emptyBody',
  'emptyField',
  'streaming',
  'askText',
  'proposal',
  'queued',
  'remindOffer',
  'welcome',
];

/** Focus-scoped and modal: exempt from the single-key switch, and nothing outside them answers. */
const MODAL = new Set<ContextName>([
  'palette',
  'menu',
  'datePicker',
  'dialog',
  'sheet',
  'lowImportance',
]);
const TEXT_EDITING = new Set(['meta+a', 'ctrl+a', 'ctrl+e', 'ctrl+k']);

type Pick = () => number;

function choose<T>(rand: Pick, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)];
}

/** DESIGN §5 rule 16 and the focus rules, one binding at a time. */
function oracleAllows(
  b: Binding,
  key: GenKey,
  focus: FocusKind,
  prefs: KeyPrefs,
  repeat: boolean,
  ctx: CommandContext,
  guardOf: (id: string) => Condition | undefined,
): boolean {
  const hasCommandModifier = key.event.metaKey || key.event.ctrlKey;
  const textOk =
    b.inTextField || key.id === 'Escape' || (hasCommandModifier && !TEXT_EDITING.has(key.id));
  const controlOk = b.inTextField || !(key.id === 'Space' || key.id === 'Enter');
  if (focus === 'text' && !textOk) return false;
  if (focus === 'control' && !controlOk) return false;
  // WCAG 2.1.4 is independent of the field rule: inTextField does not exempt a character key.
  if (!prefs.singleKeyShortcuts && key.character && !MODAL.has(b.context)) return false;
  if (repeat && !b.repeat) return false;
  if (ctx.stack.some(c => DISABLED_IN[c]?.includes(b.commandId))) return false;
  const guard = guardOf(b.commandId);
  return guard === undefined || ctx.conditions[guard] === true;
}

/** Contexts that may answer: the innermost modal and anything inside it, else the whole stack. */
function reachable(stack: readonly ContextName[]): readonly ContextName[] {
  let start = 0;
  stack.forEach((c, i) => {
    if (MODAL.has(c)) start = i;
  });
  return stack.slice(start);
}

/** The innermost reachable context that answers decides; the highest-priority guard first; a hold rides only with its partner tap. */
function oracle(
  key: GenKey,
  ctx: CommandContext,
  table: readonly Binding[],
  repeat: boolean,
  composing: boolean,
  guardOf: (id: string) => Condition | undefined,
) {
  if (composing) return null;
  const contexts = reachable(ctx.stack);
  const candidates = table.filter(b => chordId(b.chord) === key.id && contexts.includes(b.context));
  const depthOf = (b: Binding) => contexts.lastIndexOf(b.context);
  const deciding = candidates
    .filter(b => oracleAllows(b, key, ctx.focus, ctx.prefs, repeat, ctx, guardOf))
    .sort((a, b) => depthOf(b) - depthOf(a));
  if (deciding.length === 0) return null;
  const depth = depthOf(deciding[0]);
  const level = deciding.filter(b => depthOf(b) === depth);
  const rank = (b: Binding) => {
    const guard = guardOf(b.commandId);
    return guard === undefined ? 99 : CONDITION_PRIORITY.indexOf(guard);
  };
  const taps = level.filter(b => b.phase === 'tap').sort((a, b) => rank(a) - rank(b));
  const holds = level.filter(b => b.phase === 'hold').sort((a, b) => rank(a) - rank(b));
  if (taps.length > 0) {
    const partner =
      holds[0] && holds[0].holdFor === taps[0].commandId ? holds[0].commandId : undefined;
    return { commandId: taps[0].commandId, phase: 'tap', holdCommandId: partner };
  }
  return { commandId: holds[0].commandId, phase: 'hold', holdCommandId: undefined };
}

type Resolved = NonNullable<ReturnType<ReturnType<typeof wiredRegistry>['resolve']>>;

/** Invariants stated by DESIGN, independent of the table. */
function assertInvariants(
  actual: Resolved | null,
  composing: boolean,
  key: GenKey,
  stack: readonly ContextName[],
  focus: FocusKind,
  prefs: KeyPrefs,
  table: readonly Binding[],
  label: string,
): boolean {
  if (composing) assert.equal(actual, null, label);
  if (!actual) return false;
  assert.ok(stack.includes(actual.context), label);
  const owner = table.find(
    b =>
      b.commandId === actual.commandId &&
      b.context === actual.context &&
      chordId(b.chord) === key.id,
  );
  assert.ok(owner, label);
  if (focus === 'text' && key.character)
    assert.ok(owner.inTextField, `single key fired in a text field: ${label}`);
  if (!prefs.singleKeyShortcuts && key.character)
    assert.ok(MODAL.has(owner.context), `single key fired with the switch off: ${label}`);
  assert.ok(reachable(stack).includes(actual.context), `a key reached behind a modal: ${label}`);
  assertPlaceInvariants(actual, key, stack, label);
  return true;
}

/** Invariants of particular places: Done, onboarding, the drill, first sync, triage arrows, Space. */
function assertPlaceInvariants(
  actual: Resolved,
  key: GenKey,
  stack: readonly ContextName[],
  label: string,
): void {
  if (stack.includes('done'))
    assert.ok(
      actual.commandId !== 'mail.done' && actual.commandId !== 'mail.later',
      `Done or Later in the Done place: ${label}`,
    );
  if (stack.some(c => ONBOARDING_WINDOW.has(c))) {
    assert.ok(
      ONBOARDING_WINDOW.has(actual.context) || MODAL.has(actual.context),
      `an app command answered in the onboarding window: ${label}`,
    );
  }
  if (stack.includes('drill') && /^[a-z]$/.test(key.id))
    assert.ok(
      actual.commandId.startsWith('drill.'),
      `a letter in the drill reached ${actual.commandId}: ${label}`,
    );
  if (stack.includes('firstSync') && key.id === 'Escape' && !MODAL.has(stack[stack.length - 1])) {
    assert.equal(
      actual.commandId,
      'onboarding.openAplos',
      `Esc on first sync must open Aplos: ${label}`,
    );
  }
  const triageArrow = key.id === 'ArrowLeft' || key.id === 'ArrowRight';
  if (triageArrow && (actual.commandId === 'mail.done' || actual.commandId === 'mail.later')) {
    assert.ok(
      ['home', 'oneByOne', 'reader'].includes(actual.context),
      `arrow triage outside Home/one by one/reader: ${label}`,
    );
  }
  if (key.id === 'Space' && actual.phase === 'hold') assert.equal(actual.context, 'compose', label);
}

/** Hold timing: a hold-capable keydown, held for a random time. Returns how long it was held. */
function checkHold(
  actual: Resolved | null,
  key: GenKey,
  tracker: ReturnType<typeof createHoldTracker>,
  prefs: KeyPrefs,
  clock: number,
  rand: () => number,
  label: string,
): number {
  const holdId = actual?.phase === 'tap' ? actual.holdCommandId : actual?.commandId;
  if (!actual || !(actual.phase === 'hold' || holdId)) return 0;
  const heldFor = Math.floor(rand() * 600);
  tracker.down(key.event, holdId!, clock);
  assert.ok(
    tracker.swallows({ ...key.event, repeat: true }),
    `auto-repeat of the armed key is swallowed: ${label}`,
  );
  const upgrade = tracker.tick(clock + heldFor);
  const release = tracker.up(key.event, clock + heldFor);
  const isHold = heldFor >= prefs.holdThresholdMs;
  assert.equal(upgrade !== null, isHold, label);
  assert.equal(release?.phase, isHold ? 'hold' : 'tap', label);
  return heldFor;
}

test(`resolver agrees with the oracle over ${SEQUENCES} seeded sequences`, () => {
  const rand = prng(SEED);
  const registries = new Map<string, ReturnType<typeof wiredRegistry>>();
  let resolved = 0;
  let checked = 0;
  for (let s = 0; s < SEQUENCES; s += 1) {
    const prefs: KeyPrefs = {
      ...DEFAULT_KEY_PREFS,
      singleKeyShortcuts: rand() > 0.2,
      swapTriageArrows: rand() > 0.8,
      holdThresholdMs: 150 + Math.floor(rand() * 300),
    };
    const cacheKey = String(prefs.swapTriageArrows);
    const registry = registries.get(cacheKey) ?? wiredRegistry(prefs);
    registries.set(cacheKey, registry);
    const guardOf = (id: string) => registry.get(id)?.spec.onlyWhen;
    const table = registry.bindings();
    const tracker = createHoldTracker(prefs.holdThresholdMs);
    const queue = createKeyQueue<number>();
    const offered: number[] = [];
    const dispatched: number[] = [];
    let stack = choose(rand, STACKS);
    let clock = 0;

    for (let i = 0; i < SEQUENCE_LENGTH; i += 1) {
      if (rand() < 0.25) stack = choose(rand, STACKS);
      const key = choose(rand, KEY_POOL);
      const composing = rand() < 0.1;
      const repeat = rand() < 0.08;
      const focus: FocusKind = rand() < 0.3 ? 'text' : rand() < 0.15 ? 'control' : 'none';
      const conditions: Partial<Record<Condition, boolean>> = {};
      for (const c of CONDITIONS) if (rand() < 0.25) conditions[c] = true;
      const ctx = context(stack, { focus, conditions, prefs });
      const event = { ...key.event, isComposing: composing, repeat };

      const actual = registry.resolve(event, ctx);
      const expected = oracle(key, ctx, table, repeat, composing, guardOf);
      const label = `seq ${s} step ${i}: ${key.id} in [${stack.join(' > ')}] focus=${focus} composing=${composing} repeat=${repeat} singleKey=${prefs.singleKeyShortcuts} conditions=${JSON.stringify(conditions)}`;
      assert.equal(actual?.commandId ?? null, expected?.commandId ?? null, label);
      assert.equal(actual?.phase, expected?.phase, label);
      assert.equal(actual?.holdCommandId, expected?.holdCommandId, label);
      checked += 1;

      if (assertInvariants(actual, composing, key, stack, focus, prefs, table, label))
        resolved += 1;

      clock += checkHold(actual, key, tracker, prefs, clock, rand, label);
      clock += 1 + Math.floor(rand() * 40);

      // Transitions open and close at random; nothing is dropped or reordered.
      if (rand() < 0.2) queue.begin();
      offered.push(checked);
      if (!queue.offer(checked)) dispatched.push(checked);
      if (rand() < 0.3) queue.end();
      dispatched.push(...queue.drain());
    }
    while (queue.busy) queue.end();
    dispatched.push(...queue.drain());
    assert.deepEqual(dispatched, offered, `key queue order in sequence ${s}`);
  }
  assert.equal(checked, SEQUENCES * SEQUENCE_LENGTH);
  // The onboarding-window and modal stacks bind few keys, so most keys there resolve to nothing by design.
  assert.ok(
    resolved > checked * 0.15,
    `enough keys resolved to mean something (${resolved} of ${checked})`,
  );
});
