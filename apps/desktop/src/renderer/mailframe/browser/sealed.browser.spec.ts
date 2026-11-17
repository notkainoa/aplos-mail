// html-5 host wiring: the MailFrame host against the REAL reporter (`packages/mail-html/assets/reporter.js`) in a real
// sealed-like frame, in headless Chromium. Every document is built by the engine (`render` + `withReporter`), issued
// a token by the engine's `FrameTokens` and answered by the engine's `serveFrame` (status, body and headers, CSP
// included), so the frame is `<iframe sandbox="allow-scripts allow-popups">` (never allow-same-origin) with the CSP as
// a response header, exactly as `Mail/serve` will answer. What is NOT the real thing until engine slice 2 and eng-host:
// the scheme. Main does not register `aplos-mail:` yet, so the spec serves `aplos-mail://m/<token>/<path>` as
// `http://sealed.test/<token>/<path>` and maps the CSP's `aplos-mail:` source to that origin; no process isolation or
// navigation policy from main is exercised (PROTOCOL.md "Before aplos-mail:// ships").
//   npx playwright test -c apps/desktop/src/renderer/mailframe/browser/playwright.config.ts sealed
// The five stress bodies run only with APLOS_MAILFRAME_STRESS=1 (see that test).

import { render } from '@aplos/mail-html';
import {
  FrameTokens,
  REPORTER_SOURCE,
  reporterHash,
  serveFrame,
  withReporter,
  type ServeResponse,
} from '@aplos/mail-html/frame';
import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from '../../../../../../packages/mail-html/corpus/index';
import { CORPUS } from '../corpus';
import { URL_SANDBOX } from '../document';
import { FALLBACK_KEYS } from '../keys';
import { FRAME_DARK, FRAME_PAPER } from '../paper';

/** A colour as the browser serialises it back from an inline style (the page's own, so no colour literal is built here). */
function cssColour(page: Page, colour: string): Promise<string> {
  return page.evaluate(value => {
    const probe = document.createElement('i');
    probe.style.background = value;
    return probe.style.background;
  }, colour);
}

/** The paper colour off by one blue step: a body colour a mail may choose, and no signal of anything. */
const OFF_WHITE = `${FRAME_PAPER.paper.slice(0, -2)}fe`;
import { parseBg } from '../protocol';

const ORIGIN = 'http://mailframe.test';
/** Stands in for `aplos-mail://m/`: the same path grammar, `/<token>/` and `/<token>/(cid|img)/<n>`. */
const REAL_ORIGIN = 'http://sealed.test';
/** Every corpus vector points here; nothing may reach it. */
const CANARY = 'http://canary.test';
/** The one window the registry knows (main binds the requesting window; here there is one). */
const WINDOW = 'host-window';
const HOST_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="root" style="width:640px"></div><script src="/entry.js"></script></body></html>`;
/** An email background the host must pick up (a token value: the spec holds no raw colours). */
const DARK = FRAME_PAPER.ink;
/** The reporter's message keys, in its order. */
const REPORT_KEYS = ['token', 'h', 'w', 'bg', 'ready', 'marks', 'plain'];

let bundle = '';

test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./entry.tsx', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  bundle = result.outputFiles[0]!.text;
});

/** How the spec's stand-in for main's scheme handler answers one token. */
interface ServeOptions {
  /** Hold the document this long before answering (a slow `Mail/serve`). */
  delayMs?: number;
  /** Positive control only: drop the CSP header. */
  noCsp?: boolean;
}

/** The engine's registry and `serveFrame`, behind the spec's `http://sealed.test` stand-in for the scheme. */
class SealedServer {
  readonly registry: FrameTokens;
  readonly options = new Map<string, ServeOptions>();
  /** Every answer: path and status. */
  readonly served: { path: string; status: number }[] = [];

