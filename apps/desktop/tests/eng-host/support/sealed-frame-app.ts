// The Electron main of sealed-frame.e2e.ts, bundled by the test with esbuild (electron external) to `<tmp>/main/main.cjs`.
// It is not the Aplos app. It wires the REAL pieces the sealed mail frame depends on in main: the `aplos-mail:` scheme and
// relay (main/mail-protocol.ts), the navigation guards (main/security.ts), the sealed-frame relays (the same
// `attachSealedFrameRelays` main/windows.ts calls, with recording sinks instead of handleLink and the browser) and the
// REAL preload (`<tmp>/main/preload.cjs`, built from main/preload.ts), to a stand-in engine that serves raw documents.
// One hidden window, no Dock item, a temp user-data dir, no network (the frame's documents are served from memory).
// It prints one `SEALED-RESULT <json>` line.
import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installMailProtocol, registerMailScheme } from '../../../src/main/mail-protocol';
import { allowMailFrames, installPermissionHandlers } from '../../../src/main/security';
import { ENGINE_PORT_ARG, hostServeArgs } from '../../../src/host/transports/port';
import { attachSealedFrameRelays } from '../../../src/host/protocol/frame-relays';
import type { ServeArgs } from '../../../src/host/protocol/relay';

if (process.platform === 'darwin') {
  app.setActivationPolicy('accessory');
  app.dock?.hide();
}
registerMailScheme();
app.on('window-all-closed', () => {});

const attached = new Map<number, string>();
const documents = new Map<string, { owner: string; html: string }>();
const LETTER_CSP = "default-src 'none'; style-src 'unsafe-inline'";

async function standInServe(args: ServeArgs): Promise<unknown> {
  const translated = hostServeArgs(args, id => attached.get(id));
  const doc = documents.get(String(translated.token));
  if (!doc || translated.path !== '' || translated.windowId !== doc.owner)
    return {
      status: 404,
      headers: { 'content-security-policy': "default-src 'none'" },
      body: new Uint8Array(),
    };
  const headers = { 'content-security-policy': LETTER_CSP, 'content-type': 'text/html' };
  return { status: 200, headers, body: new TextEncoder().encode(doc.html) };
}

function issue(owner: string, html: string): string {
  const token = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(
    '',
  );
  documents.set(token, { owner, html });
  return `aplos-mail://m/${token}/`;
}

const HOST_PAGE = `<!doctype html><meta charset="utf-8"><body><input id="field"><script>
window.hostKeys = [];
window.mailKeys = [];
window.got = [];
addEventListener('message', e => got.push(String(e.data)));
addEventListener('keydown', e => hostKeys.push(e.key));
if (window.aplos) window.aplos.subscribe(e => { if (e.type === 'mail-key') mailKeys.push(e.payload); });
window.addFrame = src => new Promise(resolve => {
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts allow-popups');
  f.onload = () => resolve(true);
  setTimeout(() => resolve(false), 5000);
  f.src = src;
  document.body.appendChild(f);
});
</script></body>`;

