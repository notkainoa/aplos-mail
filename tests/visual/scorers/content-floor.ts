import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The content floor of the axe scorer: a page that is nearly empty (blank, everything display:none
// or aria-hidden) has no violations, so it must not score 100. After the axe run the page is
// measured; one below the floor counts as a failed state, like one that did not open.

/** Fewest visible characters a page may show. */
export const MIN_TEXT = 12;
export const FLOOR_FILE = join(import.meta.dirname, 'content-floor.json');

export interface ContentStats {
  /** `document.body.innerText.trim().length`: display:none and visibility:hidden text is not in it. */
  text: number;
  /** Visible interactive elements outside an `aria-hidden` subtree. */
  interactive: number;
}

export interface FloorConfig {
  /** State id -> reason it may show less than MIN_TEXT characters. */
  exempt: Record<string, string>;
  /** State id -> fewest visible interactive elements; a state not listed needs none. */
  minInteractive: Record<string, number>;
}

const INTERACTIVE =
  'a, button, input, select, textarea, [tabindex], ' +
  '[role="button"], [role="option"], [role="menuitem"], [role="tab"], [role="link"], ' +
  '[role="checkbox"], [role="radio"]';

// A string, not a function: tsx would inject a `__name` helper into a serialised function.
const MEASURE = `(() => {
  const visible = el => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const interactive = [...document.querySelectorAll(${JSON.stringify(INTERACTIVE)})].filter(el => {
    if (el.hasAttribute('tabindex') && el.tabIndex < 0) return false;
    return visible(el) && !el.closest('[aria-hidden="true"]');
  });
  return { text: document.body.innerText.trim().length, interactive: interactive.length };
})()`;

/** Measures the open page. */
export async function measureContent(page: Page): Promise<ContentStats> {
  return page.evaluate<ContentStats>(MEASURE);
}

/** Why the page is below the floor, or null when it passes. Pure. */
export function floorFailure(
  stateId: string,
  stats: ContentStats,
  config: FloorConfig,
): string | null {
  const reasons: string[] = [];
  if (stats.text < MIN_TEXT && !(stateId in config.exempt))
    reasons.push(`${stats.text} visible characters, floor ${MIN_TEXT}`);
  const need = config.minInteractive[stateId] ?? 0;
  if (stats.interactive < need)
    reasons.push(`${stats.interactive} visible interactive elements, floor ${need}`);
  return reasons.length > 0 ? `content-floor: ${reasons.join('; ')}` : null;
}

function record<T>(value: unknown, name: string, ok: (entry: unknown) => entry is T) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`content-floor.json "${name}" must be an object`);
  const entries = Object.entries(value);
  if (!entries.every(([, entry]) => ok(entry)))
    throw new Error(`content-floor.json "${name}" has an entry of the wrong type`);
  return Object.fromEntries(entries) as Record<string, T>;
}

/** Validates the parsed JSON; throws on a wrong shape, a blank reason or a negative floor. */
export function parseFloorConfig(raw: unknown): FloorConfig {
  const parsed = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const exempt = record(
    parsed.exempt,
    'exempt',
    (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
  );
  const minInteractive = record(
    parsed.minInteractive,
    'minInteractive',
    (entry): entry is number => Number.isInteger(entry) && (entry as number) >= 0,
  );
  return { exempt, minInteractive };
}

export function loadFloorConfig(file = FLOOR_FILE): FloorConfig {
  return parseFloorConfig(JSON.parse(readFileSync(file, 'utf8')));
}

/** Keys of either map that are not state ids. */
export function staleFloorKeys(config: FloorConfig, ids: readonly string[]): string[] {
  const known = new Set(ids);
  return [...Object.keys(config.exempt), ...Object.keys(config.minInteractive)].filter(
    key => !known.has(key),
  );
}