  /** `pinned`: the one token this server will issue, so a document can name its own token before it is issued. */
  constructor(pinned?: string) {
    const random = pinned
      ? (bytes: Uint8Array) => bytes.set(Buffer.from(pinned, 'hex'))
      : undefined;
    this.registry = new FrameTokens({ insecureTestRandom: random });
  }

  /** Issue a token for a finished frame document (reporter included or not). */
  issue(document: string, options: ServeOptions = {}, cids: readonly string[] = []): string {
    const input = {
      windowId: WINDOW,
      messageId: 'm1',
      accountScope: 'a1',
      imagePolicy: 'block' as const,
    };
    const frame = { ...input, document, remoteImages: [], cids } as const;
    const { token } = this.registry.issue(frame, Date.now());
    this.options.set(token, options);
    return token;
  }

  async answer(url: string): Promise<ServeResponse> {
    const [, token = '', ...rest] = new URL(url).pathname.split('/');
    const path = rest.length === 0 ? undefined : rest.join('/');
    const deps = { now: Date.now, reporterHash: await reporterHash() };
    const response = await serveFrame(this.registry, { windowId: WINDOW, token, path }, deps);
    const options = this.options.get(token) ?? {};
    if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
    this.served.push({ path: `${token}/${path ?? ''}`, status: response.status });
    return { ...response, headers: harnessHeaders(response.headers, options) };
  }
}

/** The engine's headers with `aplos-mail:` mapped to the stand-in origin (and the CSP dropped for the control). */
function harnessHeaders(headers: Record<string, string>, options: ServeOptions) {
  const out = { ...headers };
  const csp = out['content-security-policy'];
  if (csp) out['content-security-policy'] = csp.replaceAll('aplos-mail:', REAL_ORIGIN);
  if (options.noCsp) delete out['content-security-policy'];
  return out;
}

/**
 * Requests seen. `own`: the frame's document and its `cid/<n>`/`img/<n>`. `outbound`: every other request event
 * (Chromium also reports loads the CSP refused in the renderer). `network`: the outbound ones that reached the network
 * layer (the route handler), i.e. would have left the machine.
 */
interface Traffic {
  own: string[];
  outbound: string[];
  network: string[];
  popups: string[];
}

/** Serve the host page, the bundle and the sealed frame; abort and record everything else. */
async function openHost(page: Page, server: SealedServer, hash: string): Promise<Traffic> {
  const traffic: Traffic = { own: [], outbound: [], network: [], popups: [] };
  const isHost = (url: string) => url === `${ORIGIN}/` || url === `${ORIGIN}/entry.js`;
  page.on('request', request => {
    const url = request.url();
    if (isHost(url)) return;
    if (url.startsWith(`${REAL_ORIGIN}/`)) traffic.own.push(url);
    else traffic.outbound.push(url);
  });
  page.on('websocket', ws => void traffic.network.push(ws.url()));
  page.context().on('page', popup => void traffic.popups.push(popup.url()));
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url === `${ORIGIN}/`) return route.fulfill({ contentType: 'text/html', body: HOST_PAGE });
    if (url === `${ORIGIN}/entry.js`)
      return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (!url.startsWith(`${REAL_ORIGIN}/`)) {
      traffic.network.push(url);
      return route.abort();
    }
    const { status, headers, body } = await server.answer(url);
    return route.fulfill({ status, headers, body: Buffer.from(body) }).catch(() => undefined);
  });
  await page.goto(`${ORIGIN}/#${hash}`);
  return traffic;
}

/** Wait until the host shows the letter or the failed state; true when the letter reported. */
async function settled(page: Page, timeout = 15_000): Promise<boolean> {
  await page.waitForFunction(
    () =>
      window.__mailframe.ready.length > 0 ||
      document.body.textContent?.includes('Couldn’t load this email.'),
    undefined,
    { timeout },
  );
  return page.evaluate(() => window.__mailframe.ready.length > 0);
}

