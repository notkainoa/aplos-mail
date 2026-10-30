import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_PROXY_LIMITS } from '@aplos/engine/ports';
import { createImageProxy, type Connector } from '../../src/host/proxy/fetch';
import {
  createSystemResolver,
  MAX_LOOKUPS,
  pinTarget,
  type Resolver,
} from '../../src/host/proxy/resolve';
import { createSemaphore, MAX_IN_FLIGHT, tokenBudget } from '../../src/host/proxy/limits';
import {
  bytes,
  dns,
  NAMES,
  png,
  proxyWith,
  PUBLIC,
  redirect,
  refusedAs,
  reply,
  run,
} from './proxy-fixtures';

// --- Hardening: split-horizon names, redirect downgrade, DNS and fetch concurrency, byte budgets ------------------

test(
  'names a private network answers are refused before any lookup',
  { timeout: 5000 },
  async () => {
    const resolver = dns(NAMES);
    const urls = [
      'http://intranet/',
      'http://printer.local/',
      'http://x.lan/',
      'http://a.internal./',
    ];
    for (const url of [...urls, 'http://router.home.arpa/', 'http://home.arpa/']) {
      const result = await pinTarget(url, IMAGE_PROXY_LIMITS.ports, resolver.resolve);
      assert.deepEqual(result, { ok: false, reason: 'address' }, url);
    }
    assert.deepEqual(resolver.calls, []);
  },
);

test(
  'names that merely contain a private suffix are still resolved',
  { timeout: 5000 },
  async () => {
    const anyName: Resolver = async () => [{ address: PUBLIC, family: 4 }];
    const names = [
      'internal.example',
      'mylocal.com',
      'lan.example.com',
      'home.arpa.example',
      'notlan.org',
    ];
    for (const name of names) {
      const result = await pinTarget(`http://${name}/`, IMAGE_PROXY_LIMITS.ports, anyName);
      assert.equal(result.ok, true, name);
    }
  },
);

test(
  'a secure page is never redirected to plain http, while http may move to https',
  { timeout: 5000 },
  async () => {
    const toHttp = proxyWith(() => redirect('http://img.example/b'));
    assert.deepEqual(
      await toHttp.proxy.fetch('https://img.example/a', run()),
      refusedAs('redirects'),
    );
    assert.equal(toHttp.server.targets.length, 1, 'the downgraded target is never connected to');
    const upgrade = proxyWith(target =>
      target.secure ? reply(200, png(1, 1)) : redirect('https://img.example/b'),
    );
    assert.equal((await upgrade.proxy.fetch('http://img.example/a', run())).kind, 'image');
    const stays = proxyWith(target =>
      target.path === '/a' ? redirect('http://img.example/b') : reply(200, png(1, 1)),
    );
    assert.equal((await stays.proxy.fetch('http://img.example/a', run())).kind, 'image');
  },
);

const tick = () => new Promise(done => setImmediate(done));

/** A lookup that never answers on its own: each call is recorded and settled by the test. */
function stuckLookup() {
  const started: string[] = [];
  const settle: ((error?: Error) => void)[] = [];
  const lookup = (host: string) =>
    new Promise<{ address: string; family: number }[]>((resolve, reject) => {
      started.push(host);
      settle.push(error => (error ? reject(error) : resolve([{ address: PUBLIC, family: 4 }])));
    });
  return { lookup, started, settle };
}

