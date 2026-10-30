import type { Browser } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Theme } from '../states';
import { openState } from '../support/gallery';
import { visualDir } from '../support/paths';
import {
  isFresh,
  log,
  parseArgs,
  parseSize,
  printScore,
  shotPath,
  stateList,
  type ScorerArgs,
  type ScorerState,
} from './common';
import { createClaudeJudge, type ClaudeJudge } from './claude-judge';
import { scorerEnv } from './env';
import { finish, onShutdown, runScorer } from './lifecycle';
import { assertSampleLocked } from './locked';
import { isPaneState, mockupTarget, newMockupContext, shootMockup } from './mockup';
import { launchBrowser, startGalleryServer } from './server';
import {
  DEFAULT_MAX_CALLS,
  DEFAULT_MODEL,
  checkCallBudget,
  criterionIds,
  failedJudgement,
  judgeState,
  loadRubric,
  pickStates,
  summarise,
  type Judge,
  type JudgeImage,
  type StateJudgement,
} from './taste-score';

// Hill-climb scorer: Claude Sonnet judges screenshots against a condensed rubric of plans/DESIGN.md
// (taste.rubric.md) and the matching mockup. Usage: npx tsx tests/visual/scorers/taste.score.ts
// [--size 1440x900] [--state prefix] [--theme light|dark|both] [--reuse] [--samples N] [--runs K]
// [--max-calls N].
// --state overrides the default list in taste.sample.json; --samples N keeps the first N states;
// --runs K asks K times per state (a different cache entry each) and takes the median per criterion.
// --max-calls N (default 12) is the run-wide cap: the run is refused when states x runs exceeds it.
// One judge call per state per run covers both themes. Needs a logged-in `claude` (env CLAUDE_BIN).

const HERE = import.meta.dirname;
const CACHE_DIR = join(visualDir, 'judge-cache');
const REFERENCE_DIR = join(visualDir, 'judge-ref');
const JUDGE_TIMEOUT_MS = 300_000;
const CONCURRENCY = 2;

interface TasteArgs {
  base: ScorerArgs;
  samples: number;
  runs: number;
  maxCalls: number;
}

function parseTasteArgs(argv: readonly string[]): TasteArgs {
  const rest: string[] = [];
  let samples = 0;
  let runs = 1;
  let maxCalls = DEFAULT_MAX_CALLS;
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = (argv[i] ?? '').split('=', 2);
    const value = (): number => Number(inline ?? argv[++i]);
    if (flag === '--samples') samples = value();
    else if (flag === '--runs') runs = value();
    else if (flag === '--max-calls') maxCalls = value();
    else rest.push(argv[i] as string);
  }
  if (!Number.isInteger(samples) || samples < 0)
    throw new Error('--samples must be a whole number');
  if (!Number.isInteger(runs) || runs < 1)
    throw new Error('--runs must be a whole number of 1 or more');
  if (!Number.isInteger(maxCalls) || maxCalls < 1)
    throw new Error('--max-calls must be a whole number of 1 or more');
  return { base: parseArgs(rest), samples, runs, maxCalls };
}

function sampleStates(args: TasteArgs): ScorerState[] {
  const listed = JSON.parse(readFileSync(join(HERE, 'taste.sample.json'), 'utf8')) as {
    states: string[];
  };
  // Checked even with --state: the default sample may not shrink.
  assertSampleLocked(listed.states);
  let entries: ScorerState[];
  if (args.base.state) entries = stateList(args.base.state);
  else entries = pickStates(listed.states, stateList());
  if (entries.length === 0) throw new Error(`no state matches "${args.base.state}"`);
  return args.samples ? entries.slice(0, args.samples) : entries;
}

async function shoot(
  browser: Browser,
  origin: string,
  size: string,
  entry: ScorerState,
  theme: Theme,
): Promise<string> {
  const file = shotPath(size, entry.id, theme);
  const context = await browser.newContext({
    baseURL: origin,
    viewport: parseSize(size),
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    await openState(page, entry.state, { theme });
    mkdirSync(dirname(file), { recursive: true });
    await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
    return file;
  } finally {
    await context.close();
  }
}

/** The mockup page for a state, shot like mockup-diff does; null with the reason when skipped. */
async function shootReference(
  browser: Browser,
  size: string,
  entry: ScorerState,
  theme: Theme,
): Promise<{ path: string } | { skip: string }> {
  const target = mockupTarget(entry, theme);
  if (typeof target === 'string') return { skip: target };
  const file = join(
    REFERENCE_DIR,
    size,
    `${target.file.replace('.html', '')}-${target.state || 'default'}.${theme}.png`,
  );
  const context = await newMockupContext(browser, size, theme);
  try {
    const tab = await context.newPage();
    const { png } = await shootMockup(tab, target.url, isPaneState(entry));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, png);
    return { path: file };
  } finally {
    await context.close();
  }
}

