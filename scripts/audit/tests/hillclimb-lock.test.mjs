import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import {
  defaultTimeoutMs,
  holderPid,
  lockDir,
  releaseHeldSlots,
  takeStaleLock,
  withCheckSlot,
} from '../hillclimb/lock.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'hillclimb-lock-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let counter = 0;
const dir = () => join(tmp, `lock-${counter++}.lock`);
const fast = { pollMs: 10, timeoutMs: 5000, staleMs: 60_000 };
const lockPath = fileURLToPath(new URL('../hillclimb/lock.mjs', import.meta.url));

const spawnScript = (script, name = 'child') =>
  new Promise((resolve, reject) => {
    const child = spawn('node', ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${name}: ${stderr}`))));
    child.on('error', reject);
  });

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

  it('treats an unkillable holder as alive (EPERM), never steals its lock', async () => {
    const d = dir();
    mkdirSync(d);
    writeFileSync(join(d, 'pid'), '1'); // launchd/init: exists, not signalable by us
    await assert.rejects(
      withCheckSlot(() => 'never', { ...fast, dir: d, timeoutMs: 60 }),
      /still held/,
    );
    assert.equal(readFileSync(join(d, 'pid'), 'utf8').trim(), '1'); // untouched
    rmSync(d, { recursive: true, force: true });
  });

  it('does not remove a slot whose pid file stopped being ours', async () => {
    const d = dir();
    await withCheckSlot(
      async () => {
        writeFileSync(join(d, 'pid'), String(process.ppid ?? 1)); // "stolen" mid-run
      },
      { ...fast, dir: d },
    );
    assert.equal(existsSync(d), true, 'a foreign pid must not be deleted on release');
    rmSync(d, { recursive: true, force: true });
  });

  it('releaseHeldSlots drops every slot this process holds', async () => {
    const d = dir();
    await withCheckSlot(
      async () => {
        releaseHeldSlots();
        assert.equal(existsSync(d), false);
      },
      { ...fast, dir: d },
    );
    // Usable again right away: nothing was left stale behind.
    assert.equal(await withCheckSlot(() => 'ok', { ...fast, dir: d }), 'ok');
  });

  it('uses the conventional lock name under tmpdir', () => {
    assert.equal(lockDir('/x'), join('/x', 'aplos-check-slot.lock'));
  });
});

describe('takeStaleLock', () => {
  it('lets exactly one contender move the stale dir aside', () => {
    const d = dir();
    mkdirSync(d);
    writeFileSync(join(d, 'pid'), '4194304');
    assert.equal(takeStaleLock(d), true);
    assert.equal(existsSync(d), false, 'stale dir moved aside and removed');
    assert.equal(takeStaleLock(d), false, 'second taker loses the rename race');
  });
});

describe('stale-takeover TOCTOU (real processes)', () => {
  it('a judgement made on the stale dir cannot steal the live lock a peer just won', async () => {
    // Deterministic interleaving: `racer` snapshots the stale dir's identity exactly as
    // the staleness check would, waits until `taker` has legitimately taken the slot over
    // and sits inside its critical section, then calls takeStaleLock — the check->rename
    // gap widened by hand. Under the fix the moved-aside dir proves to be a different,
    // live lock and is put back; unfixed it is discarded and both hold the slot.
    const d = dir();
    mkdirSync(d);
    writeFileSync(join(d, 'token'), 'stale-t0');
    writeFileSync(join(d, 'pid'), '4194304'); // dead pid -> stale for both children
    // The identity snapshot the staleness check captured on the stale dir, taken before
    // any child starts so it cannot already describe the winner's live lock.
    const expected = {
      pid: 4194304,
      token: 'stale-t0',
      mtimeMs: statSync(d).mtimeMs,
    };
    const marker = join(tmp, `race-a-${counter}.log`);
    const go = join(tmp, `race-a-${counter}.go`);
    const takerScript = `
      const { withCheckSlot } = await import(${JSON.stringify(lockPath)});
      const fs = await import('node:fs');
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      await withCheckSlot(async () => {
        fs.appendFileSync(${JSON.stringify(marker)}, 'enter taker\\n');
        fs.writeFileSync(${JSON.stringify(go)}, 'go');
        await sleep(500);
        fs.appendFileSync(${JSON.stringify(marker)}, 'exit taker\\n');
      }, { dir: ${JSON.stringify(d)}, pollMs: 5, timeoutMs: 15000, staleMs: 60000 });
    `;
    const racerScript = `
      const { takeStaleLock } = await import(${JSON.stringify(lockPath)});
      const fs = await import('node:fs');
      const { join } = await import('node:path');
      const d = ${JSON.stringify(d)};
      const marker = ${JSON.stringify(marker)};
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const expected = ${JSON.stringify(expected)};
      for (let i = 0; i < 500 && !fs.existsSync(${JSON.stringify(go)}); i++) await sleep(10);
      const won = takeStaleLock(d, expected);
      if (won) {
        fs.mkdirSync(d);
        fs.writeFileSync(join(d, 'token'), 'racer');
        fs.writeFileSync(join(d, 'pid'), String(process.pid));
        fs.appendFileSync(marker, 'enter racer\\n');
        await sleep(40);
        fs.appendFileSync(marker, 'exit racer\\n');
      } else {
        fs.appendFileSync(marker, 'racer lost\\n');
      }
    `;
    await Promise.all([spawnScript(takerScript, 'taker'), spawnScript(racerScript, 'racer')]);
    const events = readFileSync(marker, 'utf8').trim().split('\n');
    let depth = 0;
    for (const event of events) {
      if (event.startsWith('enter')) {
        depth++;
        assert.ok(depth <= 1, `two holders at once: ${events.join(' | ')}`);
      } else if (event.startsWith('exit')) {
        depth--;
      }
    }
    assert.ok(events.includes('racer lost'), JSON.stringify(events));
    assert.ok(!events.includes('enter racer'), JSON.stringify(events));
    assert.equal(existsSync(d), false, 'taker released the slot');
  });

  it('two contending processes never overlap across 20 stale takeovers', async () => {
    const marker = join(tmp, `race-b-${counter}.log`);
    const base = join(tmp, `races-${counter}`);
    mkdirSync(base);
    // Each child walks 20 slot dirs, replanting a stale (dead-pid) lock when none exists,
    // then entering the real withCheckSlot path. A takeover race lets both hold at once;
    // the marker file then shows two 'enter's without an 'exit' between them.
    const script = name => `
      const { withCheckSlot } = await import(${JSON.stringify(lockPath)});
      const fs = await import('node:fs');
      const { join } = await import('node:path');
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 20; i++) {
        const d = join(${JSON.stringify(base)}, 'slot-' + i + '.lock');
        try {
          fs.mkdirSync(d);
          fs.writeFileSync(join(d, 'token'), 'stale-' + i);
          fs.writeFileSync(join(d, 'pid'), '4194304');
        } catch {}
        await sleep(Math.random() * 10);
        await withCheckSlot(async () => {
          fs.appendFileSync(${JSON.stringify(marker)}, i + ' enter ${name}\\n');
          await sleep(15);
          fs.appendFileSync(${JSON.stringify(marker)}, i + ' exit ${name}\\n');
        }, { dir: d, pollMs: 2, timeoutMs: 30000, staleMs: 60000 });
      }
    `;
    await Promise.all([spawnScript(script('a'), 'a'), spawnScript(script('b'), 'b')]);
    const bySlot = new Map();
    for (const line of readFileSync(marker, 'utf8').trim().split('\n')) {
      const [i, kind] = line.split(' ');
      const list = bySlot.get(i) ?? [];
      list.push(kind);
      bySlot.set(i, list);
    }
    assert.equal(bySlot.size, 20);
    for (const [i, kinds] of bySlot) {
      let depth = 0;
      for (const kind of kinds) {
        if (kind === 'enter') {
          depth++;
          assert.equal(depth, 1, `slot ${i} overlapped: ${kinds.join(', ')}`);
        } else {
          depth--;
        }
      }
      assert.equal(depth, 0, `slot ${i} left unbalanced: ${kinds.join(', ')}`);
    }
  });
});

describe('two concurrent takers (real processes)', () => {
  it('never hold the slot at the same time', async () => {
    const d = dir();
    mkdirSync(d);
    writeFileSync(join(d, 'pid'), '4194304'); // dead pid -> stale for both children
    const log = join(tmp, 'race.log');
    // Each child writes start/end markers around a delay inside the slot. If takeover
    // raced, the log would interleave (start a, start b, ...) or a child would exit 1.
    const makeScript = name => `
      const { withCheckSlot } = await import(${JSON.stringify(lockPath)});
      const fs = await import('node:fs');
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      await withCheckSlot(async () => {
        fs.appendFileSync(${JSON.stringify(log)}, 'start ${name}\\n');
        await sleep(200);
        fs.appendFileSync(${JSON.stringify(log)}, 'end ${name}\\n');
      }, { dir: ${JSON.stringify(d)}, pollMs: 5, timeoutMs: 15000, staleMs: 60000 });
    `;
    const run = name =>
      new Promise((resolve, reject) => {
        const child = spawn('node', ['--input-type=module', '-e', makeScript(name)], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', chunk => {
          stderr += chunk;
        });
        child.on('close', code =>
          code === 0 ? resolve() : reject(new Error(`${name}: ${stderr}`)),
        );
        child.on('error', reject);
      });
    await Promise.all([run('a'), run('b')]);
    const events = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual([...events].sort(), ['end a', 'end b', 'start a', 'start b']);
    // Strict alternation: a held slot means every start is answered by an end before the
    // next start; interleaving (start, start, ...) means two holders at once.
    const starts = events.map(e => e.startsWith('start'));
    assert.deepEqual(starts, [true, false, true, false], `interleaved: ${events}`);
    assert.equal(existsSync(d), false, 'last holder released the slot');
  });
});

describe('defaults', () => {
  it('waits up to three hours for a queued suite', () => {
    assert.equal(defaultTimeoutMs, 3 * 60 * 60 * 1000);
  });
});
