import { expect, type Page } from '@playwright/test';
import { FROZEN_NOW, galleryUrl, type Theme, type VisualState } from '../states';

export interface OpenOptions {
  theme?: Theme;
  /** Increase Contrast (`data-contrast="more"`). */
  contrast?: boolean;
}

/**
 * Opens a state with the clock frozen at 2026-10-29T10:00 (Los Angeles), waits until the gallery
 * reports that fonts are in and the tree is laid out, and fails on an unknown state.
 * `Date` is fixed and timers keep running, so tooltips and toasts still schedule normally.
 */
export async function openState(
  page: Page,
  state: VisualState,
  { theme = 'light', contrast = false }: OpenOptions = {},
): Promise<void> {
  await page.clock.setFixedTime(new Date(FROZEN_NOW));
  // The config pins the light scheme. The shell follows the system appearance (#450), so a dark run needs the
  // media query to say dark too, or every full-shell scene draws light under `?theme=dark`.
  await page.emulateMedia({ colorScheme: theme });
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto(galleryUrl(state, theme, contrast));
  await page.waitForFunction(() => window.__galleryReady === true || window.__galleryError);
  const error = await page.evaluate(() => window.__galleryError);
  expect(error, `gallery state ${state.id}`).toBeUndefined();
  expect(failures, `page errors in ${state.id}`).toEqual([]);
}

declare global {
  interface Window {
    __galleryReady?: boolean;
    __galleryError?: string;
  }
}
