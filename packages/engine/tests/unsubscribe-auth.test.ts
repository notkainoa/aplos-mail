import test from 'node:test';
import assert from 'node:assert/strict';
import type { PinnedTarget } from '../../../apps/desktop/src/host/proxy/resolve';
import { createUnsubscribeExecutor } from '../../../apps/desktop/src/host/providers/google/unsubscribe';
import { handlers, type EngineServices, type MethodContext } from '../src/methods/index';
import { DOMAIN_WINDOW, fromDomain } from '../src/methods/unsubscribe';
import { openStore, type MessageWrite, type StorePort } from '../src/store';
import { ACCOUNT, accountWrite, folderWrites, msg, tempDb } from './store/helpers';

/**
 * RFC 8058 section 4 in `methods/unsubscribe.ts`: one-click only for an authenticated message
 * (`ListHeaders.authenticated === true`), and an authenticated message is the thread's target over any newer one. Runs
 * the real host executor with a fake resolver and transport: no network, and every POST it would send is recorded.
 */

type Executor = EngineServices['unsubscribe'];

const PUBLIC = '93.184.216.34';
const ONE_CLICK = { oneClick: true } as const;
const REAL = 'https://real.example/u';
const EVIL = 'https://evil.example/u';

function recordingExecutor() {
  const posts: PinnedTarget[] = [];
  const executor = createUnsubscribeExecutor({
    resolve: async () => [{ address: PUBLIC, family: 4 }],
    transport: async target => {
      posts.push(target);
      return { status: 200, body: (async function* () {})(), close: () => undefined };
    },
  });
  return { posts, executor };
}

function context(store: StorePort, unsubscribe: Executor): MethodContext {
  return {
    caller: { kind: 'window', scopes: ['read', 'triage'] },
    signal: new AbortController().signal,
    services: { store, unsubscribe } as EngineServices,
    connectionId: 'c1',
    redispatch: () => Promise.reject(new Error('no re-dispatch in these tests')),
  };
}

async function withThread(writes: MessageWrite[], fn: (store: StorePort) => Promise<void>) {
  const file = tempDb();
  const store = openStore(file.open());
  try {
    store.commit({ opId: 'setup', origin: 'sync', writes: [accountWrite, ...folderWrites] });
    store.commit({ opId: 'mail', origin: 'sync', writes });
    await fn(store);
  } finally {
    store.close();
    file.cleanup();
  }
}

const T = `${ACCOUNT}:t1`;

function listMsg(id: string, minutes: number, urls: string[], verdict?: unknown): MessageWrite {
  const auth = verdict === undefined ? {} : { listAuthenticated: verdict as boolean };
  return msg(id, 't1', minutes, { listUnsubscribe: { urls, ...ONE_CLICK }, ...auth });
}

async function getAndRun(store: StorePort, executor: Executor, opId: string) {
  const ctx = context(store, executor);
  const get = await handlers['Unsubscribe/get']({ threadId: T }, ctx);
  const run = await handlers['Unsubscribe/run']({ opId, threadId: T }, ctx);
  return { get, run };
}

test('one-click is allowed for an authenticated message: the POST goes to its URL', async () => {
  await withThread([listMsg('m1', 0, [REAL], true)], async store => {
    const { posts, executor } = recordingExecutor();
    const { get, run } = await getAndRun(store, executor, 'op-1');
    assert.deepEqual(get, { method: 'oneClick' });
    assert.equal(run.outcome, 'done');
    assert.deepEqual(
      posts.map(p => p.hostHeader),
      ['real.example'],
    );
  });
});

test('one-click is refused for a message that is not authenticated, unknown, or carries a non-boolean verdict', async () => {
  for (const verdict of [false, undefined, 'true', 1]) {
    await withThread([listMsg('m1', 0, [REAL], verdict)], async store => {
      const { posts, executor } = recordingExecutor();
      const { get, run } = await getAndRun(store, executor, 'op-1');
      const label = JSON.stringify(verdict) ?? 'absent';
      assert.deepEqual(get, { method: 'link', url: REAL }, label);
      assert.deepEqual(run, { outcome: 'openLink', message: run.message, url: REAL }, label);
      assert.equal(posts.length, 0, `${label}: no POST`);
    });
  }
});