/** What the host can see: its recorder, the frame element, and whether anything in the frame reached it. */
function hostState(page: Page) {
  return page.evaluate(() => {
    const frame = document.querySelector('iframe');
    const recorder = window.__mailframe;
    return {
      ready: recorder.ready,
      keys: recorder.keys,
      hostKeys: recorder.hostKeys,
      posted: recorder.posted,
      opened: recorder.opened,
      frames: document.querySelectorAll('iframe').length,
      sandbox: frame?.getAttribute('sandbox'),
      src: frame?.getAttribute('src'),
      height: frame?.style.height,
      padding: frame?.style.padding,
      background: frame?.style.background,
      colorScheme: frame?.style.colorScheme,
      radius: frame?.style.borderRadius,
      hidden: frame?.style.visibility === 'hidden',
      href: location.href,
      aplos: JSON.stringify((window as unknown as { aplos: unknown }).aplos),
      pwned: (window as { pwned?: unknown }).pwned,
    };
  });
}

/** True when every post that reached the host is the genuine reporter's: its seven keys, this token. */
function onlyReporterPosts(posted: unknown[], token: string): boolean {
  return posted.every(data => {
    if (typeof data !== 'object' || data === null) return false;
    const message = data as Record<string, unknown>;
    return Object.keys(message).join() === REPORT_KEYS.join() && message.token === token;
  });
}

function sealedDocument(html: string, cids: string[] = []): string {
  const result = render({ html, imagePolicy: 'block', cids });
  if (result.bodyKind !== 'html' || !result.document) throw new Error('not an html body');
  return withReporter(result.document);
}

/** A plain letter reports `plain: true`; a rich one that paints the host's own surface colours as its body background never does. */
const PLAIN_CASES: [string, string, boolean][] = [
  [
    'a plain letter',
    '<p>Hello</p><p><b>Bold</b> and <a href="https://example.com/x">a link</a></p>',
    true,
  ],
  [
    'a rich letter painting the dark surface',
    `<body bgcolor="${FRAME_DARK.surface}"><style>p{color:red}</style><p>Hello</p></body>`,
    false,
  ],
  [
    'a rich letter painting the off-white sentinel',
    `<body style="background:${OFF_WHITE}"><p style="color:gray">Hello</p></body>`,
    false,
  ],
  [
    'a styled letter that forges the marker on its own html element',
    `<html data-aplos-plain="x"><body bgcolor="${FRAME_DARK.surface}"><style>p{color:red}</style><p>Hello</p></body></html>`,
    false,
  ],
  [
    'a rich letter painting paper',
    `<body bgcolor="${FRAME_PAPER.paper}"><table><tr><td>Hello</td></tr></table></body>`,
    false,
  ],
];
for (const [name, html, plain] of PLAIN_CASES)
  test(`the real reporter reports plain from the sanitiser's marker, never from a colour: ${name}`, async ({
    page,
  }) => {
    const server = new SealedServer();
    const token = server.issue(sealedDocument(html), {}, []);
    await openHost(page, server, `real/${token}`);
    expect(await settled(page)).toBe(true);
    const state = await hostState(page);
    const posts = state.posted as Record<string, unknown>[];
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) expect(post.plain).toBe(plain);
    expect(onlyReporterPosts(state.posted, token)).toBe(true);
    // The host's own styling follows the marker and nothing else: a rich letter keeps the light paper in its inset ring,
    // whatever body colour it painted; only a plain one is flush on the card.
    if (plain) {
      expect(state.padding).toBe('0px');
      expect(state.radius).toBe('0px');
    } else {
      expect(state.padding).toContain('--sheet-inset');
      expect(state.background).toBe(await cssColour(page, FRAME_PAPER.paper));
      expect(state.colorScheme).toBe('light');
      expect(state.radius).not.toBe('0px');
    }
  });

/**
 * Dark theme (hands-on test 2026-11-16): a letter with no colours of its own draws on the card's dark surface, and that
 * includes a reply whose Gmail-style quote bar has an inline margin and border style (it used to read as "rich" and
 * sat on a white sheet). A forward is not folded away: its text is open in the document.
 */
