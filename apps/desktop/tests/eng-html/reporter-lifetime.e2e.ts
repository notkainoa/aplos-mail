import { expect, test } from '@playwright/test';
import { loadCorpus } from '../../../../packages/mail-html/corpus/index';
import { REPORTER_SOURCE, withReporter } from '../../../../packages/mail-html/src/frame/reporter';
import { render } from '../../../../packages/mail-html/src/index';
import { launchBed, type Bed, type Opened } from './support/reporter-bed';

// THE FRAME REPORTER'S LIFETIME AND COST, IN REAL CHROMIUM. Split out of reporter.e2e.ts (max-lines). The real
// reporter and the real sanitizer in a sandboxed iframe in a hidden Electron; each check has a control that shows
// the bed can see the defect. Run (from the repo root, headless, no network):
//
//   npx playwright test -c apps/desktop/tests/eng-html/support/playwright.config.ts reporter-lifetime.e2e.ts

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

/** A raw document (no sanitizer) with the real reporter last in its body. */
function rawDocument(body: string): string {
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body>${body}</body></html>`;
  return withReporter(page);
}

let bed: Bed;
test.beforeAll(async () => {
  bed = await launchBed();
});
test.afterAll(async () => {
  await bed?.dispose();
});

test.describe('the reporter lifetime and cost', () => {
  // Reporter lifetime. Controls are copies of the script with one rule put back; they are served without the
  // engine's policy because their hash is not the pinned one.
  function variant(
    document: string,
    changes: [from: string, to: string][],
  ): { document: string; headers: 'none' } {
    let script = REPORTER_SOURCE;
    for (const [from, to] of changes) {
      expect(script.includes(from), `the script holds: ${from}`).toBe(true);
      script = script.replace(from, () => to);
    }
    return { document: document.replace(REPORTER_SOURCE, () => script), headers: 'none' };
  }

  async function countAt(opened: Opened, seconds: number[]): Promise<number[]> {
    const counts: number[] = [];
    let waited = 0;
    for (const second of seconds) {
      await opened.page.waitForTimeout((second - waited) * 1_000);
      waited = second;
      counts.push((await opened.reports()).length);
    }
    return counts;
  }

  const OLD_KEY = [
    [
      'message.h, message.w, message.ready, message.marks',
      'message.h, message.w, message.bg, message.ready, message.marks',
    ],
    ['if (shape !== form) {', 'if (true) {'],
  ] as [string, string][];

  test('174: a letter that only changes colour stops posting after its first reports', async () => {
    const opened = await bed.open({
      document: frameDocument(entry('174').html ?? ''),
      follow: false,
    });
    const [early, late] = await countAt(opened, [3, 7]);
    expect(late).toBeLessThanOrEqual(4);
    expect(late).toBe(early);
    await opened.page.close();
  });

  test('control 174: with the colour in the change key and every post extending the watch, it posts on', async () => {
    const opened = await bed.open({
      ...variant(frameDocument(entry('174').html ?? ''), OLD_KEY),
      follow: false,
    });
    const [early, late] = await countAt(opened, [4, 7]);
    expect(early).toBeGreaterThan(20);
    expect(late).toBeGreaterThan(early + 20);
    await opened.page.close();
  });

  test('175: a size that changes for ever stops after the lifetime cap, on the last state', async () => {
    const opened = await bed.open({
      ...variant(frameDocument(entry('175').html ?? ''), [
        ['const LIFETIME = 2000;', 'const LIFETIME = 60;'],
      ]),
      follow: false,
    });
    // Poll for the cap rather than a wall-clock count: a slow runner may take longer to reach it.
    await expect.poll(async () => (await opened.reports()).length, { timeout: 30_000 }).toBe(60);
    await opened.page.waitForTimeout(3_000);
    const reports = await opened.reports();
    expect(reports.length, 'nothing posts past the cap').toBe(60);
    expect(reports[0].ready).toBe(false); // the first report was delivered at once
    expect(reports[reports.length - 1].h).toBeGreaterThanOrEqual(100);
    await opened.page.close();
  });

  test('control 175: without the cap it keeps posting', async () => {
    const opened = await bed.open({
      ...variant(frameDocument(entry('175').html ?? ''), [
        ['const LIFETIME = 2000;', 'const LIFETIME = 1e9;'],
      ]),
      follow: false,
    });
    const [early, late] = await countAt(opened, [4, 8]);
    expect(late).toBeGreaterThan(early + 40);
    expect(late).toBeGreaterThan(60);
    await opened.page.close();
  });

  // Chromium stops animation frames in an off-screen cross-origin frame. The frame sits 3000 px down a 900 px
  // host window with forty images that fail late, one height change each: the held-back report must still arrive.
  const broken = (count: number) =>
    Array.from(
      { length: count },
      (_, n) => `<img src="/missing/${n}.png" alt="image number ${n}" style="display:block">`,
    ).join('');
  const trueHeight = (opened: Opened) =>
    opened.frame.evaluate(
      'Math.ceil(document.documentElement.getBoundingClientRect().height)',
    ) as Promise<number>;

  test('a letter below the fold with many late images gets its final report without scrolling into view', async () => {
    const opened = await bed.open({
      document: rawDocument(broken(40)),
      headers: 'none',
      height: 100,
      follow: false,
      below: 3_000,
    });
    await opened.page.waitForTimeout(4_000);
    const reports = await opened.reports();
    const last = reports[reports.length - 1];
    expect(last.h).toBe(await trueHeight(opened));
    expect(last.ready).toBe(true);
    await opened.page.close();
  });

  test('control: with animation frames alone, the off-screen letter is left stale', async () => {
    const opened = await bed.open({
      ...variant(rawDocument(broken(40)), [['if (later) later.call(w, go, WAIT);', '']]),
      height: 100,
      follow: false,
      below: 3_000,
    });
    await opened.page.waitForTimeout(4_000);
    const reports = await opened.reports();
    const last = reports[reports.length - 1];
    expect(last.ready === true && last.h === (await trueHeight(opened))).toBe(false);
    await opened.page.close();
  });

  // 15,000 elements end an animation together. The reporter only asks for a look on the next frame, so its
  // handlers cost about what an empty handler costs; measuring inside each event cost seven times that.
  const MANY =
    '<style>.a{animation:a .5s 1s forwards}@keyframes a{to{color:red}}</style>' +
    Array.from({ length: 15_000 }, () => '<i class="a">x</i>').join('') +
    '<mark class="aplos-find">m</mark>';

  async function endSpan(html: string, headers: 'engine' | 'none'): Promise<number> {
    const opened = await bed.open({ document: html, headers, height: 300, follow: false });
    await opened.frame.evaluate(() => {
      const mark = window as unknown as { __t: number[] };
      mark.__t = [];
      document.addEventListener('animationend', () => mark.__t.push(performance.now()), true);
    });
    await opened.page.waitForTimeout(3_500);
    const times = (await opened.frame.evaluate('window.__t')) as number[];
    expect(times.length).toBe(15_000);
    await opened.page.close();
    return times[times.length - 1] - times[0];
  }

  test('15,000 animations ending together cost the frame little more than an empty handler', async () => {
    const result = render({ html: MANY, cids: [], imagePolicy: 'block' });
    if (result.bodyKind !== 'html') throw new Error('not html');
    const spans = { with: [] as number[], without: [] as number[] };
    for (let round = 0; round < 3; round++) {
      spans.with.push(await endSpan(withReporter(result.document), 'none'));
      spans.without.push(await endSpan(result.document, 'none'));
    }
    const best = (list: number[]) => Math.min(...list);
    expect(best(spans.with)).toBeLessThan(best(spans.without) * 3 + 30);
  });

  test('control: measuring inside every event, with the marks counted each time, is several times slower', async () => {
    const result = render({ html: MANY, cids: [], imagePolicy: 'block' });
    if (result.bodyKind !== 'html') throw new Error('not html');
    const document = withReporter(result.document);
    const old = variant(document, [
      [
        "listen.call(d, 'animationend', look, true);",
        "listen.call(d, 'animationend', () => { marks = size(findAll.call(d, 'mark.aplos-find').length, 100000); last = ''; report(); watch(); }, true);",
      ],
    ]);
    const spans: number[] = [];
    const plain: number[] = [];
    for (let round = 0; round < 3; round++) {
      spans.push(await endSpan(old.document, 'none'));
      plain.push(await endSpan(document, 'none'));
    }
    expect(Math.min(...spans)).toBeGreaterThan(Math.min(...plain) * 1.5);
  });
});
