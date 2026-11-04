// The Electron main of relay.e2e.ts, bundled by the test with esbuild (electron external) to `<tmp>/main/main.cjs`. It
// is not the Aplos app: it wires the REAL relay (main/mail-protocol.ts: the handler, the window stamp, the backstop)
// and the REAL navigation guards (main/security.ts, with the host page written where its `trustedURL` expects the
// renderer: `<tmp>/renderer/index.html`) to a stand-in engine that does what the utility and the engine do
// (hostServeArgs, then slice 1's FrameTokens and serveFrame), opens hidden windows, and prints one `RELAY-RESULT <json>`
// line. Nothing is shown, no Dock item, no network beyond the loopback canary the test passes in APLOS_RELAY_CANARY.
// Each window replaces security.ts's window-open handler with a recording deny, so no link ever reaches the browser.
import { app, BrowserWindow, protocol, WebContentsView } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mailHtml } from '@aplos/mail-html';
import {
  FrameTokens,
  frameUrl,
  reporterHash,
  serveFrame,
  withReporter,
  type ServeResponse,
} from '@aplos/mail-html/frame';
import { installMailProtocol } from '../../../src/main/mail-protocol';
import { allowMailFrames, installPermissionHandlers } from '../../../src/main/security';
import { hostServeArgs } from '../../../src/host/transports/port';
import type { ServeArgs } from '../../../src/host/protocol/relay';

const canary = process.env.APLOS_RELAY_CANARY ?? 'http://127.0.0.1:9';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