const DARK_CASES: [string, string, { plain: boolean; folded: boolean }][] = [
  ['a plain letter', '<p>Hello there</p>', { plain: true, folded: false }],
  [
    'a reply with a quote bar',
    `<div dir="ltr">Thanks</div><div class="gmail_quote"><blockquote class="gmail_quote" style="margin:0;border-left:1px solid ${FRAME_DARK.rule};padding-left:0">old text</blockquote></div>`,
    { plain: true, folded: true },
  ],
  [
    'a forward',
    '<div dir="ltr"><br><div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br>From: A</div><div>The forwarded words</div></div></div>',
    { plain: true, folded: false },
  ],
  [
    'a letter with its own colours',
    `<p style="color:${FRAME_PAPER.accent}">Hello</p>`,
    { plain: false, folded: false },
  ],
];
for (const [name, html, want] of DARK_CASES)
  test(`dark theme: ${name} sits on the dark card or keeps its paper; quotes fold only after words`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    const server = new SealedServer();
    const document = sealedDocument(html);
    const token = server.issue(document, {}, []);
    await openHost(page, server, `real/${token}`);
    expect(await settled(page)).toBe(true);
    const state = await hostState(page);
    const posts = state.posted as Record<string, unknown>[];
    expect(posts.at(-1)?.plain).toBe(want.plain);
    expect(state.background).toBe(
      await cssColour(page, want.plain ? FRAME_DARK.surface : FRAME_PAPER.paper),
    );
    expect(document.includes('<details class="aplos-quote"')).toBe(want.folded);
  });

test('the real reporter sizes the host: height, bg and onReady once, from an opaque frame', async ({
  page,
}) => {
  const server = new SealedServer();
  // An inline part too: the frame's own `cid/0` request, a positive control that the spec sees what the
  // out-of-process frame loads (no `cidBytes` here, so the engine answers 404 and the image is empty).
  const html = `<body style="background:${DARK}"><div style="height:700px">Hello</div><img src="cid:logo@x" alt="" width="1" height="1" style="display:block;position:absolute;top:0"></body>`;
  const token = server.issue(sealedDocument(html, ['logo@x']), {}, ['logo@x']);
  const traffic = await openHost(page, server, `real/${token}`);
  expect(await settled(page)).toBe(true);
  const state = await hostState(page);
  expect(state.ready).toHaveLength(1);
  // 700 px of content plus the engine's 16 px body padding above and below.
  expect(state.ready[0]).toEqual({ height: 732, bg: parseBg(DARK), blocked: 0, trackers: 0 });
  expect(state).toMatchObject({ sandbox: URL_SANDBOX, height: '732px', hidden: false });
  expect(state.src).toBe(`${REAL_ORIGIN}/${token}/`);
  expect(state.posted.length).toBeGreaterThan(0);
  expect(onlyReporterPosts(state.posted, token)).toBe(true);
  const cid = `${REAL_ORIGIN}/${token}/cid/0`;
  expect(traffic).toEqual({
    own: [`${REAL_ORIGIN}/${token}/`, cid],
    outbound: [],
    network: [],
    popups: [],
  });
  // The frame is opaque and the CSP header is in force: an inline script added to it is refused, storage throws.
  const frame = page.frames().find(f => f.url() === `${REAL_ORIGIN}/${token}/`)!;
  const inside = await frame.evaluate(async () => {
    const attempt = (run: () => unknown) => {
      try {
        run();
        return 'ran';
      } catch (error) {
        return (error as Error).name;
      }
    };
    const violation = new Promise<string>(resolve =>
      document.addEventListener('securitypolicyviolation', e => resolve(e.effectiveDirective), {
        once: true,
      }),
    );
    const script = document.createElement('script');
    script.textContent = 'document.body.dataset.ran = "1"';
    document.body.append(script);
    return {
      origin: self.origin,
      inlineScript: document.body.dataset.ran ?? 'refused',
      directive: await violation,
      storage: attempt(() => localStorage.length),
      parentAplos: attempt(() => (parent as unknown as { aplos: unknown }).aplos),
    };
  });
  expect(inside).toEqual({
    origin: 'null',
    inlineScript: 'refused',
    directive: 'script-src-elem',
    storage: 'SecurityError',
    parentAplos: 'SecurityError',
  });
  // Single render: the document is never served twice.
  expect(server.served).toEqual([
    { path: `${token}/`, status: 200 },
    { path: `${token}/cid/0`, status: 404 },
  ]);
});

