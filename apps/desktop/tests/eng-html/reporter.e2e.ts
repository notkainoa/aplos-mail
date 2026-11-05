import { expect, test } from '@playwright/test';
import { loadCorpus } from '../../../../packages/mail-html/corpus/index';
import { REPORTER_SOURCE, withReporter } from '../../../../packages/mail-html/src/frame/reporter';
import { READING_DOCTYPE, render } from '../../../../packages/mail-html/src/index';
import { launchBed, type Bed, type Opened } from './support/reporter-bed';

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

  // Sliced-image newsletters were written against the table-cell rule: the cell is as tall as its image. The bed
  // serves no sub-resources, so the image's rewritten address is swapped for a data URI and the page is served bare.
  const GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  function slicedLetter(doctype: string): string {
    const sliced =
      '<table cellspacing="0" cellpadding="0"><tr><td><img src="https://img.example/a.gif" width="120" height="120"></td></tr></table>';
    const result = render({ html: sliced, cids: [], imagePolicy: 'allow' });
    if (result.bodyKind !== 'html') throw new Error('not html');
    const swapped = result.document
      .replace(READING_DOCTYPE, doctype)
      .replace(/src="[^"]*"/, `src="${GIF}"`);
    expect(swapped).toContain(GIF);
    return withReporter(swapped);
  }
  const cellGap = (frame: { evaluate(script: string): Promise<unknown> }) =>
    frame.evaluate(
      "document.querySelector('td').getBoundingClientRect().height - document.querySelector('img').getBoundingClientRect().height",
    );

  test('an image alone in a table cell leaves no baseline strip, and the frame is still measured by its content', async () => {
    const opened = await bed.open({ document: slicedLetter(READING_DOCTYPE), headers: 'none' });
    const report = await last(opened);
    expect(await cellGap(opened.frame)).toBe(0);
    // Standards-style measuring: the report follows the letter, not the viewport (quirks reports the window's height).
    expect(report.h).toBeGreaterThanOrEqual(120);
    expect(report.h).toBeLessThan(200);
    expect(await opened.frame.evaluate('document.compatMode')).toBe('CSS1Compat');
    await opened.page.close();
  });

  test('control: with the plain standards doctype the same cell is taller than its image', async () => {
    const opened = await bed.open({ document: slicedLetter('<!DOCTYPE html>'), headers: 'none' });
    await last(opened);
    expect(await cellGap(opened.frame)).toBeGreaterThan(0);
    await opened.page.close();
  });

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
      // Growing 32 px a report at up to 20 reports a second, 5 s is a frame of thousands of px.
      expect((await opened.capped()) || (await opened.frameHeight()) > 2_000, unit).toBe(true);
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

  test('a zoomed body cannot inflate the reported height either', async () => {
    const html = '<style>body{zoom:1000}</style><p>short</p>';
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
    expect((await opened.capped()) || (await opened.frameHeight()) > 2_000).toBe(true);
    await opened.page.close();
  });
});

