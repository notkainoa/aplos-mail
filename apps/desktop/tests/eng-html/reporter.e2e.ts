import { expect, test } from '@playwright/test';
import { loadCorpus } from '../../../../packages/mail-html/corpus/index';
import { withReporter } from '../../../../packages/mail-html/src/frame/reporter';
import { render } from '../../../../packages/mail-html/src/index';
import { launchBed, FOLLOW_CAP, type Bed, type Opened } from './support/reporter-bed';

// THE FRAME REPORTER IN REAL CHROMIUM (ui-core REQUEST, html-5 slice 2). The real reporter, the real sanitizer and
// the engine's real headers, in a sandboxed iframe in a hidden Electron, with a host page that follows the reported
// height the way the reader does. How to run, from the repo root (headless, no network, about 30 s):
//
//   npx playwright test -c apps/desktop/tests/eng-html/support/playwright.config.ts reporter.e2e.ts
//
// Each check has a control that shows the bed can see the defect: the previous reporter (below, verbatim), or a
// raw document. A control that stops failing would make its check meaningless.

/** The reporter before this change, verbatim: scrollHeight, body-only background, names read off `document`. */
const LEGACY_REPORTER = String.raw`/* global window */
(function (w) {
  'use strict';
  const d = w.document;
  const M = w.Math;
  let live = false;
  let token = '';
  function size(value, max) {
    return typeof value === 'number' && w.isFinite(value)
      ? M.round(M.min(M.max(value, 0), max))
      : 0;
  }
  function background() {
    const body = d.body;
    const colour = body ? w.getComputedStyle(body).backgroundColor : '';
    return typeof colour === 'string' ? colour.slice(0, 64) : '';
  }
  function report() {
    if (!live) return;
    try {
      const width = w.innerWidth;
      if (!(typeof width === 'number' && width > 0)) return;
      const root = d.documentElement;
      const body = d.body;
      const height = M.max(root ? root.scrollHeight : 0, body ? body.scrollHeight : 0);
      const message = {
        token: token,
        h: size(height, 1000000),
        w: size(width, 100000),
        bg: background(),
        ready: d.readyState === 'complete',
        marks: size(d.querySelectorAll('mark.aplos-find').length, 100000),
      };
      w.parent.postMessage(message, '*');
    } catch {
      return;
    }
  }
  try {
    token = ('' + w.location.pathname).split('/')[1];
    if (!/^[0-9a-f]{32}$/.test(token)) return;
    d.addEventListener('DOMContentLoaded', report);
    d.addEventListener('toggle', report, true);
    w.addEventListener('load', report);
    w.addEventListener('resize', report);
    if (typeof w.ResizeObserver === 'function') {
      new w.ResizeObserver(report).observe(d.documentElement);
    }
    if (d.fonts && d.fonts.ready && typeof d.fonts.ready.then === 'function') {
      d.fonts.ready.then(report, report);
    }
    live = true;
    report();
  } catch {
    return;
  }
})(window);
`;

const corpus = loadCorpus({ canaryOrigin: 'http://127.0.0.1:9' });
const entry = (id: string) => {
  const found = corpus.find(candidate => candidate.id.startsWith(id));
  if (!found) throw new Error(`no corpus entry ${id}`);
  return found;
};

/** The sanitizer's document for a mail body, with the real reporter last in its body. */
function frameDocument(html: string): string {
  const result = render({ html, cids: [], imagePolicy: 'block' });
  if (result.bodyKind !== 'html') throw new Error('not html');
  return withReporter(result.document);
}

/**
 * The same document with the previous reporter in place of the real one. It is not the hashed script, so it is served
 * without the engine's policy (which would refuse it).
 */
function withLegacyReporter(html: string): { document: string; headers: 'none' } {
  const result = render({ html, cids: [], imagePolicy: 'block' });
  if (result.bodyKind !== 'html') throw new Error('not html');
  const script = `<script>${LEGACY_REPORTER}</script></body>`;
  return { document: result.document.replace('</body>', () => script), headers: 'none' };
}