test('the real reporter re-reports when the letter grows: a <details> toggle and a late image', async ({
  page,
}) => {
  const server = new SealedServer();
  const html =
    '<p>Top</p><details><summary>More</summary><div style="height:400px">Hidden</div></details>';
  const token = server.issue(sealedDocument(html));
  await openHost(page, server, `real/${token}`);
  expect(await settled(page)).toBe(true);
  const heightOf = async () => Number.parseInt((await hostState(page)).height ?? '0', 10);
  const first = await heightOf();
  const frame = page.frames().find(f => f.url() === `${REAL_ORIGIN}/${token}/`)!;
  await frame.locator('summary').click();
  await expect.poll(heightOf).toBeGreaterThanOrEqual(first + 400);
  const opened = await heightOf();
  // Late growth with no event of its own (an image arriving): the reporter's ResizeObserver.
  await frame.evaluate(() => {
    const block = document.createElement('div');
    block.style.height = '300px';
    document.body.append(block);
  });
  await expect.poll(heightOf).toBeGreaterThanOrEqual(opened + 300);
  const state = await hostState(page);
  expect(state.ready).toHaveLength(1);
  expect(state.ready[0]!.height).toBe(first);
  expect(onlyReporterPosts(state.posted, token)).toBe(true);
  // Closing it again: recorded, not asserted. The reporter measures `scrollHeight`, which never falls below the
  // frame's own height, so a letter does not shrink (REQUEST to eng-html in PROTOCOL.md).
  await frame.locator('summary').click();
  await page.waitForTimeout(300);
  test.info().annotations.push({
    type: 'shrink',
    description: `after closing: ${await heightOf()} px (open + image: ${opened + 300} px)`,
  });
});

/** A token chosen by the spec (the engine's are random), for documents that name their own token. */
const PINNED = 'feedfacefeedfacefeedfacefeedface';

/** A forged reporter message, as script in the email would post it. */
function forgery(h: number): string {
  return `parent.postMessage({token:'${PINNED}',h:${h},w:innerWidth,bg:'${DARK}',ready:true,marks:0},'*')`;
}

/** The reporter's one post, exactly as `REPORTER_SOURCE` spells it (`host` is its `w.parent`). */
const REPORTER_POST = "host.postMessage(message, '*')";
/** A copy of the real reporter with its post swapped for a forgery: same code, a different hash. */
const FORGED_REPORTER = REPORTER_SOURCE.replace(REPORTER_POST, forgery(4326));

/**
 * Unsanitised on purpose (the sanitiser strips all of these): every way an email might run script, each posting a
 * perfect forgery with the right token, plus a copy of the reporter with its post swapped for a forgery.
 */
const HOSTILE = [
  '<html><body><p>Hi</p>',
  `<img src="${CANARY}/control.png" alt="">`,
  `<script>${forgery(4321)};window.pwned=1;try{parent.aplos.leak=1}catch(e){};try{top.location='${CANARY}/top'}catch(e){}</script>`,
  `<img src="data:," onerror="${forgery(4322)}">`,
  `<svg onload="${forgery(4323)}"></svg>`,
  `<script src="data:text/javascript,${encodeURIComponent(forgery(4324))}"></script>`,
  `<iframe srcdoc="<script>${forgery(4325).replace('parent', 'parent.parent')}</script>"></iframe>`,
  `<script>${FORGED_REPORTER}</script>`,
  '</body></html>',
].join('');