interface Prepared {
  entry: ScorerState;
  images: JudgeImage[];
  referenceNote?: string;
  skipped?: string;
  /** Set when the state could not be shot at all; it is then scored 0. */
  failed?: string;
}

/** `prepare`, but an exception while shooting one state becomes a failed state, not a dead scorer. */
async function prepareSafely(
  browser: Browser,
  origin: string,
  args: TasteArgs,
  entry: ScorerState,
): Promise<Prepared> {
  try {
    return await prepare(browser, origin, args, entry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { entry, images: [], failed: `state-failed-to-shoot ${message.split('\n')[0]}` };
  }
}

async function prepare(
  browser: Browser,
  origin: string,
  args: TasteArgs,
  entry: ScorerState,
): Promise<Prepared> {
  const { size, themes, reuse } = args.base;
  const images: JudgeImage[] = [];
  for (const theme of themes) {
    const existing = shotPath(size, entry.id, theme);
    const path =
      reuse && isFresh(existing) ? existing : await shoot(browser, origin, size, entry, theme);
    images.push({ label: `SHOT ${theme} (the view under review)`, path });
  }
  const references: JudgeImage[] = [];
  let skip = '';
  for (const theme of themes) {
    const reference = await shootReference(browser, size, entry, theme);
    if ('path' in reference)
      references.push({
        label: `REFERENCE MOCKUP ${theme} (the visual target)`,
        path: reference.path,
      });
    else skip = reference.skip;
  }
  if (references.length === themes.length) return { entry, images: [...images, ...references] };
  return {
    entry,
    images,
    referenceNote: 'no reference mockup is attached; score fidelity null.',
    skipped: skip,
  };
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++)
      results[index] = await work(items[index] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Judges the prepared states; one that could not be shot is a failed judgement, scored 0. */
async function judgeAll(
  prepared: readonly Prepared[],
  context: {
    rubric: string;
    criteria: string[];
    model: string;
    runs: number;
    judge: Judge;
  },
): Promise<StateJudgement[]> {
  return mapLimit(prepared, CONCURRENCY, item =>
    item.failed
      ? Promise.resolve(failedJudgement(item.entry.id, item.failed))
      : judgeState({
          ...context,
          stateId: item.entry.id,
          title: item.entry.title,
          images: item.images,
          referenceNote: item.referenceNote,
          cacheDir: CACHE_DIR,
        }),
  );
}

async function main(): Promise<void> {
  const args = parseTasteArgs(process.argv.slice(2));
  const entries = sampleStates(args);
  checkCallBudget(entries.length, args.runs, args.maxCalls);
  const rubric = loadRubric(join(HERE, 'taste.rubric.md'));
  const criteria = criterionIds(rubric);
  const model = process.env.TASTE_MODEL || DEFAULT_MODEL;
  log(
    `taste: ${entries.length} states, ${args.runs} run(s) each, model ${model}, max ${args.maxCalls} calls`,
  );

  let results: StateJudgement[];
  const notes: string[] = [];
  const server = await startGalleryServer();
  let judge: ClaudeJudge | undefined;
  try {
    const browser = await launchBrowser();
    try {
      const prepared = await mapLimit(entries, CONCURRENCY, entry =>
        prepareSafely(browser, server.origin, args, entry),
      );
      for (const item of prepared)
        if (item.skipped) notes.push(`${item.entry.id}: no mockup reference (${item.skipped})`);
      const images = [
        ...new Set(prepared.flatMap(item => item.images.map(image => resolve(image.path)))),
      ];
      // A retry may double the calls of a state; nothing else may exceed the cap.
      judge = createClaudeJudge({
        bin: process.env.CLAUDE_BIN || 'claude',
        model,
        images,
        hardCap: args.maxCalls * 2,
        env: scorerEnv(process.env),
        timeoutMs: JUDGE_TIMEOUT_MS,
      });
      onShutdown(judge.dispose);
      results = await judgeAll(prepared, {
        rubric,
        criteria,
        model,
        runs: args.runs,
        judge: judge.judge,
      });
    } finally {
      await browser.close();
    }
  } finally {
    server.stop();
    judge?.dispose();
  }

  const calls = results.reduce((sum, result) => sum + result.calls, 0);
  const hits = results.reduce((sum, result) => sum + result.cacheHits, 0);
  log(`taste: ${hits} judge cache hits, ${calls} judge calls`);
  for (const result of results)
    log(
      `  ${result.stateId}: ${result.ok ? (result.score as number).toFixed(1) : `FAILED ${result.error}`}`,
    );
  const summary = summarise(results, notes);
  if (summary.failures === results.length) {
    log(`taste: every state failed, nothing to score. ${summary.details[0] ?? ''}`);
    await finish(1);
  }
  printScore(summary.score, summary.details);
  await finish(0);
}

runScorer(main);
