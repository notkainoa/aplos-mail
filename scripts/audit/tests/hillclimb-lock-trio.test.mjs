import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, describe, it } from 'node:test';
import { killTrackedChildren, spawnNodeScript } from './hillclimb-children.mjs';

// The three-process stale-takeover interleaving, in its own file so a failure here cannot hide
// behind (or be slowed by) the other lock tests, and so each file stays under the lint line cap.
const tmp = mkdtempSync(join(tmpdir(), 'hillclimb-lock-trio-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(killTrackedChildren);

const counter = 0;
const lockPath = fileURLToPath(new URL('../hillclimb/lock.mjs', import.meta.url));
const spawnScript = spawnNodeScript;

describe('stale-takeover TOCTOU (three real processes)', () => {
  it('three processes: a stale judgement cannot strand a peer live lock', async () => {
    // The 6e3f2fe hole this pins down: A snapshots the stale dir, B legitimately takes
    // over and sits inside its critical section, then A fires takeStaleLock — old code
    // renames B's LIVE lock aside, and while it is gone C publishes a fresh lock; A's
    // rename-back then fails EEXIST and B's live lock is destroyed while C also holds
    // (two holders at once). Every round re-plants a stale lock and re-runs the
    // interleaving; `enter c` inside `enter b`..`exit b` is the overlap. Under the fix
    // A's re-read sees B's token and backs off — the dir is never moved aside, so C
    // never finds the slot path empty.
    const base = join(tmp, `trio-${counter}`);
    mkdirSync(base);
    const d = join(base, 'slot.lock');
    const marker = join(base, 'marker.log');
    const roundF = join(base, 'round');
    const stopF = join(base, 'stop');
    const cFire = join(base, 'c-fire');
    const flag = name => join(base, name);
    const rounds = 30;
    // Child A: snapshot the stale identity, wait until B holds the slot, then fire
    // takeStaleLock with the stale snapshot — the dangerous call this test isolates.
    const aScript = `
      const { takeStaleLock } = await import(${JSON.stringify(lockPath)});
      const fs = await import('node:fs');
      const { join } = await import('node:path');
      const base = ${JSON.stringify(base)}, d = join(base, 'slot.lock');
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const wait = async f => {
        for (let i = 0; i < 30000 && !fs.existsSync(f); i++) await sleep(2);
        if (!fs.existsSync(f)) throw new Error('a: timeout ' + f);
      };
      let seen = 0;
      while (!fs.existsSync(${JSON.stringify(stopF)})) {
        let r = 0;
        try { r = Number(fs.readFileSync(join(base, 'round'), 'utf8').trim()); } catch {}
        if (r <= seen) { await sleep(2); continue; }
        seen = r;
        const expected = {
          pid: Number(fs.readFileSync(join(d, 'pid'), 'utf8').trim()) || null,
          token: fs.readFileSync(join(d, 'token'), 'utf8').trim() || null,
          mtimeMs: fs.statSync(d).mtimeMs,
        };
        fs.writeFileSync(join(base, 'a-ready-' + r), '1');
        await wait(join(base, 'b-held-' + r));
        // Record what takeStaleLock answered: against B's live lock it must return false.
        let answer = 'threw';
        try {
          answer = String(takeStaleLock(d, expected, { pid: process.pid, token: 'a-' + process.pid }));
        } catch {}
        // temp + rename: the test reads the answer the moment the flag appears, so the flag
        // must never exist half-written.
        fs.writeFileSync(join(base, 'a-done-' + r + '.tmp'), answer);
        fs.renameSync(join(base, 'a-done-' + r + '.tmp'), join(base, 'a-done-' + r));
      }
    `;
    // Child B: waits for the go flag, takes the stale lock through withCheckSlot, and
    // holds it inside the critical section until released — enter-b/exit-b bracket it.
    const bScript = `
      const { withCheckSlot } = await import(${JSON.stringify(lockPath)});
      const fs = await import('node:fs');
      const { join } = await import('node:path');
      const base = ${JSON.stringify(base)}, d = join(base, 'slot.lock');
      const marker = join(base, 'marker.log');
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const wait = async f => {
        for (let i = 0; i < 30000 && !fs.existsSync(f); i++) await sleep(2);
        if (!fs.existsSync(f)) throw new Error('b: timeout ' + f);
      };
      let seen = 0;
      while (!fs.existsSync(${JSON.stringify(stopF)})) {
        let r = 0;
        try { r = Number(fs.readFileSync(join(base, 'round'), 'utf8').trim()); } catch {}
        if (r <= seen) { await sleep(2); continue; }
        seen = r;
        await wait(join(base, 'b-go-' + r));
        await withCheckSlot(async () => {
          fs.appendFileSync(marker, 'enter-b\\n');
          fs.writeFileSync(join(base, 'b-held-' + r + '.tmp'), String(process.pid));
          fs.renameSync(join(base, 'b-held-' + r + '.tmp'), join(base, 'b-held-' + r));
          await wait(join(base, 'b-release-' + r));
          fs.appendFileSync(marker, 'exit-b\\n');
        }, { dir: d, pollMs: 2, timeoutMs: 60000, staleMs: 60000 });
        fs.writeFileSync(join(base, 'b-out-' + r), '1');
      }
    `;
    // Child C: while c-fire exists, hammer the real publish protocol (stage + rename).
    // It can only land while the slot path is absent — which under the broken design
    // is exactly the rename-aside gap around a live lock.
    const cScript = `
      const fs = await import('node:fs');
      const { join } = await import('node:path');
      const base = ${JSON.stringify(base)}, d = join(base, 'slot.lock');
      const marker = join(base, 'marker.log');
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      let n = 0;
      let idle = 0;
      while (!fs.existsSync(${JSON.stringify(stopF)})) {
        if (!fs.existsSync(${JSON.stringify(cFire)})) {
          // Idle heartbeat: the test waits for it to advance after clearing c-fire, which proves
          // any in-flight rename/rm iteration has finished before the next round re-plants d.
          // Written via a temp file + rename so the reader never sees a truncated count.
          fs.writeFileSync(join(base, 'c-idle.tmp'), String(++idle));
          fs.renameSync(join(base, 'c-idle.tmp'), join(base, 'c-idle'));
          await sleep(2);
          continue;
        }
        const stage = d + '.c-' + process.pid + '-' + n++;
        try {
          fs.mkdirSync(stage);
          fs.writeFileSync(join(stage, 'token'), 'c-' + process.pid);
          fs.writeFileSync(join(stage, 'pid'), String(process.pid));
          fs.renameSync(stage, d);
          fs.appendFileSync(marker, 'enter-c\\n');
          fs.appendFileSync(marker, 'exit-c\\n');
          fs.rmSync(d, { recursive: true, force: true });
        } catch {
          try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
        }
      }
    `;
    writeFileSync(roundF, '0');
    const settled = Promise.allSettled([
      spawnScript(aScript, 'a'),
      spawnScript(bScript, 'b'),
      spawnScript(cScript, 'c'),
    ]);
    const readIdle = () => {
      try {
        return Number(readFileSync(join(base, 'c-idle'), 'utf8')) || 0;
      } catch {
        return 0;
      }
    };
    const waitFor = async (f, label) => {
      for (let i = 0; i < 1200 && !existsSync(f); i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!existsSync(f)) {
        // Name the state a failure leaves behind: the lock dir's files and the round flags.
        const peek = path => {
          try {
            return readdirSync(path).sort().join(',');
          } catch (error) {
            return error.code;
          }
        };
        const pid = (() => {
          try {
            return readFileSync(join(d, 'pid'), 'utf8').trim();
          } catch (error) {
            return error.code;
          }
        })();
        assert.fail(
          `timeout waiting for ${label}; lock dir [${peek(d)}] pid ${pid}; base [${peek(base)}]`,
        );
      }
    };
    try {
      for (let r = 1; r <= rounds; r++) {
        // Re-plant a stale lock while C is gated off (no c-fire yet), so the only
        // absent-slot moments inside the window are the ones under test.
        rmSync(d, { recursive: true, force: true });
        mkdirSync(d);
        writeFileSync(join(d, 'token'), `stale-${r}`);
        writeFileSync(join(d, 'pid'), '4194304'); // dead pid -> stale
        // Atomic (temp + rename): the children poll this file, and a torn read once produced
        // a bogus round number (a-ready-90) that stranded the whole run.
        writeFileSync(`${roundF}.tmp`, String(r));
        renameSync(`${roundF}.tmp`, roundF);
        await waitFor(flag(`a-ready-${r}`), `a-ready-${r}`);
        writeFileSync(cFire, '1');
        writeFileSync(flag(`b-go-${r}`), '1');
        await waitFor(flag(`a-done-${r}`), `a-done-${r}`);
        // B still holds the slot here (it is released below): A's stale judgement must have been
        // refused, and the lock files must still name B, not A or the planted stale owner.
        assert.equal(
          readFileSync(flag(`a-done-${r}`), 'utf8'),
          'false',
          `round ${r}: takeStaleLock must return false against a peer's live lock`,
        );
        const bPid = readFileSync(flag(`b-held-${r}`), 'utf8').trim();
        assert.equal(readFileSync(join(d, 'pid'), 'utf8').trim(), bPid, `round ${r}: pid names B`);
        assert.ok(
          readFileSync(join(d, 'token'), 'utf8').trim().startsWith(`${bPid}-`),
          `round ${r}: token names B`,
        );
        rmSync(cFire, { force: true });
        // Quiesce C: its in-flight iteration (rename into d, then rm d) must finish before
        // anything re-plants d, or its rm would delete the NEXT round's lock (test race, not
        // a lock defect). Two heartbeats after the removal guarantee one full pass.
        const idle0 = readIdle();
        for (let i = 0; i < 3000 && readIdle() < idle0 + 2; i++) {
          await new Promise(resolve => setTimeout(resolve, 2));
        }
        assert.ok(readIdle() >= idle0 + 2, 'child c never went idle');
        writeFileSync(flag(`b-release-${r}`), '1');
        await waitFor(flag(`b-out-${r}`), `b-out-${r}`);
      }
    } finally {
      writeFileSync(stopF, '1');
      // Give the children a moment to see the stop flag, then kill whatever is left so a
      // failing run can never leave a child holding node:test's pipes open.
      let giveUp;
      await Promise.race([
        settled,
        new Promise(resolve => {
          giveUp = setTimeout(resolve, 15_000);
        }),
      ]);
      clearTimeout(giveUp);
      killTrackedChildren();
    }
    for (const result of await settled) {
      if (result.status === 'rejected') throw result.reason;
    }
    const events = existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : [];
    let depth = 0;
    const overlap = [];
    for (const event of events) {
      if (event.startsWith('enter')) {
        depth++;
        if (depth > 1) overlap.push(event);
      } else if (event.startsWith('exit')) {
        depth--;
      }
    }
    const heldB = events.filter(e => e === 'enter-b').length;
    assert.equal(heldB, rounds, `B held every round: ${events.length} events`);
    assert.deepEqual(overlap, [], `two holders at once: ${events.join(' | ')}`);
  });
});