test('the forged reporter copy is a forgery, never an exact copy of the reporter', () => {
  // An exact copy would carry the reporter's hash, so the CSP would run it and the case would prove nothing.
  expect(REPORTER_SOURCE.split(REPORTER_POST)).toHaveLength(2);
  expect(FORGED_REPORTER).not.toBe(REPORTER_SOURCE);
  expect(FORGED_REPORTER).toContain(forgery(4326));
  expect(FORGED_REPORTER).not.toContain(REPORTER_POST);
});

function forgedHeights(posted: unknown[]): unknown[] {
  return posted
    .map(p => (p as { h?: unknown }).h)
    .filter(h => typeof h === 'number' && h >= 4321 && h <= 4326);
}

test('script in the email cannot run or post: the CSP hash pins the reporter', async ({ page }) => {
  const server = new SealedServer(PINNED);
  server.issue(withReporter(HOSTILE));
  const traffic = await openHost(page, server, `real/${PINNED}`);
  expect(await settled(page)).toBe(true);
  await page.waitForTimeout(400);
  const state = await hostState(page);
  expect(forgedHeights(state.posted)).toEqual([]);
  expect(onlyReporterPosts(state.posted, PINNED)).toBe(true);
  expect(state.ready[0]!.height).toBeLessThan(1_000);
  expect(state.pwned).toBeUndefined();
  expect(state.aplos).toBe(JSON.stringify({ secret: 'host-only' }));
  expect(state.href).toBe(`${ORIGIN}/#real/${PINNED}`);
  // The CSP refused the canary image in the renderer: Chromium reports the attempt, nothing reached the network.
  expect(traffic.network).toEqual([]);
  expect(traffic.popups).toEqual([]);
});

test('positive control: without the CSP header the same email forges its size and the host is fooled', async ({
  page,
}) => {
  // The email's inline script now runs, and its forgery is indistinguishable from the reporter's (same window, same
  // token): the hash in the CSP is what keeps an email from sizing its own frame. The sandbox still holds.
  const server = new SealedServer(PINNED);
  server.issue(withReporter(HOSTILE), { noCsp: true });
  const traffic = await openHost(page, server, `real/${PINNED}`);
  await page.waitForFunction(() =>
    window.__mailframe.posted.some(p => (p as { h?: unknown }).h === 4321),
  );
  // The reporter copy forges too (its swapped post runs once it measures), so the CSP case above refuses a real forgery.
  await page.waitForFunction(() =>
    window.__mailframe.posted.some(p => (p as { h?: unknown }).h === 4326),
  );
  const state = await hostState(page);
  // The harness sees a load from inside the out-of-process frame, so the zero counts elsewhere are not blind.
  expect(traffic.network).toContain(`${CANARY}/control.png`);
  expect(forgedHeights(state.posted).length).toBeGreaterThan(0);
  // The inline forgery runs before the reporter (which is last in the body), so it is the first report taken.
  expect(state.ready[0]!.height).toBe(4321);
  expect(state.pwned).toBeUndefined();
  expect(state.aplos).toBe(JSON.stringify({ secret: 'host-only' }));
  expect(state.href).toBe(`${ORIGIN}/#real/${PINNED}`);
});

/** Poll until the frame's height and the posts that reached the host stop changing; the settled height in px. */
async function stopsGrowing(page: Page): Promise<number> {
  let last = '';
  let height = 0;
  await expect
    .poll(
      async () => {
        const state = await hostState(page);
        const now = `${state.height}|${state.posted.length}`;
        const stable = now === last;
        last = now;
        height = Number.parseInt(state.height ?? '0', 10);
        return stable;
      },
      { timeout: 30_000, intervals: [750] },
    )
    .toBe(true);
  return height;
}