test.describe('the reading rules cannot be overridden by the mail', () => {
  /** The root and body reading rules before the layer: unlayered, without position, inset or writing mode. */
  const BEFORE =
    'html:root{display:flow-root!important;height:auto!important;min-height:0!important;max-height:none!important;transform:none!important;scale:none!important;rotate:none!important;translate:none!important;zoom:1!important}' +
    'html:root>body{height:auto!important;min-height:0!important;max-height:none!important}';

  function withoutLayer(document: string): string {
    const layer = /@layer aplos-reading\{.*?\}\}/;
    expect(layer.test(document), 'the reading layer is in the document').toBe(true);
    return document.replace(layer, () => BEFORE);
  }

  /** Grown, or still moving after many reports: the signs of a frame that follows its letter. */
  async function runsAway(opened: Opened): Promise<boolean> {
    return (
      (await opened.capped()) ||
      (await opened.frameHeight()) > 2_000 ||
      (await opened.reports()).length >= 25
    );
  }

  const vectors = [
    ['141', 'html positioned with a negative bottom, with and without !important'],
    ['142', 'body positioned with a negative bottom, with and without !important'],
    ['144', 'layered !important rules (named, ordered, anonymous)'],
    ['146', 'mail layers named like the reading layer'],
  ] as const;

  for (const [id, title] of vectors) {
    test(`${id}: ${title}: the frame settles`, async () => {
      const opened = await bed.open({ document: frameDocument(entry(id).html ?? '') });
      const reports = await opened.settled(6_000);
      expect(await opened.capped()).toBe(false);
      expect(reports.length).toBeLessThan(20);
      const final = reports[reports.length - 1].h;
      expect(final).toBeGreaterThan(0);
      expect(final).toBeLessThan(400);
      expect(await opened.frameHeight()).toBe(final);
      await opened.page.close();
    });

    test(`control ${id}: with the reading rules as they were, the frame grows without end`, async () => {
      const opened = await bed.open({
        document: withoutLayer(frameDocument(entry(id).html ?? '')),
      });
      await opened.page.waitForTimeout(5_000);
      // Growing 50 px a report, a frame of a few thousand px in 5 s is not a letter of 100 px.
      expect(await runsAway(opened)).toBe(true);
      await opened.page.close();
    });
  }

  test('143: a sideways root is sized by its content, so a tall frame shrinks to the letter', async () => {
    const opened = await bed.open({
      document: frameDocument(entry('143').html ?? ''),
      height: 1_500,
      follow: false,
    });
    expect((await last(opened)).h).toBeLessThan(400);
    await opened.page.close();
  });

  test('control 143: with the root scroll height, a sideways root reports the frame', async () => {
    const opened = await bed.open({
      ...rootScrollOnly(withoutLayer(frameDocument(entry('143').html ?? ''))),
      height: 1_500,
      follow: false,
    });
    expect((await last(opened)).h).toBeGreaterThanOrEqual(1_500);
    await opened.page.close();
  });

  test('the usual inline body style (colour, margin, padding) still shows', async () => {
    const html = '<body style="margin:0;padding:0;background-color:#336699"><p>x</p></body>';
    const opened = await bed.open({ document: frameDocument(html) });
    const report = await last(opened);
    expect(report.bg).toBe('rgb(51, 102, 153)');
    expect(report.h).toBeLessThan(80);
    await opened.page.close();
  });

  test('an empty letter still has a size', async () => {
    const opened = await bed.open({
      document: frameDocument('<body style="margin:0;padding:0"></body>'),
      height: 300,
      follow: false,
    });
    expect((await last(opened)).h).toBeGreaterThanOrEqual(1);
    await opened.page.close();
  });

  // An element's own style attribute outranks every cascade layer, !important or not. The frame body's keeps
  // only colours, margins, padding and type; the control writes the mail's original style back onto the body.
  const inline = [
    [
      '145',
      'position:fixed!important;top:0!important;bottom:-50px!important;margin:0;background:#f4f1ea',
    ],
    ['148', 'zoom:1000 !important;margin:0;background:#eef2f7'],
    ['149', 'writing-mode:vertical-lr!important;margin-bottom:-50px;color:#222'],
    // The same text on a div before the body: the body must not be handed that element's unfiltered style.
    ['164', 'position:fixed!important;top:0!important;bottom:-50px!important'],
  ] as const;

  for (const [id, style] of inline) {
    test(`${id}: an inline body style that sizes the body cannot reach the frame body`, async () => {
      const document = frameDocument(entry(id).html ?? '');
      const style = document.match(/<body style="([^"]*)"/)?.[1] ?? '';
      for (const declaration of style.split(';').filter(Boolean)) {
        const name = declaration.split(':')[0].trim();
        expect(name, style).toMatch(
          /^(?:background|color|margin|padding|font|text-align|line-height)/,
        );
      }
      const opened = await bed.open({ document });
      const reports = await opened.settled(6_000);
      expect(await opened.capped()).toBe(false);
      expect(reports.length).toBeLessThan(20);
      expect(reports[reports.length - 1].h).toBeLessThan(400);
      await opened.page.close();
    });

    test(`control ${id}: with the mail's own body style written back, the frame body is sized by it`, async () => {
      const document = frameDocument(entry(id).html ?? '').replace(
        /<body[^>]*>/,
        () => `<body style="${style}">`,
      );
      const opened = await bed.open({ document });
      await opened.page.waitForTimeout(5_000);
      const reports = await opened.reports();
      const inflated = reports.some(report => report.h > 5_000);
      expect((await runsAway(opened)) || inflated).toBe(true);
      await opened.page.close();
    });
  }

  test('166: type sizes past the bound never reach the frame body, and a huge font would inflate it', async () => {
    const document = frameDocument(entry('166').html ?? '');
    expect(document).not.toMatch(/<body[^>]*font/);
    const opened = await bed.open({ document });
    const reports = await opened.settled(5_000);
    expect(reports[reports.length - 1].h).toBeLessThan(400);
    await opened.page.close();
    const huge = document.replace(
      /<body[^>]*>/,
      () => '<body style="font:900px/100 Arial;margin:0">',
    );
    const control = await bed.open({ document: huge });
    const inflated = await control.settled(5_000);
    expect(inflated[inflated.length - 1].h).toBeGreaterThan(5_000);
    await control.page.close();
  });

  // Item 1: what the root's box leaves out. The body is positioned, so its scroll height takes in positioned and
  // transformed content; the control reports the root's box alone.
  const clipped = [
    ['150', 'absolute content 1,200 px down', 1_200],
    ['151', 'a tall absolute child of a relative box', 900],
    ['152', 'a dropdown at top:100% of a relative item', 300],
    ['153', 'a block translated 800 px down', 800],
    ['154', 'a body translated 500 px down', 500],
    ['155', 'a body with a negative bottom margin', 150],
  ] as const;

  /** The document with the reporter's measuring line replaced: the controls for what the reporter reads. */
  function measuring(document: string, expression: string): { document: string; headers: 'none' } {
    const same = 'M.max(M.ceil(boxOf.call(root).height), below(body))';
    expect(REPORTER_SOURCE.includes(same), 'the measuring line is where this control expects').toBe(
      true,
    );
    const script = REPORTER_SOURCE.replace(same, () => expression);
    return { document: document.replace(REPORTER_SOURCE, () => script), headers: 'none' };
  }

  /** The reporter of the first version: the root's box alone. */
  const rootBoxOnly = (document: string) => measuring(document, 'M.ceil(boxOf.call(root).height)');

  /** The reporter of the first version before that: the root's scroll height, at least the frame's. */
  const rootScrollOnly = (document: string) => measuring(document, 'scrollOf.call(root)');

  for (const [id, title, least] of clipped) {
    test(`${id}: ${title}: the report reaches the content`, async () => {
      const opened = await bed.open({
        document: frameDocument(entry(id).html ?? ''),
        height: 100,
        follow: false,
      });
      const report = await last(opened);
      expect(report.h).toBeGreaterThanOrEqual(least);
      expect(report.h).toBeLessThan(least + 400);
      await opened.page.close();
    });

    test(`control ${id}: the root's box alone misses it`, async () => {
      const opened = await bed.open({
        ...rootBoxOnly(frameDocument(entry(id).html ?? '')),
        height: 100,
        follow: false,
      });
      expect((await last(opened)).h).toBeLessThan(least);
      await opened.page.close();
    });
  }

  // Item 2: properties that stop the root or the body from being measured.
  const measured = [
    ['156', 'a zero-width root on an offset path', 60, 2_000],
    ['157', 'a root moved up an offset path', 60, 400],
    ['158', 'size containers on the root and body', 800, 1_100],
    ['163', 'a root with content-visibility:hidden', 60, 400],
  ] as const;

  async function placed(opened: Opened) {
    const reports = await opened.settled(4_000);
    const top = (await opened.frame
      .evaluate("document.querySelector('p').getBoundingClientRect().top")
      .catch(() => -1e9)) as number;
    return { h: reports.length ? reports[reports.length - 1].h : -1, top };
  }

  for (const [id, title, least, most] of measured) {
    test(`${id}: ${title}: the letter is measured and in view`, async () => {
      const opened = await bed.open({ document: frameDocument(entry(id).html ?? '') });
      const { h, top } = await placed(opened);
      expect(h).toBeGreaterThanOrEqual(least);
      expect(h).toBeLessThanOrEqual(most);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top).toBeLessThan(300);
      await opened.page.close();
    });

    test(`control ${id}: with the previous rules and the root box alone, it is not`, async () => {
      const opened = await bed.open({
        ...rootBoxOnly(withoutLayer(frameDocument(entry(id).html ?? ''))),
      });
      const { h, top } = await placed(opened);
      const fine = h >= least && h <= most && top >= 0 && top < 300;
      expect(fine).toBe(false);
      await opened.page.close();
    });
  }

  // Item 4: orthogonal writing modes and height-following media queries. The control writes the original
  // property and feature names back.
  const feedback = [
    ['159', 'vertical text in a block'],
    ['160', 'a max-height media query'],
    ['161', 'an orientation media query'],
    ['162', 'a staircase of min-height media rules'],
    ['165', 'vendor-prefixed writing-mode aliases'],
  ] as const;

  const original = (document: string) =>
    document.replace(
      /--m-([a-z-]*writing-mode|[a-z-]*height|orientation|aspect-ratio)/g,
      (_all, name: string) => name,
    );

  for (const [id, title] of feedback) {
    test(`${id}: ${title}: the frame settles`, async () => {
      const opened = await bed.open({ document: frameDocument(entry(id).html ?? '') });
      const reports = await opened.settled(6_000);
      expect(await opened.capped()).toBe(false);
      expect(reports.length).toBeLessThan(20);
      expect(reports[reports.length - 1].h).toBeLessThan(3_000);
      await opened.page.close();
    });

    test(`control ${id}: with the original names, the frame follows its letter without end`, async () => {
      const document = frameDocument(entry(id).html ?? '');
      expect(original(document)).not.toBe(document);
      const opened = await bed.open({ document: original(document) });
      await opened.page.waitForTimeout(6_000);
      expect(await runsAway(opened)).toBe(true);
      await opened.page.close();
    });
  }

  // CSS if(media()) and scroll-driven animations follow the frame. The control puts the original message in a
  // raw document (no sanitizer), which the browser then runs as written.
  const following = [
    ['167', 'if(media()) conditions on height, orientation and aspect ratio'],
    ['168', 'if(media()) in the allowlisted body margin and padding'],
    ['169', 'scroll-driven animation timelines'],
  ] as const;

  for (const [id, title] of following) {
    test(`${id}: ${title}: the frame settles`, async () => {
      const document = frameDocument(entry(id).html ?? '');
      expect(document).not.toMatch(/\bif\(|(?<![-\w])animation-timeline\s*:/);
      const opened = await bed.open({ document });
      const reports = await opened.settled(6_000);
      expect(await opened.capped()).toBe(false);
      expect(reports.length).toBeLessThan(20);
      // The 1000 px keyframes of 169 apply without a timeline (two blocks, 2086 px), once and steadily.
      expect(reports[reports.length - 1].h).toBeLessThan(id === '169' ? 3_000 : 400);
      await opened.page.close();
    });

    test(`control ${id}: written as the mail wrote it, the frame follows its letter without end`, async () => {
      const opened = await bed.open({
        document: rawDocument(entry(id).html ?? '', 'real'),
        headers: 'none',
      });
      await opened.page.waitForTimeout(5_000);
      expect(await runsAway(opened)).toBe(true);
      await opened.page.close();
    });
  }

  test('170: a body with display:contents still has a box, so the report reaches the content', async () => {
    const opened = await bed.open({
      document: frameDocument(entry('170').html ?? ''),
      height: 100,
      follow: false,
    });
    expect((await last(opened)).h).toBeGreaterThanOrEqual(1_200);
    await opened.page.close();
  });

  test('control 170: with the previous body rule, display:contents hides the content', async () => {
    const opened = await bed.open({
      document: withoutLayer(frameDocument(entry('170').html ?? '')),
      height: 100,
      follow: false,
    });
    expect((await last(opened)).h).toBeLessThan(1_200);
    await opened.page.close();
  });

  /** The reporter without its frame and timer loop, or without its animation events, or without both. */
  function without(
    document: string,
    parts: { loop?: boolean; events?: boolean },
  ): { document: string; headers: 'none' } {
    const line = "typeof w.requestAnimationFrame === 'function' ? w.requestAnimationFrame : null";
    expect(REPORTER_SOURCE.includes(line), 'the frame line is where this control expects').toBe(
      true,
    );
    let script = REPORTER_SOURCE;
    if (parts.loop) {
      script = script
        .replace(line, () => 'null')
        .replace("typeof w.setTimeout === 'function' ? w.setTimeout : null", () => 'null');
    }
    if (parts.events) {
      script = script
        .replace("listen.call(d, 'animationend', watch, true);", () => '')
        .replace("listen.call(d, 'transitionend', watch, true);", () => '');
    }
    expect(script === REPORTER_SOURCE, 'the control changed the script').toBe(false);
    return { document: document.replace(REPORTER_SOURCE, () => script), headers: 'none' };
  }

  async function lastAfter(opened: Opened, ms: number) {
    await opened.page.waitForTimeout(ms);
    const reports = await opened.reports();
    return reports[reports.length - 1].h;
  }

  test('171: a box that moves down after load is reported at its new place', async () => {
    const opened = await bed.open({
      document: frameDocument(entry('171').html ?? ''),
      height: 100,
      follow: false,
    });
    await opened.page.waitForTimeout(3_500);
    const reports = await opened.reports();
    expect(reports[reports.length - 1].h).toBeGreaterThanOrEqual(1_200);
    expect(reports.length).toBeLessThan(30);
    await opened.page.close();
  });

  test('control 171: without the frame loop and its events the move goes unseen', async () => {
    const opened = await bed.open({
      ...without(frameDocument(entry('171').html ?? ''), { loop: true, events: true }),
      height: 100,
      follow: false,
    });
    await opened.page.waitForTimeout(3_500);
    const reports = await opened.reports();
    expect(reports[reports.length - 1].h).toBeLessThan(1_200);
    await opened.page.close();
  });

  test('172: a jump with no end event is seen by the frame loop', async () => {
    const opened = await bed.open({
      document: frameDocument(entry('172').html ?? ''),
      height: 100,
      follow: false,
    });
    expect(await lastAfter(opened, 3_500)).toBeGreaterThanOrEqual(1_200);
    await opened.page.close();
  });

  test('control 172: without the frame loop (the events never come) the jump goes unseen', async () => {
    const opened = await bed.open({
      ...without(frameDocument(entry('172').html ?? ''), { loop: true }),
      height: 100,
      follow: false,
    });
    expect(await lastAfter(opened, 3_500)).toBeLessThan(1_200);
    await opened.page.close();
  });

  test('173: a move after the quiet period is reported when its animation ends', async () => {
    const opened = await bed.open({
      document: frameDocument(entry('173').html ?? ''),
      height: 100,
      follow: false,
    });
    expect(await lastAfter(opened, 6_500)).toBeGreaterThanOrEqual(1_200);
    await opened.page.close();
  });

  test('control 173: without the animation events the late move goes unseen', async () => {
    const opened = await bed.open({
      ...without(frameDocument(entry('173').html ?? ''), { events: true }),
      height: 100,
      follow: false,
    });
    expect(await lastAfter(opened, 6_500)).toBeLessThan(1_200);
    await opened.page.close();
  });

  test('an animated height posts at most 20 reports a second, not one per frame', async () => {
    const html =
      '<style>.a { animation: a 1s linear infinite } @keyframes a { from { height: 100px } to { height: 600px } }</style><div class="a">x</div>';
    const opened = await bed.open({ document: frameDocument(html), height: 100, follow: false });
    await opened.page.waitForTimeout(3_000);
    const count = (await opened.reports()).length;
    expect(count).toBeGreaterThan(10);
    expect(count).toBeLessThanOrEqual(3 * 20 + 25);
    await opened.page.close();
  });
});
