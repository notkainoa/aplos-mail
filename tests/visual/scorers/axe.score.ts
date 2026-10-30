import { chromium, type Browser } from '@playwright/test';
import { axeKnownDefects } from '../known-defects';
import type { Theme } from '../states';
import { runAxe } from '../support/axe';
import { openState } from '../support/gallery';
import { axeDetails, axeScore, type AxeFinding } from './axe-score';
import { log, parseArgs, parseSize, printScore, stateList, type ScorerState } from './common';
import { startGalleryServer } from './server';

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
    try {
      await openState(page, entry.state, { theme });
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
      return [openFailure(entry.id, theme, message ?? 'failed to open')];
    }
    const known = axeKnownDefects[entry.id] ?? {};
    const violations = await runAxe(page);
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

function openFailure(state: string, theme: string, message: string): AxeFinding {
  return {
    state,
    theme,
    rule: 'state-failed-to-open',
    impact: 'critical',
    nodes: 1,
    target: message,
    known: false,
  };
}

async function runJobs(
  browser: Browser,
  origin: string,
  size: string,
  jobs: Job[],
): Promise<AxeFinding[]> {
  const findings: AxeFinding[][] = jobs.map(() => []);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < jobs.length; index = next++)
      findings[index] = await scoreJob(browser, origin, size, jobs[index] as Job);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  return findings.flat();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const entries = stateList(args.state);
  if (entries.length === 0) throw new Error(`no state id starts with "${args.state}"`);
  const jobs = entries.flatMap(entry => args.themes.map(theme => ({ entry, theme })));

  const server = await startGalleryServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const started = Date.now();
    const findings = await runJobs(browser, server.origin, args.size, jobs);
    log(`axe: ${jobs.length} pages, ${findings.length} findings, ${Date.now() - started} ms`);
    printScore(axeScore(findings), axeDetails(findings));
  } finally {
    await browser.close();
    server.stop();
  }
  // The server's stderr pipe would keep Node alive a moment longer.
  process.exit(0);
}

main().catch(error => {
  log(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
