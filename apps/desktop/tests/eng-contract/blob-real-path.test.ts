import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComposedHost } from '../../src/host/compose';
import { createProcessState } from '../../src/host/lifecycle';
import {
  createEngineLink,
  createEngineSupervisor,
  createPortBroker,
  type EngineLink,
  type Timers,
  type UtilityRequest,
} from '../../src/host/transports/port';
import type { SendPort } from '../../../../packages/engine/src/ports/engine';
import type { SubmissionPayload } from '../../../../packages/engine/src/ports/provider';
import { fakeClock, fakeWindow, inProcessUtility, portTracker, T0, until } from './rig';

// Blob area work package 10 (plans/engine/blob-area.md): the blob surface over the REAL path — `runEngineUtility`
// and `composeEngineHost` on a temp data folder, the real supervisor and port broker in front of it, real bytes on
// disk in `<dir>/blobs/`. A window `Blob/put`s 5 MB and attaches it to a draft, the engine "process" is killed
// (`crash()` drops the ports and reports exit 137 like a SIGKILL; the composed host still gets its close, which a
// process kill would not run — torn-write safety is the host tests', here everything asserted was committed first),
// the supervisor restarts it, and after the broker re-issues the port `Blob/get` answers the same bytes — the index
// was rebuilt from `list()` over files the dead process fsync'd. The queued send then leaves through an injected
// `SendPort` with those bytes inside the pinned MIME, a second window reads the same blob (every window is the
// `app` principal), a window disconnect drops the caller's unheld blobs but keeps a draft-held one, and a listener
// caller gets `notFound`. No Electron and no network: `testOptions` refuses `fetch`, the fake clock drives the undo
// window, and the send goes to a recording fake, never to a provider.

const timers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: handle => clearTimeout(handle as NodeJS.Timeout),
};

/** Main's side over in-process engine "processes" on one data folder, like real-path.test.ts's. */
function mainSide(
  t: TestContext,
  options: { ports?: Parameters<typeof inProcessUtility>[0]['ports'] } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'aplos-blobpath-'));
  const clock = fakeClock(T0);
  const hosts: ComposedHost[] = [];
  const utilities: ReturnType<typeof inProcessUtility>[] = [];
  const requests: UtilityRequest[] = [];
  const processState = createProcessState();
  const ports = portTracker(t);
  const ups: boolean[] = [];
  const box: { supervisor?: ReturnType<typeof createEngineSupervisor> } = {};
  const broker = createPortBroker({
    channel: ports.channel,
    link: () => box.supervisor?.current(),
  });
  const supervisor = createEngineSupervisor({
    spawn: (): EngineLink => {
      const utility = inProcessUtility({ dir, clock, hosts, ports: options.ports });
      utilities.push(utility);
      return createEngineLink(
        utility.child,
        { dataDir: dir, appVersion: '0.3.0-test' },
        {
          hostEvent: () => undefined,
          request: async request => (requests.push(request), 'posted'),
        },
        timers,
      );
    },
    noteExit: () => processState.noteEngineExit(Date.now()),
    onUp: (_link, restarted) => {
      ups.push(restarted);
      if (restarted) broker.reissue();
    },
    onDown: () => undefined,
    timers,
    restartDelayMs: 10,
  });
  box.supervisor = supervisor;
  // Registered before the folder's removal hook: the engine is closed while the folder still exists.
  t.after(() => supervisor.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, clock, hosts, utilities, requests, ups, broker, supervisor };
}

function pattern(bytes: number) {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < out.length; i++) out[i] = i & 0xff;
  return out;
}

type BlobAnswer = { bytes: Uint8Array; mime: string; size: number; name?: string };

