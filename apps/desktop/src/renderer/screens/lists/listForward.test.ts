/**
 * F on a list: the cursor row's thread opens as a forward, one row at a time. With rows picked the key belongs to the
 * bulk bar and nothing opens; a draft row is not a thread and is never forwarded; the registry's F reaches it.
 * Run: cd apps/desktop && npx tsx --test src/renderer/screens/lists/listForward.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppRegistry, DEFAULT_KEY_PREFS, type CommandContext } from '../../commands';
import { shellRegistryFor } from '../../shell/ShellRegistry';
import { createListActions, type ListDeps, type ListSnapshot } from './listActions';
import { commandsForList } from './listCommands';

const thread = { id: 't1', participants: [], workflow: {} };
const draft = { id: 'd1', revision: 1, html: '' };

function depsOver(snapshot: Partial<ListSnapshot>, forwarded: string[]): ListDeps {
  const rows: Record<string, unknown> = { t1: thread, d1: draft };
  return {
    kind: 'all',
    snapshot: () => ({
      ids: ['t1', 'd1'],
      key: 't1',
      rowOf: (id: string) => rows[id] as never,
      ...snapshot,
    }),
    forward: (id: string) => void forwarded.push(id),
  } as unknown as ListDeps;
}

test('F forwards the cursor row’s thread, and only a thread', () => {
  const forwarded: string[] = [];
  createListActions(depsOver({}, forwarded)).forward();
  assert.deepEqual(forwarded, ['t1']);
  createListActions(depsOver({ key: 'd1' }, forwarded)).forward();
  assert.deepEqual(forwarded, ['t1'], 'a draft is not forwarded');
  createListActions(depsOver({ key: null }, forwarded)).forward();
  assert.deepEqual(forwarded, ['t1'], 'no cursor, nothing to forward');
});

test('with rows picked F does nothing', () => {
  const forwarded: string[] = [];
  const bulk = { picked: ['t1', 'd1'], loadedIds: ['t1', 'd1'], total: 2, allPicked: false };
  createListActions(depsOver({ bulk: bulk as never }, forwarded)).forward();
  assert.deepEqual(forwarded, []);
});

test('the registry resolves F to Forward in a list and runs it', () => {
  const forwarded: string[] = [];
  const registry = createAppRegistry();
  const detach = shellRegistryFor(registry).register(
    commandsForList(createListActions(depsOver({}, forwarded))),
  );
  const context: CommandContext = {
    stack: ['global', 'list'],
    target: null,
    selection: [],
    conditions: {},
    prefs: DEFAULT_KEY_PREFS,
    focus: 'none',
  };
  const resolution = registry.resolve(
    { key: 'f', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false },
    context,
  );
  assert.equal(resolution?.commandId, 'mail.forward');
  assert.equal(registry.run('mail.forward', context).status, 'ran');
  assert.deepEqual(forwarded, ['t1']);
  detach();
});
