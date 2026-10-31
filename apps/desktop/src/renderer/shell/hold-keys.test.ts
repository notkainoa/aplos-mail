/**
 * Hold keys through the shell's key listener (review finding 8): the armed key's auto-repeats are swallowed, a held R
 * upgrades the reply tap to dictation, a held Space in an empty body dictates, and every hold ends with a release the
 * handler can read (kept only when the key came up after the upgrade). Real shell registry, fake clock and timers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppRegistry, createHoldTracker, type HoldRelease } from '../commands';
import type { ContextName, ConditionState, TargetSummary } from '../commands';
import {
  cancelShellHold,
  dispatchShellKey,
  releaseShellKey,
  type ShellHold,
  type ShellKeyState,
} from './keys-dispatch';
import { shellRegistryFor } from './ShellRegistry';

type Fake = Partial<Omit<KeyboardEvent, 'target'>> & { key: string; target?: unknown };

const TEXTAREA = { tagName: 'TEXTAREA' };
const THREAD: TargetSummary = { kind: 'thread', id: 't1', title: 'Hi' };

function key(init: Fake): KeyboardEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    isComposing: false,
    repeat: false,
    ...init,
  } as unknown as KeyboardEvent;
}

const R = key({ key: 'r', code: 'KeyR' });
const R_REPEAT = key({ key: 'r', code: 'KeyR', repeat: true, target: TEXTAREA });
const SPACE = key({ key: ' ', code: 'Space', target: TEXTAREA });

interface Timer {
  readonly at: number;
  readonly run: () => void;
  cancelled: boolean;
}

interface MutableState {
  stack: readonly ContextName[];
  target: TargetSummary | null;
  conditions: ConditionState;
}

/** The real shell registry with recorders for the reply, the two dictation commands and Esc in compose. */
function setup(initial: MutableState) {
  const shell = shellRegistryFor(createAppRegistry());
  const calls: string[] = [];
  const releases: HoldRelease[] = [];
  const state: MutableState = { ...initial };
  const recorder = (id: string) => ({
    run: () => void calls.push(id),
    release: (_ctx: unknown, release: HoldRelease) => void releases.push(release),
  });
  shell.register({
    'mail.reply': {
      run: () => {
        calls.push('mail.reply');
        state.stack = ['global', 'reader', 'compose'];
        state.conditions = { emptyBody: true };
      },
    },
    'mail.dictateReply': recorder('mail.dictateReply'),
    'compose.dictate': recorder('compose.dictate'),
    'compose.close': { run: () => void calls.push('compose.close') },
  });
  let now = 0;
  const timers: Timer[] = [];
  let removed = 0;
  const hold: ShellHold = {
    tracker: createHoldTracker(250),
    now: () => now,
    schedule(ms, run) {
      const timer: Timer = { at: now + ms, run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    readState: () => state,
    removeTyped: () => {
      removed++;
    },
  };
  function advance(ms: number): void {
    now += ms;
    for (const timer of timers.splice(0)) {
      if (timer.cancelled) continue;
      if (timer.at <= now) timer.run();
      else timers.push(timer);
    }
  }
  const snapshot = (): ShellKeyState => ({ ...state });
  const down = (event: KeyboardEvent) => dispatchShellKey(shell.registry, snapshot(), event, hold);
  const up = (event: KeyboardEvent) => releaseShellKey(shell.registry, snapshot(), event, hold);
  const cancel = () => cancelShellHold(shell.registry, snapshot(), hold);
  return { calls, releases, state, advance, down, up, cancel, removed: () => removed };
}

const reader = (): MutableState => ({
  stack: ['global', 'reader'],
  target: THREAD,
  conditions: {},
});

test('R opens the reply and its auto-repeats are swallowed instead of typing "rrr"', () => {
  const kit = setup(reader());
  assert.equal(kit.down(R), true, 'the tap ran');
  assert.deepEqual(kit.calls, ['mail.reply']);
  for (let i = 0; i < 3; i++) {
    kit.advance(30);
    assert.equal(kit.down(R_REPEAT), true, 'the repeat is prevented');
  }
  assert.deepEqual(kit.calls, ['mail.reply'], 'nothing else ran');
});

test('holding R past the threshold dictates the reply once; releasing R keeps it', () => {
  const kit = setup(reader());
  kit.down(R);
  kit.advance(249);
  assert.deepEqual(kit.calls, ['mail.reply']);
  kit.advance(1);
  assert.deepEqual(kit.calls, ['mail.reply', 'mail.dictateReply']);
  kit.down(R_REPEAT);
  kit.advance(500);
  assert.deepEqual(kit.calls, ['mail.reply', 'mail.dictateReply'], 'the upgrade fires once');
  kit.up(R);
  assert.equal(kit.releases.length, 1);
  const [release] = kit.releases;
  assert.equal(release?.commandId, 'mail.dictateReply');
  assert.equal(release?.upgraded, true);
  assert.equal(release?.ended, 'up');
});

test('a quick R tap never dictates and releases as not upgraded', () => {
  const kit = setup(reader());
  kit.down(R);
  kit.advance(100);
  kit.up(R);
  kit.advance(1000);
  assert.deepEqual(kit.calls, ['mail.reply']);
  assert.equal(kit.releases.length, 1);
  assert.equal(kit.releases[0]?.upgraded, false);
  assert.equal(kit.releases[0]?.ended, 'up');
  assert.equal(
    kit.down(R_REPEAT),
    false,
    'nothing is armed: a later R in the field is not swallowed',
  );
});

test('another key mid-hold interrupts it; blur cancels it', () => {
  const kit = setup(reader());
  kit.down(R);
  kit.advance(300);
  kit.down(key({ key: 'j', code: 'KeyJ', target: TEXTAREA }));
  assert.equal(kit.releases[0]?.ended, 'interrupt');
  assert.equal(kit.releases[0]?.upgraded, true);
  kit.up(R);
  assert.equal(kit.releases.length, 1, 'the keyup after an interrupt releases nothing');

  const other = setup(reader());
  other.down(R);
  other.advance(300);
  other.cancel();
  assert.equal(other.releases[0]?.ended, 'cancel');
  other.advance(1000);
  assert.deepEqual(other.calls, ['mail.reply', 'mail.dictateReply']);
});

test('a modifier pressed mid-hold does not end it', () => {
  const kit = setup(reader());
  kit.down(R);
  kit.advance(100);
  kit.down(key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }));
  assert.equal(kit.releases.length, 0);
  kit.advance(200);
  assert.deepEqual(kit.calls, ['mail.reply', 'mail.dictateReply']);
});

