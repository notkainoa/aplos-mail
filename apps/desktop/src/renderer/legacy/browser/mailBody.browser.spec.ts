// Improve plan 001: the legacy reader (what release builds still ship) keeps remote content off while "Load images" is
// off. DOMPurify keeps SVG `image`, `feImage` and `use` with an https `href`, which the img gate never looked at, so the
// body is sanitized first with SVG and MathML forbidden, and the gate and `hasRemoteImages` read the sanitized result.
// Every case mounts the prepared body in headless Chromium and records each request that is not the host page.
//   npx playwright test -c apps/desktop/src/renderer/legacy/browser/playwright.config.ts

import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'http://legacy.test';
const TRACKER = 'tracker.example';
const HOST_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/entry.js"></script></body></html>`;
const PIXEL = `data:image/gif;base64,R0lGODlhAQABAAAAACw=`;

let bundle = '';

test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./entry.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    // `bridge.ts` reads Vite's `import.meta.env`; the bundle has none, and nothing here calls the bridge.
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    logLevel: 'silent',
  });
  bundle = result.outputFiles[0]!.text;
});

interface Prepared {
  readonly body: string;
  readonly hasRemoteImages: boolean;
}

/** Opens the host page; returns every request that is not the page or its bundle (all are aborted). */
async function openHost(page: Page): Promise<string[]> {
  const seen: string[] = [];
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url === `${ORIGIN}/`) return route.fulfill({ contentType: 'text/html', body: HOST_PAGE });
    if (url === `${ORIGIN}/entry.js`)
      return route.fulfill({ contentType: 'text/javascript', body: bundle });
    seen.push(url);
    return route.abort();
  });
  await page.goto(`${ORIGIN}/`);
  return seen;
}

/** Prepares `html` as the reader does, mounts the body, and waits for any late loads. */
async function mount(
  page: Page,
  html: string,
  remote: boolean,
  attachments: unknown[] = [],
): Promise<Prepared> {
  const prepared = await page.evaluate(
    ({ source, load, parts }) => {
      const message = { html: source, text: '', quoted: '', attachments: parts };
      const run = (
        window as unknown as {
          prepareMessageBody: (
            m: unknown,
            o: unknown,
          ) => { body: string; hasRemoteImages: boolean };
        }
      ).prepareMessageBody;
      const result = run(message, { remote: load, spam: false, inline: {} });
      return result;
    },
    { source: html, load: remote, parts: attachments },
  );
  if (!remote) await page.evaluate(body => (document.body.innerHTML = body), prepared.body);
  await page.waitForTimeout(200);
  return prepared;
}

const toTracker = (urls: readonly string[]) => urls.filter(url => url.includes(TRACKER));

test.describe('legacy reader: images off means no request', () => {
  test('SVG image with href', async ({ page }) => {
    const seen = await openHost(page);
    const prepared = await mount(
      page,
      `<p>Hi</p><svg><image href="https://${TRACKER}/p.gif"/></svg>`,
      false,
    );
    expect(prepared.body).not.toMatch(/<svg|tracker\.example/);
    expect(toTracker(seen)).toEqual([]);
  });

  test('SVG xlink:href and feImage', async ({ page }) => {
    const seen = await openHost(page);
    const prepared = await mount(
      page,
      `<svg xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="https://${TRACKER}/x.gif"/><filter id="f"><feImage href="https://${TRACKER}/f.gif"/></filter><use href="https://${TRACKER}/u.svg#a"/></svg>`,
      false,
    );
    expect(prepared.body).not.toMatch(/<svg|tracker\.example/);
    expect(toTracker(seen)).toEqual([]);
  });

  test('MathML', async ({ page }) => {
    const seen = await openHost(page);
    const prepared = await mount(
      page,
      `<math><mi href="https://${TRACKER}/m">x</mi></math><p>after</p>`,
      false,
    );
    expect(prepared.body).not.toMatch(/<math|tracker\.example/);
    expect(prepared.body).toContain('after');
    expect(toTracker(seen)).toEqual([]);
  });

  test('a plain remote img is hidden, and counted', async ({ page }) => {
    const seen = await openHost(page);
    const prepared = await mount(page, `<img src="https://${TRACKER}/i.gif">`, false);
    expect(prepared.hasRemoteImages).toBe(true);
    expect(prepared.body).not.toContain(TRACKER);
    expect(toTracker(seen)).toEqual([]);
  });

  test('with images on the remote source is kept (not mounted here)', async ({ page }) => {
    await openHost(page);
    const prepared = await mount(page, `<img src="https://${TRACKER}/i.gif">`, true);
    expect(prepared.hasRemoteImages).toBe(true);
    expect(prepared.body).toContain(`https://${TRACKER}/i.gif`);
  });

  test('text only: nothing remote, the text survives', async ({ page }) => {
    await openHost(page);
    const prepared = await mount(page, `<p>Hello</p>`, false);
    expect(prepared.hasRemoteImages).toBe(false);
    expect(prepared.body).toContain('Hello');
  });

  test('an inline cid image still becomes inline data after the sanitize', async ({ page }) => {
    const seen = await openHost(page);
    const prepared = await mount(page, `<img src="cid:logo@x">`, false, [
      {
        id: 'a1',
        contentId: 'logo@x',
        type: 'image/gif',
        data: PIXEL.split(',')[1],
        name: 'logo.gif',
      },
    ]);
    expect(prepared.body).toContain('data:image/gif;base64,');
    expect(prepared.hasRemoteImages).toBe(false);
    expect(seen).toEqual([]);
  });

  // Remote-looking sources the first gate missed: still hidden, and now counted, so "Load images" shows.
  for (const [name, source] of [
    ['protocol-relative', `//${TRACKER}/i.gif`],
    ['a leading space', ` https://${TRACKER}/i.gif`],
    ['upper-case scheme', `HTTPS://${TRACKER}/i.gif`],
    ['a relative path', `/${TRACKER}/i.gif`],
  ] as const) {
    test(`an img with ${name} src is hidden and counted`, async ({ page }) => {
      const seen = await openHost(page);
      const prepared = await mount(page, `<img src="${source}">`, false);
      expect(prepared.hasRemoteImages).toBe(true);
      expect(prepared.body).not.toContain(TRACKER);
      expect(toTracker(seen)).toEqual([]);
    });
  }

  // Other ways to make a mail client fetch: each makes no request, with the markup gone from the prepared body.
  for (const [name, html] of [
    ['style url()', `<p style="background:url(https://${TRACKER}/s.gif)">x</p>`],
    ['a style block', `<style>p{background:url(https://${TRACKER}/b.gif)}</style><p>x</p>`],
    [
      'srcset',
      `<img srcset="https://${TRACKER}/a.gif 1x, https://${TRACKER}/b.gif 2x" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">`,
    ],
    ['background=', `<table background="https://${TRACKER}/t.gif"><tr><td>x</td></tr></table>`],
    ['a base element', `<base href="https://${TRACKER}/"><img src="logo.gif">`],
    ['link preload', `<link rel="preload" as="image" href="https://${TRACKER}/l.gif"><p>x</p>`],
  ] as const) {
    test(`${name} makes no request while images are off`, async ({ page }) => {
      const seen = await openHost(page);
      const prepared = await mount(page, html, false);
      expect(prepared.body).not.toContain(TRACKER);
      expect(toTracker(seen)).toEqual([]);
    });
  }
});
