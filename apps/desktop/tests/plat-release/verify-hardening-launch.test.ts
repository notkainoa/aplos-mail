import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// The script is plain ESM without type declarations, so load it untyped.
const vh = await import(new URL('../../scripts/verify-hardening.mjs', import.meta.url).href);

type Row = { id: string; status: string; reason: string };

// ---- launch checks with a fake spawn: nothing is launched ----

type Plan = { output?: string; exitCode?: number; signal?: string } | undefined;
type Behaviour = (args: string[], env: Record<string, string>) => Plan;
type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal: string) => void;
};
function fakeSpawn(
  behaviour: Behaviour,
  calls: Array<{ args: string[]; env: Record<string, string> }>,
) {
  return (_executable: string, args: string[], options: { env: Record<string, string> }) => {
    calls.push({ args, env: options.env });
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (signal: string) =>
      setImmediate(() => {
        child.emit('exit', null, signal);
        child.emit('close', null, signal);
      });
    const plan = behaviour(args, options.env) ?? {};
    // process.nextTick, not setImmediate: the planned exit then always lands before the check's
    // kill timer, however busy the machine is (a timer could win against setImmediate under load).
    process.nextTick(() => {
      if (plan.output) child.stderr.emit('data', Buffer.from(plan.output));
      if (plan.exitCode !== undefined || plan.signal) {
        const code = plan.signal ? null : plan.exitCode;
        child.emit('exit', code, plan.signal ?? null);
        child.emit('close', code, plan.signal ?? null);
      }
    });
    return child; // no exit planned: keeps "running" until killed
  };
}
const debugArg = (args: string[]) => args.some(a => /^--?(inspect|remote-debugging)/.test(a));
const GUARD = 78;
const IDS = [
  'launch-control',
  'launch-remote-debugging',
  'launch-inspect',
  'launch-run-as-node',
  'launch-node-options',
  'launch-remote-debugging-dash',
];

async function launch(behaviour: Behaviour, extra: Record<string, unknown> = {}) {
  const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
  const removed: string[] = [];
  let n = 0;
  const rows: Row[] = await vh.runLaunchChecks({
    executable: '/nowhere/Aplos Mail',
    spawn: fakeSpawn(behaviour, calls),
    timeoutMs: 40,
    baseEnv: {
      PATH: '/usr/bin',
      NODE_OPTIONS: '--require /tmp/evil.js',
      ELECTRON_RUN_AS_NODE: '1',
    },
    makeTempDir: () => `/tmp/fake-${++n}`,
    removeDir: (dir: string) => removed.push(dir),
    exists: () => false,
    isRunning: () => false,
    ...extra,
  });
  return { rows, calls, removed, statuses: rows.map(r => r.status) };
}

test('launch checks: a hardened release passes (control stays up, debug flags hit the guard)', async () => {
  assert.equal(vh.DEBUG_GUARD_EXIT_CODE, GUARD);
  const { rows, calls, removed } = await launch(args =>
    debugArg(args) ? { exitCode: GUARD } : undefined,
  );
  assert.deepEqual(
    rows.map(r => [r.id, r.status]),
    IDS.map(id => [id, 'PASS']),
  );
  assert.match(rows[1].reason, /refused by the debug guard \(exit code 78\)/);
  assert.match(
    rows[3].reason,
    /behaved like the plain launch \(still running after 0\.04s, then killed\)/,
  );
  assert.match(rows[4].reason, /behavioural smoke test only.*the fuses row is the evidence/);
  assert.deepEqual(removed, [
    '/tmp/fake-1',
    '/tmp/fake-2',
    '/tmp/fake-3',
    '/tmp/fake-4',
    '/tmp/fake-5',
    '/tmp/fake-6',
  ]);
  // Each launch gets its own temp data dir and Chromium profile, and only its own hostile variable.
  calls.forEach((call, i) => {
    assert.equal(call.env.APLOS_DATA_DIR, `/tmp/fake-${i + 1}`);
    assert.equal(call.args[0], `--user-data-dir=/tmp/fake-${i + 1}/chromium`);
  });
  assert.deepEqual(
    calls.map(c => [c.env.ELECTRON_RUN_AS_NODE, c.env.NODE_OPTIONS]),
    [
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
      ['1', undefined],
      [undefined, '--inspect=0'],
      [undefined, undefined],
    ],
  );
});

test("launch checks: an app that exits on every launch passes nothing (the reviewer's repro)", async () => {
  for (const plan of [
    { exitCode: 0 },
    { signal: 'SIGKILL' },
    { signal: 'SIGABRT' },
    { exitCode: GUARD },
  ]) {
    const { rows, calls, statuses } = await launch(() => plan);
    assert.deepEqual(statuses, Array(IDS.length).fill('FAIL'), JSON.stringify(plan));
    assert.match(rows[0].reason, /a plain launch exited .* so the hostile launches prove nothing/);
    assert.match(rows[1].reason, /not run, the plain control launch did not stay up/);
    assert.equal(calls.length, 1, 'no hostile launch after a failed control');
  }
});