const LETTER = `<!doctype html><html><body tabindex="-1"><p>Hello</p>
<a id="mail-blank" target="_blank" href="mailto:ada@example.invalid?subject=Hi%20there">mail blank</a>
<a id="mail-self" href="mailto:grace@example.invalid">mail self</a>
<a id="web-blank" target="_blank" href="https://example.invalid/x">web blank</a>
<a id="web-self" href="https://example.invalid/y">web self</a>
<a id="http-self" href="http://example.invalid/z">http self</a>
<a id="inject" target="_blank" href="mailto:a@b.invalid?subject=Hi%0d%0aBcc:evil@c.invalid">inject</a>
<a id="js-blank" target="_blank" href="javascript:parent.postMessage('pwned','*')">js blank</a>
<a id="js-self" href="javascript:parent.postMessage('pwned','*')">js self</a>
<a id="data-blank" target="_blank" href="data:text/html,<p>x</p>">data blank</a>
<a id="data-self" href="data:text/html,<p>x</p>">data self</a>
<a id="file-blank" target="_blank" href="file:///etc/hosts">file blank</a>
<a id="file-self" href="file:///etc/hosts">file self</a>
<a id="blob-blank" target="_blank" href="blob:https://example.invalid/00000000-0000-0000-0000-000000000000">blob blank</a>
<a id="tel-blank" target="_blank" href="tel:+15551234">tel blank</a>
<a id="tel-self" href="tel:+15551234">tel self</a>
<a id="ftp-blank" target="_blank" href="ftp://example.invalid/x">ftp blank</a>
<a id="toc" href="#m-section">table of contents</a>
<a id="top-mail" target="_top" href="aplos-mail://m/${'ab'.repeat(16)}/">top mail</a>
</body></html>`;

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function scenario() {
  installPermissionHandlers();
  installMailProtocol(standInServe);
  allowMailFrames();
  // security.ts trusts `<bundle dir>/../renderer/index.html`; the test removes the whole temp directory afterwards.
  const file = resolve(__dirname, '../renderer/index.html');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, HOST_PAGE);
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      additionalArguments: [ENGINE_PORT_ARG],
    },
  });
  const mails: string[] = [];
  const webs: string[] = [];
  const navigations: {
    url: string;
    main: boolean;
    frame: string | null;
    initiator: string | null;
  }[] = [];
  win.webContents.on('will-frame-navigate', event =>
    navigations.push({
      url: event.url,
      main: event.isMainFrame,
      frame: event.frame?.url ?? null,
      initiator: event.initiator?.url ?? null,
    }),
  );
  attachSealedFrameRelays(win.webContents, {
    openMail: url => void mails.push(url),
    openWeb: url => void webs.push(url),
  });
  await win.loadURL(pathToFileURL(file).href);
  attached.set(win.id, `conn-${win.id}`);
  const url = issue(`conn-${win.id}`, LETTER);
  const page = <T>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  await page(`addFrame(${JSON.stringify(url)})`);
  await wait(300);
  const frame = win.webContents.mainFrame.frames[0];
  if (!frame || frame.url !== url) throw new Error(`the letter did not load: ${frame?.url}`);
  const inFrame = <T>(code: string) => frame.executeJavaScript(code, true) as Promise<T>;

  const isolation = await measureIsolation(win, frame, page, inFrame);
  const links = await clickLinks(win, frame, inFrame, page, mails, webs, navigations, url);
  const keys = await pressKeys(win, frame, inFrame, page);
  const fragment = await afterFragmentClick(win, frame, inFrame, page, mails, webs);
  return { url, isolation, links, keys, fragment, hostUrl: win.webContents.getURL() };
}

async function measureIsolation(
  win: BrowserWindow,
  frame: Electron.WebFrameMain,
  page: <T>(code: string) => Promise<T>,
  inFrame: <T>(code: string) => Promise<T>,
) {
  const host = win.webContents.mainFrame;
  const metrics = app.getAppMetrics().map(m => ({ pid: m.pid, type: m.type }));
  const probe = `(() => {
    const out = {};
    for (const name of ['aplos', 'aplosEngine', 'require', 'process', 'Buffer', 'electron'])
      out[name] = typeof window[name];
    out.origin = String(window.origin);
    try { out.parentDocument = String(parent.document.title); } catch (e) { out.parentDocument = e.name; }
    try { out.parentAplos = String(parent.aplos); } catch (e) { out.parentAplos = e.name; }
    try { out.topLocation = String(top.location.href); } catch (e) { out.topLocation = e.name; }
    try { out.openerNull = String(window.opener); } catch (e) { out.openerNull = e.name; }
    try { out.storage = String(localStorage.length); } catch (e) { out.storage = e.name; }
    return out;
  })()`;
  return {
    frameProcess: { id: frame.processId, os: frame.osProcessId },
    hostProcess: { id: host.processId, os: host.osProcessId },
    mainPid: process.pid,
    metrics,
    inFrame: await inFrame<Record<string, string>>(probe),
    inHost: await page<Record<string, string>>(`(() => {
      const f = document.querySelector('iframe');
      const out = { aplos: typeof window.aplos, aplosEngine: typeof window.aplosEngine };
      out.contentDocument = String(f.contentDocument);
      try { out.contentWindowDocument = String(f.contentWindow.document); } catch (e) { out.contentWindowDocument = e.name; }
      try { out.frameDom = String(f.contentWindow.document.body); } catch (e) { out.frameDom = e.name; }
      return out;
    })()`),
  };
}

async function clickLinks(
  win: BrowserWindow,
  frame: Electron.WebFrameMain,
  inFrame: <T>(code: string) => Promise<T>,
  page: <T>(code: string) => Promise<T>,
  mails: string[],
  webs: string[],
  navigations: { url: string; main: boolean; frame: string | null; initiator: string | null }[],
  url: string,
) {
  const clicked: Record<
    string,
    { mails: string[]; webs: string[]; frameUrl: string; hostUrl: string }
  > = {};
  const ids = [
    'mail-blank',
    'mail-self',
    'web-blank',
    'web-self',
    'http-self',
    'inject',
    'js-blank',
    'js-self',
    'data-blank',
    'data-self',
    'file-blank',
    'file-self',
    'blob-blank',
    'tel-blank',
    'tel-self',
    'ftp-blank',
    'top-mail',
  ];
  for (const id of ids) {
    const before = { mails: mails.length, webs: webs.length };
    await inFrame(`document.getElementById(${JSON.stringify(id)}).click(); 1`);
    await wait(250);
    clicked[id] = {
      mails: mails.slice(before.mails),
      webs: webs.slice(before.webs),
      frameUrl: frame.url,
      hostUrl: win.webContents.getURL(),
    };
  }
  return {
    clicked,
    navigations: navigations.filter(n => n.url !== url),
    messages: await page<string[]>('got'),
  };
}

