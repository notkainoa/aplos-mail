import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '@aplos/mail-html';
import { frameHeaders, notFound, resourceHeaders } from '@aplos/mail-html/frame';
import {
  ENGINE_HEADERS,
  MAIL_PRIVILEGES,
  MAX_RELAY_IN_FLIGHT,
  MAX_RELAY_PER_WINDOW,
  MAX_SERVE_BODY_BYTES,
  limitInFlight,
  WINDOW_HEADER,
  backstopCancels,
  createMailHandler,
  isMailDocumentUrl,
  servedResponse,
  splitMailUrl,
  stampWindow,
  type ServeArgs,
} from '../../src/host/protocol/relay';

// html-5's main-side decisions, pure (no Electron): the GET-only handler, the window stamp, the backstop, the strict
// subframe document check. relay.e2e.ts runs the same functions in a hidden Electron.

const TOKEN = 'ab'.repeat(16);
const DOC = `aplos-mail://m/${TOKEN}/`;
const HASH = 'A'.repeat(43) + '=';

/** What the handler reads of a `Request`: method, the raw URL text, and headers (fakes keep the URL exactly). */
function request(
  url: string,
  options: { method?: string; headers?: Record<string, string>; signal?: AbortSignal } = {},
) {
  return {
    method: options.method ?? 'GET',
    url,
    headers: new Headers(options.headers ?? { [WINDOW_HEADER]: '7' }),
    signal: options.signal ?? new AbortController().signal,
  } as unknown as Request;
}

const okDocument = () => ({
  status: 200,
  headers: frameHeaders(HASH),
  body: new TextEncoder().encode('<p>hi</p>'),
});

function relay(answer: (args: ServeArgs) => Promise<unknown> = async () => okDocument()) {
  const calls: ServeArgs[] = [];
  const handler = createMailHandler({
    serve: args => {
      calls.push(args);
      return answer(args);
    },
    windowOf: id => (id === 7 ? 3 : undefined),
  });
  return { handler, calls };
}

async function assertUniform404(response: Response, what: string) {
  const expected = notFound();
  assert.equal(response.status, 404, what);
  assert.deepEqual(Object.fromEntries(response.headers), expected.headers, `${what}: headers`);
  assert.equal((await response.arrayBuffer()).byteLength, 0, `${what}: body`);
}

test('the scheme is registered standard+secure and nothing else', () => {
  assert.deepEqual({ ...MAIL_PRIVILEGES }, { standard: true, secure: true });
  assert.ok(Object.isFrozen(MAIL_PRIVILEGES));
});

test('GET only: every other method is 405 with Allow: GET, an empty body, and no engine call', async () => {
  const { handler, calls } = relay();
  for (const method of ['POST', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'get']) {
    const response = await handler(request(DOC, { method }));
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('allow'), 'GET', method);
    assert.equal((await response.arrayBuffer()).byteLength, 0, method);
  }
  assert.equal(calls.length, 0);
});

test('a GET reaches the engine with the raw token, the raw path and the stamped window', async () => {
  const { handler, calls } = relay();
  const response = await handler(request(`${DOC}cid/3`));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  const { signal, ...rest } = calls[0];
  assert.deepEqual(rest, { token: TOKEN, path: 'cid/3', windowId: '3' });
  assert.ok(signal instanceof AbortSignal, 'with the request’s own signal');
});

test('the response is exactly the engine’s: status, every header and the bytes, nothing added', async () => {
  const { handler } = relay();
  const response = await handler(request(DOC));
  assert.deepEqual(Object.fromEntries(response.headers), frameHeaders(HASH));
  assert.equal(await response.text(), '<p>hi</p>');
  assert.match(
    response.headers.get('content-security-policy')!,
    /sandbox allow-scripts allow-popups$/,
  );
  const image = relay(async () => ({
    status: 200,
    headers: resourceHeaders('image/png'),
    body: new Uint8Array([1, 2, 3]),
  }));
  const served = await image.handler(request(`${DOC}img/0`));
  assert.deepEqual(Object.fromEntries(served.headers), resourceHeaders('image/png'));
  assert.deepEqual(new Uint8Array(await served.arrayBuffer()), new Uint8Array([1, 2, 3]));
});

