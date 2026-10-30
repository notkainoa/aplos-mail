import type { Browser, BrowserContext, Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FROZEN_NOW, type Theme } from '../states';
import { repoRoot } from '../support/paths';
import { parseSize, type ScorerState } from './common';
import {
  MOCKUP_OVERRIDES,
  parseMockup,
  resolveMockupState,
  type Region,
} from './mockup-diff-score';

// How a mockup page is found and shot, shared by the visual-diff and the taste scorers so both
// see the same reference: same override table, same frozen clock, same quiet CSS.

export const MOCKUPS = join(repoRoot, 'mockups');
export const EXCLUDE_FILE = join(import.meta.dirname, 'mockup-diff.exclude.json');
export const QUIET_CSS =
  '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' +
  '.mockbar,.tooltip{display:none!important}';

export interface MockupTarget {
  url: string;
  label: string;
  file: string;
  /** The page's `?state=` value, '' for a page without states. */
  state: string;
}

export function listedStates(file: string): string[] {
  const html = readFileSync(join(MOCKUPS, file), 'utf8');
  const match = /<html[^>]*data-states="([^"]*)"/.exec(html);
  return (match?.[1] ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

/** The file URL of the mockup for a state at a theme, or the reason it cannot be resolved. */
export function mockupTarget(entry: ScorerState, theme: Theme): MockupTarget | string {
  const parsed = parseMockup(MOCKUP_OVERRIDES[entry.id] ?? entry.mockup);
  if (!parsed) return `no mockup page in "${entry.mockup}"`;
  if (!existsSync(join(MOCKUPS, parsed.file))) return `mockups/${parsed.file} does not exist`;
  const state = resolveMockupState(parsed.label, listedStates(parsed.file));
  if (state === null) return `mockups/${parsed.file} has no state "${parsed.label}"`;
  const query = new URLSearchParams({ shot: '1', theme });
  if (state) query.set('state', state);
  return {
    url: `file://${join(MOCKUPS, parsed.file)}?${query.toString()}`,
    label: parsed.label,
    file: parsed.file,
    state,
  };
}

/** True when the state is compared as a pane (the mockup's `.main`), false for a whole window. */
export function isPaneState(entry: ScorerState): boolean {
  return (entry.state.frame ?? 'pane') === 'pane';
}

/** A context for shooting a mockup page: same viewport, locale, zone and motion setting as the app shots. */
export async function newMockupContext(
  browser: Browser,
  size: string,
  theme: Theme,
): Promise<BrowserContext> {
  return browser.newContext({
    viewport: parseSize(size),
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    colorScheme: theme,
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  });
}

/** The mockup's white pane (`.main`) for a pane state, otherwise its whole window. */
export async function shootMockup(
  page: Page,
  url: string,
  pane: boolean,
): Promise<{ png: Buffer; region: Region }> {
  await page.clock.setFixedTime(new Date(FROZEN_NOW));
  await page.goto(url);
  await page.addStyleTag({ content: QUIET_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const region = await page.evaluate((wantPane: boolean) => {
    const element =
      (wantPane && document.querySelector('.main')) || document.querySelector('.window');
    const r = (element ?? document.body).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, pane);
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  return { png, region };
}

/** The exclude file: state id to the reason its mockup is not comparable. */
export function loadExcluded(file = EXCLUDE_FILE): Record<string, string> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
}

/** Exclude entries naming a state that no longer exists in states.ts: a stale file fails the run. */
export function staleExcludes(
  excluded: Readonly<Record<string, string>>,
  knownIds: Iterable<string>,
): string[] {
  const known = new Set(knownIds);
  return Object.keys(excluded).filter(id => !known.has(id));
}
