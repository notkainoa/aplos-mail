import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { frameHeaders, notFound } from '../../src/frame/headers';
import { reporterHash } from '../../src/frame/reporter';
import { serveFrame, type ServeDeps } from '../../src/frame/serve';
import { FrameTokens, MAX_TOKENS_PER_WINDOW, type FrameRenderInput } from '../../src/frame/tokens';
import { render } from './fixtures';

// `Mail/serve`'s response builder, and the work package's "token abuse" check: a reused,
// guessed, expired or released token, a token from another window, path traversal under a
// token, and more than 64 live must all get the one 404.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const NOT_FOUND = notFound();

async function setup(extra: Partial<FrameRenderInput> = {}) {
  const tokens = new FrameTokens({ ttlMs: 1_000 });
  const clock = { now: 0 };
  const calls: string[] = [];
  const deps: ServeDeps = {
    now: () => clock.now,
    reporterHash: await reporterHash(),
    imageBytes: (token, index, url) => {
      calls.push(`img ${token} ${index} ${url}`);
      return { mime: 'image/png', bytes: PNG };
    },
    cidBytes: async (record, index, cid) => {
      calls.push(`cid ${record.messageId} ${index} ${cid}`);
      return { mime: 'image/gif', bytes: PNG };
    },
  };
  const issued = tokens.issue(
    render({
      document: '<html><body>héllo</body></html>',
      remoteImages: ['https://a.example/1.png', 'https://a.example/2.png'],
      cids: ['<part1@x>'],
      ...extra,
    }),
    0,
  );
  const serve = (path: string, token: unknown = issued.token, windowId: unknown = 'w1') =>
    serveFrame(tokens, { windowId, token, path }, deps);
  return { tokens, clock, calls, deps, issued, serve };
}

describe('Mail/serve', () => {
  it('serves the document once, with the frame headers and UTF-8 bytes', async () => {
    const { serve, deps } = await setup();
    const first = await serve('');
    assert.equal(first.status, 200);
    assert.deepEqual(first.headers, frameHeaders(deps.reporterHash));
    assert.equal(new TextDecoder().decode(first.body), '<html><body>héllo</body></html>');
    assert.deepEqual(await serve(''), NOT_FOUND);
  });

  it('serves an issued cid and an allowed image after the document', async () => {
    const { serve, calls, issued } = await setup({ imagePolicy: 'allow' });
    assert.deepEqual(await serve('img/0'), NOT_FOUND, 'nothing before the document');
    await serve('');
    const image = await serve('img/1');
    assert.equal(image.status, 200);
    assert.equal(image.headers['content-type'], 'image/png');
    assert.equal(image.headers['x-content-type-options'], 'nosniff');
    assert.equal(image.body, PNG);
    const inline = await serve('cid/0');
    assert.equal(inline.headers['content-type'], 'image/gif');
    assert.deepEqual(calls, [
      `img ${issued.token} 1 https://a.example/2.png`,
      'cid m1 0 <part1@x>',
    ]);
  });

  it('refuses every img/<n> while images are blocked, with the unknown-path 404', async () => {
    const { serve, calls } = await setup({ imagePolicy: 'block' });
    await serve('');
    for (const path of ['img/0', 'img/1', 'img/2']) assert.deepEqual(await serve(path), NOT_FOUND);
    assert.deepEqual(calls, [], 'the proxy is never asked');
    assert.deepEqual(await serve('nope'), NOT_FOUND);
  });

  it('refuses an index the render did not issue', async () => {
    const { serve, calls } = await setup({ imagePolicy: 'allow' });
    await serve('');
    for (const path of ['img/2', 'img/999999', 'cid/1', 'cid/999999']) {
      assert.deepEqual(await serve(path), NOT_FOUND, path);
    }
    assert.deepEqual(calls, []);
  });

  it('turns a non-raster answer into a download and a missing answer into the 404', async () => {
    const { tokens, deps, serve } = await setup({ imagePolicy: 'allow' });
    await serve('');
    const svg = await serveFrame(
      tokens,
      { windowId: 'w1', token: (await setup()).issued.token, path: 'img/0' },
      deps,
    );
    assert.deepEqual(svg, NOT_FOUND, 'a token of another registry is unknown here');
    deps.imageBytes = () => ({ mime: 'image/svg+xml', bytes: PNG });
    const download = await serve('img/0');
    assert.equal(download.headers['content-type'], 'application/octet-stream');
    assert.equal(download.headers['content-disposition'], 'attachment');
    deps.imageBytes = () => undefined;
    assert.deepEqual(await serve('img/0'), NOT_FOUND);
    deps.imageBytes = () => ({ mime: 'image/png', bytes: 'not bytes' as unknown as Uint8Array });
    assert.deepEqual(await serve('img/0'), NOT_FOUND);
    deps.imageBytes = undefined;
    assert.deepEqual(await serve('img/0'), NOT_FOUND);
  });

  it('answers a throwing or rejecting callback with the 404', async () => {
    const { deps, serve } = await setup({ imagePolicy: 'allow' });
    await serve('');
    deps.imageBytes = () => {
      throw new Error('proxy down');
    };
    assert.deepEqual(await serve('img/0'), NOT_FOUND);
    deps.cidBytes = () => Promise.reject(new Error('no file'));
    assert.deepEqual(await serve('cid/0'), NOT_FOUND);
  });

  it('does not spend the token when the reporter hash is broken', async () => {
    const { deps, serve } = await setup();
    const good = deps.reporterHash;
    deps.reporterHash = 'broken';
    assert.deepEqual(await serve(''), NOT_FOUND);
    deps.reporterHash = good;
    assert.equal((await serve('')).status, 200);
  });
});