test('the path is never decoded or normalised: escapes, dot segments and queries reach the engine as written', async () => {
  const { handler, calls } = relay(async () => notFound());
  const paths = ['cid/%31', '%2e%2e/x', '../x', './', 'cid/1?x=1', 'img//0', 'cid\\1', 'CID/1'];
  for (const path of paths) await handler(request(`${DOC}${path}`));
  assert.deepEqual(
    calls.map(call => call.path),
    paths,
  );
  assert.ok(calls.every(call => call.token === TOKEN));
});

test('host exactly m, no port, no userinfo, a slash after the token: anything else is the 404 with no engine call', async () => {
  const { handler, calls } = relay();
  const urls = [
    `aplos-mail://M/${TOKEN}/`,
    `aplos-mail://mm/${TOKEN}/`,
    `aplos-mail://m:80/${TOKEN}/`,
    `aplos-mail://u@m/${TOKEN}/`,
    `aplos-mail://m.example/${TOKEN}/`,
    `aplos-mail:m/${TOKEN}/`,
    `aplos-mail://m/${TOKEN}`,
    `aplos-mail://m//`,
    `aplos-mail://m/${'a'.repeat(65)}/`,
    `${DOC}${'x'.repeat(2001)}`,
    `https://m/${TOKEN}/`,
  ];
  for (const url of urls) await assertUniform404(await handler(request(url)), url);
  assert.equal(calls.length, 0);
  assert.deepEqual(splitMailUrl(`${DOC}`), { token: TOKEN, path: '' });
});

test('fail closed on the window: no stamp, a malformed one, or one that is no app window is the 404, no engine call', async () => {
  // windowOf answers for EVERY id, so only the stamp check can refuse here; it must never even be asked.
  const calls: ServeArgs[] = [];
  const asked: number[] = [];
  const handler = createMailHandler({
    serve: async args => (calls.push(args), okDocument()),
    windowOf: id => (asked.push(id), 3),
  });
  const stamps: (Record<string, string> | undefined)[] = [
    {},
    { [WINDOW_HEADER]: '' },
    { [WINDOW_HEADER]: '0' },
    { [WINDOW_HEADER]: '-7' },
    { [WINDOW_HEADER]: '07' },
    { [WINDOW_HEADER]: '7.0' },
    { [WINDOW_HEADER]: '7 x' },
    { [WINDOW_HEADER]: '7, 7' },
    { [WINDOW_HEADER]: '99999999999999999999' },
    { 'X-Aplos-Win': '7' },
  ];
  for (const headers of stamps)
    await assertUniform404(await handler(request(DOC, { headers })), JSON.stringify(headers));
  assert.deepEqual(asked, [], 'windowOf is never asked without a valid stamp');
  assert.equal(calls.length, 0);
  // A valid stamp that names no app window.
  const { handler: noWindow, calls: none } = relay();
  await assertUniform404(await noWindow(request(DOC, { headers: { [WINDOW_HEADER]: '8' } })), '8');
  assert.equal(none.length, 0);
});