/** A newsletter's table of contents: a fragment link changes the frame's URL to `<document>#m-section`. */
async function afterFragmentClick(
  win: BrowserWindow,
  frame: Electron.WebFrameMain,
  inFrame: <T>(code: string) => Promise<T>,
  page: <T>(code: string) => Promise<T>,
  mails: string[],
  webs: string[],
) {
  await inFrame("document.getElementById('toc').click(); 1");
  await wait(250);
  const frameUrl = frame.url;
  await page('mailKeys.splice(0)');
  await inFrame('document.body.focus(); 1');
  await page("document.querySelector('iframe').focus(); 1");
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'J' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'J' });
  await wait(150);
  const mailKeys = await page<unknown[]>('mailKeys.splice(0)');
  const before = { mails: mails.length, webs: webs.length };
  await inFrame("document.getElementById('mail-self').click(); 1");
  await wait(250);
  await inFrame("document.getElementById('web-self').click(); 1");
  await wait(250);
  return {
    frameUrl,
    focused: win.webContents.focusedFrame?.url ?? 'none',
    mailKeys,
    mails: mails.slice(before.mails),
    webs: webs.slice(before.webs),
  };
}

interface KeyStep {
  step: string;
  focused: string;
  mailKeys: unknown[];
  hostKeys: string[];
}

async function pressKeys(
  win: BrowserWindow,
  frame: Electron.WebFrameMain,
  inFrame: <T>(code: string) => Promise<T>,
  page: <T>(code: string) => Promise<T>,
) {
  const contents = win.webContents;
  const steps: KeyStep[] = [];
  const snapshot = async (step: string) => {
    await wait(120);
    steps.push({
      step,
      focused: contents.focusedFrame?.url ?? 'none',
      mailKeys: await page<unknown[]>('mailKeys.splice(0)'),
      hostKeys: await page<string[]>('hostKeys.splice(0)'),
    });
  };
  const press = async (keyCode: string, modifiers: Electron.InputEvent['modifiers'] = []) => {
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  // Focus inside the sealed frame, as relay.e2e.ts's key probe does.
  await inFrame('document.body.focus(); 1');
  contents.focus();
  await page("document.querySelector('iframe').focus(); 1");
  for (const [name, keyCode, modifiers] of [
    ['j', 'J', []],
    ['k', 'K', []],
    ['shift J', 'J', ['shift']],
    ['shift K', 'K', ['shift']],
    ['ArrowUp', 'Up', []],
    ['ArrowDown', 'Down', []],
    ['PageUp', 'PageUp', []],
    ['PageDown', 'PageDown', []],
    ['Home', 'Home', []],
    ['End', 'End', []],
    ['Escape', 'Escape', []],
    ['e', 'E', []],
    ['r', 'R', []],
    ['Space', 'Space', []],
    ['Enter', 'Enter', []],
    ['Delete', 'Delete', []],
    ['Backspace', 'Backspace', []],
    ['ctrl j', 'J', ['control']],
    ['meta k', 'K', ['meta']],
    ['alt ArrowUp', 'Up', ['alt']],
    ['shift ArrowDown', 'Down', ['shift']],
  ] as [string, string, Electron.InputEvent['modifiers']][]) {
    await press(keyCode, modifiers);
    await snapshot(name);
  }
  // Forged messages straight onto the channel: preload drops each; the one good message arrives once.
  for (const forged of [{ key: 'e' }, { key: 'Enter' }, { key: 'j', extra: 1 }, 'j', null])
    contents.send('aplos:mail-key', forged);
  contents.send('aplos:mail-key', { key: 'Escape' });
  await snapshot('forged channel messages, then one good one');
  // The app page's own keys: focus the page (not the frame), press the same listed key.
  await page("document.getElementById('field').focus(); 1");
  await wait(100);
  await press('J');
  await snapshot('app page: j typed in its own input');
  await page('document.activeElement.blur(); 1');
  contents.focus();
  await press('K');
  await snapshot('app page: k with focus on the page');
  void frame;
  return steps;
}

void app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();
  try {
    const result = await scenario();
    process.stdout.write(`SEALED-RESULT ${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`SEALED-ERROR ${String((error as Error)?.stack ?? error)}\n`);
  }
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  app.quit();
});
