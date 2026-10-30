import type { Browser } from '@playwright/test';
import { axeKnownDefects } from '../known-defects';
import { STATES, type Theme } from '../states';
import { runAxe, type AxeViolation } from '../support/axe';
import { openState } from '../support/gallery';
import { axeDetails, axeScore, axeSummaryLine, openFailure, type AxeFinding } from './axe-score';
import { log, parseArgs, parseSize, printScore, stateList, type ScorerState } from './common';
import {
  floorFailure,
  loadFloorConfig,
  measureContent,
  staleFloorKeys,
  type FloorConfig,
} from './content-floor';
import { finish, runScorer } from './lifecycle';
import { assertStatesLocked } from './locked';
import { launchBrowser, startGalleryServer } from './server';

// Hill-climb scorer: axe-core on every state (or those matching --state), in both themes (or
// --theme). Usage: npx tsx tests/visual/scorers/axe.score.ts [--size 1440x900] [--state prefix]
// [--theme light|dark|both]. Prints {"score", "details"} as the last stdout line and exits 0.

const CONCURRENCY = 4;

interface Job {
  entry: ScorerState;
  theme: Theme;
}

async function scoreJob(
  browser: Browser,
  origin: string,
  size: string,
  job: Job,
  floor: FloorConfig,
): Promise<AxeFinding[]> {
  const { entry, theme } = job;
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
    let violations: AxeViolation[];
    try {
      await openState(page, entry.state, { theme });
      violations = await runAxe(page);
      const empty = floorFailure(entry.id, await measureContent(page), floor);
      if (empty) return [openFailure(entry.id, theme, empty)];
    } catch (error) {
      return [openFailure(entry.id, theme, firstLine(error))];
    }
    const known = axeKnownDefects[entry.id] ?? {};
    return violations.map(violation => ({
      state: entry.id,
      theme,
      rule: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.length,
      target: violation.nodes[0]?.target.join(' ') ?? '',
      known: violation.id in known,
    }));
  } finally {
    await context.close();
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] || 'failed to open';
}

async function runJobs(
  browser: Browser,
  origin: string,
  size: string,
  jobs: Job[],
  floor: FloorConfig,
): Promise<AxeFinding[]> {
  const findings: AxeFinding[][] = jobs.map(() => []);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < jobs.length; index = next++) {
      const job = jobs[index] as Job;
      try {
        findings[index] = await scoreJob(browser, origin, size, job, floor);
      } catch (error) {
        findings[index] = [openFailure(job.entry.id, job.theme, firstLine(error))];
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  return findings.flat();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertStatesLocked(STATES.map(state => state.id));
  const floor = loadFloorConfig();
  const stale = staleFloorKeys(
    floor,
    STATES.map(state => state.id),
  );
  if (stale.length > 0)
    throw new Error(`content-floor.json lists unknown states: ${stale.join(', ')}`);
  const entries = stateList(args.state);
  if (entries.length === 0) throw new Error(`no state id starts with "${args.state}"`);
  const jobs = entries.flatMap(entry => args.themes.map(theme => ({ entry, theme })));

  const server = await startGalleryServer();
  try {
    const browser = await launchBrowser();
    try {
      const started = Date.now();
      const findings = await runJobs(browser, server.origin, args.size, jobs, floor);
      log(`axe: ${jobs.length} pages, ${findings.length} findings, ${Date.now() - started} ms`);
      printScore(axeScore(findings, jobs.length), [
        axeSummaryLine(jobs.length, findings),
        ...axeDetails(findings),
      ]);
    } finally {
      await browser.close();
    }
  } finally {
    server.stop();
  }
  // The server's stderr pipe would keep Node alive a moment longer.
  await finish(0);
}

runScorer(main);
