import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Frame, NotificationItem } from '@aplos/contract';
import { FakeClock as EmulatorClock, createGmailEmulator } from '@aplos/emulators';
import type { SqlDatabase } from '@aplos/engine/store/sql';
import { fakeClock } from '../../../../packages/engine/src/clock/fake';
import { composeEngineHost, type ComposeOptions } from '../../src/host/compose';
import { openSqlite } from '../../src/host/sqlite';
import { DraftBridge } from '../prov-gmail/draft-bridge';
import { fakeBrowser, getStatus, memoryVault } from '../prov-gov/flow-rig';

const T0 = Date.UTC(2026, 9, 27, 16, 0, 0);
const CLIENT_ID = 'eng-host-compose.apps.example.test';
const CLIENT_SECRET = 'GOCSPX-compose-never-shown';

/** The emulated Gmail, the engine's clock, and every host port the composition takes, as fakes. */
function world(threads = 3) {
  const dir = mkdtempSync(join(tmpdir(), 'aplos-compose-'));
  // The emulator waits out its latency on its own auto clock; the engine's clock moves only when a test moves it.
  const emu = createGmailEmulator({ clock: new EmulatorClock({ start: T0 }), retryAfter: 'none' });
  emu.oauth.addClient(CLIENT_ID, CLIENT_SECRET);
  emu.seedMailbox({ threads, seed: 5 });
  const bridge = new DraftBridge();
  bridge.attach(emu);
  const clock = fakeClock(T0);
  const power = new EventEmitter();
  const events: string[] = [];
  const posted: NotificationItem[] = [];
  const address = emu.users()[0].email;
  const vault = memoryVault();
  const browser = fakeBrowser(consent => {
    const redirect = new URL(emu.oauth.authorize(consent));
    return [Object.fromEntries(redirect.searchParams)];
  });
  const options: ComposeOptions = {
    dataDir: dir,
    fetch: bridge.fetch,
    clock,
    logSink: { write: () => undefined, close: () => void events.push('log.close') },
    deviceId: 'mac-compose',
    power,
    vault,
    env: () => ({ focused: false, windowVisible: true, onBattery: false }),
    openExternal: browser.openExternal,
    googleClient: () => ({
      env: { APLOS_GOOGLE_CLIENT_ID: CLIENT_ID, APLOS_GOOGLE_CLIENT_SECRET: CLIENT_SECRET },
      bundled: {},
    }),
    postNotification: item => {
      posted.push(item);
      return 'posted';
    },
    openDatabase: path => recording(openSqlite(path), events),
  };
  return {
    dir,
    emu,
    bridge,
    clock,
    power,
    events,
    posted,
    address,
    vault,
    emuBrowser: browser,
    options,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

type World = ReturnType<typeof world>;

/** The database, with its close recorded so a test can see when in the shutdown it happened. */
function recording(db: SqlDatabase, events: string[]): SqlDatabase {
  return {
    exec: sql => db.exec(sql),
    prepare: sql => db.prepare(sql),
    close: () => {
      events.push('db.close');
      db.close();
    },
  };
}

/** Moves the engine's clock in small steps until `done` holds; each step lets real I/O (the sign-in callback) run. */
async function pump(w: World, done: () => boolean, what: string, limit = 4_000): Promise<void> {
  for (let i = 0; i < limit; i++) {
    if (done()) return;
    await w.clock.advance(250);
  }
  assert.fail(`timed out waiting for ${what}`);
}

const hasDrafts = (w: World) => w.emu.mailbox.listDrafts().length;

async function withHost(
  w: World,
  fn: (host: Awaited<ReturnType<typeof composeEngineHost>>) => Promise<void>,
  extra: Partial<ComposeOptions> = {},
): Promise<void> {
  const host = await composeEngineHost({ ...w.options, ...extra });
  try {
    await fn(host);
  } finally {
    await host.close();
    w.cleanup();
  }
}

/** Signs the emulated owner in through the engine's own `Account/connect`, and waits for the actor to finish its sync. */
async function connectOwner(w: World, host: Awaited<ReturnType<typeof composeEngineHost>>) {
  const session = host.engine.connect();
  const frames: Frame[] = [];
  session.subscribe(frame => frames.push(frame));
  await session.call('Account/connect', { provider: 'google', loginHint: w.address });
  const connected = () =>
    frames.find(f => f.frame === 'connect' && f.state === 'connected') as
      (Frame & { accountId?: string }) | undefined;
  await pump(w, () => connected() !== undefined, 'the sign-in to finish');
  const accountId = connected()!.accountId!;
  await pump(w, () => host.accounts.status(accountId)?.status !== undefined, 'the actor to start');
  return { session, accountId };
}

test('start: the engine answers a read method, and the account list is empty on a new data folder', async () => {
  const w = world();
  await withHost(w, async host => {
    const session = host.engine.connect();
    const out = (await session.call('Account/get', {})) as { list: unknown[] };
    assert.deepEqual(out.list, []);
    const reminders = (await session.call('Reminder/list', {})) as { items: unknown[] };
    assert.deepEqual(reminders.items, []);
  });
});

test('sign-in through the composed Google connect creates the account and starts its actor', async () => {
  const w = world();
  await withHost(w, async host => {
    const { session, accountId } = await connectOwner(w, host);
    const list = (await session.call('Account/get', {})) as {
      list: { id: string; address: string }[];
    };
    assert.equal(list.list.length, 1);
    assert.equal(list.list[0].id, accountId);
    assert.equal(list.list[0].address, w.address);
  });
});

test('a draft saved through the engine reaches Gmail via the actor host; discarding it removes it with the expected message id', async () => {
  const w = world();
  await withHost(w, async host => {
    const { session, accountId } = await connectOwner(w, host);
    await pump(w, () => host.accounts.status(accountId)?.status.state === 'ok', 'a first sync');
    const removes: unknown[][] = [];
    const remove = host.accounts.remove.bind(host.accounts);
    host.accounts.remove = (...args) => {
      removes.push(args);
      return remove(...args);
    };
    const set = (await session.call('Draft/set', {
      opId: 'compose-draft-1',
      fields: {
        accountId,
        mode: 'new',
        to: [{ address: 'friend@example.test' }],
        cc: [],
        bcc: [],
        subject: 'Composed draft',
        html: '<p>Written through the composed engine.</p>',
        attachments: [],
        signature: false,
      },
    })) as { draft: { id: string } };
    await pump(w, () => hasDrafts(w) === 1, 'the draft to reach Gmail');
    const copy = w.emu.mailbox.listDrafts()[0];
    assert.match(w.emu.mailbox.rawOf(copy.message.id).toString('utf8'), /Composed draft/);
    await session.call('Draft/destroy', { opId: 'compose-draft-2', id: set.draft.id });
    await pump(w, () => hasDrafts(w) === 0, 'the copy to be removed');
    assert.equal(removes.length, 1);
    assert.equal(removes[0][0], accountId);
    assert.equal(removes[0][1], copy.id);
    assert.equal(removes[0][2], copy.message.id, 'the guarded removal names the saved message');
  });
});

test('mail that arrives after the first sync is posted through the notification loop', async () => {
  const w = world();
  await withHost(w, async host => {
    const { accountId } = await connectOwner(w, host);
    await pump(w, () => host.accounts.status(accountId)?.status.state === 'ok', 'a first sync');
    await pump(w, () => accountBaselineDone(host, accountId), 'the baseline');
    w.emu.mailbox.addMessage({
      from: 'new.sender@example.test',
      to: [w.address],
      subject: 'Fresh mail',
      text: 'hello',
      labelIds: ['INBOX', 'UNREAD'],
      internalDate: w.clock.now(),
    });
    host.accounts.request(accountId, { manual: true });
    await pump(w, () => w.posted.length > 0, 'the banner');
    assert.equal(w.posted[0].kind, 'mail');
  });
});

test("an actor's sync commit reaches a window as a state frame (the actors commit through the engine's store)", async () => {
  const w = world();
  await withHost(w, async host => {
    const { session, accountId } = await connectOwner(w, host);
    await pump(w, () => accountBaselineDone(host, accountId), 'the baseline');
    await w.clock.advance(1_000);
    const frames: Frame[] = [];
    session.subscribe(frame => frames.push(frame));
    w.emu.mailbox.addMessage({
      from: 'someone@example.test',
      to: [w.address],
      subject: 'Seen by a window',
      text: 'hi',
      labelIds: ['INBOX', 'UNREAD'],
      internalDate: w.clock.now(),
    });
    host.accounts.request(accountId, { manual: true });
    const stateTypes = () => frames.flatMap(f => (f.frame === 'state' ? Object.keys(f.types) : []));
    await pump(w, () => stateTypes().includes('Message'), 'a state frame for the new mail');
  });
});

function accountBaselineDone(host: Awaited<ReturnType<typeof composeEngineHost>>, id: string) {
  return host.engine.services.store.read(
    q =>
      q.get<{ at: number | null }>('SELECT baseline_done_at AS at FROM accounts WHERE id = ?', id)
        ?.at != null,
  );
}

test('a power resume wakes the engine once, and no longer after close', async () => {
  const w = world();
  await withHost(w, async host => {
    let wakes = 0;
    const wake = host.engine.wake.bind(host.engine);
    host.engine.wake = () => {
      wakes++;
      wake();
    };
    w.power.emit('resume');
    assert.equal(wakes, 1);
    await host.close();
    w.power.emit('resume');
    assert.equal(wakes, 1, 'the power listeners are gone after close');
  });
});

test('close stops the engine, then the actors, then the database, the log and the lock, once', async () => {
  const w = world();
  const host = await composeEngineHost({
    ...w.options,
    lock: () => () => void w.events.push('lock.release'),
  });
  const engineClose = host.engine.close.bind(host.engine);
  host.engine.close = () => {
    w.events.push('engine.close');
    return engineClose();
  };
  const dispose = host.accounts.dispose.bind(host.accounts);
  host.accounts.dispose = () => {
    w.events.push('actors.dispose');
    return dispose();
  };
  const first = host.close();
  const second = host.close();
  assert.equal(first, second, 'a second close is the first one');
  await first;
  await host.close();
  assert.deepEqual(w.events, [
    'engine.close',
    'actors.dispose',
    'db.close',
    'log.close',
    'lock.release',
  ]);
  assert.throws(() => host.engine.connect(), /not running|unavailable/i);
  w.cleanup();
});

test('a second composition on the same data folder is refused by the lock, before it opens anything', async () => {
  const w = world();
  let held = false;
  const lock: ComposeOptions['lock'] = () => {
    if (held) throw new Error('already running');
    held = true;
    return () => {
      held = false;
    };
  };
  const first = await composeEngineHost({ ...w.options, lock });
  const opened = w.events.length;
  await assert.rejects(composeEngineHost({ ...w.options, lock }), /already running/);
  assert.equal(w.events.length, opened, 'the refused composition opened and closed nothing');
  await first.close();
  assert.equal(held, false);
  const again = await composeEngineHost({ ...w.options, lock });
  await again.close();
  w.cleanup();
});

test('a composition that fails while starting stops what it started', async () => {
  const w = world();
  let released = 0;
  const broken: SqlDatabase = {
    exec: () => undefined,
    prepare: () => {
      throw new Error('disk is gone');
    },
    close: () => void w.events.push('db.close'),
  };
  await assert.rejects(
    composeEngineHost({
      ...w.options,
      lock: () => () => void released++,
      openDatabase: () => broken,
    }),
    /disk is gone/,
  );
  assert.equal(released, 1);
  assert.deepEqual(w.events, ['db.close', 'log.close']);
  w.cleanup();
});

test('close ends a sign-in that is still waiting: no listener, a late callback is refused, nothing is stored', async () => {
  const w = world();
  const consents: URL[] = [];
  const host = await composeEngineHost({
    ...w.options,
    openExternal: url => void consents.push(new URL(url)),
  });
  const session = host.engine.connect();
  await session.call('Account/connect', { provider: 'google', loginHint: w.address });
  await pump(w, () => consents.length === 1, 'the browser to open');
  const answer = new URL(w.emu.oauth.authorize(consents[0]));
  const callback = new URL(consents[0].searchParams.get('redirect_uri')!);
  for (const [key, value] of answer.searchParams) callback.searchParams.set(key, value);
  await host.close();
  assert.equal(await getStatus(callback), 0, 'the loopback listener is gone');
  await w.clock.advance(1_000);
  assert.equal(w.vault.writes, 0);
  assert.equal(w.vault.entries.size, 0, 'no refresh token without an account row');
  w.cleanup();
});

test('a banner that rejects is logged, not an unhandled rejection', async () => {
  const w = world();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const records: string[] = [];
  const calls: string[] = [];
  const host = await composeEngineHost({
    ...w.options,
    logSink: { write: record => void records.push(record.event) },
    postNotification: item => {
      calls.push(item.id);
      return Promise.reject(new Error('banner failed: secret text'));
    },
  });
  try {
    host.engine.services.frames.emit({
      frame: 'host',
      event: {
        type: 'reminder',
        item: { id: 'reminder:t1:1', kind: 'reminder', threadId: 't1', title: 'Call', at: T0 },
      },
    });
    await w.clock.advance(100);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(calls, ['reminder:t1:1']);
    assert.deepEqual(unhandled, []);
    assert.ok(records.includes('rpc.failed'));
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await host.close();
    w.cleanup();
  }
});

test('restarting with a draft already due uploads it: the stored account is started before the loop runs', async () => {
  const w = world();
  const first = await composeEngineHost(w.options);
  const { session, accountId } = await connectOwner(w, first);
  await pump(w, () => accountBaselineDone(first, accountId), 'the baseline');
  await session.call('Draft/set', {
    opId: 'restart-draft-1',
    fields: {
      accountId,
      mode: 'new',
      to: [{ address: 'friend@example.test' }],
      cc: [],
      bcc: [],
      subject: 'After a restart',
      html: '<p>Saved before the host quit.</p>',
      attachments: [],
      signature: false,
    },
  });
  await first.close();
  assert.equal(hasDrafts(w), 0, 'closed before the upload was due');
  await w.clock.advance(60_000);
  const second = await composeEngineHost(w.options);
  try {
    assert.ok(second.accounts.status(accountId), 'the stored account was started');
    await pump(w, () => hasDrafts(w) === 1, 'the draft to reach Gmail');
  } finally {
    await second.close();
    w.cleanup();
  }
});

test('with a data key the workflow channel and lease are built, and close leaves nothing running', async () => {
  const w = world();
  const key = new Uint8Array(32).fill(7);
  const keys = { dataKey: () => Promise.resolve(key) } as unknown as NonNullable<
    ComposeOptions['keys']
  >;
  const host = await composeEngineHost({ ...w.options, keys });
  const { accountId } = await connectOwner(w, host);
  await pump(w, () => accountBaselineDone(host, accountId), 'the baseline');
  await pump(w, () => host.accounts.status(accountId)?.lease !== undefined, 'the lease round');
  await host.close();
  assert.equal(w.clock.pending(), 0, 'no timer is left armed');
  w.cleanup();
});
