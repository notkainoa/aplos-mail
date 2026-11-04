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
const SEALED_TOKEN = 'Sealed_Tok3n_0123456789';
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
  const arg = { t: SEALED_TOKEN, bg: FORGED_BG };
  const fromEmail = await frame.evaluate(({ t, bg }) => {
    const w = innerWidth;
    const size = { t: 'size', token: t, h: 500, w, bg };
    const own = `"t":"size","token":"${t}","h":500,"w":${w},"bg":"${bg}"`;
    const forged: unknown[] = [
      { ...size, token: 'Wrong_Tok3n_0123456789' },
      { ...size, token: '' },
      { ...size, h: 200_001 },
      { ...size, h: Number.NaN },
      { ...size, h: Number.POSITIVE_INFINITY },
      { ...size, h: -5 },
      { ...size, h: '500' },
      { ...size, w: 0 },
      { ...size, w: 43_000 },
      JSON.parse(`{${own},"__proto__":{"polluted":true}}`),
      { ...size, constructor: { prototype: { polluted: true } } },
      JSON.stringify(size),
      [size],
      { t: 'key', token: t, key: 'r' },
      { t: 'key', token: t, key: 'e' },
      { t: 'key', token: t, key: ' ' },
      { t: 'key', token: 'Wrong_Tok3n_0123456789', key: 'j' },
      JSON.parse(`{"t":"key","token":"${t}","key":"j","__proto__":{"key":"r"}}`),
      { t: 'key', token: t, key: 'j', constructor: {} },
    ];
    for (const data of forged) parent.postMessage(data, '*');
    // A child frame of the email: right shape and token, wrong source.
    const child = document.createElement('iframe');
    const script = `top.postMessage(${JSON.stringify(size)},'*');top.postMessage(${JSON.stringify({ t: 'key', token: t, key: 'j' })},'*')`;
    child.srcdoc = `<script>${script}</script>`;
    document.body.append(child);
    return forged.length + 2;
  }, arg);
  const fromHost = await page.evaluate(({ t, bg }) => {
    const frame = document.querySelector('iframe')!;
    const w = frame.clientWidth;
    const size = { t: 'size', token: t, h: 500, w, bg };
    // A hostile sibling frame: right shape and token, wrong source (its origin is 'null' too).
    const sibling = document.createElement('iframe');
    sibling.setAttribute('sandbox', 'allow-scripts');
    sibling.srcdoc = `<script>parent.postMessage(${JSON.stringify(size)},'*');parent.postMessage(${JSON.stringify({ t: 'key', token: t, key: 'j' })},'*')</script>`;
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
    return events.length + 2;
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
  const report = { t: 'size', token: SEALED_TOKEN, h: 321, bg: FRAME_PAPER.canvas };
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

  // Control: the frame's own listed key is relayed once, as a key and not as a window keydown.
  await frame.evaluate(
    t => parent.postMessage({ t: 'key', token: t, key: 'j' }, '*'),
    SEALED_TOKEN,
  );
  await page.waitForFunction(() => window.__mailframe.keys.length === 1);
  expect(await sealedState(page)).toMatchObject({
    keys: [{ key: 'j', shift: false, alt: false }],
    hostKeys: [],
  });
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
    ({ t, bg }) => parent.postMessage({ t: 'size', token: t, h: 222, w: innerWidth, bg }, '*'),
    { t: SEALED_TOKEN, bg: FRAME_PAPER.canvas },
  );
  await page.waitForFunction(() => window.__mailframe.ready.length === 1);
  expect(await page.evaluate(() => window.__mailframe.ready[0]!.height)).toBe(222);
  // Past the deadline again: the report settled it, so the letter stays.
  await page.waitForTimeout(2_000);
  await expect(failed).toBeHidden();
  expect(await page.locator('iframe').count()).toBe(1);
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