/** A raw document (no sanitizer) with the reporter of the caller's choosing last in its body. */
function rawDocument(body: string, reporter: 'real' | 'legacy'): string {
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body>${body}</body></html>`;
  return reporter === 'real'
    ? withReporter(page)
    : page.replace('</body>', () => `<script>${LEGACY_REPORTER}</script></body>`);
}

/** The reading style's body padding: 16 px above and below. */
const PAD = 32;

let bed: Bed;
test.beforeAll(async () => {
  bed = await launchBed();
});
test.afterAll(async () => {
  await bed?.dispose();
});

async function last(opened: Opened) {
  const reports = await opened.settled();
  expect(reports.length, 'the reporter reported').toBeGreaterThan(0);
  return reports[reports.length - 1];
}

test.describe('height is the content, never the frame', () => {
  const tall = '<div style="height:200px">two hundred</div>';

  test('a frame much taller than the letter reports the letter', async () => {
    const opened = await bed.open({ document: frameDocument(tall), height: 3000, follow: false });
    expect((await last(opened)).h).toBe(200 + PAD);
    await opened.page.close();
  });

  test('control: the previous reporter reports the frame', async () => {
    const opened = await bed.open({ ...withLegacyReporter(tall), height: 3000, follow: false });
    expect((await last(opened)).h).toBe(3000);
    await opened.page.close();
  });

  test('a letter that shrinks (a quote folding up) shrinks its frame', async () => {
    const html =
      '<p>before</p><details open><summary>quote</summary><div style="height:1000px">q</div></details>';
    const opened = await bed.open({ document: frameDocument(html), height: 100 });
    const grown = await last(opened);
    expect(grown.h).toBeGreaterThan(1000);
    expect(await opened.frameHeight()).toBe(grown.h);
    await opened.frame.evaluate("document.querySelector('details').open = false");
    await expect.poll(async () => (await opened.reports()).at(-1)?.h).toBeLessThan(200);
    expect(await opened.frameHeight()).toBe((await opened.reports()).at(-1)?.h);
    await opened.page.close();
  });

  test('control: with the previous reporter the frame stays as tall as it was', async () => {
    const html =
      '<p>before</p><details open><summary>quote</summary><div style="height:1000px">q</div></details>';
    const opened = await bed.open({ ...withLegacyReporter(html), height: 100 });
    const grown = await last(opened);
    await opened.frame.evaluate("document.querySelector('details').open = false");
    await opened.page.waitForTimeout(1_000);
    expect((await opened.reports()).at(-1)?.h).toBe(grown.h);
    await opened.page.close();
  });

  test('html and body heights set by the mail cannot pin the frame', async () => {
    const html = '<style>html,body{height:100%;min-height:100vh}</style><p>short</p>';
    const opened = await bed.open({ document: frameDocument(html), height: 2000, follow: false });
    expect((await last(opened)).h).toBeLessThan(120);
    await opened.page.close();
  });

  test('content that spills past the root box still counts', async () => {
    const html =
      '<div style="position:relative"><div style="position:absolute;top:500px">low</div></div>';
    const opened = await bed.open({ document: frameDocument(html), height: 100, follow: false });
    expect((await last(opened)).h).toBeGreaterThan(500);
    await opened.page.close();
  });
});

test.describe('paper colour', () => {
  test('falls back to the html element when the body has none', async () => {
    const opened = await bed.open({ document: frameDocument(entry('139').html ?? '') });
    expect((await last(opened)).bg).toBe('rgb(232, 239, 228)');
    await opened.page.close();
  });

  test('control: the previous reporter saw only the body', async () => {
    const opened = await bed.open({ ...withLegacyReporter(entry('139').html ?? '') });
    expect((await last(opened)).bg).toBe('rgba(0, 0, 0, 0)');
    await opened.page.close();
  });

  test('prefers the body, and reports clear when neither is coloured', async () => {
    const both = '<style>html{background:#e8efe4}</style><body bgcolor="#112233"><p>x</p></body>';
    const opened = await bed.open({ document: frameDocument(both) });
    expect((await last(opened)).bg).toBe('rgb(17, 34, 51)');
    await opened.page.close();
    const none = await bed.open({ document: frameDocument('<p>x</p>') });
    expect((await last(none)).bg).toBe('rgba(0, 0, 0, 0)');
    await none.page.close();
  });

  test('an opaque body colour that ends in a 0 channel is a colour, not see-through', async () => {
    const yellow = '<style>html{background:#e8efe4}</style><body bgcolor="#ffff00"><p>x</p></body>';
    const opened = await bed.open({ document: frameDocument(yellow) });
    expect((await last(opened)).bg).toBe('rgb(255, 255, 0)');
    await opened.page.close();
  });

  test('a body colour with alpha 0 in the slash form falls back to the html element', async () => {
    const html =
      '<style>html{background:#e8efe4}body{background:oklch(0.5 0.2 30 / 0)}</style><p>x</p>';
    const opened = await bed.open({ document: frameDocument(html) });
    expect((await last(opened)).bg).toBe('rgb(232, 239, 228)');
    await opened.page.close();
  });
});

test.describe('DOM clobbering', () => {
  /** Names and ids a script reading `document.body` and its neighbours by name would be hijacked by. */
  const clobbers = `<div style="display:none">${[
    'body',
    'documentElement',
    'addEventListener',
    'querySelectorAll',
    'readyState',
    'fonts',
    'getElementById',
    'children',
    'scrollHeight',
    'getBoundingClientRect',
  ]
    .map(
      name =>
        `<img name="${name}" id="${name}"><form name="${name}" id="${name}"><input name="${name}"></form>` +
        `<embed name="${name}" src="x"><object name="${name}"></object><iframe name="${name}" src="about:blank"></iframe>`,
    )
    .join('')}</div><div style="height:300px">measured</div>`;

  test('an unsanitized document full of collisions still reports the right values', async () => {
    const opened = await bed.open({
      document: rawDocument(clobbers, 'real'),
      headers: 'none',
      follow: false,
    });
    const report = await last(opened);
    expect(report.h).toBe(300);
    expect(report.token).toBe(opened.token);
    expect(Object.keys(report)).toEqual(['token', 'h', 'w', 'bg', 'ready', 'marks']);
    await opened.page.close();
  });

  test('control: the previous reporter is silenced by the same document', async () => {
    const opened = await bed.open({
      document: rawDocument(clobbers, 'legacy'),
      headers: 'none',
      follow: false,
    });
    await opened.page.waitForTimeout(1_500);
    expect(await opened.reports()).toEqual([]);
    await opened.page.close();
  });

  test('window members shadowed by ids do not stop it either', async () => {
    const ids = ['addEventListener', 'ResizeObserver', 'getComputedStyle', 'Document', 'parent']
      .map(name => `<a id="${name}" name="${name}"></a>`)
      .join('');
    const opened = await bed.open({
      document: rawDocument(`${ids}<div style="height:120px">x</div>`, 'real'),
      headers: 'none',
      follow: false,
    });
    expect((await last(opened)).h).toBe(120);
    await opened.page.close();
  });

  test('the sanitized corpus message reports its content, and keeps every name in m-', async () => {
    const document = frameDocument(entry('137').html ?? '');
    expect(document).not.toMatch(/\b(?:id|name)="(?!m-)/);
    const opened = await bed.open({ document, follow: false });
    const report = await last(opened);
    expect(report.h).toBeGreaterThanOrEqual(200 + PAD);
    expect(report.h).toBeLessThan(400);
    await opened.page.close();
  });

  test('the older clobbering message still reports', async () => {
    const opened = await bed.open({ document: frameDocument(entry('064').html ?? '') });
    expect((await last(opened)).h).toBeGreaterThan(PAD);
    await opened.page.close();
  });
});

test.describe('standards mode', () => {
  const doctypes = [
    '',
    '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">',
    '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">',
    '<!-- first --><!DOCTYPE html>',
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
  ];

  for (const [index, doctype] of doctypes.entries()) {
    test(`doctype ${index} (${doctype.slice(10, 50) || 'none'}) renders in standards mode`, async () => {
      const opened = await bed.open({ document: frameDocument(`${doctype}<p>x</p>`) });
      await last(opened);
      expect(await opened.frame.evaluate('document.compatMode')).toBe('CSS1Compat');
      await opened.page.close();
    });
  }

  test('control: a document with no doctype is quirks mode', async () => {
    const page = '<html><body><p>x</p></body></html>';
    const opened = await bed.open({ document: withReporter(page), headers: 'none' });
    await last(opened);
    expect(await opened.frame.evaluate('document.compatMode')).toBe('BackCompat');
    await opened.page.close();
  });

  test('the whole corpus message with a quirks layout reports a bounded height', async () => {
    const opened = await bed.open({ document: frameDocument(entry('138').html ?? '') });
    const report = await last(opened);
    expect(report.h).toBeGreaterThan(400);
    expect(report.h).toBeLessThan(800);
    await opened.page.close();
  });
});

test.describe('viewport units cannot grow the frame', () => {
  test('the sanitized corpus message settles', async () => {
    const opened = await bed.open({ document: frameDocument(entry('136').html ?? '') });
    const reports = await opened.settled(6_000);
    expect(await opened.capped()).toBe(false);
    expect(reports.length).toBeLessThan(20);
    const final = reports[reports.length - 1].h;
    expect(final).toBeGreaterThan(0);
    // The units are bounded lengths now, so the letter is as tall as its own content says.
    expect(final).toBeLessThan(10_000);
    expect(await opened.frameHeight()).toBe(final);
    await opened.page.close();
  });

  test('container query units with no container settle too (the sanitized corpus message)', async () => {
    const opened = await bed.open({ document: frameDocument(entry('140').html ?? '') });
    const reports = await opened.settled(6_000);
    expect(await opened.capped()).toBe(false);
    expect(reports.length).toBeLessThan(20);
    expect(reports[reports.length - 1].h).toBeLessThan(10_000);
    expect(await opened.frameHeight()).toBe(reports[reports.length - 1].h);
    await opened.page.close();
  });

  test('control: unsanitized 100cqh and 100cqb blocks grow without end', async () => {
    for (const unit of ['cqh', 'cqb']) {
      const opened = await bed.open({
        document: rawDocument(`<div style="height:100${unit};padding:16px">x</div>`, 'real'),
        headers: 'none',
      });
      await opened.page.waitForTimeout(5_000);
      expect(await opened.capped(), unit).toBe(true);
      await opened.page.close();
    }
  });

  test('a scaled or zoomed root cannot inflate the reported height', async () => {
    const html =
      '<style>html{transform:scale(1000);zoom:50;scale:1000;translate:0 900px}</style><p>short</p>';
    const opened = await bed.open({ document: frameDocument(html), height: 2000, follow: false });
    expect((await last(opened)).h).toBeLessThan(120);
    await opened.page.close();
  });

  test('control: an unsanitized 100vh block grows without end', async () => {
    const opened = await bed.open({
      document: rawDocument('<div style="height:100vh;padding:16px">x</div>', 'real'),
      headers: 'none',
    });
    await opened.page.waitForTimeout(5_000);
    expect(await opened.capped()).toBe(true);
    expect((await opened.reports()).length).toBeGreaterThanOrEqual(FOLLOW_CAP);
    await opened.page.close();
  });
});
