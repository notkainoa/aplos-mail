/**
 * The reader's keys on a thread from every Home lane: → E ← L R ⇧R Space work whatever the suggested action is
 * (owner decision 2026-11-13). Stand-in engine, real registry, no DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppRegistry, DEFAULT_KEY_PREFS, type CommandContext } from '../../commands';
import { shellRegistryFor } from '../../shell/ShellRegistry';
import { getToasts, resetToasts } from '../../shell/store-toast';
import { createReaderActions } from './readerActions';
import { commandsForReader } from './readerCommands';
import { PLAIN_REPLY, replyRequestOf } from './readerUi';
import { boot, depsOver } from './readerTestKit';

/** Every normal shortcut works in the reader on a thread from every Home lane, whatever its suggestion is (owner decision 2026-11-13). */
for (const lane of ['do', 'update', 'follow'] as const) {
  test(`the reader answers → E ← L R ⇧R Space on a ${lane} thread`, async () => {
    resetToasts();
    const world = await boot();
    try {
      const snap = world.home.snapshot();
      const section = snap.sections.find(s => s.key === lane);
      assert.ok(section && section.count > 0, `the demo has a ${lane} thread`);
      const id = snap.ids[section.start - snap.position]!;
      const { deps, state } = depsOver(world, id);
      const registry = createAppRegistry();
      const detach = shellRegistryFor(registry).register(
        commandsForReader(createReaderActions(deps)),
      );
      const context: CommandContext = {
        stack: ['global', 'list', 'reader'],
        target: null,
        selection: [],
        conditions: {},
        prefs: DEFAULT_KEY_PREFS,
        focus: 'none',
      };
      const press = (k: string, shiftKey = false) => {
        const resolution = registry.resolve(
          { key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey },
          context,
        );
        assert.ok(resolution, `${k} resolves`);
        return registry.run(resolution.commandId, context).status;
      };
      // One triage slot: a verb shows as a new toast taking the place of the last one.
      const toasted = (kind: string) =>
        getToasts()
          .filter(t => t.kind === kind)
          .map(t => t.id)
          .join();
      const undo = async () => {
        assert.equal(press('z'), 'ran');
        await world.flush();
        state.open = id;
      };

      assert.equal(press('R', true), 'ran');
      assert.equal(press('r'), 'ran');
      assert.deepEqual(state.requests, [{ replyAll: true, dictate: false }, PLAIN_REPLY]);

      for (const k of ['ArrowRight', 'e']) {
        const before = toasted('done');
        assert.equal(press(k), 'ran', k);
        assert.notEqual(toasted('done'), before, `${k} is Done`);
        await undo();
      }
      for (const k of ['ArrowLeft', 'l']) {
        const before = toasted('later');
        assert.equal(press(k), 'ran', k);
        assert.notEqual(toasted('later'), before, `${k} is Later`);
        await undo();
      }

      const read = getToasts().length;
      assert.equal(press('u'), 'ran', 'U marks it read or unread');
      assert.equal(getToasts().length, read + 1);
      await undo();

      const toastsBefore = getToasts().length;
      const repliesBefore = state.replies.length;
      const suggestedBefore = state.suggested.length;
      assert.equal(press(' '), 'ran');
      assert.ok(
        getToasts().length > toastsBefore ||
          state.replies.length > repliesBefore ||
          state.suggested.length > suggestedBefore,
        `Space ran the ${lane} thread's suggestion`,
      );
      detach();
      await world.flush();
    } finally {
      world.connection.close();
    }
  });
}

test('a thread opened for a reply asks the reader for that reply card', () => {
  const reply = { replyAll: false, dictate: false, nudge: false };
  assert.deepEqual(replyRequestOf(reply), PLAIN_REPLY);
  assert.deepEqual(replyRequestOf({ ...reply, replyAll: true }), {
    replyAll: true,
    dictate: false,
  });
  assert.deepEqual(replyRequestOf({ ...reply, dictate: true }), { replyAll: false, dictate: true });
  assert.deepEqual(replyRequestOf({ ...reply, nudge: true }), {
    replyAll: false,
    dictate: false,
    suggest: { kind: 'followUp' },
  });
});
