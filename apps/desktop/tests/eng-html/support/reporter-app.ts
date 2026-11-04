// The Electron main of reporter.e2e.ts, bundled by the test with esbuild (electron external). The REAL reporter in a
// real Chromium: each document is built by the engine (`render`, then `withReporter`), issued a token by the engine's
// `FrameTokens` and answered by its `serveFrame` (status, body, every header, the CSP with the reporter's hash) under
// `aplos-mail://` registered {standard, secure}. A hidden host page frames it with the sealed sandbox and, like the
// reader's host, sizes each frame to the height it reports. Prints one `REPORTER-RESULT <json>` line. Nothing is
// shown, no Dock item, no network: the documents load nothing outside `aplos-mail:` (CSP) and the test maps every
// host name to "not found".
import { app, BrowserWindow, protocol } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { render } from '@aplos/mail-html';
import { FrameTokens, reporterHash, serveFrame, withReporter } from '@aplos/mail-html/frame';

if (process.platform === 'darwin') {
  app.setActivationPolicy('accessory');
  app.dock?.hide();
}
protocol.registerSchemesAsPrivileged([
  { scheme: 'aplos-mail', privileges: { standard: true, secure: true } },
]);
app.on('window-all-closed', () => {});

const WINDOW = 'w1';
const tokens = new FrameTokens();
let hash = '';

