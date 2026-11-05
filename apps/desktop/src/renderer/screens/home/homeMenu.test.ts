// The focus letter's ⋯ menu: every action the letter has a handler for, in order, each with its registry
// command so the Menu shows the real keys (→ or E on Done, ← or L on Later).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAppRegistry } from '../../commands';
import type { MenuEntry } from '../../ui/props';
import { menuEntries } from './HomeMenu';

const REPLY = { verb: 'Reply', icon: 'reply', isDone: false } as const;
const DONE = { verb: 'Done', icon: 'check', isDone: true } as const;

function ids(entries: readonly MenuEntry[]): readonly string[] {
  return entries.map(e => (e.kind === 'item' ? e.id : e.kind));
}

test('the menu lists every action, the suggested verb first and Trash last with the danger style', () => {
  const entries = menuEntries(undefined, REPLY);
  assert.deepEqual(ids(entries), [
    'suggested',
    'later',
    'done',
    'separator',
    'setDate',
    'bookmark',
    'why',
    'separator',
    'trash',
  ]);
  const items = entries.filter((e): e is Extract<MenuEntry, { kind: 'item' }> => e.kind === 'item');
  assert.equal(items[0].label, 'Reply');
  assert.equal(items[0].commandId, 'mail.suggested');
  const last = items[items.length - 1];
  assert.equal(last.id, 'trash');
  assert.equal(last.danger, true);
  assert.ok(
    items.every(item => item.commandId !== undefined),
    'every row draws its key',
  );
});

test('a Done suggestion leaves the second Done out, like the letter does', () => {
  assert.ok(!ids(menuEntries(undefined, DONE)).includes('done'));
  assert.ok(ids(menuEntries(undefined, REPLY)).includes('done'));
});

test('Done and Later each show both keys, the arrow first, from the registry', () => {
  const registry = createAppRegistry();
  assert.equal(registry.describeKeys('mail.done'), '→ or E');
  assert.equal(registry.describeKeys('mail.later'), '← or L');
});

test('the bookmark row reads the row it is on', () => {
  const rows = menuEntries({ workflow: { bookmarked: true } } as never, REPLY);
  const bookmark = rows.find(e => e.kind === 'item' && e.id === 'bookmark');
  assert.equal(bookmark?.kind === 'item' ? bookmark.label : '', 'Remove bookmark');
});
