// Lane card done criterion 4 in a real browser: every hostile corpus item rendered by MailFrameView in the real
// scriptless srcdoc iframe in headless Chromium makes ZERO outbound requests, runs no script, cannot reach
// `window.aplos` or `parent`, and never navigates. A second pass bypasses the sanitiser to show the sandbox and the
// inner CSP hold on their own. Also: the key relay delivers one listed key once (never R, E, Space or a letter), links
// open outside, never in the frame, and the sealed-frame host ignores every forged message and times out a silent frame.
//   npx playwright test -c apps/desktop/src/renderer/mailframe/browser/playwright.config.ts

import { expect, test, type Frame, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { CORPUS } from '../corpus';
import { frameCsp, SRCDOC_SANDBOX } from '../document';
import { FRAME_PAPER } from '../paper';
import { LIGHT_PAPER, parseBg } from '../protocol';
import { NOTICES } from '../sanitise';

const ORIGIN = 'http://mailframe.test';
/** The stand-in sealed frame: no reporter of its own; the spec posts from inside it with `frame.evaluate`. */
const SEALED_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><p>Sealed letter</p></body></html>`;
/** A dark paper a forgery would try to set (a token value: the spec holds no raw colours). */
const FORGED_BG = FRAME_PAPER.ink;
/** entry.tsx's sealed token. */
const SEALED_TOKEN = '5ea1ed005ea1ed005ea1ed005ea1ed00';
/** Another well-formed token, for forgeries. */
const WRONG_TOKEN = '0bad0bad0bad0bad0bad0bad0bad0bad';
const HOST_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="root" style="width:640px"></div><script src="/entry.js"></script></body></html>`;

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

/** Requests seen: `attempts` are every request event (Chromium also reports CSP-blocked loads); `network` are the
 * ones that reached the network layer (the route handler), i.e. would have left the machine. */
interface Traffic {
  attempts: string[];
  network: string[];
  /** Why each failed request failed (Chromium's error text). */
  failures: string[];
}

/** Serve the host page and bundle; abort and record everything else. */
async function openHost(page: Page, hash: string): Promise<Traffic> {
  const traffic: Traffic = { attempts: [], network: [], failures: [] };
  const isSealed = (url: string) => url.startsWith(`${ORIGIN}/sealed/`);
  const isHost = (url: string) =>
    url === `${ORIGIN}/` || url === `${ORIGIN}/entry.js` || isSealed(url);
  page.on(
    'request',
    request => void (isHost(request.url()) || traffic.attempts.push(request.url())),
  );
  page.on(
    'requestfailed',
    request => void traffic.failures.push(request.failure()?.errorText ?? '?'),
  );
  page.on('websocket', ws => void traffic.network.push(ws.url()));
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url === `${ORIGIN}/`) return route.fulfill({ contentType: 'text/html', body: HOST_PAGE });
    if (url === `${ORIGIN}/entry.js`)
      return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (isSealed(url)) return route.fulfill({ contentType: 'text/html', body: SEALED_PAGE });
    traffic.network.push(url);
    return route.abort();
  });
  await page.goto(`${ORIGIN}/#${hash}`);
  return traffic;
}

