/**
 * Triage from the reader on the stand-in engine: what Later, Done and Restore act on (the letter on paper), and where the
 * reader goes next. Hands-on test 2026-11-16: Later, then Done, took a thread the owner had not seen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getToasts, resetToasts } from '../../shell/store-toast';
import { createReaderActions } from './readerActions';
import { boot, depsOver } from './readerTestKit';

test('Later then Done act on two different threads, each the one on paper when its key ran', async () => {
  resetToasts();
  const world = await boot();
  try {
    const [first, second, third] = world.doIds();
    const { deps, state, controller } = depsOver(world, first!, false);
    const actions = createReaderActions(deps);
    const homeIds = () => world.home.snapshot().ids;
    actions.later();
    assert.equal(
      controller.snapshot().letter,
      second,
      'Later put the next thread on paper at once',
    );
    assert.ok(!homeIds().includes(first!), 'Later took the first thread');
    assert.ok(homeIds().includes(second!), 'the next thread was not touched');
    actions.done();
    assert.ok(!homeIds().includes(second!), 'Done took the thread on paper');
    assert.ok(homeIds().includes(third!), 'and only that one');
    assert.equal(controller.snapshot().letter, third);
    assert.equal(state.open, third);
    await world.flush();
  } finally {
    world.connection.close();
  }
});

test('Restore sends a thread read from Trash back, leaves like Done, and its Undo brings it back', async () => {
  resetToasts();
  const world = await boot();
  try {
    const [first, second] = world.doIds();
    const { deps, state } = depsOver(world, first!);
    createReaderActions(deps).restore();
    assert.equal(state.open, second, 'the reader moved on to the next thread');
    assert.ok(
      getToasts().some(t => t.message === 'Restored'),
      'one Restored toast',
    );
    await world.flush();
  } finally {
    world.connection.close();
  }
});
