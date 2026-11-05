import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { frameHeaders, notFound } from '../../src/frame/headers';
import { reporterHash, withReporter } from '../../src/frame/reporter';
import { READING_DOCTYPE, render as renderMail } from '../../src/index';
import { serveFrame, type ServeDeps } from '../../src/frame/serve';
import { FrameTokens, MAX_TOKENS_PER_WINDOW, type FrameRenderInput } from '../../src/frame/tokens';
import { bytes, render, SAMPLES } from './fixtures';

// `Mail/serve`'s response builder, and the work package's "token abuse" check: a reused,
// guessed, expired or released token, a token from another window, path traversal under a
// token, and more than 64 live must all get the one 404.

const PNG = SAMPLES.png;
const GIF = SAMPLES.gif89;
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
      return { bytes: PNG };
    },
    cidBytes: async (record, index, cid) => {
      calls.push(`cid ${record.messageId} ${index} ${cid}`);
      return { bytes: GIF };
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

  it('serves a document that starts with the reading doctype, whatever the mail declared', async () => {
    const legacy = '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">';
    const inputs = [
      '<p>x</p>',
      `${legacy}<p>x</p>`,
      '<!-- c -->\ufeff<p>x</p>',
      '<![CDATA[x]]><p>x</p>',
    ];
    inputs.push('<?xml version="1.0"?><!DOCTYPE html SYSTEM "about:legacy-compat"><p>x</p>');
    for (const html of inputs) {
      const result = renderMail({ html, cids: [], imagePolicy: 'block' });
      assert.equal(result.bodyKind, 'html');
      const document = withReporter(result.bodyKind === 'html' ? result.document : '');
      const { serve } = await setup({ document });
      const served = new TextDecoder().decode((await serve('')).body);
      assert.ok(served.startsWith(`${READING_DOCTYPE}<html`), `${html} -> ${served.slice(0, 60)}`);
      // The two things that bring quirks mode back: anything before the doctype, a second doctype.
      assert.equal(served.match(/<!doctype/gi)?.length, 1, html);
      assert.equal(served.charCodeAt(0), 0x3c, 'no BOM or space first');
    }
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

  it('answers a non-raster or missing answer with the 404', async () => {
    const { tokens, deps, serve } = await setup({ imagePolicy: 'allow' });
    await serve('');
    const foreign = await serveFrame(
      tokens,
      { windowId: 'w1', token: (await setup()).issued.token, path: 'img/0' },
      deps,
    );
    assert.deepEqual(foreign, NOT_FOUND, 'a token of another registry is unknown here');
    deps.imageBytes = () => undefined;
    assert.deepEqual(await serve('img/0'), NOT_FOUND);
    deps.imageBytes = () => ({ bytes: 'not bytes' as unknown as Uint8Array });
    assert.deepEqual(await serve('img/0'), NOT_FOUND);
    deps.imageBytes = undefined;
    assert.deepEqual(await serve('img/0'), NOT_FOUND);
  });

  it('types a sub-resource by sniffing its bytes, never by the claimed mime', async () => {
    const { deps, serve } = await setup({ imagePolicy: 'allow' });
    await serve('');
    const claimed = (mime: string, body: Uint8Array) => () => ({ mime, bytes: body }) as never;
    deps.imageBytes = claimed('image/svg+xml', SAMPLES.webp);
    const webp = await serve('img/0');
    assert.equal(webp.status, 200);
    assert.equal(webp.headers['content-type'], 'image/webp', 'the bytes win over the claim');
    assert.equal(webp.headers['content-disposition'], 'inline');
    const hostile = [
      bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      bytes('<!doctype html><script>alert(1)</script>'),
      bytes('MZ', 0x90, 0, 3, 0, 0, 0),
    ];
    for (const body of hostile) {
      deps.imageBytes = claimed('image/png', body);
      assert.deepEqual(await serve('img/0'), NOT_FOUND, 'img with an image mime');
      deps.cidBytes = claimed('image/gif', body);
      assert.deepEqual(await serve('cid/0'), NOT_FOUND, 'cid with an image mime');
    }
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

describe('Mail/serve liveness and window ids', () => {
  function slowImage(deps: ServeDeps) {
    let finish: () => void = () => undefined;
    deps.imageBytes = () =>
      new Promise(resolve => {
        finish = () => resolve({ bytes: PNG });
      });
    return () => finish();
  }

  it('refuses an image whose token is released while it is being fetched', async () => {
    const { serve, deps, tokens, issued } = await setup({ imagePolicy: 'allow' });
    await serve('');
    const finish = slowImage(deps);
    const pending = serve('img/0');
    await Promise.resolve();
    tokens.release('w1', issued.url);
    finish();
    assert.deepEqual(await pending, NOT_FOUND);
  });

  it('refuses an image whose window closes while it is being fetched', async () => {
    const { serve, deps, tokens } = await setup({ imagePolicy: 'allow' });
    await serve('');
    const finish = slowImage(deps);
    const pending = serve('img/0');
    await Promise.resolve();
    tokens.releaseWindow('w1');
    finish();
    assert.deepEqual(await pending, NOT_FOUND);
  });

  it('keeps serving a served token past the unfetched deadline', async () => {
    const { serve, clock } = await setup({ imagePolicy: 'allow' });
    await serve('');
    clock.now = 10_000_000;
    assert.equal((await serve('img/0')).status, 200);
  });

  it('still serves a slow image whose token lives', async () => {
    const { serve, deps } = await setup({ imagePolicy: 'allow' });
    await serve('');
    const finish = slowImage(deps);
    const pending = serve('img/0');
    finish();
    assert.equal((await pending).status, 200);
  });

  it('refuses an empty or non-string window id', async () => {
    const { serve, tokens, deps, issued } = await setup();
    for (const windowId of ['', null, 0, ['w1'], { toString: () => 'w1' }]) {
      assert.deepEqual(await serve('', undefined, windowId), NOT_FOUND, String(windowId));
    }
    const missing = { windowId: undefined, token: issued.token, path: '' };
    assert.deepEqual(await serveFrame(tokens, missing, deps), NOT_FOUND);
    assert.equal((await serve('')).status, 200);
  });

  it('never asks the registry about an empty window', async () => {
    const { tokens, deps, issued } = await setup();
    const asked: unknown[] = [];
    for (const method of ['takeDocument', 'forResource', 'lookup'] as const) {
      const original = tokens[method].bind(tokens);
      tokens[method] = ((windowId: string, token: unknown, now: number) => {
        asked.push(windowId);
        return original(windowId, token, now);
      }) as never;
    }
    for (const path of ['', 'cid/0', 'img/0']) {
      await serveFrame(tokens, { windowId: '', token: issued.token, path }, deps);
    }
    assert.deepEqual(asked, []);
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

  it('refuses an expired (never fetched) token, document and sub-resource', async () => {
    const late = await setup({ imagePolicy: 'allow' });
    late.clock.now = 1_000;
    assert.deepEqual(await late.serve(''), NOT_FOUND);
    assert.deepEqual(await late.serve('img/0'), NOT_FOUND);
    assert.ok(late.issued.expiresAt <= 1_000);
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