test('a spoofed newer message cannot swap the target: the older authenticated one is used', async () => {
  for (const spoof of [false, undefined]) {
    const writes = [listMsg('m1', 0, [REAL], true), listMsg('m2', 5, [EVIL], spoof)];
    await withThread(writes, async store => {
      const { posts, executor } = recordingExecutor();
      const seen: Parameters<Executor['run']>[0][] = [];
      const watching: Executor = {
        describe: h => executor.describe(h),
        run: request => {
          seen.push(request);
          return executor.run(request);
        },
      };
      const { get, run } = await getAndRun(store, watching, 'op-1');
      assert.deepEqual(get, { method: 'oneClick' });
      assert.equal(run.outcome, 'done');
      assert.equal(seen[0].headers.listUnsubscribe, `<${REAL}>`);
      assert.equal(seen[0].headers.authenticated, true);
      assert.deepEqual(
        posts.map(p => p.hostHeader),
        ['real.example'],
      );
    });
  }
});

test('with no authenticated message the newest one is used, gated to the owner-visible ways', async () => {
  const writes = [listMsg('m1', 0, [REAL]), listMsg('m2', 5, [EVIL], false)];
  await withThread(writes, async store => {
    const { posts, executor } = recordingExecutor();
    const { get, run } = await getAndRun(store, executor, 'op-1');
    assert.deepEqual(get, { method: 'link', url: EVIL }, 'the owner sees where it goes');
    assert.equal(run.outcome, 'openLink');
    assert.equal(run.url, EVIL);
    assert.equal(posts.length, 0);
  });
});

test('mailto stays offered for an unauthenticated message, as a prepared email the owner reviews', async () => {
  const urls = ['mailto:leave@list.example', REAL];
  await withThread([listMsg('m1', 0, urls)], async store => {
    const { posts, executor } = recordingExecutor();
    const { get, run } = await getAndRun(store, executor, 'op-1');
    const mailto = 'mailto:leave@list.example?subject=unsubscribe';
    assert.deepEqual(get, { method: 'mailto', url: mailto });
    assert.equal(run.outcome, 'compose');
    assert.equal(run.url, mailto);
    assert.equal(posts.length, 0);
  });
});

/**
 * Several From domains among the authenticated messages: "authenticated" only means aligned with that message's own
 * From, so a signer of their own domain who replies into a real thread must not become the one-click target.
 */

function fromMsg(
  id: string,
  minutes: number,
  address: string | undefined,
  urls: string[],
  verdict?: boolean,
): MessageWrite {
  const base = listMsg(id, minutes, urls, verdict);
  return { ...base, from: address === undefined ? undefined : { address } };
}

async function posted(writes: MessageWrite[]) {
  let result:
    | { posts: PinnedTarget[]; get: unknown; run: Awaited<ReturnType<typeof getAndRun>>['run'] }
    | undefined;
  await withThread(writes, async store => {
    const { posts, executor } = recordingExecutor();
    const { get, run } = await getAndRun(store, executor, 'op-1');
    result = { posts, get, run };
  });
  return result!;
}

test('one From domain across several authenticated messages keeps the one-click POST', async () => {
  const writes = [
    fromMsg('m1', 0, 'news@real.example', [REAL], true),
    fromMsg('m2', 5, 'deals@real.example', [REAL], true),
    fromMsg('m3', 9, 'news@real.example', [REAL], true),
  ];
  const { get, run, posts } = await posted(writes);
  assert.deepEqual(get, { method: 'oneClick' });
  assert.equal(run.outcome, 'done');
  assert.equal(posts.length, 1);
});

test('the attacker case: two authenticated domains strip the POST for whichever message is the target', async () => {
  const orders: [string, string][] = [
    ['news@real.example', 'x@attacker.example'],
    ['x@attacker.example', 'news@real.example'],
  ];
  for (const [older, newer] of orders) {
    const writes = [fromMsg('m1', 0, older, [REAL], true), fromMsg('m2', 5, newer, [EVIL], true)];
    const { get, run, posts } = await posted(writes);
    assert.deepEqual(
      get,
      { method: 'link', url: EVIL },
      `${older} then ${newer}: the owner sees the page`,
    );
    assert.equal(run.outcome, 'openLink');
    assert.equal(run.url, EVIL);
    assert.equal(posts.length, 0, 'no POST');
  }
});

