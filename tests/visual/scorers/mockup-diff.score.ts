import type { Browser, BrowserContext, Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STATES, type Theme } from '../states';
import { openState } from '../support/gallery';
import { visualDir } from '../support/paths';
import {
  log,
  isFresh,
  parseArgs,
  parseSize,
  printScore,
  shotPath,
  stateList,
  type ScorerState,
} from './common';
import { finish, runScorer } from './lifecycle';
import {
  CELL,
  compareImages,
  detailLine,
  implRegion,
  mockupReport,
  unresolvedScore,
  type Comparison,
  type Region,
  type Rgba,
  type StateScore,
} from './mockup-diff-score';
import { isPaneState, loadExcluded, mockupTarget, shootMockup, staleExcludes } from './mockup';
import { assertStatesLocked } from './locked';
import { launchBrowser, startGalleryServer } from './server';

// Hill-climb scorer: how close is each implementation state to its mockup in layout and style?
// Usage: npx tsx tests/visual/scorers/mockup-diff.score.ts [--size 1440x900] [--state prefix]
// [--theme light|dark|both] [--reuse]. Prints {"score", "details"} as the last stdout line, exits 0.
// Maths in mockup-diff-score.ts; states that cannot be compared are listed in mockup-diff.exclude.json.

const CONCURRENCY = 4;

interface Job {
  entry: ScorerState;
  theme: Theme;
}

interface Outcome {
  score: StateScore | null;
  skipped?: string;
}

async function newContext(
  browser: Browser,
  origin: string,
  size: string,
  theme: Theme,
): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: origin,
    viewport: parseSize(size),
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    colorScheme: theme,
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  });
}

async function shootImpl(
  page: Page,
  entry: ScorerState,
  theme: Theme,
  size: string,
  reuse: boolean,
) {
  const file = shotPath(size, entry.id, theme);
  if (reuse && isFresh(file)) return readFileSync(file);
  await openState(page, entry.state, { theme });
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png);
  return png;
}

/** Decodes a PNG in a blank page, crops it to `region` and resamples to `width` x `height`. */
async function decodeRegion(
  scratch: Page,
  png: Buffer,
  region: Region,
  width: number,
  height: number,
): Promise<Rgba> {
  const base64 = await scratch.evaluate(
    async ({ b64, rect, w, h }) => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(w, h);
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, w, h);
      const pixels = context.getImageData(0, 0, w, h).data;
      let binary = '';
      for (let i = 0; i < pixels.length; i += 0x8000)
        binary += String.fromCharCode(...pixels.subarray(i, i + 0x8000));
      return btoa(binary);
    },
    { b64: png.toString('base64'), rect: region, w: width, h: height },
  );
  return { data: Buffer.from(base64, 'base64'), width, height };
}

/** impl | mockup | heatmap, each at half size, as a PNG. */
async function renderOverlay(
  scratch: Page,
  impl: Rgba,
  mockup: Rgba,
  comparison: Comparison,
): Promise<Buffer> {
  const cols = Math.ceil(impl.width / CELL);
  const base64 = await scratch.evaluate(
    async ({ a, b, deltas, w, h, cols: columns, cell }) => {
      const bytes = (text: string) =>
        new Uint8ClampedArray(Array.from(atob(text), c => c.charCodeAt(0)));
      const paint = (data: Uint8ClampedArray<ArrayBuffer>) => {
        const canvas = new OffscreenCanvas(w, h);
        canvas.getContext('2d')!.putImageData(new ImageData(data, w, h), 0, 0);
        return canvas;
      };
      const left = paint(bytes(a));
      const right = paint(bytes(b));
      const heat = new OffscreenCanvas(w, h);
      const hc = heat.getContext('2d')!;
      hc.globalAlpha = 0.3;
      hc.drawImage(right, 0, 0);
      hc.globalAlpha = 1;
      deltas.forEach((delta: number, i: number) => {
        hc.fillStyle = `rgba(230,30,30,${Math.min(1, delta / 30)})`;
        hc.fillRect((i % columns) * cell, Math.floor(i / columns) * cell, cell, cell);
      });
      const out = new OffscreenCanvas(Math.floor(w / 2) * 3 + 8, Math.floor(h / 2));
      const oc = out.getContext('2d')!;
      oc.fillStyle = '#888';
      oc.fillRect(0, 0, out.width, out.height);
      [left, right, heat].forEach((canvas, i) =>
        oc.drawImage(canvas, i * (Math.floor(w / 2) + 4), 0, Math.floor(w / 2), out.height),
      );
      const blob = await out.convertToBlob({ type: 'image/png' });
      const buffer = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < buffer.length; i += 0x8000)
        binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
      return btoa(binary);
    },
    {
      a: Buffer.from(impl.data as Uint8Array).toString('base64'),
      b: Buffer.from(mockup.data as Uint8Array).toString('base64'),
      deltas: Array.from(comparison.cellDeltas),
      w: impl.width,
      h: impl.height,
      cols,
      cell: CELL,
    },
  );
  return Buffer.from(base64, 'base64');
}