test(
  'at most MAX_RELAY_IN_FLIGHT relays open: the next is the 404 with no engine call; every exit frees a slot',
  { timeout: 5000 },
  async () => {
    assert.equal(MAX_RELAY_IN_FLIGHT, 64);
    const pending: { resolve(value: unknown): void; reject(error: unknown): void }[] = [];
    let calls = 0;
    // Per-window cap off for this test (the global pool is what it checks); the per-window cap has its own test below.
    const serve = limitInFlight(
      () => {
        calls++;
        return new Promise((resolve, reject) => pending.push({ resolve, reject }));
      },
      MAX_RELAY_IN_FLIGHT,
      MAX_RELAY_IN_FLIGHT,
    );
    const handler = createMailHandler({ serve, windowOf: () => 3 });
    const open = Array.from({ length: 64 }, () => handler(request(DOC)));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 64);
    await assertUniform404(await handler(request(DOC)), 'the 65th');
    assert.equal(calls, 64, 'the 65th never reached the engine');

    pending[0].resolve(okDocument());
    pending[1].reject(new Error('timeout'));
    assert.equal((await open[0]).status, 200);
    await assertUniform404(await open[1], 'a timed-out call');
    const next = [handler(request(DOC)), handler(request(DOC))];
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 66, 'an answer and a rejection each freed a slot');
    await assertUniform404(await handler(request(DOC)), 'full again');
    for (const call of pending.slice(2)) call.resolve(okDocument());
    await Promise.all([...open, ...next]);

    let throws = 0;
    const throwing = limitInFlight(() => {
      throws++;
      throw new Error('sync');
    }, 1);
    await assert.rejects(throwing({ token: 't', path: '', windowId: '1' }));
    await assert.rejects(throwing({ token: 't', path: '', windowId: '1' }), /sync/);
    assert.equal(throws, 2, 'a throw frees its slot too');
  },
);

test('any engine failure or an answer of another shape is the same uniform 404', async () => {
  const bad: unknown[] = [
    undefined,
    null,
    'text',
    { status: 200, headers: frameHeaders(HASH) },
    { status: 200, headers: frameHeaders(HASH), body: 'string' },
    { status: 302, headers: frameHeaders(HASH), body: new Uint8Array() },
    { status: 500, headers: frameHeaders(HASH), body: new Uint8Array() },
    { status: '200', headers: frameHeaders(HASH), body: new Uint8Array() },
    { status: 200, headers: [], body: new Uint8Array() },
    { status: 200, headers: { 'content-type': 'text/html' }, body: new Uint8Array() },
    {
      status: 200,
      headers: { ...frameHeaders(HASH), 'set-cookie': 'a=1' },
      body: new Uint8Array(),
    },
    {
      status: 200,
      headers: { ...frameHeaders(HASH), 'Content-Type': 'x' },
      body: new Uint8Array(),
    },
    {
      status: 200,
      headers: { ...frameHeaders(HASH), 'access-control-allow-origin': '*' },
      body: new Uint8Array(),
    },
    { status: 200, headers: { ...frameHeaders(HASH), 'content-type': 1 }, body: new Uint8Array() },
  ];
  for (const answer of bad) {
    const { handler } = relay(async () => answer);
    await assertUniform404(await handler(request(DOC)), JSON.stringify(answer));
    assert.equal(servedResponse(answer), undefined);
  }
  for (const failure of [new Error('down'), 'timeout', undefined]) {
    const { handler } = relay(() => Promise.reject(failure));
    await assertUniform404(await handler(request(DOC)), `rejected ${String(failure)}`);
  }
  const throwing = createMailHandler({
    serve: () => {
      throw new Error('sync');
    },
    windowOf: () => 3,
  });
  await assertUniform404(await throwing(request(DOC)), 'serve threw');
  const badWindow = createMailHandler({
    serve: async () => okDocument(),
    windowOf: () => {
      throw new Error('gone');
    },
  });
  await assertUniform404(await badWindow(request(DOC)), 'windowOf threw');
});

test('the header allow-list is the engine’s own set: every header the frame code writes, nothing else', () => {
  const written = new Set([
    ...Object.keys(frameHeaders(HASH)),
    ...Object.keys(resourceHeaders('image/webp')),
    ...Object.keys(notFound().headers),
  ]);
  assert.deepEqual([...written].sort(), [...ENGINE_HEADERS].sort());
});

