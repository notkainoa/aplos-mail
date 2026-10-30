// Lane card done criterion 4 in a real browser: every hostile corpus item rendered by MailFrameView in the real
// scriptless srcdoc iframe in headless Chromium makes ZERO outbound requests, runs no script, cannot reach
// `window.aplos` or `parent`, and never navigates. A second pass bypasses the sanitiser to show the sandbox and the
// inner CSP hold on their own. Also: the key relay delivers one key once, and links open outside, never in the frame.
//   npx playwright test -c apps/desktop/src/renderer/mailframe/browser/playwright.config.ts

import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { CORPUS } from '../corpus';
import { frameCsp, SRCDOC_SANDBOX } from '../document';
import { LIGHT_PAPER } from '../protocol';

const ORIGIN = 'http://mailframe.test';
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
  const isHost = (url: string) => url === `${ORIGIN}/` || url === `${ORIGIN}/entry.js`;
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
      items: CORPUS.map(({ id, html }) => ({ id, html })),
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