test(
  'blob real path: a put survives an engine kill, the held draft still sends its bytes',
  { timeout: 60_000 },
  async t => {
    const sent: SubmissionPayload[] = [];
    const send: SendPort = {
      admission: () => ({ ok: true }),
      send: async (_account, payload) => {
        sent.push(payload);
        return { acceptedAt: Date.now() };
      },
      findSent: async () => ({ kind: 'absent', checkedAt: Date.now() }),
    };
    const main = mainSide(t, { ports: { send } });
    const link = await main.supervisor.start();
    const ready = await link.ready;

    // A hidden window puts 5 MB and attaches it to a new draft, which the owner sends.
    const one = fakeWindow(1);
    main.broker.connect(one.win);
    const demo = (await one.client.call('Demo/load', {})) as { accountIds: string[] };
    const bytes = pattern(5 * 1024 * 1024);
    const put = (await one.client.call('Blob/put', {
      bytes,
      mime: 'application/pdf',
      name: 'report.pdf',
    })) as { blobId: string };
    assert.match(put.blobId, /^b_[0-9a-f]{32}$/);
    const saved = (await one.client.call('Draft/set', {
      opId: 'blob-realpath-draft',
      fields: {
        accountId: demo.accountIds[0],
        mode: 'new',
        to: [{ address: 'owner@example.com' }],
        cc: [],
        bcc: [],
        subject: 'With attachment',
        html: '<p>Body</p>',
        attachments: [
          {
            id: 'att-1',
            name: 'report.pdf',
            mime: 'application/pdf',
            size: bytes.length,
            blobId: put.blobId,
          },
        ],
        signature: false,
      },
    })) as { draft: { id: string; revision: number } };
    await one.client.call('Submission/set', {
      opId: 'blob-realpath-send',
      action: { type: 'send', draftId: saved.draft.id, revision: saved.draft.revision },
    });

    // The engine process dies before the send drains (SIGKILL: no quit, the ports just stop).
    await main.utilities[0]!.crash();
    await until(() => main.utilities.length === 2 && main.ups.length === 2, 'a restarted engine');
    // The broker re-issued the window's port — a second delivery on the same database.
    await until(() => one.state.deliveries === 2, 'the re-issued port');
    await until(
      () => one.client.position().dbEpoch === ready.dbEpoch,
      'the same mailbox after restart',
    );

    // After the restart the blob reads back byte-for-byte: the index was rebuilt from the files on disk.
    const got = (await one.client.call('Blob/get', { blobId: put.blobId })) as BlobAnswer;
    assert.deepEqual(new Uint8Array(got.bytes), bytes);
    assert.equal(got.name, 'report.pdf');

    // A second window is the same `app` principal: it reads the blob too.
    const two = fakeWindow(2);
    main.broker.connect(two.win);
    const again = (await two.client.call('Blob/get', { blobId: put.blobId })) as BlobAnswer;
    assert.deepEqual(new Uint8Array(again.bytes), bytes);

    // On the restarted engine the window puts two more blobs: one a draft holds, one it never will.
    const held = (await one.client.call('Blob/put', {
      bytes: pattern(64),
      mime: 'text/plain',
      name: 'held.txt',
    })) as { blobId: string };
    await one.client.call('Draft/set', {
      opId: 'blob-realpath-draft-2',
      fields: {
        accountId: demo.accountIds[0],
        mode: 'new',
        to: [{ address: 'owner@example.com' }],
        cc: [],
        bcc: [],
        subject: 'Held',
        html: '<p>Held</p>',
        attachments: [
          {
            id: 'att-2',
            name: 'held.txt',
            mime: 'text/plain',
            size: 64,
            blobId: held.blobId,
          },
        ],
        signature: false,
      },
    });
    const free = (await one.client.call('Blob/put', {
      bytes: pattern(32),
      mime: 'text/plain',
      name: 'free.txt',
    })) as { blobId: string };

    // Closing the first window: the disconnect sweep drops the blob only that connection created and nothing held —
    // `free` goes — while the draft-held one stays. Polling the `free` read is the ordering itself: it can only
    // answer notFound once the detach has been processed on the engine's side.
    main.broker.revoke(1);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await two.client.call('Blob/get', { blobId: free.blobId });
        await new Promise(resolve => setTimeout(resolve, 20));
      } catch (error) {
        assert.equal((error as { type?: string }).type, 'notFound');
        break;
      }
      if (attempt === 99) assert.fail('the unheld blob was never released on disconnect');
    }
    const kept = (await two.client.call('Blob/get', { blobId: held.blobId })) as BlobAnswer;
    assert.deepEqual(new Uint8Array(kept.bytes), pattern(64));
    const still = (await two.client.call('Blob/get', { blobId: put.blobId })) as BlobAnswer;
    assert.deepEqual(new Uint8Array(still.bytes), bytes);

    // The queued send drains on the NEW engine with the bytes the dead one wrote (the undo window is 10 s).
    await main.clock.advance(11_000);
    await until(() => sent.length === 1, 'the send into the fake SendPort');
    const mime = Buffer.from(sent[0]!.mime).toString('latin1').replace(/\r\n/g, '');
    assert.ok(
      mime.includes(Buffer.from(bytes).toString('base64')),
      'the pinned MIME carries the attachment bytes in full',
    );

    // A listener client is its own principal: the app's blob is notFound to it, never its bytes.
    const listener = main.utilities[1]!.host()!.engine.connect({
      kind: 'listener',
      via: 'socket',
      clientId: 'listener-1',
      scopes: ['read'],
    });
    await assert.rejects(listener.call('Blob/get', { blobId: put.blobId }), {
      type: 'notFound',
    });
    listener.close();
  },
);