test('the stamp: every spelling the page sent is removed, an aplos-mail request gets String(webContentsId)', () => {
  const forged = {
    'X-Aplos-Window': '99',
    'x-aplos-window': '98',
    'X-APLOS-WINDOW': '97',
    Accept: '*/*',
  };
  assert.deepEqual(stampWindow({ url: DOC, webContentsId: 4, requestHeaders: forged }), {
    Accept: '*/*',
    'X-Aplos-Window': '4',
  });
  assert.deepEqual(stampWindow({ url: `${DOC}img/0`, webContentsId: 12, requestHeaders: {} }), {
    'X-Aplos-Window': '12',
  });
  assert.equal(forged['x-aplos-window'], '98', 'the input is not edited in place');
});

test('the stamp: no webContentsId (or a nonsense one) removes the forgery and adds none', () => {
  for (const webContentsId of [undefined, 0, -1, 1.5, Number.NaN]) {
    const headers = stampWindow({
      url: DOC,
      webContentsId,
      requestHeaders: { 'x-aplos-window': '99', Accept: '*/*' },
    });
    assert.deepEqual(headers, { Accept: '*/*' }, String(webContentsId));
  }
});

test('the stamp: other URLs keep their headers but never carry the window header', () => {
  const headers = stampWindow({
    url: 'https://example.com/',
    webContentsId: 4,
    requestHeaders: { 'X-Aplos-Window': '4', Cookie: 'a=1' },
  });
  assert.deepEqual(headers, { Cookie: 'a=1' });
  const mixedCase = stampWindow({
    url: `APLOS-MAIL://m/${TOKEN}/`,
    webContentsId: 5,
    requestHeaders: {},
  });
  assert.deepEqual(mixedCase, { 'X-Aplos-Window': '5' });
});

test('the backstop cancels http, https, ws and wss from an opaque origin or an aplos-mail frame, nothing else', () => {
  const network = [
    'http://a.example/x',
    'https://a.example/x',
    'ws://a.example/',
    'wss://a.example/',
    'HTTPS://a.example/',
  ];
  for (const url of network) {
    assert.equal(backstopCancels({ url, initiatorOrigin: 'null' }), true, `${url} null`);
    assert.equal(backstopCancels({ url, frameUrl: DOC }), true, `${url} frame`);
    assert.equal(backstopCancels({ url, frameUrl: `${DOC}img/0` }), true, `${url} frame sub`);
    assert.equal(backstopCancels({ url, frameUrl: 'APLOS-MAIL://x' }), true, `${url} frame case`);
    assert.equal(backstopCancels({ url, initiatorOrigin: 'file://' }), false, `${url} app page`);
    assert.equal(
      backstopCancels({
        url,
        initiatorOrigin: 'http://localhost:5173',
        frameUrl: 'http://localhost:5173/',
      }),
      false,
    );
    assert.equal(backstopCancels({ url }), false, `${url} browser-initiated`);
  }
  for (const url of [DOC, 'file:///x', 'data:,x', 'blob:null/x', 'devtools://x'])
    assert.equal(backstopCancels({ url, initiatorOrigin: 'null', frameUrl: DOC }), false, url);
});

test('the subframe document check is the exact issued form, nothing else', () => {
  assert.equal(isMailDocumentUrl(DOC), true);
  const refused = [
    `aplos-mail://m/${TOKEN}`,
    `${DOC}cid/0`,
    `${DOC}img/0`,
    `${DOC}?x`,
    `${DOC}#x`,
    `aplos-mail://m/${TOKEN.toUpperCase()}/`,
    `aplos-mail://m/${TOKEN.slice(1)}/`,
    `aplos-mail://M/${TOKEN}/`,
    `aplos-mail://x/${TOKEN}/`,
    `aplos-mail://m:1/${TOKEN}/`,
    `aplos-mail://m/${TOKEN}//`,
    `aplos-mail://m/../${TOKEN}/`,
    'aplos-mail://m/',
    'about:blank',
    `https://m/${TOKEN}/`,
    undefined,
  ];
  for (const url of refused) assert.equal(isMailDocumentUrl(url), false, String(url));
});

