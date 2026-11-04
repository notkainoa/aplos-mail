import { expect, test, type Page } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// The status family's reduced-motion resting poses (DESIGN 4.8 `status`: static). Under prefers-reduced-motion the
// indeterminate runner rests inside its track and the spinner glyph rests upright, both with no animation; with no
// preference the normal loops are unchanged. The gallery has no 'waiting' state, so the markup is injected into the
// first-sync state, which already loads the status stylesheet.

const state = STATES.find(s => s.id === 'progress-first-sync');
if (!state) throw new Error('progress-first-sync state is missing');

interface Poses {
  track: { left: number; right: number };
  runner: { left: number; right: number; width: number; animation: string };
  glyph: { animation: string; playState: string; transform: string };
}

async function poses(page: Page): Promise<Poses> {
  return page.evaluate(() => {
    const host = document.createElement('div');
    host.innerHTML =
      '<div class="ui-progress-segments" data-variant="waiting" style="width:300px">' +
      '<div class="ui-progress-segments__track"><i class="ui-progress-segments__runner"></i></div></div>' +
      '<span class="ui-spinner" data-state="shown"><svg class="ui-spinner__glyph" viewBox="0 0 24 24"></svg></span>';
    document.body.append(host);
    const rect = (selector: string) => {
      const box = host.querySelector(selector)?.getBoundingClientRect();
      if (!box) throw new Error(`missing ${selector}`);
      return box;
    };
    const style = (selector: string) => {
      const el = host.querySelector(selector);
      if (!el) throw new Error(`missing ${selector}`);
      return getComputedStyle(el);
    };
    const track = rect('.ui-progress-segments__track');
    const runner = rect('.ui-progress-segments__runner');
    const glyph = style('.ui-spinner__glyph');
    return {
      track: { left: track.left, right: track.right },
      runner: {
        left: runner.left,
        right: runner.right,
        width: runner.width,
        animation: style('.ui-progress-segments__runner').animationName,
      },
      glyph: {
        animation: glyph.animationName,
        playState: glyph.animationPlayState,
        transform: glyph.transform,
      },
    };
  });
}

test.describe('status reduced motion', () => {
  test.describe('reduce', () => {
    test.use({ reducedMotion: 'reduce' });

    test('the runner rests inside its track and the spinner rests upright', async ({ page }) => {
      await openState(page, state);
      const p = await poses(page);
      expect(p.runner.animation).toBe('none');
      expect(p.runner.width).toBeGreaterThan(0);
      expect(p.runner.left).toBeGreaterThanOrEqual(p.track.left);
      expect(p.runner.right).toBeLessThanOrEqual(p.track.right);
      expect(p.runner.width).toBeLessThan((p.track.right - p.track.left) / 2);
      expect(p.glyph.playState).toBe('paused');
      expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(p.glyph.transform);
    });
  });

  test.describe('no preference', () => {
    test.use({ reducedMotion: 'no-preference' });

    test('the loops are unchanged', async ({ page }) => {
      await openState(page, state);
      const p = await poses(page);
      expect(p.runner.animation).toBe('ui-status-run');
      expect(p.glyph.animation).toBe('ui-spin');
      expect(p.glyph.playState).toBe('running');
    });
  });
});
