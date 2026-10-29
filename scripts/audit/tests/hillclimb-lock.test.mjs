import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { holderPid, lockDir, withCheckSlot } from '../hillclimb/lock.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'hillclimb-lock-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let counter = 0;
const dir = () => join(tmp, `lock-${counter++}.lock`);
const fast = { pollMs: 10, timeoutMs: 5000, staleMs: 60_000 };

describe('withCheckSlot', () => {
  it('serializes two concurrent holders', async () => {
    const d = dir();
    const order = [];
    const hold = (name, ms) =>
      withCheckSlot(
        async () => {
          order.push(`${name}-start`);
          assert.equal(holderPid(d), process.pid);
          await new Promise(resolve => setTimeout(resolve, ms));
          order.push(`${name}-end`);
        },
        { ...fast, dir: d },
      );
    await Promise.all([hold('a', 80), hold('b', 10)]);
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('releases the slot when fn throws', async () => {
    const d = dir();
    await assert.rejects(
      withCheckSlot(() => Promise.reject(new Error('boom')), { ...fast, dir: d }),
      /boom/,
    );
    const ran = await withCheckSlot(() => 'free again', { ...fast, dir: d });
    assert.equal(ran, 'free again');
  });

  it('takes over a lock whose pid is dead', async () => {
    const d = dir();
    mkdirSync(d);
    // A pid that cannot be alive (way above any real pid, process.kill throws ESRCH).
    writeFileSync(join(d, 'pid'), '4194304');
    const ran = await withCheckSlot(() => 'took over', { ...fast, dir: d });
    assert.equal(ran, 'took over');
    assert.equal(holderPid(d), null); // released after fn
  });

  it('takes over a lock with no pid file older than staleMs', async () => {
    const d = dir();
    mkdirSync(d);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(d, old, old);
    const ran = await withCheckSlot(() => 'stale gone', { ...fast, dir: d, staleMs: 60_000 });
    assert.equal(ran, 'stale gone');
  });

  it('times out waiting for a live holder', async () => {
    const d = dir();
    mkdirSync(d);
    writeFileSync(join(d, 'pid'), String(process.pid)); // ourselves = alive
    await assert.rejects(
      withCheckSlot(() => 'never', { ...fast, dir: d, timeoutMs: 60 }),
      /still held/,
    );
    rmSync(d, { recursive: true, force: true });
  });

  it('uses the conventional lock name under tmpdir', () => {
    assert.equal(lockDir('/x'), join('/x', 'aplos-check-slot.lock'));
  });
});
