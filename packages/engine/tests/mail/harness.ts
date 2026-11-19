import type { LogRecord } from '@aplos/contract';
import { parseArgs } from '@aplos/contract';
import type { EngineSession } from '@aplos/contract/client';
import { mailHtml } from '@aplos/mail-html';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import type { Caller } from '../../src/methods/types';
import type { ImageProxy, MailHtml, MailHtmlInput, ProxiedImage } from '../../src/ports';
import type { HostFacts } from '../../src/runtime/services';
import { findMessage, type MessageRef } from '../../src/mail/message';
import { openStore, type BodyRecord, type StoreWrite } from '../../src/store';
import { manualClock } from '../runtime.helpers';
import { ACCOUNT, accountWrite, folderWrites, msg, T0, tempDb } from '../store/helpers';

// A real engine over a temp `mail.db` (opened with every lane's writers), the real sanitizer behind a counting wrapper,
// and fake provider and image-proxy ports that record what they were asked. Sessions are made in a fixed order, so
// their connection ids are known: the window ids main's relay will pass to `Mail/serve` (html-5).

export { ACCOUNT, T0 };

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
export const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
);
export const HTML = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');
export const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);

/** An HTML message with one inline part, one remote image and quoted history. */
export const RICH: BodyRecord = {
  html:
    '<p>Hello there</p><img src="cid:logo@x" width="40" height="40">' +
    '<img src="https://img.example/a.png" width="200" height="100">' +
    '<div class="gmail_quote">On Monday someone wrote: old words</div>',
  text: 'Hello there\n> old words',
  cidMap: { 'logo@x': 'part-1' },
  quotedRanges: [{ start: 12, end: 23 }],
};

export const PLAIN: BodyRecord = { text: 'Just text\n> quoted line', cidMap: {} };

/** Message ids (contract form) in the seeded mailbox. */
export const IDS = {
  rich: `${ACCOUNT}:r1`,
  plain: `${ACCOUNT}:r2`,
  remote: `${ACCOUNT}:r3`,
  other: `${ACCOUNT}:r4`,
};

export interface WorldOptions {
  /** Sender of the rich message. */
  from?: string;
  /** What the host says it is (default: a bare host with no capabilities). */
  host?: HostFacts;
  /** Runs on the empty file's path before the store opens it (a file made by an older opener, say). */
  prepare?: (path: string) => void;
}

function seed(from: string): StoreWrite[] {
  return [
    accountWrite,
    ...folderWrites,
    msg('r1', 't1', 0, { from: { address: from, name: 'Sender' } }),
    msg('r2', 't2', 1),
    msg('r3', 't3', 2, { from: { address: 'news@shop.example' } }),
    msg('r4', 't4', 3),
    { kind: 'body', accountId: ACCOUNT, remoteId: 'r1', body: RICH },
    { kind: 'body', accountId: ACCOUNT, remoteId: 'r2', body: PLAIN },
    { kind: 'body', accountId: ACCOUNT, remoteId: 'r4', body: RICH },
  ];
}