async function scoreJob(
  browser: Browser,
  origin: string,
  args: { size: string; reuse: boolean },
  job: Job,
): Promise<Outcome> {
  const { entry, theme } = job;
  const target = mockupTarget(entry, theme);
  if (typeof target === 'string')
    return { score: unresolvedScore(entry.id, theme, target), skipped: target };

  const context = await newContext(browser, origin, args.size, theme);
  try {
    const viewport = parseSize(args.size);
    const implPage = await context.newPage();
    const failed = (note: string): Outcome => ({
      score: { state: entry.id, theme, score: 0, worst: null, note },
    });
    let implPng: Buffer;
    try {
      implPng = await shootImpl(implPage, entry, theme, args.size, args.reuse);
    } catch (error) {
      return failed(`state-failed-to-open ${firstLine(error)}`);
    }
    const pane = isPaneState(entry);
    const mockPage = await context.newPage();
    let mock: { png: Buffer; region: Region };
    try {
      mock = await shootMockup(mockPage, target.url, pane);
    } catch (error) {
      return failed(`mockup-failed-to-render ${firstLine(error)}`);
    }
    const scratch = await context.newPage();
    await scratch.goto('about:blank');
    // tsx wraps named functions in __name(); the blank page has no such helper.
    await scratch.evaluate('window.__name = f => f');
    const width = Math.max(CELL, Math.round(mock.region.width));
    const height = Math.max(CELL, Math.round(mock.region.height));
    const impl = await decodeRegion(
      scratch,
      implPng,
      implRegion(entry.state.frame, viewport),
      width,
      height,
    );
    const mockup = await decodeRegion(scratch, mock.png, mock.region, width, height);
    const comparison = compareImages(impl, mockup);
    const overlay = await renderOverlay(scratch, impl, mockup, comparison);
    const file = join(visualDir, 'mockup-diff', args.size, `${entry.id}.${theme}.png`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, overlay);
    return {
      score: { state: entry.id, theme, score: comparison.score, worst: comparison.worst },
    };
  } finally {
    await context.close();
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? 'failed';
}

async function runJobs(
  browser: Browser,
  origin: string,
  args: { size: string; reuse: boolean },
  jobs: Job[],
): Promise<Outcome[]> {
  const outcomes: Outcome[] = jobs.map(() => ({ score: null }));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < jobs.length; index = next++) {
      const job = jobs[index] as Job;
      try {
        outcomes[index] = await scoreJob(browser, origin, args, job);
      } catch (error) {
        outcomes[index] = {
          score: {
            state: job.entry.id,
            theme: job.theme,
            score: 0,
            worst: null,
            note: firstLine(error),
          },
        };
      }
      const done = outcomes[index]?.score;
      log(`mockup-diff ${index + 1}/${jobs.length} ${done ? detailLine(done) : job.entry.id}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  return outcomes;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertStatesLocked(STATES.map(state => state.id));
  const entries = stateList(args.state);
  if (entries.length === 0) throw new Error(`no state id starts with "${args.state}"`);
  const excluded = loadExcluded();
  const stale = staleExcludes(
    excluded,
    STATES.map(state => state.id),
  );
  if (stale.length > 0)
    throw new Error(`mockup-diff.exclude.json lists unknown states: ${stale.join(', ')}`);
  const kept = entries.filter(entry => !(entry.id in excluded));
  log(`mockup-diff: ${kept.length} states, ${entries.length - kept.length} excluded`);
  const jobs = kept.flatMap(entry => args.themes.map(theme => ({ entry, theme })));
  const total = entries.length * args.themes.length;
  const excludedPages = total - jobs.length;

  const server = await startGalleryServer();
  try {
    const browser = await launchBrowser();
    try {
      const started = Date.now();
      const outcomes = await runJobs(browser, server.origin, args, jobs);
      const scored = outcomes.flatMap(outcome => (outcome.score ? [outcome.score] : []));
      outcomes.forEach((outcome, i) => {
        if (outcome.skipped) log(`unresolved ${jobs[i]?.entry.id}: ${outcome.skipped}`);
      });
      log(`mockup-diff: ${scored.length} compared, ${Date.now() - started} ms`);
      const report = mockupReport(scored, total, excludedPages);
      printScore(report.score, report.details);
    } finally {
      await browser.close();
    }
  } finally {
    server.stop();
  }
  await finish(0);
}

runScorer(main);
