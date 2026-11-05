import { expect, test, type Page } from '@playwright/test';
import { STATES } from './states';
import { openState } from './support/gallery';

// The status family under reduced motion. The indeterminate runner is static (DESIGN 4.8 `status`, Reduced column):
// it rests as a centred 30 % bar inside its track with no animation. The Spinner glyph KEEPS turning (DESIGN 11.5:
// "spinners stay"). Read together (DESIGN 11.5 says so explicitly): 4.8 for the runner, 11.5 for the Spinner. With no
// preference the normal loops are unchanged. The gallery has no 'waiting' state, so the markup is injected into the
// first-sync state, which already loads the status stylesheet.

const state = STATES.find(s => s.id === 'progress-first-sync');
if (!state) throw new Error('progress-first-sync state is missing');

interface Poses {
  track: { left: number; right: number };
  runner: { left: number; right: number; width: number; animation: string };
  glyph: { animation: string; playState: string };
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
      },
    };
  });
}

test.describe('status reduced motion', () => {
  test.describe('reduce', () => {
    test.use({ reducedMotion: 'reduce' });

    test('the runner rests inside its track (4.8) and the spinner keeps turning (11.5)', async ({
      page,
    }) => {
      await openState(page, state);
      const p = await poses(page);
      expect(p.runner.animation).toBe('none');
      expect(p.runner.width).toBeGreaterThan(0);
      expect(p.runner.left).toBeGreaterThanOrEqual(p.track.left);
      expect(p.runner.right).toBeLessThanOrEqual(p.track.right);
      expect(p.runner.width).toBeLessThan((p.track.right - p.track.left) / 2);
      expect(p.glyph.animation).toBe('ui-spin');
      expect(p.glyph.playState).toBe('running');
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
