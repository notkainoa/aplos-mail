import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, describe, it } from 'node:test';
import {
  HARD_EXIT_PRELUDE,
  killTrackedChildren,
  spawnNodeScript,
  trackChild,
} from './hillclimb-children.mjs';
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
// A failing real-process test must not leak children (they hold node:test's pipes open).
afterEach(killTrackedChildren);

let counter = 0;
const dir = () => join(tmp, `lock-${counter++}.lock`);
const fast = { pollMs: 10, timeoutMs: 5000, staleMs: 60_000 };
const lockPath = fileURLToPath(new URL('../hillclimb/lock.mjs', import.meta.url));

const spawnScript = spawnNodeScript;

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

  it('a pid-less lock dir is only taken once it is older than staleMs', async () => {
    // A FRESH empty dir is not stale: rename(2) onto an empty dir would silently
    // replace it, so acquisition must see it as an existing lock and wait.
    const fresh = dir();
    mkdirSync(fresh);
    await assert.rejects(
      withCheckSlot(() => 'never', { ...fast, dir: fresh, timeoutMs: 120 }),
      /still held/,
    );
    assert.equal(existsSync(fresh), true, 'a fresh empty lock dir must not be stolen');
    rmSync(fresh, { recursive: true, force: true });

    // Same for a fresh pid-less dir that happens to carry a file.
    const freshFiles = dir();
    mkdirSync(freshFiles);
    writeFileSync(join(freshFiles, 'token'), 'half-written-t0');
    await assert.rejects(
      withCheckSlot(() => 'never', { ...fast, dir: freshFiles, timeoutMs: 120 }),
      /still held/,
    );
    rmSync(freshFiles, { recursive: true, force: true });

    // Aged past staleMs, an empty dir is taken over in place.
    const aged = dir();
    mkdirSync(aged);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(aged, old, old);
    const ran = await withCheckSlot(() => 'stale gone', {
      ...fast,
      dir: aged,
      staleMs: 60_000,
    });
    assert.equal(ran, 'stale gone');
  });

  it('times out waiting for a live holder held by this very process', async () => {
    const d = dir();
    await withCheckSlot(
      async () => {
        // The outer call's pid+token are on disk and its token is in `held`: our own
        // live lock must read as ALIVE, not as a recyclable self-pid.
        await assert.rejects(
          withCheckSlot(() => 'never', { ...fast, dir: d, timeoutMs: 60 }),
          /still held/,
        );
      },
      { ...fast, dir: d },
    );
  });

  it('times out waiting for a live holder in another process', async () => {
    const d = dir();
    mkdirSync(d);
    const child = spawn('node', ['-e', 'setTimeout(() => {}, 30000)']);
    try {
      writeFileSync(join(d, 'pid'), String(child.pid)); // a live foreign pid
      await assert.rejects(
        withCheckSlot(() => 'never', { ...fast, dir: d, timeoutMs: 60 }),
        /still held/,
      );
    } finally {
      child.kill('SIGKILL');
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('takes over a lock whose dead holder pid was recycled onto this process', async () => {
    const d = dir();
    mkdirSync(d);
    writeFileSync(join(d, 'token'), 'dead-owner-t0');
    // The recorded pid is a live process — ours — but no token of this dir is in
    // `held`, so the holder is dead and the pid is a recycled one: stale, not live.
    writeFileSync(join(d, 'pid'), String(process.pid));
    const ran = await withCheckSlot(() => 'took over', {
      ...fast,
      dir: d,
      timeoutMs: 300,
    });
    assert.equal(ran, 'took over');
    assert.equal(holderPid(d), null); // released after fn
  });

  it('treats a lock with an unreadable pid file as alive (fail closed)', async () => {
    const d = dir();
    mkdirSync(d);
    writeFileSync(join(d, 'token'), 't0');
    const pidPath = join(d, 'pid');
    writeFileSync(pidPath, '4194304');
    chmodSync(pidPath, 0o000); // EACCES on read — not "no pid file"
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(d, old, old); // even ancient, an unreadable pid must never be stolen
    const warnings = [];
    const origWrite = process.stderr.write;
    process.stderr.write = function (chunk, ...rest) {
      warnings.push(String(chunk));
      return origWrite.call(process.stderr, chunk, ...rest);
    };
    try {
      await assert.rejects(
        withCheckSlot(() => 'never', { ...fast, dir: d, timeoutMs: 120 }),
        /still held/,
      );
      assert.equal(takeStaleLock(d), false, 'an unreadable pid is never judged stale');
      const lines = warnings.filter(w => w.includes('check slot'));
      assert.equal(lines.length, 1, `expected one warning line, got ${JSON.stringify(warnings)}`);
      assert.match(lines[0], /EACCES/);
    } finally {
      process.stderr.write = origWrite;
      chmodSync(pidPath, 0o644);
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('does not sleep a full poll interval past the deadline', async () => {
    const d = dir();
    mkdirSync(d);
    writeFileSync(join(d, 'pid'), '1'); // live foreign holder (launchd)
    const start = Date.now();
    await assert.rejects(
      withCheckSlot(() => 'never', { ...fast, dir: d, timeoutMs: 100, pollMs: 5000 }),
      /still held/,
    );
    assert.ok(Date.now() - start < 3000, `slept past the deadline: ${Date.now() - start}ms`);
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

  it('takes over a stray FILE at the lock path once it is stale', async () => {
    const d = dir();
    writeFileSync(d, 'not a dir');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(d, old, old);
    const ran = await withCheckSlot(() => 'cleared', { ...fast, dir: d, staleMs: 60_000 });
    assert.equal(ran, 'cleared');
    assert.equal(holderPid(d), null);
  });

  it('leaves no staging or graveyard siblings behind', async () => {
    const d = dir();
    await withCheckSlot(() => 'done', { ...fast, dir: d });
    const leftovers = readdirSync(tmp).filter(name => name.startsWith(`${d.split('/').pop()}.`));
    assert.deepEqual(leftovers, []);
  });

  it('uses the conventional lock name under tmpdir', () => {
    assert.equal(lockDir('/x'), join('/x', 'aplos-check-slot.lock'));
  });
});

describe('takeStaleLock', () => {
  it('takes the stale lock in place — the dir is never removed', () => {
    const d = dir();
    mkdirSync(d);
    writeFileSync(join(d, 'pid'), '4194304');
    writeFileSync(join(d, 'token'), 'dead-t0');
    assert.equal(takeStaleLock(d), true);
    // Same dir, still with a complete pid+token pair — now this process's.
    assert.equal(readFileSync(join(d, 'pid'), 'utf8').trim(), String(process.pid));
    assert.ok(readFileSync(join(d, 'token'), 'utf8').trim().length > 0);
    assert.equal(takeStaleLock(d), false, 'the live replacement is not stale');
    rmSync(d, { recursive: true, force: true });
  });

  it('backs off when the judged identity changed (a peer took over first)', () => {
    const d = dir();
    mkdirSync(d);
    writeFileSync(join(d, 'pid'), '4194304');
    writeFileSync(join(d, 'token'), 'dead-t0');
    const expected = { pid: 4194304, token: 'dead-t0' };
    // A peer's live lock now wears a different token: our stale snapshot must not touch it.
    writeFileSync(join(d, 'token'), 'peer-t1');
    writeFileSync(join(d, 'pid'), String(process.pid));
    assert.equal(takeStaleLock(d, expected), false);
    assert.equal(readFileSync(join(d, 'token'), 'utf8').trim(), 'peer-t1');
    rmSync(d, { recursive: true, force: true });
  });

  it('takes over when our pid was recycled but the token is not held by this process', () => {
    const d = dir();
    mkdirSync(d);
    writeFileSync(join(d, 'pid'), String(process.pid));
    writeFileSync(join(d, 'token'), 'dead-owner-t0');
    // pidAlive says "alive" — but no held token of ours matches: the holder is dead
    // and the pid was recycled onto this process, so the lock is stale.
    assert.equal(takeStaleLock(d, { pid: process.pid, token: 'dead-owner-t0' }), true);
    assert.notEqual(readFileSync(join(d, 'token'), 'utf8').trim(), 'dead-owner-t0');
    rmSync(d, { recursive: true, force: true });
  });

  it('never takes a live foreign pid even when the token still matches the snapshot', () => {
    const d = dir();
    mkdirSync(d);
    writeFileSync(join(d, 'pid'), '1'); // launchd: alive, not signalable (EPERM)
    writeFileSync(join(d, 'token'), 'live-t0');
    assert.equal(takeStaleLock(d, { pid: 1, token: 'live-t0' }), false);
    assert.equal(readFileSync(join(d, 'token'), 'utf8').trim(), 'live-t0');
    rmSync(d, { recursive: true, force: true });
  });

  it('backs off a live claim and clears a dead claimant', () => {
    const d = dir();
    mkdirSync(d);
    writeFileSync(join(d, 'pid'), '4194304');
    writeFileSync(join(d, 'token'), 'dead-t0');
    // A live claimant holds the marker: nobody else may touch the dir.
    writeFileSync(join(d, 'claim'), '1'); // launchd: live, not signalable
    assert.equal(takeStaleLock(d), false);
    assert.equal(readFileSync(join(d, 'pid'), 'utf8').trim(), '4194304', 'dir untouched');
    // A claimant that died mid-takeover leaves a claim naming its dead pid; the next
    // contender clears it and completes the takeover.
    writeFileSync(join(d, 'claim'), '4194304');
    assert.equal(takeStaleLock(d), true);
    assert.equal(readFileSync(join(d, 'pid'), 'utf8').trim(), String(process.pid));
    assert.equal(existsSync(join(d, 'claim')), false, 'won claim removed');
    rmSync(d, { recursive: true, force: true });
  });

  it('clears a claim left under our recycled pid — we never wrote it, so it is dead', () => {
    const d = dir();
    mkdirSync(d);
    writeFileSync(join(d, 'pid'), '4194304');
    writeFileSync(join(d, 'token'), 'dead-t0');
    // A claim naming our own pid can only be a dead claimant's marker under a
    // recycled pid: this process reads a claim only after its own O_EXCL create
    // failed, so no live claim of ours can ever be sitting there to read.
    writeFileSync(join(d, 'claim'), String(process.pid));
    assert.equal(takeStaleLock(d), true);
    assert.equal(readFileSync(join(d, 'pid'), 'utf8').trim(), String(process.pid));
    assert.equal(existsSync(join(d, 'claim')), false, 'won claim removed');
    rmSync(d, { recursive: true, force: true });
  });

  it('clears a stray FILE at the lock path and publishes over it', () => {
    const d = dir();
    writeFileSync(d, 'not a dir');
    assert.equal(takeStaleLock(d), true);
    assert.equal(readFileSync(join(d, 'pid'), 'utf8').trim(), String(process.pid));
    rmSync(d, { recursive: true, force: true });
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
      const won = takeStaleLock(d, expected, { pid: process.pid, token: 'racer' });
      if (won) {
        // Old semantics cleared the dir for us to rebuild; new semantics already swapped
        // our identity in place — either way a win means we hold the slot.
        if (!fs.existsSync(d)) {
          fs.mkdirSync(d);
          fs.writeFileSync(join(d, 'token'), 'racer');
          fs.writeFileSync(join(d, 'pid'), String(process.pid));
        }
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

describe('atomic publish (real processes)', () => {
  it('a reader never observes a PERSISTENT lock dir without readable pid and token', async () => {
    // Two children hammer the slot while a third watches. An incomplete listing that
    // keeps re-reading unchanged for 50 ms is a real mid-publish or half-deleted lock —
    // the stage+rename publish and rename-aside release can never produce one. A
    // transiently empty or partial listing of a just-renamed dir is an APFS
    // enumeration artifact (it settles on the next read), so observations must stay
    // stable across a sustained window before they count.
    const d = dir();
    const violations = join(tmp, `partial-${counter}.log`);
    const stop = join(tmp, `partial-${counter}.stop`);
    const hammer = () => `
      const { withCheckSlot } = await import(${JSON.stringify(lockPath)});
      const fs = await import('node:fs');
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 60; i++) {
        await withCheckSlot(async () => { await sleep(2); },
          { dir: ${JSON.stringify(d)}, pollMs: 1, timeoutMs: 30000, staleMs: 60000 });
        await sleep(Math.random() * 3);
      }
    `;
    const watch = `
      const fs = await import('node:fs');
      const { join } = await import('node:path');
      const d = ${JSON.stringify(d)};
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const seen = new Set();
      const list = () => {
        try { return fs.readdirSync(d).sort().join(','); } catch { return null; }
      };
      for (let i = 0; i < 200000 && !fs.existsSync(${JSON.stringify(stop)}); i++) {
        const names = list();
        // An EMPTY listing is the releaser between removing the files and the rmdir (the
        // in-place design); a pid-less empty dir is only ever taken over after staleMs, so a
        // descheduled releaser is harmless and not a violation.
        if (names === null || names === '' || names === 'pid,token') continue;
        // An anomalous listing only counts if the SAME listing keeps re-reading for
        // 50 ms: APFS transiently reports partial/empty enumerations right around a
        // rename and settles on the next read, while a real mid-publish or
        // half-deleted lock dir persists unchanged.
        let stable = true;
        const start = Date.now();
        while (stable && Date.now() - start < 50) {
          await sleep(1);
          const again = list();
          stable = again === names;
        }
        if (stable) seen.add(JSON.stringify(names));
      }
      fs.writeFileSync(${JSON.stringify(violations)}, [...seen].join('\\n'));
    `;
    await Promise.all([
      Promise.all([spawnScript(hammer()), spawnScript(hammer())]).finally(() =>
        writeFileSync(stop, '1'),
      ),
      spawnScript(watch, 'watcher'),
    ]);
    assert.equal(
      readFileSync(violations, 'utf8').trim(),
      '',
      'reader saw a persistently incomplete lock dir',
    );
    assert.equal(existsSync(d), false, 'slot released');
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
        const child = trackChild(
          spawn('node', ['--input-type=module', '-e', HARD_EXIT_PRELUDE + makeScript(name)], {
            stdio: ['ignore', 'ignore', 'pipe'],
          }),
        );
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

describe('stray-file handoff race (real processes)', () => {
  it('a live lock dir swapped over the stray file is never carried aside and deleted', async () => {
    // The child flips the slot path between a stray FILE and its own live lock dir
    // (the real stage+rename publish protocol), while this process hammers
    // takeStaleLock. On the old code the stray-file branch stats the path and then
    // blindly renames whatever it finds aside and deletes it — if the child's live
    // lock dir landed in between, it is destroyed while held, and the child's
    // post-hold verify fails. The fix re-lstats the exact path before the rename
    // (and verifies the moved-aside object after), so a live lock dir can never be
    // carried away.
    const d = dir();
    const base = join(tmp, `stray-race-${counter}`);
    mkdirSync(base);
    const violationF = join(base, 'violation');
    const doneF = join(base, 'done');
    const flips = 800;
    const childScript = `
      const fs = await import('node:fs');
      const d = ${JSON.stringify(d)};
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < ${flips}; i++) {
        try { fs.writeFileSync(d, 'stray-' + i); } catch { await sleep(1); continue; }
        await sleep(1); // leave the file phase open for the hammer to catch
        try { fs.rmSync(d, { force: true }); } catch {}
        const stage = d + '.mine-' + i;
        try {
          fs.mkdirSync(stage);
          fs.writeFileSync(stage + '/token', 'live-' + i);
          fs.writeFileSync(stage + '/pid', String(process.pid));
          fs.renameSync(stage, d);
        } catch {
          try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
          continue; // a peer's lock occupies the path — this round simply lost
        }
        await sleep(2); // held: the lock must survive its whole hold
        // Re-verify for a few ms: during the fixed code's rename-aside->restore window
        // the path is transiently absent for microseconds — only a lock that stays
        // missing or wrong was genuinely carried away and destroyed.
        const verify = () => {
          try {
            return (
              fs.readFileSync(d + '/pid', 'utf8').trim() === String(process.pid) &&
              fs.readFileSync(d + '/token', 'utf8').trim() === 'live-' + i
            );
          } catch {
            return false;
          }
        };
        let ok = verify();
        for (let t = 0; t < 20 && !ok; t++) {
          await sleep(1);
          ok = verify();
        }
        if (!ok) {
          try { fs.writeFileSync(${JSON.stringify(violationF)}, 'iteration ' + i); } catch {}
          process.exit(1);
        }
        try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
      }
      fs.writeFileSync(${JSON.stringify(doneF)}, '1');
    `;
    const child = trackChild(
      spawn('node', ['--input-type=module', '-e', HARD_EXIT_PRELUDE + childScript], {
        stdio: ['ignore', 'ignore', 'pipe'],
      }),
    );
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    const childDone = new Promise(resolve => child.on('close', resolve));
    try {
      const cap = Date.now() + 30000;
      while (!existsSync(doneF) && !existsSync(violationF) && Date.now() < cap) {
        for (let i = 0; i < 200; i++) {
          if (takeStaleLock(d, null, { pid: process.pid, token: 'hammer' })) {
            releaseHeldSlots();
            // Only remove a dir that is still OUR won lock — a child's fresh live
            // lock could have landed in the release->rm gap.
            try {
              const ours =
                readFileSync(join(d, 'pid'), 'utf8').trim() === String(process.pid) &&
                readFileSync(join(d, 'token'), 'utf8').trim() === 'hammer';
              if (ours) rmSync(d, { recursive: true, force: true });
            } catch {
              // Already gone.
            }
          }
        }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    } finally {
      child.kill('SIGKILL');
      await childDone;
    }
    assert.equal(
      existsSync(violationF),
      false,
      `a live lock dir was carried aside and deleted: ${
        existsSync(violationF) ? readFileSync(violationF, 'utf8') : ''
      }`,
    );
    assert.equal(existsSync(doneF), true, `child never finished flipping: ${stderr}`);
  });
});

describe('defaults', () => {
  it('waits up to three hours for a queued suite', () => {
    assert.equal(defaultTimeoutMs, 3 * 60 * 60 * 1000);
  });
});