export async function mailWorld(options: WorldOptions = {}) {
  const file = tempDb();
  options.prepare?.(file.path);
  const db = file.open();
  const store = openStore(db, { now: () => T0, extensions: laneExtensions() });
  store.commit({ opId: 'seed', origin: 'sync', writes: seed(options.from ?? 'ada@corp.example') });
  const clock = manualClock();
  const records: LogRecord[] = [];
  const log = createLogger({ sink: { write: r => records.push(r) }, salt: 'mail', clock });
  const calls = { opened: [] as string[], parts: [] as string[], images: [] as string[] };
  const renders: MailHtmlInput[] = [];
  const html = {
    version: 'v1',
    render(input: MailHtmlInput) {
      renders.push(input);
      return mailHtml.render(input);
    },
  };
  /** The provider's copy of bodies the store does not hold yet (`openThread` commits them). */
  const remote = new Map<string, BodyRecord>([['r3', RICH]]);
  const parts = new Map<string, Uint8Array>([['part-1', PNG]]);
  let image: ProxiedImage = { kind: 'image', mime: 'image/png', bytes: PNG };
  let imageFn: (() => Promise<ProxiedImage>) | undefined;
  let stream: (() => AsyncIterable<Uint8Array>) | undefined;
  /** What `status(account)` answers: undefined (no runtime facts) unless a test sets a pause. */
  let accountStatus: unknown;
  const accounts = {
    status: () => accountStatus,
    async openThread(account: string, thread: string, opts?: { lane?: string }) {
      calls.opened.push(`${account} ${thread} ${opts?.lane}`);
      const writes: StoreWrite[] = [...remote].map(([remoteId, body]) => ({
        kind: 'body',
        accountId: account,
        remoteId,
        body,
      }));
      if (writes.length)
        store.commit({ opId: `open-${calls.opened.length}`, origin: 'sync', writes });
      return { messages: [], costUnits: 1 };
    },
    async attachment(account: string, ref: { remoteMessageId: string; part: string }) {
      calls.parts.push(`${account} ${ref.remoteMessageId} ${ref.part}`);
      if (stream) return stream();
      const bytes = parts.get(ref.part);
      if (!bytes) throw new Error('no part');
      return (async function* () {
        yield bytes.slice(0, 3);
        yield bytes.slice(3);
      })();
    },
  };
  const images: ImageProxy = {
    async fetch(url, opts) {
      calls.images.push(`${opts.token} ${url}`);
      return imageFn ? imageFn() : image;
    },
  };
  const engine = await createEngine({
    store,
    clock,
    log,
    validate: parseArgs as (m: string, a: unknown) => unknown,
    ports: { accounts: accounts as never, html: html as MailHtml, images },
    ...(options.host ? { host: options.host } : {}),
  });
  // Connection ids are `c1`, `c2`, ... in connect order: window A, window B, then main.
  const windowA = engine.connect();
  const windowB = engine.connect();
  const host: Caller = { kind: 'host', scopes: ['host', 'read'] };
  const main = engine.connect(host);
  return {
    engine,
    store,
    clock,
    calls,
    renders,
    html,
    remote,
    parts,
    windowA,
    windowB,
    main,
    ids: { windowA: 'c1', windowB: 'c2' },
    /** Writes around the store, for state another lane's unbuilt writer would leave. */
    rawSql(sql: string, ...params: (string | number)[]) {
      db.prepare(sql).run(...params);
    },
    /** Replaces every inline part's byte stream (a stalled provider, say). */
    setStream(next: () => AsyncIterable<Uint8Array>) {
      stream = next;
    },
    refOf(messageId: string): MessageRef {
      const ref = store.read(q => findMessage(q, messageId));
      if (!ref) throw new Error(`no message ${messageId}`);
      return ref;
    },
    /** The account runtime `status` answers (an `AccountRuntime`-shaped object, or undefined). */
    setAccountStatus(next: unknown) {
      accountStatus = next;
    },
    setImage(next: ProxiedImage) {
      image = next;
      imageFn = undefined;
    },
    /** The proxy answers by calling `next` each time (a host proxy that hangs, say). */
    setImageFn(next: () => Promise<ProxiedImage>) {
      imageFn = next;
    },
    async cleanup() {
      await engine.close();
      store.close();
      file.cleanup();
    },
  };
}

export type World = Awaited<ReturnType<typeof mailWorld>>;

export function frameOf(session: EngineSession, args: Record<string, unknown>) {
  return session.call('Mail/frame', args) as Promise<{
    url: string;
    expiresAt: number;
    bodyKind: string;
    trackersRemoved: number;
    hasRemoteImages: boolean;
    quotedCount: number;
    srcdoc?: string;
  }>;
}

export const tokenIn = (url: string) => url.slice('aplos-mail://m/'.length, -1);

export async function serve(world: World, url: string, path: string, windowId?: unknown) {
  const args: Record<string, unknown> = { token: tokenIn(url), path };
  if (windowId !== undefined) args.windowId = windowId;
  return (await world.main.call('Mail/serve', args)) as {
    status: number;
    headers: Record<string, string>;
    body: Uint8Array;
  };
}

export const text = (body: Uint8Array) => new TextDecoder().decode(body);

/** Lets work queued behind a call (promise jobs, immediates) run. */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve));
}