test('Esc during dictation cancels it and does not also close the reply', () => {
  const kit = setup(reader());
  kit.down(R);
  kit.advance(300);
  assert.equal(kit.down(key({ key: 'Escape', code: 'Escape', target: TEXTAREA })), true);
  assert.equal(kit.releases[0]?.ended, 'cancel');
  assert.deepEqual(kit.calls, ['mail.reply', 'mail.dictateReply']);

  const early = setup(reader());
  early.down(R);
  early.advance(100);
  early.down(key({ key: 'Escape', code: 'Escape', target: TEXTAREA }));
  assert.equal(early.releases[0]?.upgraded, false);
  assert.deepEqual(
    early.calls,
    ['mail.reply', 'compose.close'],
    'before the upgrade Esc still closes',
  );
});

test('holding Space in an empty body types, then removes the space and dictates; release keeps', () => {
  const kit = setup({
    stack: ['global', 'reader', 'compose'],
    target: THREAD,
    conditions: { emptyBody: true },
  });
  assert.equal(kit.down(SPACE), false, 'the space goes through to the field');
  assert.deepEqual(kit.calls, []);
  kit.state.conditions = { emptyBody: false };
  kit.advance(30);
  assert.equal(kit.down(key({ key: ' ', code: 'Space', repeat: true, target: TEXTAREA })), true);
  kit.advance(220);
  assert.equal(kit.removed(), 1, 'the typed space is removed');
  assert.deepEqual(kit.calls, ['compose.dictate']);
  kit.up(SPACE);
  assert.equal(kit.releases[0]?.commandId, 'compose.dictate');
  assert.equal(kit.releases[0]?.upgraded, true);
  assert.equal(kit.releases[0]?.ended, 'up');
});

test('a quick Space tap in an empty body only types', () => {
  const kit = setup({
    stack: ['global', 'reader', 'compose'],
    target: THREAD,
    conditions: { emptyBody: true },
  });
  kit.down(SPACE);
  kit.advance(80);
  kit.up(SPACE);
  kit.advance(1000);
  assert.equal(kit.removed(), 0);
  assert.deepEqual(kit.calls, []);
  assert.equal(kit.releases[0]?.upgraded, false);
});
