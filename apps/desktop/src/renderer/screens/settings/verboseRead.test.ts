/** The renderer's verbose read against the contract fixture: no `on` is a read, and what it answers is what the switch shows. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness } from '../../data/harness';
import { verboseFrom, verboseOn } from './settings.model';

test('Diagnostics/verbose with no on reads the deadline and changes nothing; the switch follows it', async () => {
  const h = createHarness();
  try {
    await h.settle();
    const { api } = h.layer;
    const now = Date.now();
    assert.equal(
      verboseOn(verboseFrom(await api.diagnostics.verbose({})), now),
      false,
      'off at first',
    );
    const set = await api.diagnostics.verbose({ on: true });
    assert.ok(set.until !== undefined, 'turning it on answers when it switches itself off');
    const read = await api.diagnostics.verbose({});
    assert.equal(read.until, set.until, 'a read answers the same deadline');
    assert.equal(
      (await api.diagnostics.verbose({})).until,
      set.until,
      'and reading twice changes nothing',
    );
    assert.equal(verboseOn(verboseFrom(read), set.until! - 1), true, 'the switch opens on');
    assert.equal(verboseOn(verboseFrom(read), set.until!), false, 'and off once the time comes');
    await api.diagnostics.verbose({ on: false });
    assert.equal(
      verboseFrom(await api.diagnostics.verbose({})),
      undefined,
      'off after the owner turns it off',
    );
  } finally {
    h.close();
  }
});