const HOST_PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0"><script>
window.reports = {};
window.frozen = {};
addEventListener('message', e => {
  const f = [...document.querySelectorAll('iframe')].find(x => x.contentWindow === e.source);
  if (!f || !e.data || typeof e.data.h !== 'number') return;
  const list = (reports[f.dataset.name] ??= []);
  list.push({ data: e.data, at: performance.now() });
  // A fence for the positive control only: unbounded growth is cut after 200 reports.
  if (list.length > 200) return void (frozen[f.dataset.name] = true);
  f.style.height = Math.max(1, Math.min(e.data.h, 200000)) + 'px';
});
window.addFrame = (name, src) => new Promise(resolve => {
  const f = document.createElement('iframe');
  f.dataset.name = name;
  f.setAttribute('sandbox', 'allow-scripts allow-popups');
  f.style.cssText = 'display:block;border:0;width:600px;height:150px';
  f.onload = () => resolve(true);
  setTimeout(() => resolve(false), 5000);
  f.src = src;
  document.body.appendChild(f);
});
</script></body>`;

function issue(document: string): string {
  const input = {
    windowId: WINDOW,
    messageId: 'acct:m1',
    accountScope: 'acct',
    imagePolicy: 'block' as const,
    document: withReporter(document),
    remoteImages: [],
    cids: [],
  };
  return tokens.issue(input, Date.now()).url;
}

/** The engine's own document for a mail: sanitized, standards mode, the reading CSS. */
function engineDocument(html: string): string {
  const result = render({ html, cids: [], imagePolicy: 'block' });
  if (result.bodyKind !== 'html' || !result.document) throw new Error('not html');
  return result.document;
}

/** The engine's head and reading CSS around a body the sanitizer never saw (the clobbering and loop controls). */
function unsanitized(body: string): string {
  return engineDocument('<p>x</p>').replace(/<body>[\s\S]*<\/body>/, () => `<body>${body}</body>`);
}

function installHandler(): void {
  protocol.handle('aplos-mail', async request => {
    const rest = request.url.slice('aplos-mail://m/'.length);
    const slash = rest.indexOf('/');
    const args = { token: rest.slice(0, slash), path: rest.slice(slash + 1), windowId: WINDOW };
    const answer = await serveFrame(tokens, args, {
      now: () => Date.now(),
      reporterHash: hash,
      cidBytes: () => undefined,
      imageBytes: () => undefined,
    });
    return new Response(answer.body as BodyInit, {
      status: answer.status,
      headers: answer.headers,
    });
  });
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const OUTRANK =
  '<style>html{height:5000px!important;margin-top:900px!important;transform:scale(3)!important}' +
  'body{height:4000px!important;position:absolute!important}' +
  '@layer aplos{html{height:6000px!important;min-height:6000px!important}}' +
  '@layer z{body{min-height:7000px!important}}</style>' +
  '<body style="height:3000px!important;min-height:3000px!important"><p>short</p></body>';

const DOCUMENTS: Record<string, () => string> = {
  // A closed <details> must report a smaller height than the open one.
  details: () =>
    engineDocument(
      '<p>Top</p><details open><summary>More</summary><div style="height:2000px">big</div></details><p>End</p>',
    ),
  // Viewport heights: fixed by the sanitizer, so the letter settles whatever the frame's height.
  vh100: () => engineDocument('<div style="height:100vh">full</div>'),
  vh150: () => engineDocument('<div style="min-height:150vh">tall</div><p>after</p>'),
  vhStyle: () =>
    engineDocument('<style>.a{height:calc(100dvh - 10px)}</style><div class="a">calc</div>'),
  // Positive control: the same 100vh without the sanitizer's rewrite grows with its frame.
  vhRaw: () => unsanitized('<div style="height:100vh">raw</div>'),
  // The paper tint: the root's colour when the body's is transparent; the body's when it has one.
  // Positive control for the doctype: the same short letter in quirks mode, where the root fills the viewport.
  quirksRaw: () => engineDocument('<p>short</p>').replace('<!DOCTYPE html>', ''),
  shortLetter: () => engineDocument('<p>short</p>'),
  // A mail trying to outrank the measuring rules: important rules unlayered, in a later layer, in a layer named like
  // the frame's own, and an important inline style on <body>. It must still measure as a short letter.
  outrank: () => engineDocument(OUTRANK),
  // Positive control: the same mail unsanitized (its layer joins the frame's, its <body> style stays important).
  outrankRaw: () => unsanitized(OUTRANK),
  rootPaper: () => engineDocument('<style>html{background:#123456}</style><p>paper</p>'),
  bodyPaper: () =>
    engineDocument(
      '<style>html{background:#123456}</style><body bgcolor="#fafafa"><p>paper</p></body>',
    ),
  noPaper: () => engineDocument('<p>none</p>'),
};

async function measure(win: BrowserWindow, name: string) {
  const frame = win.webContents.mainFrame.frames.find(f => f.url === urls[name]);
  if (!frame) return null;
  return frame.executeJavaScript(
    `(() => {
      const get = (type, key) => Object.getOwnPropertyDescriptor(type.prototype, key).get;
      const root = get(Document, 'documentElement').call(document);
      const box = Element.prototype.getBoundingClientRect.call(root);
      return {
        root: Math.ceil(box.height),
        top: box.top,
        compat: document.compatMode,
        inner: innerHeight,
      };
    })()`,
    true,
  ) as Promise<{ root: number; top: number; compat: string; inner: number }>;
}

const urls: Record<string, string> = {};

/** The clobbering document: what markup did to `document` and `window` in Chromium, read from the main world. */
const CLOBBER_FACTS = `(() => {
  const D = Document.prototype;
  const realBody = Object.getOwnPropertyDescriptor(D, 'body').get.call(document);
  return {
    documentBodyIsBody: document.body === realBody,
    documentElementIsRoot: document.documentElement === Object.getOwnPropertyDescriptor(D, 'documentElement').get.call(document),
    documentAddEventListener: typeof document.addEventListener,
    documentFonts: document.fonts === Object.getOwnPropertyDescriptor(D, 'fonts').get.call(document),
    windowAddEventListener: typeof window.addEventListener,
    windowResizeObserver: typeof window.ResizeObserver,
    windowGetComputedStyle: typeof window.getComputedStyle,
    windowInnerWidth: typeof window.innerWidth,
    windowParentIsParent: window.parent !== window,
    windowDocument: window.document === realBody.ownerDocument,
    windowDocumentCtor: typeof window.Document,
    windowObject: typeof window.Object,
    windowLocation: typeof window.location.pathname,
    root: Math.ceil(Element.prototype.getBoundingClientRect.call(Object.getOwnPropertyDescriptor(D, 'documentElement').get.call(document)).height),
  };
})()`;

async function scenario() {
  hash = await reporterHash();
  installHandler();
  const clobberHtml = readFileSync(process.env.APLOS_REPORTER_CLOBBER ?? '', 'utf8');
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { backgroundThrottling: false },
  });
  const file = join(app.getPath('userData'), 'host.html');
  writeFileSync(file, HOST_PAGE);
  await win.loadURL(pathToFileURL(file).href);
  const docs: Record<string, string> = Object.fromEntries(
    Object.entries(DOCUMENTS).map(([name, make]) => [name, make()]),
  );
  docs.clobber = unsanitized(clobberHtml);
  for (const [name, document] of Object.entries(docs)) {
    urls[name] = issue(document);
    await win.webContents.executeJavaScript(
      `addFrame(${JSON.stringify(name)}, ${JSON.stringify(urls[name])})`,
    );
  }
  await wait(2500);
  const settled: Record<string, unknown> = {};
  for (const name of Object.keys(docs)) settled[name] = await measure(win, name);
  const clobberFrame = win.webContents.mainFrame.frames.find(f => f.url === urls.clobber);
  const clobber = clobberFrame ? await clobberFrame.executeJavaScript(CLOBBER_FACTS, true) : null;
  const before = await reportsOf(win);
  // Close the <details>, then open it again: the height must follow both ways.
  const detailsFrame = win.webContents.mainFrame.frames.find(f => f.url === urls.details);
  await detailsFrame?.executeJavaScript(`document.querySelector('details').open = false; 1`, true);
  await wait(800);
  const closed = await reportsOf(win);
  await detailsFrame?.executeJavaScript(`document.querySelector('details').open = true; 1`, true);
  await wait(800);
  const reopened = await reportsOf(win);
  const frames = await win.webContents.executeJavaScript(
    `Object.fromEntries([...document.querySelectorAll('iframe')].map(f => [f.dataset.name, f.getBoundingClientRect().height]))`,
  );
  const frozen = await win.webContents.executeJavaScript('frozen');
  return { urls, before, closed, reopened, settled, clobber, frames, frozen };
}

function reportsOf(win: BrowserWindow) {
  return win.webContents.executeJavaScript('reports') as Promise<
    Record<string, { data: Record<string, unknown>; at: number }[]>
  >;
}

void app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();
  try {
    const result = await scenario();
    process.stdout.write(`REPORTER-RESULT ${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`REPORTER-ERROR ${String((error as Error)?.stack ?? error)}\n`);
  }
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  app.quit();
});
