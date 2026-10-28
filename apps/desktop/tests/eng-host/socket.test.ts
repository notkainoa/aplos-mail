import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DoorwayError,
  SUN_PATH_MAX,
  startSocketListener,
  socketPlacement,
  type SocketLimits,
  type SocketListener,
} from '../../src/host/transports/socket';
import { AUTH_REFUSED } from '../../src/host/transports/auth';
import {
  DB_EPOCH,
  fakeBackend,
  fakeRegistry,
  pause,
  rawConnect,
  stateFrame,
  type FakeBackend,
  type FakeRegistry,
  type RawConnection,
} from './doorway-fakes';

/*
 * host-4, the Unix socket: placement and modes, the Hello handshake, framing limits, the method guard and revocation.
 * Real sockets in mkdtemp folders; short timeouts are injected so every case finishes well under two seconds.
 */

const uid = process.getuid?.() ?? 0;
const mode = (path: string) => statSync(path).mode & 0o777;
const scratch = (prefix = 'aplos-sock-') => mkdtempSync(join(tmpdir(), prefix));

interface Rig {
  dataDir: string;
  reg: FakeRegistry;
  be: FakeBackend;
  listener: SocketListener;
}

async function rig(
  t: TestContext,
  limits: Partial<SocketLimits> = {},
  dataDir = scratch(),
): Promise<Rig> {
  const reg = fakeRegistry();
  const be = fakeBackend();
  const listener = await startSocketListener({
    dataDir,
    registry: reg.registry,
    backend: be.backend,
    limits: { helloTimeoutMs: 400, ...limits },
  });
  t.after(async () => {
    await listener.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, reg, be, listener };
}

const helloLine = (token?: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({
    v: 1,
    apiVersion: 1,
    appVersion: '1.0.0',
    client: { name: 'test tool', kind: 'cli' },
    ...(token === undefined ? {} : { token }),
    ...extra,
  })}\n`;

const call = (id: number | string, method: string, args: unknown = {}) =>
  `${JSON.stringify({ v: 1, id, method, args })}\n`;

const frames = (text: string) =>
  text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>);

const lineCount = (n: number) => (text: string) => frames(text).length >= n;

/** Opens a connection and completes the handshake; returns the connection and the hello reply. */
async function open(r: Rig, token: string) {
  const c = await rawConnect({ path: r.listener.path });
  c.socket.write(helloLine(token));
  await c.waitFor(lineCount(1));
  return { c, reply: frames(c.text())[0] };
}

async function expectRefusedHello(c: RawConnection, type: 'forbidden' | 'unsupported') {
  await c.waitFor(lineCount(1));
  const [reply] = frames(c.text());
  assert.equal(reply.ok, false);
  assert.equal((reply.error as { type: string }).type, type);
  await c.closed();
  return reply;
}

test('the socket is 0600 in a 0700 run directory under the data directory', async t => {
  const r = await rig(t);
  assert.equal(r.listener.path, join(r.dataDir, 'run', 'engine.sock'));
  assert.equal(mode(join(r.dataDir, 'run')), 0o700);
  assert.ok(lstatSync(r.listener.path).isSocket());
  assert.equal(mode(r.listener.path), 0o600);
  assert.ok(Buffer.byteLength(r.listener.path) < SUN_PATH_MAX);
});

test('a loose run directory in the data directory is tightened to 0700', async t => {
  const dataDir = scratch();
  mkdirSync(join(dataDir, 'run'), { mode: 0o755 });
  chmodSync(join(dataDir, 'run'), 0o755);
  await rig(t, {}, dataDir);
  assert.equal(mode(join(dataDir, 'run')), 0o700);
});

test('a run directory that is a symlink is refused', async t => {
  const dataDir = scratch();
  const elsewhere = scratch();
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  chmodSync(elsewhere, 0o700);
  symlinkSync(elsewhere, join(dataDir, 'run'));
  await assert.rejects(
    startSocketListener({ dataDir, ...fakes() }),
    (e: unknown) => e instanceof DoorwayError && e.code === 'unsafeDirectory',
  );
  assert.equal(existsSync(join(elsewhere, 'engine.sock')), false);
});

const fakes = () => ({ registry: fakeRegistry().registry, backend: fakeBackend().backend });

/** A data directory deep enough that `<dataDir>/run/engine.sock` is past `sun_path`. */
function longDataDir(): string {
  const dir = join(scratch(), 'a'.repeat(50), 'b'.repeat(50));
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('a data directory too long for sun_path falls back to <tmp>/aplos-<uid>, created 0700', async t => {
  const tmpRoot = scratch('aplos-tmproot-');
  const dataDir = longDataDir();
  assert.ok(Buffer.byteLength(join(dataDir, 'run', 'engine.sock')) >= SUN_PATH_MAX);
  const placement = socketPlacement(dataDir, { uid, tmpRoot });
  assert.equal(placement.fallback, true);
  const listener = await startSocketListener({ dataDir, tmpRoot, ...fakes() });
  t.after(() => listener.close());
  assert.equal(listener.path, join(tmpRoot, `aplos-${uid}`, 'engine.sock'));
  assert.equal(mode(join(tmpRoot, `aplos-${uid}`)), 0o700);
  assert.equal(mode(listener.path), 0o600);
});

test('the /tmp fallback refuses a planted symlink, a loose mode and another owner', async () => {
  const dataDir = longDataDir();
  const planted = scratch('aplos-tmproot-');
  const target = scratch('aplos-attacker-');
  chmodSync(target, 0o700);
  symlinkSync(target, join(planted, `aplos-${uid}`));
  const refused = (e: unknown) => e instanceof DoorwayError && e.code === 'unsafeDirectory';
  await assert.rejects(startSocketListener({ dataDir, tmpRoot: planted, ...fakes() }), refused);
  assert.equal(existsSync(join(target, 'engine.sock')), false);

  const loose = scratch('aplos-tmproot-');
  mkdirSync(join(loose, `aplos-${uid}`), { mode: 0o755 });
  chmodSync(join(loose, `aplos-${uid}`), 0o755);
  await assert.rejects(startSocketListener({ dataDir, tmpRoot: loose, ...fakes() }), refused);
  assert.equal(mode(join(loose, `aplos-${uid}`)), 0o755, 'the fallback is never "repaired"');

  // Another user's directory: simulated by claiming a uid this process does not have.
  const foreign = scratch('aplos-tmproot-');
  const other = uid + 4242;
  mkdirSync(join(foreign, `aplos-${other}`), { mode: 0o700 });
  await assert.rejects(
    startSocketListener({ dataDir, tmpRoot: foreign, uid: other, ...fakes() }),
    refused,
  );
});

/** Leaves a socket file behind with nothing listening: a child binds it and is killed with SIGKILL. */
async function staleSocket(path: string): Promise<void> {
  const script = `require('net').createServer().listen(${JSON.stringify(path)}, () => process.stdout.write('up'))`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>(resolve => child.stdout.once('data', () => resolve()));
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
}

test('a stale socket from a dead process is reclaimed', async t => {
  const dataDir = scratch();
  mkdirSync(join(dataDir, 'run'), { mode: 0o700 });
  await staleSocket(join(dataDir, 'run', 'engine.sock'));
  assert.ok(lstatSync(join(dataDir, 'run', 'engine.sock')).isSocket());
  const r = await rig(t, {}, dataDir);
  const grant = r.reg.grant(['read']);
  const { reply } = await open(r, grant.token);
  assert.equal(reply.ok, true);
});

test('a live socket means another Aplos: the listener refuses to start and leaves it alone', async t => {
  const dataDir = scratch();
  mkdirSync(join(dataDir, 'run'), { mode: 0o700 });
  const path = join(dataDir, 'run', 'engine.sock');
  const other = createServer(socket => socket.end('other\n'));
  await new Promise<void>(resolve => other.listen(path, resolve));
  t.after(() => new Promise<void>(resolve => other.close(() => resolve())));
  await assert.rejects(
    startSocketListener({ dataDir, ...fakes() }),
    (e: unknown) => e instanceof DoorwayError && e.code === 'inUse',
  );
  const c = await rawConnect({ path });
  assert.equal(await c.waitFor(text => text.includes('other')), 'other\n');
});

test('a file that is not a socket in its place is refused, not deleted', async () => {
  const dataDir = scratch();
  mkdirSync(join(dataDir, 'run'), { mode: 0o700 });
  writeFileSync(join(dataDir, 'run', 'engine.sock'), 'keep me');
  await assert.rejects(
    startSocketListener({ dataDir, ...fakes() }),
    (e: unknown) => e instanceof DoorwayError && e.code === 'notSocket',
  );
  assert.ok(existsSync(join(dataDir, 'run', 'engine.sock')));
});

test('hello with a good token: the session comes from the stored client, not from the hello', async t => {
  const r = await rig(t);
  const grant = r.reg.grant(['read', 'draft'], 'cli');
  const c = await rawConnect({ path: r.listener.path });
  // The hello claims to be an MCP client with every scope; neither has any effect.
  c.socket.write(helloLine(grant.token, { client: { name: 'x', kind: 'mcp' }, scopes: ['admin'] }));
  await c.waitFor(lineCount(1));
  const [reply] = frames(c.text());
  assert.deepEqual(reply, {
    ok: true,
    session: { apiVersion: 1, dbEpoch: DB_EPOCH, clientId: grant.id, scopes: ['read', 'draft'] },
  });
  c.socket.write(call(1, 'Thread/get', { ids: ['t1'] }));
  await c.waitFor(lineCount(2));
  assert.deepEqual(frames(c.text())[1], { id: 1, ok: true, result: { method: 'Thread/get' } });
  const [record] = r.be.calls;
  assert.equal(record.caller.kind, 'listener');
  assert.equal(record.caller.via, 'socket');
  assert.equal(record.caller.clientId, grant.id);
  assert.deepEqual(record.caller.scopes, ['read', 'draft']);
});

test('a stored MCP client is limited to the MCP tools over the socket too', async t => {
  const r = await rig(t);
  const grant = r.reg.grant(['read', 'triage', 'draft'], 'mcp');
  const { c } = await open(r, grant.token);
  c.socket.write(call(1, 'Thread/act', { opId: 'op-1', ids: ['t1'], action: { type: 'done' } }));
  c.socket.write(call(2, 'Thread/get', { ids: ['t1'] }));
  await c.waitFor(lineCount(3));
  const [, refusedAct, allowedGet] = frames(c.text());
  assert.equal((refusedAct.error as { type: string }).type, 'forbidden');
  assert.equal(allowedGet.ok, true);
  assert.deepEqual(r.be.executed, ['Thread/get']);
  assert.equal(r.be.calls[0].caller.via, 'mcp');
});

test('an unauthenticated frame before hello is refused and closed, nothing executed', async t => {
  const r = await rig(t);
  const grant = r.reg.grant(['read', 'triage', 'draft', 'send', 'ai', 'admin']);
  const c = await rawConnect({ path: r.listener.path });
  c.socket.write(call(1, 'Thread/get', { ids: ['t1'] }) + helloLine(grant.token));
  const reply = await expectRefusedHello(c, 'forbidden');
  assert.equal((reply.error as { message: string }).message, AUTH_REFUSED);
  assert.equal(frames(c.text()).length, 1, 'the hello after it was never read');
  assert.deepEqual(r.be.entered, []);
});

test('no token, a wrong token and a revoked token get the same refusal and a closed connection', async t => {
  const r = await rig(t);
  const revoked = r.reg.grant(['read']);
  r.reg.revoke(revoked.id);
  const replies: unknown[] = [];
  for (const token of [undefined, 'A'.repeat(43), revoked.token, '', 'x y']) {
    const c = await rawConnect({ path: r.listener.path });
    c.socket.write(helloLine(token));
    replies.push(await expectRefusedHello(c, 'forbidden'));
  }
  assert.ok(replies.every(reply => JSON.stringify(reply) === JSON.stringify(replies[0])));
  assert.deepEqual(r.be.entered, []);
});

test('a hello for another major version gets unsupported with an update message, then closes', async t => {
  const r = await rig(t);
  const grant = r.reg.grant(['read']);
  for (const extra of [{ apiVersion: 2 }, { v: 2 }, { apiVersion: 0 }]) {
    const c = await rawConnect({ path: r.listener.path });
    c.socket.write(helloLine(grant.token, extra));
    const reply = await expectRefusedHello(c, 'unsupported');
    assert.match((reply.error as { message: string }).message, /Update Aplos/);
  }
  assert.deepEqual(r.be.entered, []);
});

const outsideListener = [
  'Ai/setKey', // secret
  'Account/connect', // secret
  'Clients/grant', // uiOnly
  'Listener/set', // uiOnly
  'Consent/grant', // uiOnly
  'Mail/frame', // uiOnly
  'Mail/serve', // host
  'Notification/claim', // host
  'Shell/open', // desktop
  'Ai/pasteKey', // desktop and secret
  'Nope/nope',
  '__proto__',
  'constructor',
  'toString',
  'hasOwnProperty',
];

test('secret, uiOnly, host and desktop methods and prototype keys never reach the backend', async t => {
  const r = await rig(t);
  const grant = r.reg.grant(['read', 'triage', 'draft', 'send', 'ai', 'admin']);
  const { c } = await open(r, grant.token);
  outsideListener.forEach((method, i) => c.socket.write(call(i, method)));
  await c.waitFor(lineCount(1 + outsideListener.length));
  for (const reply of frames(c.text()).slice(1)) {
    assert.equal(reply.ok, false);
    assert.match((reply.error as { type: string }).type, /^(forbidden|unsupported)$/);
  }
  assert.deepEqual(r.be.entered, ['subscribe']);
});

test('a read client calling a send method is forbidden by the contract checkAccess, before the backend', async t => {
  const r = await rig(t);
  const grant = r.reg.grant(['read']);
  const { c } = await open(r, grant.token);
  c.socket.write(
    call('s', 'Submission/set', { opId: 'op-1', draftId: 'd1', action: { type: 'send' } }),
  );
  c.socket.write(call('t', 'Thread/act', { opId: 'op-2', ids: ['t1'], action: { type: 'done' } }));
  await c.waitFor(lineCount(3));
  const [, send, act] = frames(c.text());
  assert.deepEqual([send.id, (send.error as { type: string }).type], ['s', 'forbidden']);
  assert.deepEqual([act.id, (act.error as { type: string }).type], ['t', 'forbidden']);
  assert.deepEqual(r.be.calls, []);
});

test('binary blob methods are refused on the socket (bytes only travel on the HTTP blob routes)', async t => {
  const r = await rig(t);
  const grant = r.reg.grant(['read', 'draft']);
  const { c } = await open(r, grant.token);
  c.socket.write(call(1, 'Blob/get', { blobId: 'b1' }) + call(2, 'Blob/put', {}));
  await c.waitFor(lineCount(3));
  for (const reply of frames(c.text()).slice(1))
    assert.equal((reply.error as { type: string }).type, 'unsupported');
  assert.deepEqual(r.be.calls, []);
});

test('a malformed envelope with an id gets a validation reply; malformed JSON closes the connection', async t => {
  const r = await rig(t);
  const grant = r.reg.grant(['read']);
  const { c } = await open(r, grant.token);
  c.socket.write(`${JSON.stringify({ v: 1, id: 7, args: {} })}\n`);
  await c.waitFor(lineCount(2));
  assert.deepEqual(frames(c.text())[1].id, 7);
  assert.equal((frames(c.text())[1].error as { type: string }).type, 'validation');
  c.socket.write('{not json\n');
  await c.closed();
  assert.deepEqual(r.be.calls, []);
});

test('a second hello after the session opened is a protocol error and closes the connection', async t => {
  const r = await rig(t);
  const grant = r.reg.grant(['read']);
  const { c } = await open(r, grant.token);
  c.socket.write(helloLine(grant.token).repeat(50));
  await c.closed();
  assert.deepEqual(r.be.calls, []);
});

test('a line over the cap closes the connection, before or without its newline', async t => {
  const r = await rig(t, { maxLineBytes: 1024 });
  const grant = r.reg.grant(['read']);
  const pre = await rawConnect({ path: r.listener.path });
  pre.socket.write('x'.repeat(4096));
  await pre.closed();
  const { c } = await open(r, grant.token);
  c.socket.write(call(1, 'Thread/get', { ids: ['x'.repeat(2048)] }));
  await c.closed();
  assert.deepEqual(r.be.calls, []);
});

test('a half-open connection that never says hello is closed at the hello timeout', async t => {
  const r = await rig(t, { helloTimeoutMs: 200 });
  const c = await rawConnect({ path: r.listener.path });
  const ms = await c.closed(1_500);
  assert.ok(ms >= 150 && ms < 1_500, `closed after ${ms} ms`);
  assert.equal(c.text(), '');
});

test('the connection cap refuses connections past it', async t => {
  const r = await rig(t, { maxConnections: 3, helloTimeoutMs: 2_000 });
  const held = await Promise.all([1, 2, 3].map(() => rawConnect({ path: r.listener.path })));
  await pause(50);
  const extra = await rawConnect({ path: r.listener.path });
  await extra.closed(1_000);
  assert.ok(held.every(c => !c.isClosed()));
  assert.equal(r.listener.connections(), 3);
});

test('pipelined calls past the in-flight cap wait their turn; every one is answered', async t => {
  const r = await rig(t, { maxInFlight: 4 });
  const grant = r.reg.grant(['read']);
  r.be.handlers.set('Thread/get', () => pause(5));
  const { c } = await open(r, grant.token);
  let batch = '';
  for (let i = 0; i < 60; i += 1) batch += call(i, 'Thread/get', { ids: ['t1'] });
  c.socket.write(batch);
  await c.waitFor(lineCount(61), 5_000);
  const ids = frames(c.text())
    .slice(1)
    .map(reply => reply.id as number)
    .sort((a, b) => a - b);
  assert.deepEqual(ids, [...Array(60).keys()]);
  assert.ok(r.be.maxConcurrent() <= 4, `peak ${r.be.maxConcurrent()}`);
});

test('frames reach a read client on its session; a client without read gets none', async t => {
  const r = await rig(t);
  const reader = r.reg.grant(['read']);
  const sender = r.reg.grant(['send']);
  const a = await open(r, reader.token);
  const b = await open(r, sender.token);
  r.be.emit(stateFrame(5));
  await a.c.waitFor(lineCount(2));
  assert.deepEqual(frames(a.c.text())[1], stateFrame(5));
  await pause(50);
  assert.equal(frames(b.c.text()).length, 1);
  assert.equal(r.be.subscribers(), 1);
});

test('revoking a client closes its socket session within 1 s and no frame follows', async t => {
  const r = await rig(t);
  const grant = r.reg.grant(['read']);
  const other = r.reg.grant(['read']);
  const { c } = await open(r, grant.token);
  const kept = await open(r, other.token);
  const before = Date.now();
  r.reg.revoke(grant.id);
  await c.closed(1_000);
  assert.ok(Date.now() - before < 1_000);
  r.be.emit(stateFrame(9));
  await kept.c.waitFor(lineCount(2));
  assert.equal(frames(c.text()).length, 1, 'only the hello reply');
  assert.equal(r.be.subscribers(), 1, 'the revoked session unsubscribed');
  const again = await rawConnect({ path: r.listener.path });
  again.socket.write(helloLine(grant.token));
  await expectRefusedHello(again, 'forbidden');
});

test('a revoke that lands while the token is being looked up still refuses the session', async t => {
  const reg = fakeRegistry();
  const be = fakeBackend();
  const grant = reg.grant(['read']);
  const lookup = reg.registry.findByTokenHash;
  reg.registry.findByTokenHash = async hash => {
    const row = await lookup(hash);
    reg.revoke(grant.id);
    return row && { ...row, revokedAt: undefined };
  };
  const dataDir = scratch();
  const listener = await startSocketListener({
    dataDir,
    registry: reg.registry,
    backend: be.backend,
  });
  t.after(() => listener.close());
  const c = await rawConnect({ path: listener.path });
  c.socket.write(helloLine(grant.token));
  await expectRefusedHello(c, 'forbidden');
  assert.deepEqual(be.entered, []);
});

test('close unbinds: the socket file is gone, sessions are closed and connecting fails', async t => {
  const r = await rig(t);
  const grant = r.reg.grant(['read']);
  const { c } = await open(r, grant.token);
  await r.listener.close();
  await c.closed();
  assert.equal(existsSync(r.listener.path), false);
  await assert.rejects(rawConnect({ path: r.listener.path }));
});