if (process.platform === 'darwin') {
  app.setActivationPolicy('accessory');
  app.dock?.hide();
}
// TEST ONLY: `supportFetchAPI` lets the forger page call fetch() with its own headers (to prove the stamp overwrites
// them). The app's registration (registerMailScheme) is standard+secure only; main-glue.test.ts pins that.
protocol.registerSchemesAsPrivileged([
  { scheme: 'aplos-mail', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.on('window-all-closed', () => {});

interface ServeLog {
  window: string;
  connection: string;
  token: string;
  path: string;
  status: number;
}

const tokens = new FrameTokens();
const attached = new Map<number, string>();
const raw = new Map<string, { owner: string; html: string; csp: string }>();
const log: ServeLog[] = [];
const popups: { contents: number; url: string }[] = [];
let hash = '';

/** The stand-in engine: the utility's translation, then the registry, or a raw test document. */
async function standInServe(args: ServeArgs): Promise<unknown> {
  const translated = hostServeArgs(args, id => attached.get(id));
  const response = await serveOne(translated);
  log.push({
    window: args.windowId,
    connection: translated.windowId,
    token: String(args.token),
    path: String(args.path),
    status: response.status,
  });
  return response;
}

async function serveOne(args: ReturnType<typeof hostServeArgs>): Promise<ServeResponse> {
  const special = raw.get(String(args.token));
  if (special && args.path === '' && args.windowId === special.owner) {
    raw.delete(String(args.token));
    const headers = { 'content-security-policy': special.csp, 'content-type': 'text/html' };
    return { status: 200, headers, body: new TextEncoder().encode(special.html) };
  }
  return serveFrame(tokens, args, {
    now: () => Date.now(),
    reporterHash: hash,
    cidBytes: () => ({ bytes: new Uint8Array(PNG) }),
    imageBytes: () => ({ bytes: new Uint8Array(PNG) }),
  });
}

function issue(connection: string, document: string, cids: string[] = []): string {
  const input = {
    windowId: connection,
    messageId: 'acct:m1',
    accountScope: 'acct',
    imagePolicy: 'block' as const,
    document,
    remoteImages: [],
    cids,
  };
  return tokens.issue(input, Date.now()).url;
}

function rawDocument(connection: string, html: string, csp: string): string {
  const token = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(
    '',
  );
  raw.set(token, { owner: connection, html, csp });
  return frameUrl(token);
}

const HOST_PAGE = `<!doctype html><meta charset="utf-8"><body><script>
window.got = [];
addEventListener('message', e => {
  const frames = [...document.querySelectorAll('iframe')];
  got.push({ origin: e.origin, data: e.data, frame: frames.findIndex(f => f.contentWindow === e.source) });
});
window.addFrame = src => new Promise(resolve => {
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts allow-popups');
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.onload = () => resolve(true);
  setTimeout(() => resolve(false), 5000);
  f.src = src;
  document.body.appendChild(f);
});
window.addImage = src => new Promise(resolve => {
  const i = new Image();
  i.onload = () => resolve('load');
  i.onerror = () => resolve('error');
  i.src = src;
});
</script></body>`;

/** security.ts's window-open handler opens http(s) in the browser; tests record and deny instead. */
function recordOpens(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(details => {
    popups.push({ contents: contents.id, url: details.url });
    return { action: 'deny' };
  });
}

async function hostWindow(file: string): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { backgroundThrottling: false },
  });
  recordOpens(win.webContents);
  await win.loadURL(pathToFileURL(file).href);
  attached.set(win.id, `conn-${win.id}`);
  return win;
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const inPage = <T>(win: BrowserWindow, code: string) =>
  win.webContents.executeJavaScript(code) as Promise<T>;

function messageA1(): { document: string; cids: string[] } {
  const html =
    `<p>Hello</p><img src="cid:logo@x" width="10" height="10">` +
    `<img src="${canary}/relay/remote.png" width="20" height="20">` +
    `<a id="web" href="https://example.invalid/x">web</a> <a id="mail" href="mailto:ada@example.invalid">mail</a>`;
  const result = mailHtml.render({ html, cids: ['logo@x'], imagePolicy: 'block' });
  if (result.bodyKind !== 'html') throw new Error('not html');
  return { document: withReporter(result.document), cids: ['logo@x'] };
}

/** Bypasses the sanitizer on purpose: only the engine's CSP header stands between this script and the page. */
const CSP_PROBE = withReporter(
  `<!doctype html><html><body><p>csp</p>` +
    `<script>parent.postMessage({ pwned: 'inline' }, '*')</script>` +
    `<img src="x" onerror="parent.postMessage({ pwned: 'handler' }, '*')"></body></html>`,
);

/** No CSP worth the name: only the session backstop stands between these and the canary. */
const BACKSTOP_PROBE =
  `<!doctype html><body><img src="${canary}/relay/backstop.png">` +
  `<script>fetch('${canary}/relay/backstop-fetch').catch(() => 0);` +
  `try { new WebSocket('${canary.replace('http', 'ws')}/relay/backstop-ws'); } catch {}` +
  `parent.postMessage({ backstop: 'ran' }, '*');</script></body>`;

function forgerPage(target: string, victimWindow: number): string {
  return `<!doctype html><body><script>
window.done = (async () => {
  const out = {};
  const forged = { 'X-Aplos-Window': '${victimWindow}', 'X-APLOS-WINDOW': '${victimWindow}' };
  const get = await fetch('${target}cid/0', { headers: forged }).catch(e => ({ status: 'error ' + e }));
  out.forgedGet = get.status;
  const post = await fetch('${target}', { method: 'POST', body: 'x', headers: forged }).catch(e => ({ status: 'error ' + e }));
  out.post = post.status;
  out.allow = post.headers ? post.headers.get('allow') : null;
  const head = await fetch('${target}cid/0', { method: 'HEAD' }).catch(e => ({ status: 'error ' + e }));
  out.head = head.status;
  await fetch('${canary}/relay/forger').catch(() => 0);
  return out;
})();
</script></body>`;
}

/** Links for the DNS-prefetch measurement: never clicked or hovered; the test reads the net log for the names. */
const DNS_LINKS = (name: string) =>
  `<p><a href="https://${name}/a">a</a> <a href="http://${name}/b">b</a></p>`;

async function scenario() {
  hash = await reporterHash();
  installPermissionHandlers();
  installMailProtocol(standInServe);
  allowMailFrames();
  // A webContents with no window first, so webContentsId and BrowserWindow id differ: the stamp's id is translated.
  const spare = new WebContentsView();
  recordOpens(spare.webContents);
  // Where security.ts's trustedURL expects the renderer (resolve(__dirname, '../renderer/index.html')); the test
  // removes the whole temp directory afterwards.
  const file = resolve(__dirname, '../renderer/index.html');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, HOST_PAGE);
  return run(file, spare);
}