for (const [css, most] of [
  ['height:100vh', 12_000],
  ['height:150vh', 200_000],
] as const) {
  test(`a letter sized in viewport units (${css}) stops chasing the frame (fence or clamp)`, async ({
    page,
  }) => {
    // Without the fence the reporter and the host chase each other: 100vh grows by the rest of the letter at every
    // step forever, 150vh reaches the 200,000 px clamp (PROTOCOL.md "Runaway growth").
    const server = new SealedServer();
    const token = server.issue(sealedDocument(`<p>Top</p><div style="${css}">Tall</div>`));
    await openHost(page, server, `real/${token}`);
    expect(await settled(page)).toBe(true);
    expect(await stopsGrowing(page)).toBeLessThanOrEqual(most);
  });
}

/** One hostile body for the corpus pass: the engine's own corpus and the host's. */
interface Hostile {
  id: string;
  html: string;
  cids: readonly string[];
  findQuery?: string;
  /** Built to exhaust a renderer (DECISIONS, leak harness note (a)): run one at a time, may hit the deadline. */
  stress: boolean;
}

const STRESS_CLASSES: readonly string[] = ['resource-exhaustion', 'css-layout-abuse'];

const HOSTILE_BODIES: Hostile[] = [
  ...loadCorpus({ canaryOrigin: CANARY, includeGenerated: false }).flatMap(entry =>
    entry.html === undefined
      ? []
      : [
          {
            ...entry,
            id: `engine ${entry.id}`,
            html: entry.html,
            stress: entry.classes.some(c => STRESS_CLASSES.includes(c)),
          },
        ],
  ),
  ...CORPUS.map(item => ({
    id: `host ${item.id}`,
    html: item.html,
    cids: [],
    stress: item.costly === true,
  })),
];

/**
 * Load one hostile body into the real frame and check it reached nothing. A stress body may instead hit the deadline
 * (`allowDeadline`): then the failed state must show and the frame must be gone; the traffic checks still apply.
 */