describe('token abuse', () => {
  it('refuses a reused token', async () => {
    const { serve } = await setup();
    await serve('');
    assert.deepEqual(await serve(''), NOT_FOUND);
  });

  it('refuses a guessed token', async () => {
    const { serve } = await setup();
    for (const guess of ['0'.repeat(32), 'f'.repeat(32), '0123456789abcdef'.repeat(2)]) {
      assert.deepEqual(await serve('', guess), NOT_FOUND);
    }
  });

  it('refuses an expired token, document and sub-resource', async () => {
    const { serve, clock, issued } = await setup({ imagePolicy: 'allow' });
    await serve('');
    clock.now = 1_000;
    assert.deepEqual(await serve('img/0'), NOT_FOUND);
    const late = await setup();
    late.clock.now = 1_000;
    assert.deepEqual(await late.serve(''), NOT_FOUND);
    assert.ok(issued.expiresAt <= 1_000);
  });

  it('refuses a released token', async () => {
    const { serve, tokens, issued } = await setup({ imagePolicy: 'allow' });
    await serve('');
    tokens.release('w1', issued.url);
    assert.deepEqual(await serve('img/0'), NOT_FOUND);
    assert.deepEqual(await serve('cid/0'), NOT_FOUND);
  });

  it('refuses a token from another window, and leaves it to its own', async () => {
    const { serve } = await setup();
    assert.deepEqual(await serve('', undefined, 'w2'), NOT_FOUND);
    assert.equal((await serve('')).status, 200);
    assert.deepEqual(await serve('cid/0', undefined, 'w2'), NOT_FOUND);
  });

  it('refuses path traversal under a valid token', async () => {
    const { serve, calls } = await setup({ imagePolicy: 'allow' });
    await serve('');
    const paths = [
      '../cid/0',
      'cid/../img/0',
      'cid/0/..',
      'cid/%30',
      '%2e%2e/cid/0',
      'cid%2f0',
      'cid\\0',
      'cid//0',
      '/cid/0',
      'cid/0/',
      './cid/0',
      'cid/0?x',
      'cid/0#x',
      'cid/00',
      'cid/-0',
      'img/1e1',
      'CID/0',
    ];
    for (const path of paths) assert.deepEqual(await serve(path), NOT_FOUND, path);
    assert.deepEqual(calls, []);
  });

  it(`refuses the oldest once more than ${MAX_TOKENS_PER_WINDOW} are live`, async () => {
    const { serve, tokens, issued } = await setup();
    for (let i = 0; i < MAX_TOKENS_PER_WINDOW; i++) tokens.issue(render(), 0);
    assert.equal(tokens.liveCount('w1'), MAX_TOKENS_PER_WINDOW);
    assert.deepEqual(await serve('', issued.token), NOT_FOUND);
  });
});

describe('hostile input never throws', () => {
  const weird: unknown[] = [
    undefined,
    null,
    0,
    -1,
    Number.NaN,
    true,
    {},
    [],
    ['cid/0'],
    { toString: () => 'cid/0' },
    '',
    ' ',
    '\u0000',
    '\ud800',
    'é',
    'x'.repeat(5_000),
    'cid/'.padEnd(2_000, '9'),
    '__proto__',
    'constructor',
    'img/__proto__',
    'cid/length',
    Symbol('s'),
    () => 'cid/0',
    BigInt(1),
  ];

  it('answers 404 or a clean 200 for every combination', async () => {
    const { tokens, deps, issued } = await setup({ imagePolicy: 'allow' });
    const tokensToTry = [...weird, issued.token, issued.url];
    const paths = [...weird, '', 'img/0', 'cid/0'];
    const windows = [...weird, 'w1', 'w2'];
    for (const token of tokensToTry) {
      for (const path of paths) {
        for (const windowId of windows) {
          const response = await serveFrame(tokens, { windowId, token, path }, deps);
          assert.ok(response.status === 404 || response.status === 200);
          assert.ok(response.body instanceof Uint8Array);
          assert.equal(response.headers['x-content-type-options'], 'nosniff');
        }
      }
    }
  });
});