test('an unauthenticated message from another domain strips the POST of an authenticated target (the safe side)', async () => {
  // The target is still authenticated-first, but every List-Unsubscribe message in the window is compared, so a spoofed
  // reply the provider did not vouch for downgrades the real thread to the page link instead of keeping the POST.
  for (const verdict of [false, undefined]) {
    const writes = [
      fromMsg('m1', 0, 'news@real.example', [REAL], true),
      fromMsg('m2', 5, 'x@attacker.example', [EVIL], verdict),
    ];
    const { get, run, posts } = await posted(writes);
    assert.deepEqual(
      get,
      { method: 'link', url: REAL },
      'still the authenticated message, as a page',
    );
    assert.equal(run.outcome, 'openLink');
    assert.equal(posts.length, 0);
  }
});

test('unauthenticated messages from the same domain keep the POST of the authenticated target', async () => {
  const writes = [
    fromMsg('m1', 0, 'news@real.example', [REAL], true),
    fromMsg('m2', 5, 'deals@Real.Example', [EVIL], false),
    fromMsg('m3', 9, 'news@real.example', [EVIL]),
  ];
  const { get, posts } = await posted(writes);
  assert.deepEqual(get, { method: 'oneClick' });
  assert.deepEqual(
    posts.map(p => p.hostHeader),
    ['real.example'],
  );
});

test('a lone authenticated attacker message over unauthenticated real ones does not get the POST', async () => {
  // The review scenario: the real sender is not authenticated (false, unknown), the attacker's single message is, and it
  // is older. It wins as the target, is alone among the authenticated messages, and must still not be POSTed to.
  const writes = [
    fromMsg('m1', 0, 'x@attacker.example', [EVIL], true),
    fromMsg('m2', 5, 'news@real.example', [REAL], false),
    fromMsg('m3', 9, 'news@real.example', [REAL]),
  ];
  const { get, run, posts } = await posted(writes);
  assert.deepEqual(get, { method: 'link', url: EVIL });
  assert.equal(run.outcome, 'openLink');
  assert.equal(posts.length, 0);
});

test('letter case in the From domain does not make two domains', async () => {
  const writes = [
    fromMsg('m1', 0, 'news@Real.Example', [REAL], true),
    fromMsg('m2', 5, 'News@REAL.example', [REAL], true),
  ];
  const { get, posts } = await posted(writes);
  assert.deepEqual(get, { method: 'oneClick' });
  assert.equal(posts.length, 1);
});

test('subdomains of one organisation are different domains: the POST is stripped', async () => {
  const writes = [
    fromMsg('m1', 0, 'a@news.real.example', [REAL], true),
    fromMsg('m2', 5, 'a@mail.real.example', [REAL], true),
  ];
  const { get, run, posts } = await posted(writes);
  assert.deepEqual(get, { method: 'link', url: REAL });
  assert.equal(run.outcome, 'openLink');
  assert.equal(posts.length, 0);
});

test('a missing or unparseable From counts as an unknown domain: the POST is stripped, even for one message', async () => {
  for (const address of [undefined, 'no-at-sign', 'person@', 'a@b c', 'a@<b>']) {
    const label = String(address);
    const alone = await posted([fromMsg('m1', 0, address, [REAL], true)]);
    assert.deepEqual(alone.get, { method: 'link', url: REAL }, `${label} alone`);
    assert.equal(alone.posts.length, 0, `${label} alone: no POST`);
    const writes = [
      fromMsg('m1', 0, address, [REAL], true),
      fromMsg('m2', 5, 'news@real.example', [REAL], true),
    ];
    const mixed = await posted(writes);
    assert.equal(mixed.run.outcome, 'openLink', `${label} beside a known domain`);
    assert.equal(mixed.posts.length, 0, `${label} beside a known domain: no POST`);
  }
});

test('fromDomain reads the text after the last @, lower-cased, and refuses what it cannot read', () => {
  assert.equal(fromDomain('News@Real.Example'), 'real.example');
  assert.equal(fromDomain('"a@b"@Real.Example'), 'real.example');
  assert.equal(fromDomain(' x@real.example '), 'real.example');
  // Non-ASCII is unknown: the Kelvin sign (U+212A) would otherwise lower-case to the ASCII letter k.
  const kelvin = 'x@K.example';
  const refused = [
    null,
    '',
    'plain',
    'x@',
    'x@ ',
    'x@a b',
    'x@a,b',
    'x@<a>',
    'x@a@',
    kelvin,
    'x@é.example',
  ];
  for (const bad of refused) {
    assert.equal(fromDomain(bad), undefined, JSON.stringify(bad));
  }
});

