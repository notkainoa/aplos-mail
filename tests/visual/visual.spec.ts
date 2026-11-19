import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { STATES, THEMES, type Theme, type VisualState } from './states';
import { CHANGED_RATIO_LIMIT, DELTA_E_LIMIT, comparePngs } from './support/compare';
import { openState } from './support/gallery';
import { visualDir } from './support/paths';

// Screenshot compare (DESIGN 12.5, plan 30 6.2). Every state is shot in light and dark. A fail is more
// than 0.1 % of pixels with CIEDE2000 above 2.
//  - Golden states (1440x900 only) are compared with the committed images in __golden__.
//  - All others are compared with a base run on the same machine: set VISUAL_BASE_DIR to the
//    VISUAL_CAPTURE_DIR of a run made at the base ref. Without it they are only captured.

const goldenDir = resolve(import.meta.dirname, '__golden__');
const GOLDEN_VIEWPORT = '1440x900';
const captureDir = process.env.VISUAL_CAPTURE_DIR
  ? resolve(process.env.VISUAL_CAPTURE_DIR)
  : join(visualDir, 'shots');
const baseDir = process.env.VISUAL_BASE_DIR ? resolve(process.env.VISUAL_BASE_DIR) : null;

interface Variant {
  theme: Theme;
  contrast: boolean;
  name: string;
}

function variantsOf(state: VisualState): Variant[] {
  const variants: Variant[] = THEMES.map(theme => ({ theme, contrast: false, name: theme }));
  if (state.contrastMore)
    for (const theme of THEMES)
      variants.push({ theme, contrast: true, name: `${theme}-contrast-more` });
  return variants;
}

function save(file: string, data: Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
}

test.describe('visual', () => {
  for (const state of STATES) {
    for (const variant of variantsOf(state)) {
      test(`${state.id} ${variant.name}`, async ({ page, context }, testInfo) => {
        const project = testInfo.project.name;
        await openState(page, state, variant);
        const shot = await page.screenshot({ animations: 'disabled', caret: 'hide' });
        const file = `${state.id}.${variant.name}.png`;
        save(join(captureDir, project, file), shot);

        const golden = state.golden && project === GOLDEN_VIEWPORT && !variant.contrast;
        const expectedFile = golden
          ? join(goldenDir, project, file)
          : baseDir
            ? join(baseDir, project, file)
            : null;
        if (!expectedFile) {
          testInfo.annotations.push({ type: 'capture', description: 'no base to compare with' });
          return;
        }

        const mode = testInfo.config.updateSnapshots;
        if (golden && (mode === 'all' || mode === 'changed')) {
          const reason = process.env.VISUAL_UPDATE_REASON?.trim();
          if (!reason)
            throw new Error(
              'Updating golden images needs a written reason: set VISUAL_UPDATE_REASON="..." and put it in the commit message.',
            );
          save(expectedFile, shot);
          testInfo.annotations.push({ type: 'golden-updated', description: reason });
          return;
        }
        if (!existsSync(expectedFile)) {
          if (golden) save(expectedFile, shot);
          throw new Error(
            golden
              ? `No golden image for ${project}/${file}; the new one was written. Review it, then commit it with a reason.`
              : `No base image at ${expectedFile}`,
          );
        }

        const scratch = await context.newPage();
        const result = await comparePngs(scratch, shot, readFileSync(expectedFile));
        await scratch.close();
        if (result.overlay) {
          const overlayPath = testInfo.outputPath(`${state.id}.${variant.name}.diff.png`);
          save(overlayPath, Buffer.from(result.overlay, 'base64'));
          if (result.ratio > CHANGED_RATIO_LIMIT)
            await testInfo.attach('diff overlay', { path: overlayPath, contentType: 'image/png' });
        }
        expect(
          result.ratio,
          `${project}/${file}: ${result.changed} pixels (${(result.ratio * 100).toFixed(3)} %) differ by more than ΔE ${DELTA_E_LIMIT}; ` +
            `largest ΔE ${result.maxDeltaE.toFixed(1)}; ` +
            `size ${result.width}x${result.height} against ${result.expectedWidth}x${result.expectedHeight}`,
        ).toBeLessThanOrEqual(CHANGED_RATIO_LIMIT);
      });
    }
  }

  // Positive control: the same page compares clean, and a planted change over 0.1 % of the pixels fails.
  test('the comparison sees a planted change and ignores none', async ({ page, context }) => {
    const state = STATES.find(candidate => candidate.id === 'list-rows')!;
    await openState(page, state);
    const before = await page.screenshot({ animations: 'disabled', caret: 'hide' });
    const scratch = await context.newPage();
    const same = await comparePngs(scratch, before, before);
    expect(same.changed).toBe(0);

    await page.addStyleTag({ content: '.ui-list-row { background: var(--stamp-tint); }' });
    const after = await page.screenshot({ animations: 'disabled', caret: 'hide' });
    const different = await comparePngs(scratch, after, before);
    expect(different.ratio).toBeGreaterThan(CHANGED_RATIO_LIMIT);
    expect(different.maxDeltaE).toBeGreaterThan(DELTA_E_LIMIT);
    expect(different.overlay).not.toBeNull();
  });
});
