/** Keys in a recipient field: ⌘/Ctrl+Return commits typed text and never picks a match or sends past it. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createAppRegistry } from '../../commands';
import { dispatchShellKey } from '../../shell/keys-dispatch';
import { shellRegistryFor } from '../../shell/ShellRegistry';
import { recipientKey, type RecipientKeyEvent, type RecipientKeyState } from './recipientKeys';

const ev = (over: Partial<RecipientKeyEvent> & { key: string }): RecipientKeyEvent => ({
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
  ...over,
});
const JORDAN = { id: 'jordan@example.com', address: 'jordan@example.com' };
const state = (over: Partial<RecipientKeyState> = {}): RecipientKeyState => ({
  query: '',
  recipients: [],
  open: false,
  ...over,
});

describe('recipientKey', () => {
  test('Return picks the highlighted match while the list is open, else commits typed text, else is left alone', () => {
    const open = state({ query: 'jo', open: true, activeSuggestionId: 'a@x.com' });
    assert.deepEqual(recipientKey(ev({ key: 'Enter' }), open), { type: 'pick', id: 'a@x.com' });
    assert.deepEqual(recipientKey(ev({ key: 'Enter' }), state({ query: 'jo' })), {
      type: 'commit',
    });
    assert.equal(recipientKey(ev({ key: 'Enter' }), state()), null);
    assert.deepEqual(
      recipientKey(ev({ key: 'Enter' }), state({ query: 'jo', activeSuggestionId: 'a@x.com' })),
      { type: 'commit' },
      'a highlight with the list shut is not a pick',
    );
  });

  test('⌘Return and Ctrl+Return with text typed are left to the send (never a match); the composer commits the text as it sends', () => {
    const open = state({
      query: 'mina@example.com',
      recipients: [JORDAN],
      open: true,
      activeSuggestionId: 'a@x.com',
    });
    for (const mod of [{ metaKey: true }, { ctrlKey: true }])
      assert.equal(recipientKey(ev({ key: 'Enter', ...mod }), open), null);
  });

  test('⌘Return with nothing typed is left to the composer (the send)', () => {
    const none = state({ recipients: [JORDAN] });
    assert.equal(recipientKey(ev({ key: 'Enter', metaKey: true }), none), null);
    assert.equal(recipientKey(ev({ key: 'Enter', metaKey: true }), state({ query: '  ' })), null);
  });

  test('comma and semicolon commit typed text; Backspace on empty text removes the last person; IME composition does nothing', () => {
    assert.deepEqual(recipientKey(ev({ key: ',' }), state({ query: 'a@b.co' })), {
      type: 'commit',
    });
    assert.deepEqual(recipientKey(ev({ key: ';' }), state({ query: 'a@b.co' })), {
      type: 'commit',
    });
    assert.equal(recipientKey(ev({ key: ',' }), state()), null);
    assert.deepEqual(recipientKey(ev({ key: 'Backspace' }), state({ recipients: [JORDAN] })), {
      type: 'remove',
      id: JORDAN.id,
    });
    assert.equal(
      recipientKey(ev({ key: 'Backspace' }), state({ query: 'x', recipients: [JORDAN] })),
      null,
    );
    assert.equal(
      recipientKey(ev({ key: 'Enter', isComposing: true }), state({ query: 'jo' })),
      null,
    );
  });
});

describe('the shell honours a key the field already handled', () => {
  const textTarget = { tagName: 'INPUT', isContentEditable: false, type: 'text' };
  const composeState = {
    stack: ['global', 'compose'] as const,
    target: null,
    conditions: {},
  };
  const key = (init: Record<string, unknown>) =>
    ({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
      isComposing: false,
      target: textTarget,
      ...init,
    }) as unknown as KeyboardEvent;

  test('⌘Return sends only when the field left it alone; once the field commits and prevents default, nothing sends', () => {
    const shell = shellRegistryFor(createAppRegistry());
    const ran: string[] = [];
    const off = shell.register({ 'compose.send': { run: () => void ran.push('send') } });
    try {
      assert.equal(
        dispatchShellKey(
          shell.registry,
          composeState,
          key({ key: 'Enter', metaKey: true, defaultPrevented: true }),
        ),
        false,
      );
      assert.deepEqual(ran, [], 'a prevented ⌘Return does not send');
      dispatchShellKey(shell.registry, composeState, key({ key: 'Enter', metaKey: true }));
      assert.deepEqual(ran, ['send'], 'the same key, untouched, is the send');
    } finally {
      off();
    }
  });

  test('Esc closes the composer only when nothing prevented it (an open suggestion list does)', () => {
    const shell = shellRegistryFor(createAppRegistry());
    const ran: string[] = [];
    const off = shell.register({ 'compose.close': { run: () => void ran.push('close') } });
    try {
      dispatchShellKey(
        shell.registry,
        composeState,
        key({ key: 'Escape', defaultPrevented: true }),
      );
      assert.deepEqual(ran, []);
      dispatchShellKey(shell.registry, composeState, key({ key: 'Escape' }));
      assert.deepEqual(ran, ['close']);
    } finally {
      off();
    }
  });
});