test('launch checks: a debug flag must exit with the guard code, not crash or hand off', async () => {
  for (const plan of [{ exitCode: 0 }, { exitCode: 1 }, { signal: 'SIGKILL' }]) {
    const { rows } = await launch(args => (debugArg(args) ? plan : undefined));
    assert.deepEqual(
      rows.slice(1, 3).map(r => r.status),
      ['FAIL', 'FAIL'],
      JSON.stringify(plan),
    );
    assert.match(rows[1].reason, /not with the debug guard's code 78/);
  }
  // RUN_AS_NODE and NODE_OPTIONS must behave like the control: exiting early is a failure.
  const early = await launch((args, env) =>
    debugArg(args)
      ? { exitCode: GUARD }
      : env.ELECTRON_RUN_AS_NODE || env.NODE_OPTIONS
        ? { exitCode: 0 }
        : undefined,
  );
  assert.deepEqual(early.statuses, ['PASS', 'PASS', 'PASS', 'FAIL', 'FAIL', 'PASS']);
  assert.match(early.rows[3].reason, /exited \(code 0\) early, while a plain launch stays up/);
});

test('launch checks: nothing is launched while another copy is running', async () => {
  const { rows, calls } = await launch(() => undefined, {
    isRunning: (name: string) => name === 'Aplos Mail',
  });
  assert.equal(calls.length, 0);
  assert.ok(
    rows.every(
      r => r.status === 'FAIL' && /Aplos Mail is already running; quit it first/.test(r.reason),
    ),
  );
  assert.deepEqual(
    rows.map(r => r.id),
    IDS,
  );
});

test("launch checks: today's unfused build fails every hostile launch", async () => {
  const { rows, statuses } = await launch((args, env) => {
    if (env.ELECTRON_RUN_AS_NODE === '1')
      return { output: `node: bad option: ${args[0]}\n`, exitCode: 9 };
    if (args.some(a => /^--?remote-debugging/.test(a)))
      return { output: 'DevTools listening on ws://127.0.0.1:53111/devtools/browser/x\n' };
    if (args.some(a => a.startsWith('--inspect')) || env.NODE_OPTIONS)
      return { output: 'Debugger listening on ws://127.0.0.1:9229/x\n' };
    return undefined;
  });
  assert.deepEqual(statuses, ['PASS', 'FAIL', 'FAIL', 'FAIL', 'FAIL', 'FAIL']);
  assert.match(rows[1].reason, /exposed a debugger/);
  assert.match(rows[5].reason, /-remote-debugging-port=0 exposed a debugger/);
  assert.match(rows[3].reason, /ran as Node/);
  assert.match(rows[4].reason, /exposed a debugger/);
});

test('launch checks: Node output, a DevToolsActivePort file, staying up and spawn errors all fail', async () => {
  const ranNode = await launch((args, env) =>
    env.ELECTRON_RUN_AS_NODE
      ? { output: 'aplos-ran-as-node' }
      : debugArg(args)
        ? { exitCode: GUARD }
        : undefined,
  );
  assert.equal(ranNode.rows[3].status, 'FAIL');
  assert.match(ranNode.rows[3].reason, /ran as Node/);

  const portFile = await launch(args => (debugArg(args) ? { exitCode: GUARD } : undefined), {
    exists: (path: string) => path.endsWith('/fake-2/chromium/DevToolsActivePort'),
  });
  assert.deepEqual(portFile.statuses, ['PASS', 'FAIL', 'PASS', 'PASS', 'PASS', 'PASS']);

  const stays = await launch(() => undefined);
  assert.match(
    stays.rows[1].reason,
    /still running after 0\.04s, then killed; a release must exit/,
  );
  assert.equal(stays.rows[1].status, 'FAIL');

  const broken = await launch(() => undefined, {
    spawn: () => {
      throw new Error('ENOENT');
    },
  });
  assert.match(broken.rows[0].reason, /could not start the app: ENOENT/);
  assert.ok(broken.rows.every(r => r.status === 'FAIL'));
  assert.equal(broken.removed.length, 1);
});

test('launch checks, guard subset: only the debug launches, no control, allowed beside a running copy', async () => {
  const guardIds = ['launch-remote-debugging', 'launch-inspect', 'launch-remote-debugging-dash'];
  assert.deepEqual(
    (vh.GUARD_CASES as Array<{ id: string }>).map(c => c.id),
    guardIds,
  );
  const ok = await launch(args => (debugArg(args) ? { exitCode: GUARD } : undefined), {
    only: 'guard',
    isRunning: () => true,
  });
  assert.deepEqual(
    ok.rows.map(r => [r.id, r.status]),
    guardIds.map(id => [id, 'PASS']),
  );
  assert.equal(ok.calls.length, 3);
  assert.ok(ok.calls.every(c => debugArg(c.args) && c.args[0].startsWith('--user-data-dir=')));

  // A build without the guard (it starts normally, or exposes a debugger) fails every row.
  const stays = await launch(() => undefined, { only: 'guard' });
  assert.deepEqual(stays.statuses, ['FAIL', 'FAIL', 'FAIL']);
  assert.match(stays.rows[0].reason, /a release must exit/);
  const open = await launch(
    args => (debugArg(args) ? { output: 'DevTools listening on ws://127.0.0.1:1/x\n' } : undefined),
    { only: 'guard' },
  );
  assert.deepEqual(open.statuses, ['FAIL', 'FAIL', 'FAIL']);
});

test('launch checks: Rosetta detection reads the slices and never guesses translated', () => {
  const launchModule = vh.runsTranslated ? vh : null;
  assert.ok(launchModule, 'runsTranslated is exported');
  // A missing file is not "translated": the normal limits apply and the launch itself reports the problem.
  assert.equal(vh.runsTranslated('/nowhere/Aplos Mail'), false);
  if (process.platform === 'darwin') {
    // /usr/bin/true ships with both slices, so neither host translates it.
    assert.equal(vh.runsTranslated('/usr/bin/true', 'arm64'), false);
    assert.equal(vh.runsTranslated('/usr/bin/true', 'x64'), false);
  }
});