/** What the host can see of itself and of the (same-origin, scriptless) frame. */
function inspectFrame(page: Page) {
  return page.evaluate(() => {
    const frame = document.querySelector('iframe')!;
    const doc = frame.contentDocument!;
    const elements = [...doc.querySelectorAll('*')];
    return {
      sandbox: frame.getAttribute('sandbox'),
      frameUrl: doc.URL,
      hidden: frame.style.visibility === 'hidden',
      csp: doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
      dangerous: doc.querySelectorAll(
        'script,iframe,frame,object,embed,form,input,button,textarea,select,link,base,svg,math,meta[http-equiv="refresh" i]',
      ).length,
      handlers: elements.flatMap(el => el.getAttributeNames().filter(n => n.startsWith('on'))),
      remote: elements.flatMap(el =>
        ['src', 'background', 'srcset', 'poster']
          .map(n => el.getAttribute(n) ?? '')
          .filter(v => /^(https?:)?\/\//i.test(v.trim())),
      ),
      frameSeesAplos: 'aplos' in (frame.contentWindow as object),
      pwned: (window as { pwned?: unknown }).pwned,
      aplos: JSON.stringify((window as unknown as { aplos: unknown }).aplos),
    };
  });
}

for (const item of CORPUS) {
  for (const policy of ['block', 'load'] as const) {
    test(`${item.id} (${policy}): zero outbound requests, no script, no reach`, async ({
      page,
    }) => {
      const traffic = await openHost(page, `${item.id}/${policy}`);
      await page.waitForFunction(() => window.__mailframe.ready.length === 1);
      // Give late loads (images, fonts, refresh timers) a chance to show up.
      await page.waitForTimeout(400);
      const seen = await inspectFrame(page);
      if (policy === 'block') expect(traffic).toEqual({ attempts: [], network: [], failures: [] });
      else expect(traffic.attempts.filter(u => !u.startsWith('https://'))).toEqual([]);
      expect(seen.sandbox).toBe(SRCDOC_SANDBOX);
      expect(seen.csp).toBe(frameCsp(policy));
      expect(seen.frameUrl).toBe('about:srcdoc');
      expect(seen.hidden).toBe(false);
      expect(seen.dangerous).toBe(0);
      expect(seen.handlers).toEqual([]);
      if (policy === 'block') expect(seen.remote).toEqual([]);
      expect(seen.frameSeesAplos).toBe(false);
      expect(seen.pwned).toBeUndefined();
      expect(seen.aplos).toBe(JSON.stringify({ secret: 'host-only' }));
      const ready = await page.evaluate(() => window.__mailframe.ready[0]!);
      expect(Number.isInteger(ready.height) && ready.height >= 1).toBe(true);
      expect(ready.bg).toMatch(/^#[0-9a-f]{6}$/);
    });
  }
}

test('the sandbox and inner CSP hold without the sanitiser: no script runs, nothing navigates', async ({
  page,
}) => {
  const traffic = await openHost(page, 'none/block');
  const results = await page.evaluate(
    async ({ items, sandbox, csp }) => {
      const out: { id: string; pwned: unknown; leak: unknown; url: string }[] = [];
      for (const item of items) {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', sandbox);
        frame.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body>${item.html}</body></html>`;
        document.body.append(frame);
        await new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
        await new Promise(resolve => setTimeout(resolve, 150));
        out.push({
          id: item.id,
          pwned: (window as { pwned?: unknown }).pwned,
          leak: (window as unknown as { aplos: { leak?: unknown } }).aplos.leak,
          url: frame.contentDocument?.URL ?? 'cross-origin',
        });
        frame.remove();
      }
      return out;
    },
    {
      // Costly items (the span bomb) are fenced by the sanitiser's caps alone; unsanitised they only cost time.
      items: CORPUS.filter(item => !item.costly).map(({ id, html }) => ({ id, html })),
      sandbox: SRCDOC_SANDBOX,
      csp: frameCsp('block'),
    },
  );
  for (const r of results)
    expect(r, r.id).toEqual({ id: r.id, pwned: undefined, leak: undefined, url: 'about:srcdoc' });
  // Nothing reached the network: the inner meta CSP blocked every load the sanitiser would have removed. Chromium
  // still reports them as attempts (and research section 1 saw a real DNS lookup for dns-prefetch despite CSP), so
  // the sanitised path above must stay at zero attempts; this records how many the fences alone had to stop.
  expect(traffic.network).toEqual([]);
  test.info().annotations.push({
    type: 'unsanitised-attempts',
    description: `${traffic.attempts.length} attempts; failures: ${[...new Set(traffic.failures)].join(', ')}`,
  });
});

test('the key relay delivers one unmodified key once and leaves modified keys in the frame', async ({
  page,
}) => {
  await openHost(page, 'inline-script/block');
  await page.waitForFunction(() => window.__mailframe.ready.length === 1);
  await page.locator('iframe').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('j');
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Shift+K');
  const { keys, hostKeys } = await page.evaluate(() => window.__mailframe);
  expect(keys).toEqual([
    { key: 'j', shift: false, alt: false },
    { key: 'K', shift: true, alt: false },
  ]);
  expect(hostKeys).toEqual([]);
});

test('keys typed in the letter never reach app commands: R, E, Space and letters stay in the frame', async ({
  page,
}) => {
  await openHost(page, 'inline-script/block');
  await page.waitForFunction(() => window.__mailframe.ready.length === 1);
  await page.locator('iframe').click({ position: { x: 5, y: 5 } });
  for (const key of ['r', 'Shift+R', 'e', 'Space', 'a', 'z', 'l', 'Enter'])
    await page.keyboard.press(key);
  // A tap held past the shell's hold threshold (250 ms): no keydown or keyup may reach the window.
  await page.keyboard.down('r');
  await page.waitForTimeout(400);
  await page.keyboard.up('r');
  for (const key of ['k', 'ArrowDown', 'End', 'Escape']) await page.keyboard.press(key);
  const { keys, hostKeys } = await page.evaluate(() => window.__mailframe);
  expect(keys.map(k => k.key)).toEqual(['k', 'ArrowDown', 'End', 'Escape']);
  expect(hostKeys).toEqual([]);
});

/** The stand-in sealed frame (`#sealed/<timeoutMs>`), once it has loaded. */
async function sealedFrame(page: Page): Promise<Frame> {
  await page.waitForFunction(() => document.querySelector('iframe')?.src.includes('/sealed/'));
  let frame: Frame | undefined;
  await expect
    .poll(() => (frame = page.frames().find(f => f.url().includes('/sealed/'))) !== undefined)
    .toBe(true);
  await frame!.waitForLoadState('load');
  return frame!;
}

/** Wait until the host window has seen `count` more message events (so the host's listener has run for each). */
async function messagesSeen(page: Page, before: number, count: number) {
  await page.waitForFunction(n => window.__mailframe.messages >= n, before + count);
}

/** What the host shows of the sealed slot. */
function sealedState(page: Page) {
  return page.evaluate(() => {
    const frame = document.querySelector('iframe');
    const recorder = window.__mailframe;
    return {
      ready: recorder.ready,
      keys: recorder.keys,
      hostKeys: recorder.hostKeys,
      height: frame?.style.height,
      hidden: frame?.style.visibility === 'hidden',
      polluted: ({} as { polluted?: unknown }).polluted,
    };
  });
}

/** Every forgery, posted from the email, a child of the email, a sibling frame and the host realm. Returns the count. */
async function forge(page: Page, frame: Frame): Promise<number> {
  const arg = { t: SEALED_TOKEN, bg: FORGED_BG, wrong: WRONG_TOKEN };
  const fromEmail = await frame.evaluate(({ t, bg, wrong }) => {
    const w = innerWidth;
    const size = { token: t, h: 500, w, bg, ready: true, marks: 0 };
    const own = `"token":"${t}","h":500,"w":${w},"bg":"${bg}","ready":true`;
    const forged: unknown[] = [
      { ...size, token: wrong },
      { ...size, token: '' },
      { ...size, h: 1_000_001 },
      { ...size, h: Number.NaN },
      { ...size, h: Number.POSITIVE_INFINITY },
      { ...size, h: -5 },
      { ...size, h: '500' },
      { ...size, w: 0 },
      { ...size, w: 43_000 },
      { ...size, marks: -1 },
      { ...size, ready: 'true' },
      JSON.parse(`{${own},"marks":0,"__proto__":{"polluted":true}}`),
      JSON.parse(`{${own},"__proto__":{"marks":0}}`),
      { ...size, constructor: { prototype: { polluted: true } } },
      { ...size, t: 'size' },
      JSON.stringify(size),
      [size],
      { t: 'key', token: t, key: 'j' },
      { t: 'key', token: t, key: 'r' },
      { t: 'key', token: t, key: ' ' },
    ];
    for (const data of forged) parent.postMessage(data, '*');
    // A child frame of the email: right shape and token, wrong source.
    const child = document.createElement('iframe');
    const script = `top.postMessage(${JSON.stringify(size)},'*')`;
    child.srcdoc = `<script>${script}</script>`;
    document.body.append(child);
    return forged.length + 1;
  }, arg);
  const fromHost = await page.evaluate(({ t, bg }) => {
    const frame = document.querySelector('iframe')!;
    const w = frame.clientWidth;
    const size = { token: t, h: 500, w, bg, ready: true, marks: 0 };
    // A hostile sibling frame: right shape and token, wrong source (its origin is 'null' too).
    const sibling = document.createElement('iframe');
    sibling.setAttribute('sandbox', 'allow-scripts');
    sibling.srcdoc = `<script>parent.postMessage(${JSON.stringify(size)},'*')</script>`;
    document.body.append(sibling);
    // Synthetic events: the frame's own window as source and the right token, but the wrong origin or no source.
    const source = frame.contentWindow;
    const events = [
      new MessageEvent('message', { data: size, origin: location.origin, source }),
      new MessageEvent('message', { data: size, origin: 'https://evil.example', source }),
      new MessageEvent('message', { data: size, origin: 'null', source: null }),
      new MessageEvent('message', { data: size, origin: 'null', source: window }),
    ];
    for (const event of events) window.dispatchEvent(event);
    return events.length + 1;
  }, arg);
  return fromEmail + fromHost;
}

test('the sealed-frame host ignores every forged message: size, bg and keys stay unchanged', async ({
  page,
}) => {
  await openHost(page, 'sealed/60000');
  const frame = await sealedFrame(page);
  const at = async () => page.evaluate(() => window.__mailframe.messages);

  // Before the letter has reported: nothing is accepted, the frame stays hidden at 1 px.
  let before = await at();
  await messagesSeen(page, before, await forge(page, frame));
  expect(await sealedState(page)).toEqual({
    ready: [],
    keys: [],
    hostKeys: [],
    height: '1px',
    hidden: true,
    polluted: undefined,
  });

  // The genuine report from the frame swaps the letter in.
  const report = { token: SEALED_TOKEN, h: 321, bg: FRAME_PAPER.canvas, ready: true, marks: 0 };
  await frame.evaluate(r => parent.postMessage({ ...r, w: innerWidth }, '*'), report);
  await page.waitForFunction(() => window.__mailframe.ready.length === 1);
  const shown = { height: 321, bg: parseBg(report.bg), blocked: 2, trackers: 2 };
  expect(await sealedState(page)).toMatchObject({ ready: [shown], height: '321px', hidden: false });

  // After it: every forgery again, and nothing moves.
  before = await at();
  await messagesSeen(page, before, await forge(page, frame));
  expect(await sealedState(page)).toEqual({
    ready: [shown],
    keys: [],
    hostKeys: [],
    height: '321px',
    hidden: false,
    polluted: undefined,
  });

  // Control: a genuine report from the frame itself still resizes (so the forgeries above were heard and refused).
  await frame.evaluate(r => parent.postMessage({ ...r, h: 654, w: innerWidth }, '*'), report);
  await page.waitForFunction(() => document.querySelector('iframe')?.style.height === '654px');
  expect(await sealedState(page)).toMatchObject({ ready: [shown], keys: [], hostKeys: [] });
});

test('a sealed frame that never reports times out to the failed state; Try again starts a fresh wait', async ({
  page,
}) => {
  await openHost(page, 'sealed/1500');
  await sealedFrame(page);
  const failed = page.getByText('Couldn’t load this email.');
  await expect(failed).toBeVisible();
  // The silent frame is gone, so nothing it sends later can be heard; nothing was reported.
  expect(await page.locator('iframe').count()).toBe(0);
  expect(await page.evaluate(() => window.__mailframe.ready)).toEqual([]);

  await page.getByRole('button', { name: 'Try again' }).click();
  expect(await page.evaluate(() => window.__mailframe.reloads)).toBe(1);
  await expect(failed).toBeHidden();
  const frame = await sealedFrame(page);
  await frame.evaluate(
    ({ t, bg }) =>
      parent.postMessage({ token: t, h: 222, w: innerWidth, bg, ready: true, marks: 0 }, '*'),
    { t: SEALED_TOKEN, bg: FRAME_PAPER.canvas },
  );
  await page.waitForFunction(() => window.__mailframe.ready.length === 1);
  expect(await page.evaluate(() => window.__mailframe.ready[0]!.height)).toBe(222);
  // Past the deadline again: the report settled it, so the letter stays.
  await page.waitForTimeout(2_000);
  await expect(failed).toBeHidden();
  expect(await page.locator('iframe').count()).toBe(1);
});

// mail-key wiring (PROTOCOL.md): main's relayed keys reach the sealed slot through `window.aplos.subscribe` (faked by
// the `#mailkey` page) and go to `onKey` only under the three guards.

/** The `#mailkey` page with its sealed letter shown (the frame's own report swapped it in). */
async function mailKeyPage(page: Page): Promise<void> {
  await openHost(page, 'mailkey');
  const frame = await sealedFrame(page);
  await frame.evaluate(
    ({ t, bg }) =>
      parent.postMessage({ token: t, h: 240, w: innerWidth, bg, ready: true, marks: 0 }, '*'),
    { t: SEALED_TOKEN, bg: FRAME_PAPER.canvas },
  );
  await page.waitForFunction(() => window.__mailframe.ready.length === 1);
}

/** Clicks into the shown letter, so the sealed iframe is the host's active element. */
async function focusLetter(page: Page): Promise<void> {
  await page
    .locator('iframe')
    .first()
    .click({ position: { x: 5, y: 5 } });
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
}

/** Moves focus to a host button outside the letter. */
async function focusOutside(page: Page): Promise<void> {
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.textContent = 'Outside';
    document.body.append(button);
    button.focus();
  });
}

/** Delivers each payload as preload would; the keys `onKey` heard for them. */
function deliver(page: Page, ...payloads: unknown[]): Promise<{ key: string; shift: boolean }[]> {
  return page.evaluate(list => {
    const before = window.__mailframe.keys.length;
    for (const payload of list) window.__mailkey.deliver(payload);
    return window.__mailframe.keys.slice(before);
  }, payloads);
}

const KEY_J = { key: 'j', shift: false, alt: false };
const KEY_K = { key: 'k', shift: false, alt: false };
const KEY_ESC = { key: 'Escape', shift: false, alt: false };

test('mail-key: a relayed key reaches onKey once, only while the sealed letter has focus', async ({
  page,
}) => {
  await mailKeyPage(page);
  await focusLetter(page);
  expect(await deliver(page, { key: 'j' })).toEqual([KEY_J]);
  await focusOutside(page);
  expect(await deliver(page, { key: 'j' }, { key: 'Escape' })).toEqual([]);
  await focusLetter(page);
  // Arrows and the paging keys scroll the letter natively and are not routed (the reader allowlist).
  const scrolling = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'];
  expect(await deliver(page, ...scrolling.map(key => ({ key })))).toEqual([]);
  // Nothing was dispatched on the host page: onKey is the only way out.
  expect(await page.evaluate(() => window.__mailframe.hostKeys)).toEqual([]);
});

test('mail-key: Caps Lock J, Shift+J and j are one key; unlisted keys and other events are dropped', async ({
  page,
}) => {
  await mailKeyPage(page);
  await focusLetter(page);
  expect(
    await deliver(page, { key: 'J' }, { key: 'J', shift: false }, { key: 'J', shift: true }),
  ).toEqual([KEY_J, KEY_J, KEY_J]);
  expect(await deliver(page, { key: 'K', shift: false }, { key: 'k' })).toEqual([KEY_K, KEY_K]);
  expect(
    await deliver(
      page,
      { key: 'r' },
      { key: 'E' },
      { key: ' ' },
      { key: 'Enter' },
      { key: 'Tab' },
      'j',
      null,
    ),
  ).toEqual([]);
  await page.evaluate(() => window.__mailkey.deliver({ key: 'j' }, 'command'));
  expect(await page.evaluate(() => window.__mailframe.keys.length)).toBe(5);
});

test('mail-key: Esc is routed with only the reader, dropped while a composer or a dialog is above it', async ({
  page,
}) => {
  await mailKeyPage(page);
  await focusLetter(page);
  await page.evaluate(() => window.__mailkey.layer(['reader']));
  expect(await deliver(page, { key: 'Escape' })).toEqual([KEY_ESC]);
  await page.evaluate(() => window.__mailkey.layer(['compose']));
  expect(await deliver(page, { key: 'Escape' }, { key: 'j' })).toEqual([]);
  await page.evaluate(() => window.__mailkey.clearLayers());
  await page.evaluate(() => window.__mailkey.layer(['reader', 'dialog']));
  expect(await deliver(page, { key: 'Escape' })).toEqual([]);
  await page.evaluate(() => window.__mailkey.clearLayers());
  await page.evaluate(() => window.__mailkey.dialog(true));
  expect(await deliver(page, { key: 'Escape' }, { key: 'k' })).toEqual([]);
  await page.evaluate(() => window.__mailkey.dialog(false));
  expect(await deliver(page, { key: 'Escape' })).toEqual([KEY_ESC]);
});

test('mail-key: a pending or off-paper letter never takes a key; the shown one takes it once', async ({
  page,
}) => {
  await mailKeyPage(page);
  await page.evaluate(() => window.__mailkey.pend());
  await expect(page.locator('iframe')).toHaveCount(2);
  await focusLetter(page);
  expect(await deliver(page, { key: 'j' })).toEqual([KEY_J]);
  // The pending (hidden) frame cannot hold focus, and does not take the key whatever has it.
  await focusOutside(page);
  await page.evaluate(() => document.querySelectorAll('iframe')[1]!.focus());
  expect(await deliver(page, { key: 'j' })).toEqual([]);
  // The off-paper letter is inert.
  await focusLetter(page);
  await page.evaluate(() => window.__mailkey.inert(true));
  expect(await deliver(page, { key: 'j' })).toEqual([]);
  await page.evaluate(() => window.__mailkey.inert(false));
  await focusLetter(page);
  expect(await deliver(page, { key: 'k' })).toEqual([KEY_K]);
});

test('mail-key: the sealed slot adds no key listener and unsubscribes on unmount (50 remounts)', async ({
  page,
}) => {
  await mailKeyPage(page);
  const state = () =>
    page.evaluate(() => ({
      listeners: window.__mailkey.listeners(),
      keyListeners: window.__mailkey.keyListeners,
    }));
  expect(await state()).toEqual({ listeners: 1, keyListeners: [] });
  await page.evaluate(() => window.__mailkey.pend());
  expect(await state()).toEqual({ listeners: 2, keyListeners: [] });
  await page.evaluate(() => window.__mailkey.remount(50));
  expect(await state()).toEqual({ listeners: 1, keyListeners: [] });
  await page.evaluate(() => window.__mailkey.unmount());
  expect(await state()).toEqual({ listeners: 0, keyListeners: [] });
});

test('mail-key: a srcdoc slot never subscribes; only the sealed slot does (exactly one call)', async ({
  page,
}) => {
  await mailKeyPage(page);
  const state = () =>
    page.evaluate(() => ({
      subscribes: window.__mailkey.subscribes(),
      listeners: window.__mailkey.listeners(),
    }));
  expect(await state()).toEqual({ subscribes: 1, listeners: 1 });
  // The srcdoc letter loads, reports and replaces the sealed one: the sealed subscription ends, nothing replaces it.
  await page.evaluate(() => window.__mailkey.srcdoc());
  await page.waitForFunction(() => window.__mailframe.ready.length === 2);
  await expect(page.locator('iframe')).toHaveCount(1);
  expect(await state()).toEqual({ subscribes: 1, listeners: 0 });
});

test('links open outside the app and never navigate the frame', async ({ page }) => {
  await openHost(page, 'javascript-links/block');
  await page.waitForFunction(() => window.__mailframe.ready.length === 1);
  const click = async (text: string) => {
    const box = await page.evaluate(label => {
      const frame = document.querySelector('iframe')!;
      const link = [...frame.contentDocument!.querySelectorAll('a')].find(
        a => a.textContent === label,
      )!;
      const f = frame.getBoundingClientRect();
      const r = link.getBoundingClientRect();
      return { x: f.left + r.left + r.width / 2, y: f.top + r.top + r.height / 2 };
    }, text);
    await page.mouse.click(box.x, box.y);
  };
  await click('js');
  await click('Safe link');
  await page.waitForTimeout(200);
  const seen = await inspectFrame(page);
  expect(await page.evaluate(() => window.__mailframe.opened)).toEqual([
    'https://safe.example/path?q=1',
  ]);
  expect(seen.frameUrl).toBe('about:srcdoc');
  expect(seen.pwned).toBeUndefined();
});

test('onReady reports the trackers removed', async ({ page }) => {
  await openHost(page, 'url-trackers/block');
  await page.waitForFunction(() => window.__mailframe.ready.length === 1);
  const ready = await page.evaluate(() => window.__mailframe.ready[0]!);
  expect(ready.blocked).toBeGreaterThanOrEqual(10);
  expect(ready.bg).toBe(LIGHT_PAPER);
});

test('email CSS cannot change the measured height of the letter', async ({ page }) => {
  await openHost(page, 'css-override/block');
  await page.waitForFunction(() => window.__mailframe.ready.length === 1);
  const ready = await page.evaluate(() => window.__mailframe.ready[0]!);
  // The body holds one 600 px block; :root, html, body and inline !important rules try to make it 2-7 px.
  expect(ready.height).toBeGreaterThanOrEqual(600);
  expect(ready.height).toBeLessThan(700);
  const shown = await page.evaluate(() => {
    const frame = document.querySelector('iframe')!;
    const root = frame.contentDocument!.documentElement;
    return {
      frame: frame.getBoundingClientRect().height,
      root: root.getBoundingClientRect().height,
    };
  });
  expect(shown.frame).toBe(ready.height);
  expect(Math.ceil(shown.root)).toBe(ready.height);
});

test("email CSS cannot hide the host's notice", async ({ page }) => {
  await openHost(page, 'long-css/block');
  await page.waitForFunction(() => window.__mailframe.ready.length === 1, undefined, {
    timeout: 20_000,
  });
  const notice = await page.evaluate(sentence => {
    const found = [...document.querySelectorAll('p')].find(p => p.textContent === sentence);
    const frameText = document.querySelector('iframe')!.contentDocument!.body.textContent ?? '';
    return {
      height: found?.getBoundingClientRect().height ?? 0,
      display: found ? getComputedStyle(found).display : 'missing',
      inFrame: frameText.includes(sentence),
    };
  }, NOTICES.truncated);
  expect(notice.display).not.toBe('none');
  expect(notice.height).toBeGreaterThan(0);
  expect(notice.inFrame).toBe(false);
});

test('a srcdoc letter sized in viewport units stops growing (the growth fence)', async ({
  page,
}) => {
  await openHost(page, 'viewport-units/block');
  await page.waitForFunction(() => window.__mailframe.ready.length === 1);
  // Without the fence the letter grows by its first paragraph at every step, forever.
  let last = '';
  await expect
    .poll(
      async () => {
        const now = await page.evaluate(() => document.querySelector('iframe')!.style.height);
        const stable = now === last;
        last = now;
        return stable;
      },
      { timeout: 30_000, intervals: [750] },
    )
    .toBe(true);
  expect(Number.parseInt(last, 10)).toBeLessThan(12_000);
});