test('mailto stays offered, as a prepared email the owner reviews, when the domains are mixed', async () => {
  const urls = ['mailto:leave@list.example', REAL];
  const writes = [
    fromMsg('m1', 0, 'news@real.example', urls, true),
    fromMsg('m2', 5, 'x@attacker.example', urls, true),
  ];
  const { get, run, posts } = await posted(writes);
  const mailto = 'mailto:leave@list.example?subject=unsubscribe';
  assert.deepEqual(get, { method: 'mailto', url: mailto });
  assert.equal(run.outcome, 'compose');
  assert.equal(run.url, mailto);
  assert.equal(posts.length, 0);
});

test('DOMAIN_WINDOW is 100, Gmail cap on messages in a thread', () => {
  assert.equal(DOMAIN_WINDOW, 100);
});

test('the window holds 100 OTHER messages: a real message at position 100 is compared, at 101 it is not', async () => {
  // Literal numbers on purpose, so changing DOMAIN_WINDOW or putting the target's own row back into the window turns
  // this red. The real sender's unauthenticated message R is the oldest; the attacker's signed message T is the
  // target (authenticated-first) and `newer` plain messages from the attacker's domain follow. R is the (newer + 1)th
  // OTHER message counted from the newest, because T is left out of the window.
  const probe = (newer: number) => [
    fromMsg('real', 0, 'news@real.example', [REAL]),
    fromMsg('evil', 5, 'x@attacker.example', [EVIL], true),
    ...Array.from({ length: newer }, (_, i) => plainMsg(`e${i}`, 10 + i, 'x@attacker.example')),
  ];
  const atEdge = await posted(probe(99));
  assert.deepEqual(
    atEdge.get,
    { method: 'link', url: EVIL },
    'R is the 100th other message: compared',
  );
  assert.equal(atEdge.posts.length, 0);
  const beyond = await posted(probe(100));
  assert.deepEqual(beyond.get, { method: 'oneClick' }, 'R is the 101st: out of the window');
  assert.equal(beyond.posts.length, 1, 'the documented limit: the POST goes to the target');
});

function plainMsg(id: string, minutes: number, address: string): MessageWrite {
  return msg(id, 't1', minutes, { from: { address } });
}

test('the target is compared too: an old authenticated attacker message is not hidden by a window of real issues', async () => {
  // The review probe: the real sender is not authenticated, the attacker's single signed message is the newest
  // AUTHENTICATED one (so the target) but older than every row in the window, which holds DOMAIN_WINDOW real issues.
  const attacker = fromMsg('evil', 0, 'x@attacker.example', [EVIL], true);
  const issues = Array.from({ length: DOMAIN_WINDOW }, (_, i) =>
    fromMsg(`issue${i}`, 10 + i, 'news@real.example', [REAL]),
  );
  const { get, run, posts } = await posted([attacker, ...issues]);
  assert.deepEqual(get, { method: 'link', url: EVIL });
  assert.equal(run.outcome, 'openLink');
  assert.equal(posts.length, 0);
});

test('messages without List-Unsubscribe are compared: a lone signed header in a personal conversation gets no POST', async () => {
  const writes = [
    plainMsg('p1', 0, 'friend@personal.example'),
    plainMsg('p2', 3, 'friend@personal.example'),
    fromMsg('evil', 5, 'x@attacker.example', [EVIL], true),
  ];
  const { get, run, posts } = await posted(writes);
  assert.deepEqual(get, { method: 'link', url: EVIL });
  assert.equal(run.outcome, 'openLink');
  assert.equal(posts.length, 0);
});

test('plain messages from the target domain keep the POST', async () => {
  const writes = [
    plainMsg('p1', 0, 'Support@Real.Example'),
    fromMsg('m1', 5, 'news@real.example', [REAL], true),
  ];
  const { get, posts } = await posted(writes);
  assert.deepEqual(get, { method: 'oneClick' });
  assert.equal(posts.length, 1);
});

test("the owner's own replies and drafts are not compared", async () => {
  const reply = msg('mine', 't1', 3, {
    from: { address: 'owner@mail.example' },
    flags: { seen: true, flagged: false, draft: false, fromMe: true },
  });
  const draft = msg('draft', 't1', 4, {
    from: { address: 'owner@mail.example' },
    flags: { seen: true, flagged: false, draft: true, fromMe: false },
  });
  const writes = [fromMsg('m1', 0, 'news@real.example', [REAL], true), reply, draft];
  const { get, posts } = await posted(writes);
  assert.deepEqual(get, { method: 'oneClick' });
  assert.equal(posts.length, 1);
});