async function run(file: string, spare: WebContentsView) {
  const a = await hostWindow(file);
  const b = await hostWindow(file);
  const connA = attached.get(a.id)!;
  const connB = attached.get(b.id)!;
  const a1 = messageA1();
  const urlA1 = issue(connA, a1.document, a1.cids);
  const urlA2 = issue(connA, CSP_PROBE);
  const urlA3 = issue(connA, withReporter('<p>unspent</p>'));
  const urlB1 = issue(connB, withReporter('<p>b</p>'));
  const urlBackstop = rawDocument(
    connA,
    BACKSTOP_PROBE,
    "default-src * 'unsafe-inline' 'unsafe-eval'",
  );

  await inPage(a, `addFrame(${JSON.stringify(urlA1)})`);
  await inPage(a, `addFrame(${JSON.stringify(urlA2)})`);
  await inPage(a, `addFrame(${JSON.stringify(urlBackstop)})`);
  await inPage(b, `addFrame(${JSON.stringify(urlB1)})`);
  await inPage(b, `addFrame(${JSON.stringify(urlA3)})`);
  await inPage(b, `addImage(${JSON.stringify(`${urlA1}cid/0`)})`);
  await inPage(a, `addFrame(${JSON.stringify(urlA3)})`);
  const urlDnsEngine = issue(connA, withReporter(DNS_LINKS('dns-engine.example')));
  const urlDnsBare = rawDocument(connA, DNS_LINKS('dns-bare.example'), "default-src 'none'");
  await inPage(a, `addFrame(${JSON.stringify(urlDnsEngine)})`);
  await inPage(a, `addFrame(${JSON.stringify(urlDnsBare)})`);
  await wait(500);

  // Links in the frame (target=_blank from the sanitizer) arrive as window-open requests of the embedding contents.
  const frameA1 = a.webContents.mainFrame.frames[0];
  await frameA1.executeJavaScript(`document.querySelector('a[href^="https:"]').click()`, true);
  await frameA1.executeJavaScript(`document.querySelector('a[href^="mailto:"]').click()`, true);
  const frameUrls = a.webContents.mainFrame.frames.map(f => ({ url: f.url, origin: f.origin }));
  const mailProcess = frameA1.processId;
  const hostProcess = a.webContents.mainFrame.processId;
  const keys = await keyProbe(a, frameA1);
  const escape = await frameEscape(a, frameA1, connA);
  const hosted = await hostedView(a, file, connA);

  // A window whose own page is an aplos-mail document forges the header and tries other methods.
  const forger = await hostWindow(file);
  attached.set(forger.id, `conn-${forger.id}`);
  const forgerUrl = rawDocument(
    attached.get(forger.id)!,
    forgerPage(urlA1, a.id),
    "default-src 'self'; script-src 'unsafe-inline'; connect-src *",
  );
  await forger.loadURL(forgerUrl);
  const forged = await inPage<Record<string, unknown>>(forger, 'window.done');

  const control = await inPage<string>(
    a,
    `addImage(${JSON.stringify(`${canary}/relay/control.png`)})`,
  );
  await wait(300);
  const result = {
    ids: {
      a: { window: a.id, contents: a.webContents.id },
      b: { window: b.id, contents: b.webContents.id },
      forger: { window: forger.id, contents: forger.webContents.id },
      spare: spare.webContents.id,
    },
    urls: { a1: urlA1, a2: urlA2, a3: urlA3, b1: urlB1, backstop: urlBackstop, forger: forgerUrl },
    log,
    gotA: await inPage<unknown[]>(a, 'got'),
    gotB: await inPage<unknown[]>(b, 'got'),
    popups,
    forged,
    control,
    frameUrls,
    processes: { mail: mailProcess, host: hostProcess },
    keys,
    escape,
    hosted,
    hostUrl: a.webContents.getURL(),
  };
  return result;
}