async function checkHostile(page: Page, body: Hostile, allowDeadline: boolean): Promise<void> {
  const rendered = render({
    html: body.html,
    cids: [...body.cids],
    imagePolicy: 'block',
    findQuery: body.findQuery,
  });
  if (rendered.bodyKind !== 'html') return;
  const server = new SealedServer();
  const token = server.issue(withReporter(rendered.document));
  const traffic = await openHost(page, server, `real/${token}`);
  const reported = await settled(page, allowDeadline ? 60_000 : 15_000);
  await page.waitForTimeout(300);
  const state = await hostState(page);
  const own = new RegExp(`^${REAL_ORIGIN}/${token}/(?:(?:cid|img)/(?:0|[1-9][0-9]{0,5}))?$`);
  expect(traffic.outbound, body.id).toEqual([]);
  expect(traffic.network, body.id).toEqual([]);
  expect(traffic.popups, body.id).toEqual([]);
  expect(
    traffic.own.filter(url => !own.test(url)),
    body.id,
  ).toEqual([]);
  expect(onlyReporterPosts(state.posted, token), body.id).toBe(true);
  expect(state, body.id).toMatchObject({
    keys: [],
    hostKeys: [],
    opened: [],
    href: `${ORIGIN}/#real/${token}`,
    aplos: JSON.stringify({ secret: 'host-only' }),
  });
  expect(state.pwned, body.id).toBeUndefined();
  if (!reported && allowDeadline) {
    expect(state, body.id).toMatchObject({ ready: [], frames: 0 });
    return;
  }
  expect(reported, body.id).toBe(true);
  expect(state.ready, body.id).toHaveLength(1);
  expect(Number.isInteger(state.ready[0]!.height) && state.ready[0]!.height >= 1).toBe(true);
  expect(state.ready[0]!.bg, body.id).toMatch(/^#[0-9a-f]{6}$/);
  expect(state, body.id).toMatchObject({ sandbox: URL_SANDBOX, src: `${REAL_ORIGIN}/${token}/` });
  expect(page.frames().map(f => f.url())).toContain(`${REAL_ORIGIN}/${token}/`);
}

for (const body of HOSTILE_BODIES.filter(b => !b.stress)) {
  test(`${body.id}: the real frame reports, makes no outbound request and reaches nothing`, async ({
    page,
  }) => {
    await checkHostile(page, body, false);
  });
}

test('stress bodies, one at a time: nothing outbound or reached; the letter reports or fails at the deadline', async ({
  browser,
}) => {
  // The spec's frame shares the host page's renderer process, so a body built to exhaust a renderer can stall the
  // host too; one at a time, each in a fresh page, with room for the 10 s deadline. Opt-in: on a busy machine 090 (a
  // 200,000 px frame spinning a 100,000 px blur every millisecond) can starve every other worker.
  test.skip(process.env.APLOS_MAILFRAME_STRESS !== '1', 'set APLOS_MAILFRAME_STRESS=1 to run');
  const stress = HOSTILE_BODIES.filter(b => b.stress);
  test.setTimeout(stress.length * 75_000);
  for (const body of stress) {
    const page = await browser.newPage();
    await checkHostile(page, body, true);
    await page.close();
  }
});

test('keys pressed in the real frame reach nothing: the reporter relays none, R included', async ({
  page,
}) => {
  const server = new SealedServer();
  const token = server.issue(sealedDocument('<p>Focus me</p><p>Second line</p>'));
  await openHost(page, server, `real/${token}`);
  expect(await settled(page)).toBe(true);
  await page.locator('iframe').click({ position: { x: 30, y: 20 } });
  for (const key of [...FALLBACK_KEYS, 'r', 'Shift+R', 'e', 'Space', 'l', 'Enter']) {
    await page.keyboard.press(key);
  }
  // A hold of R past the shell's hold threshold (250 ms): no keydown or keyup may reach the window.
  await page.keyboard.down('r');
  await page.waitForTimeout(400);
  await page.keyboard.up('r');
  await page.waitForTimeout(200);
  const state = await hostState(page);
  expect(state).toMatchObject({ keys: [], hostKeys: [] });
  expect(onlyReporterPosts(state.posted, token)).toBe(true);
});

test('a real frame without the reporter times out to the failed state', async ({ page }) => {
  const server = new SealedServer();
  const silent = render({ html: '<p>No reporter here</p>', imagePolicy: 'block', cids: [] });
  if (silent.bodyKind !== 'html') throw new Error('not an html body');
  const token = server.issue(silent.document);
  await openHost(page, server, `real/${token}/1500`);
  await expect(page.getByText('Couldn’t load this email.')).toBeVisible();
  const state = await hostState(page);
  expect(state).toMatchObject({ ready: [], posted: [], frames: 0 });
  expect(server.served).toEqual([{ path: `${token}/`, status: 200 }]);
});

test('a slow document is refused after the deadline, and Try again on the same token is a 404', async ({
  page,
}) => {
  const server = new SealedServer();
  const token = server.issue(sealedDocument('<p>Late letter</p>'), { delayMs: 2_500 });
  await openHost(page, server, `real/${token}/1000`);
  const failed = page.getByText('Couldn’t load this email.');
  await expect(failed).toBeVisible();
  // Past the late answer: the frame was unmounted at the deadline, so nothing it might have sent is heard.
  await expect.poll(() => server.served.length, { timeout: 5_000 }).toBe(1);
  await page.waitForTimeout(500);
  expect(await hostState(page)).toMatchObject({ ready: [], posted: [], frames: 0 });
  await expect(failed).toBeVisible();
  // Single render: the engine never serves a token's document twice, so a retry needs a new `Mail/frame` token.
  server.options.set(token, {});
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => server.served.length).toBe(2);
  expect(server.served).toEqual([
    { path: `${token}/`, status: 200 },
    { path: `${token}/`, status: 404 },
  ]);
  await expect(failed).toBeVisible();
  expect(await hostState(page)).toMatchObject({ ready: [], posted: [] });
});