test(
  'at most two DNS lookups run at once: the third waits for a slot',
  { timeout: 5000 },
  async () => {
    assert.equal(MAX_LOOKUPS, 2);
    const stuck = stuckLookup();
    const resolve = createSystemResolver(stuck.lookup);
    const outcomes = ['a', 'b', 'c', 'd'].map(host =>
      resolve(host).then(
        () => 'fulfilled',
        () => 'rejected',
      ),
    );
    await tick();
    assert.deepEqual(stuck.started, ['a', 'b']);
    stuck.settle[0]();
    await tick();
    assert.deepEqual(stuck.started, ['a', 'b', 'c'], 'a freed slot goes to the next in line');
    stuck.settle[1](new Error('SERVFAIL'));
    await tick();
    assert.deepEqual(stuck.started, ['a', 'b', 'c', 'd'], 'a failed lookup frees its slot too');
    stuck.settle[2]();
    stuck.settle[3]();
    assert.deepEqual(await Promise.all(outcomes), [
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
  },
);

test(
  'a queued lookup whose fetch gave up leaves the line, but a running one keeps its slot',
  { timeout: 5000 },
  async () => {
    const stuck = stuckLookup();
    const resolve = createSystemResolver(stuck.lookup);
    const controller = new AbortController();
    void resolve('a');
    void resolve('b');
    const waiting = resolve('c', controller.signal);
    const next = resolve('d');
    await tick();
    controller.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
    stuck.settle[0]();
    await tick();
    assert.deepEqual(stuck.started, ['a', 'b', 'd'], 'c never ran');
    void next;
    stuck.settle[1]();
    stuck.settle[2]();
  },
);

test(
  'fetches whose DNS is stuck time out as timeout without running more than two lookups',
  { timeout: 5000 },
  async () => {
    const stuck = stuckLookup();
    const proxy = createImageProxy({
      resolve: createSystemResolver(stuck.lookup),
      limits: { timeoutMs: 40 },
    });
    const urls = ['a', 'b', 'c', 'd'].map(name => `https://${name}.example/x`);
    const results = await Promise.all(urls.map(url => proxy.fetch(url, run())));
    assert.deepEqual(
      results,
      urls.map(() => refusedAs('timeout')),
    );
    assert.deepEqual(stuck.started, ['a.example', 'b.example']);
  },
);

test(
  'a semaphore holds at most max, passes slots in order and drops aborted waiters',
  { timeout: 5000 },
  async () => {
    const slots = createSemaphore(2);
    const first = await slots.acquire();
    const second = await slots.acquire();
    const order: string[] = [];
    const controller = new AbortController();
    const third = slots.acquire().then(release => (order.push('third'), release));
    const dropped = slots.acquire(controller.signal);
    const fifth = slots.acquire().then(release => (order.push('fifth'), release));
    await tick();
    assert.deepEqual(order, []);
    controller.abort();
    await assert.rejects(dropped, { name: 'AbortError' });
    first();
    first();
    await tick();
    assert.deepEqual(order, ['third'], 'releasing twice frees one slot, not two');
    second();
    await tick();
    assert.deepEqual(order, ['third', 'fifth']);
    (await third)();
    (await fifth)();
    await assert.rejects(slots.acquire(controller.signal), { name: 'AbortError' });
  },
);

test(
  'no more than six fetches are in flight at once, and the rest still finish',
  { timeout: 5000 },
  async () => {
    assert.equal(MAX_IN_FLIGHT, 6);
    let open = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const connect: Connector = async () => {
      open += 1;
      peak = Math.max(peak, open);
      await new Promise<void>(done => gates.push(done));
      open -= 1;
      return reply(200, png(1, 1));
    };
    const proxy = createImageProxy({ resolve: dns(NAMES).resolve, connect });
    const all = Array.from({ length: 20 }, (_, i) =>
      proxy.fetch(`https://img.example/${i}`, run()),
    );
    await tick();
    await tick();
    assert.equal(open, 6);
    while (gates.length > 0) {
      gates.shift()?.();
      await tick();
      await tick();
    }
    const results = await Promise.all(all);
    assert.ok(results.every(result => result.kind === 'image'));
    assert.equal(peak, 6);
  },
);

test(
  'a fetch waiting for a slot is cut off by the time limit and by an abort without taking one',
  { timeout: 5000 },
  async () => {
    const connect: Connector = (_target, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      );
    const proxy = createImageProxy({
      resolve: dns(NAMES).resolve,
      connect,
      limits: { maxInFlight: 1, timeoutMs: 60 },
    });
    const holder = proxy.fetch('https://img.example/a', run());
    const controller = new AbortController();
    const aborted = proxy.fetch('https://img.example/b', run(controller.signal));
    const waiting = proxy.fetch('https://img.example/c', run());
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(aborted, { name: 'AbortError' });
    assert.deepEqual(await waiting, refusedAs('timeout'));
    assert.deepEqual(await holder, refusedAs('timeout'));
  },
);

test(
  'a token that pulls more than its byte budget is refused as budget; other tokens are not',
  { timeout: 5000 },
  async () => {
    const body = png(1, 1);
    const padded = bytes(body, new Uint8Array(60 - body.length));
    const { proxy } = proxyWith(() => reply(200, padded), { limits: { perTokenBytes: 100 } });
    assert.equal((await proxy.fetch('https://img.example/1', run())).kind, 'image');
    assert.deepEqual(await proxy.fetch('https://img.example/2', run()), refusedAs('budget'));
    assert.deepEqual(await proxy.fetch('https://img.example/3', run()), refusedAs('budget'));
    const other = { token: 't2', signal: new AbortController().signal };
    assert.equal((await proxy.fetch('https://img.example/1', other)).kind, 'image');
    proxy.release('t1');
    assert.equal((await proxy.fetch('https://img.example/1', run())).kind, 'image');
  },
);

test('a byte budget is cumulative per token, exact at the limit, and ignores unknown tokens', () => {
  const budget = tokenBudget({ perToken: 5, perTokenBytes: 100, maxTokens: 2 });
  assert.equal(budget.spendBytes('gone', 1000), true, 'an unknown token has nothing to protect');
  assert.equal(budget.take('a'), true);
  assert.equal(budget.spendBytes('a', 60), true);
  assert.equal(budget.take('a'), true, 'a request count does not reset the bytes');
  assert.equal(budget.spendBytes('a', 40), true, 'exactly the budget is allowed');
  assert.equal(budget.spendBytes('a', 1), false);
});