/**
 * The work package's "frame escape" items, from inside a served mail frame, against the real security.ts guards: the
 * frame navigating itself (script and a target=_self link) to another well-formed document, target=_top, a form
 * post, window.open of a javascript: URL. Each target is a fresh token issued to the same window, so a navigation that
 * got through would show up in the serve log as a 200.
 */
async function frameEscape(win: BrowserWindow, frame: Electron.WebFrameMain, connection: string) {
  const doc = () => issue(connection, withReporter('<p>escape target</p>'));
  const urls = { script: doc(), link: doc(), top: doc(), form: doc() };
  const opens = popups.length;
  const js = (code: string) => frame.executeJavaScript(code, true).catch(() => 'threw');
  await js(`location.href = ${JSON.stringify(urls.script)}; 1`);
  await wait(300);
  await js(
    `(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(urls.link)}; a.target = '_self'; document.body.append(a); a.click(); return 1; })()`,
  );
  await wait(300);
  await js(
    `(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(urls.top)}; a.target = '_top'; document.body.append(a); a.click(); return 1; })()`,
  );
  await js(
    `(() => { const f = document.createElement('form'); f.method = 'post'; f.action = ${JSON.stringify(urls.form)}; document.body.append(f); f.submit(); return 1; })()`,
  );
  const opened = await js(
    `String(window.open('javascript:parent.postMessage({pwned:"open"},"*")'))`,
  );
  const opener = await js('String(window.opener)');
  await wait(400);
  return {
    urls,
    frameUrl: frame.url,
    hostUrl: win.webContents.getURL(),
    opened,
    opener,
    popups: popups.slice(opens).map(p => p.url),
  };
}

/**
 * A WebContentsView hosted in window A: its contents is not A's own, so its aplos-mail request must not be stamped as
 * A. A document issued to A's connection, framed by the view, must be the 404.
 */
async function hostedView(win: BrowserWindow, file: string, connection: string) {
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } });
  recordOpens(view.webContents);
  win.contentView.addChildView(view);
  await view.webContents.loadURL(pathToFileURL(file).href);
  const url = issue(connection, withReporter('<p>for window A only</p>'));
  await view.webContents.executeJavaScript(`addFrame(${JSON.stringify(url)})`);
  await wait(200);
  const facts = { url, type: view.webContents.getType(), contents: view.webContents.id };
  win.contentView.removeChildView(view);
  view.webContents.close();
  return facts;
}

interface KeySeen {
  type: string;
  key: string;
  focused: string | null;
}

/**
 * The open question of ARCH 10 (does `before-input-event` fire with focus inside an out-of-process mail frame?),
 * measured here and recorded, not wired: html-5 builds no key relay (DECISIONS). Focus goes into the frame, then one
 * key goes in through `sendInputEvent` (the browser-side input path a real key takes) and one through DevTools'
 * `Input.dispatchKeyEvent`.
 */
async function keyProbe(win: BrowserWindow, frame: Electron.WebFrameMain): Promise<KeySeen[]> {
  const seen: KeySeen[] = [];
  const contents = win.webContents;
  const listener = (_event: Electron.Event, input: Electron.Input) => {
    seen.push({ type: input.type, key: input.key, focused: contents.focusedFrame?.url ?? null });
  };
  contents.on('before-input-event', listener);
  await frame.executeJavaScript('document.body.tabIndex = -1; document.body.focus(); 1', true);
  await contents.executeJavaScript("document.querySelector('iframe').focus(); 1");
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'J' });
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'J' });
  contents.debugger.attach('1.3');
  const key = { key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75 };
  await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
  await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  contents.debugger.detach();
  await wait(200);
  contents.off('before-input-event', listener);
  return seen;
}

void app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();
  try {
    const result = await scenario();
    process.stdout.write(`RELAY-RESULT ${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`RELAY-ERROR ${String((error as Error)?.stack ?? error)}\n`);
  }
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  // A normal quit, so Chromium finishes the net log the test reads.
  app.quit();
});