test('the protocol request’s own signal reaches the engine call', async () => {
  const gone = new AbortController();
  const { handler, calls } = relay();
  await handler(request(DOC, { signal: gone.signal }));
  assert.equal(calls[0].signal, gone.signal);
});

test(
  'an aborted request frees its slot at once, and only once; the late answer changes nothing',
  { timeout: 5000 },
  async () => {
    const pending: ((value: unknown) => void)[] = [];
    const serve = limitInFlight(() => new Promise<unknown>(resolve => pending.push(resolve)), 2, 2);
    const abort = new AbortController();
    const args = (signal?: AbortSignal): ServeArgs => ({
      token: 't',
      path: '',
      windowId: '1',
      ...(signal ? { signal } : {}),
    });
    const first = serve(args(abort.signal));
    const second = serve(args());
    await assert.rejects(serve(args()), /Too many/, 'full');
    abort.abort();
    await assert.rejects(first, /cancelled/);
    const third = serve(args());
    await assert.rejects(serve(args()), /Too many/, 'the freed slot is taken again, not two');
    pending[0](okDocument());
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(
      serve(args()),
      /Too many/,
      'the late answer of the aborted call freed nothing more',
    );
    for (const resolve of pending.slice(1)) resolve(okDocument());
    await Promise.all([second, third]);
    await new Promise(resolve => setImmediate(resolve));
    const last = serve(args());
    assert.equal(pending.length, 4, 'both slots were free again');
    pending[3](okDocument());
    await last;
  },
);

test(
  'one window cannot take the whole pool: its per-window cap is the 404 while another window still gets served',
  { timeout: 5000 },
  async () => {
    assert.equal(MAX_RELAY_PER_WINDOW < MAX_RELAY_IN_FLIGHT, true);
    const pending: ((value: unknown) => void)[] = [];
    const serve = limitInFlight(
      () => new Promise<unknown>(resolve => pending.push(resolve)),
      10,
      2,
    );
    const a = [
      serve({ token: 't', path: '', windowId: 'A' }),
      serve({ token: 't', path: '', windowId: 'A' }),
    ];
    await assert.rejects(serve({ token: 't', path: '', windowId: 'A' }), /Too many/);
    const b = serve({ token: 't', path: '', windowId: 'B' });
    assert.equal(pending.length, 3, 'window B was served');
    pending[0](okDocument());
    await a[0];
    const again = serve({ token: 't', path: '', windowId: 'A' });
    assert.equal(pending.length, 4, 'A has a slot again once one of its calls ended');
    for (const resolve of pending.slice(1)) resolve(okDocument());
    await Promise.all([a[1], b, again]);
  },
);

test('a response body above the cap is the 404; exactly at the cap passes', () => {
  const answer = (size: number) => ({ ...okDocument(), body: new Uint8Array(size) });
  assert.ok(servedResponse(answer(MAX_SERVE_BODY_BYTES)));
  // A boolean, not a deepEqual: a failing comparison of a 10 MB body would take a minute to print.
  assert.ok(servedResponse(answer(MAX_SERVE_BODY_BYTES + 1)) === undefined);
});

test('a hostile document at the sanitizer limits stays far under the body cap, data: images included', () => {
  // The relay cap (10 MiB) is for cid parts and proxied images; the document is bounded by the sanitizer's own markup cap.
  const dataUrl = `data:image/png;base64,${'A'.repeat(500_000)}`;
  const worst = `<img src="${dataUrl}">` + '&'.repeat(10_000);
  const hostile = [
    worst,
    '<p>"</p>'.repeat(60_000),
    '<img src="data:image/gif;base64,AAAA" alt="&&&&">'.repeat(9_000),
  ];
  for (const html of hostile) {
    const out = render({ html, cids: [], imagePolicy: 'block' });
    assert.equal(out.bodyKind, 'html');
    if (out.bodyKind === 'html')
      assert.ok(out.document.length < MAX_SERVE_BODY_BYTES / 2, `${out.document.length}`);
  }
});
