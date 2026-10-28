// @ts-nocheck -- DRAFT. Remove this line once `tests/e2e/support/electron.ts` and `@playwright/test` are on this branch
// (they are on origin/revamp, PR plat-ci "e2e base"); the spec is written against that API and typechecked against it
// from a worktree that has it. Until then `tsc -p apps/desktop` cannot resolve them.
//
// Onboarding window chrome and startup, hidden (plan 30 U8 acceptance 5; DESIGN 7.11; Appendix C F3, F4).
// Skipped unless APLOS_E2E_ELECTRON=1. It needs the F8 test mode in main (windows created, never shown) and the
// eng-host patch in `src/main/windows/onboarding.patch.md`. Never launches a visible window: `launchAplos()` refuses
// otherwise, and every test ends with `assertNoVisibleWindows()`.
//
// Not picked up by `tests/e2e/playwright.config.ts` from this folder (its `testDir` is `tests/e2e`): REQUEST plat-ci
// to add this directory to the electron project, or to move the file to `tests/e2e/onboarding.electron.spec.ts`
// (then the import below becomes './support/electron').
import { expect, test } from '@playwright/test';
import { launchAplos, type AplosApp } from '../../../../tests/e2e/support/electron';

test.skip(
  process.env.APLOS_E2E_ELECTRON !== '1',
  'Electron test mode has not landed; set APLOS_E2E_ELECTRON=1 once F8 and the onboarding window patch have',
);

/** Every window's facts, read in main. Titles and bounds are what Electron reports, not what the renderer thinks. */
async function windowFacts(aplos: AplosApp) {
  return aplos.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map(win => ({
      url: win.webContents.getURL(),
      size: win.getSize(),
      contentSize: win.getContentSize(),
      min: win.getMinimumSize(),
      max: win.getMaximumSize(),
      resizable: win.isResizable(),
      maximizable: win.isMaximizable(),
      fullScreenable: win.isFullScreenable(),
      visible: win.isVisible(),
    })),
  );
}

const isOnboarding = (url: string) => new URL(url).searchParams.get('window') === 'onboarding';

test.describe('onboarding window (U8 acceptance 5)', () => {
  let aplos: AplosApp;
  test.beforeEach(async () => {
    // A fresh data directory has no account and no recorded setup: first run.
    aplos = await launchAplos();
    await aplos.app.firstWindow();
  });
  test.afterEach(async () => {
    await aplos.assertNoVisibleWindows();
    await aplos.cleanup();
  });

  test('a fresh install opens exactly one window, the onboarding window, and no mail window', async () => {
    const windows = await windowFacts(aplos);
    expect(windows).toHaveLength(1);
    expect(isOnboarding(windows[0]!.url)).toBe(true);
    expect(new URL(windows[0]!.url).searchParams.get('mode')).toBe('first');
  });

  test('640 x 600, minimum 640 x 520, width fixed, not maximizable or fullscreenable', async () => {
    const [win] = await windowFacts(aplos);
    expect(win!.size).toEqual([640, 600]);
    expect(win!.min).toEqual([640, 520]);
    expect(win!.max[0]).toBe(640);
    expect(win!.resizable).toBe(true);
    expect(win!.maximizable).toBe(false);
    expect(win!.fullScreenable).toBe(false);
  });

  test('resizes vertically only: the height follows, the width and the 520 minimum hold', async () => {
    const sizes = await aplos.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      const out: number[][] = [];
      win.setSize(900, 760);
      out.push(win.getSize());
      win.setSize(300, 200);
      out.push(win.getSize());
      return out;
    });
    expect(sizes[0]).toEqual([640, 760]);
    expect(sizes[1]).toEqual([640, 520]);
  });

  test('hidden-inset title bar: the content fills the whole window height (macOS)', async ({}, info) => {
    test.skip(process.platform !== 'darwin', 'hiddenInset is a macOS title bar style');
    const [win] = await windowFacts(aplos);
    // With a standard title bar the content height is the window height minus about 28 px.
    expect(win!.contentSize).toEqual(win!.size);
    info.annotations.push({ type: 'note', description: 'Electron has no getter for titleBarStyle; this is the observable effect.' });
  });

  test('a second launch and a Dock click focus the one window and never open another (F3)', async () => {
    await aplos.app.evaluate(({ app }) => {
      // Test mode takes no single-instance lock, so a second launch is simulated by the event it would raise.
      app.emit('second-instance', {}, ['aplos'], process.cwd());
      app.emit('second-instance', {}, ['aplos', 'mailto:someone@example.com'], process.cwd());
      app.emit('activate');
    });
    const windows = await windowFacts(aplos);
    expect(windows).toHaveLength(1);
    expect(isOnboarding(windows[0]!.url)).toBe(true);
  });

  test('handoff: the mail window is created only at finish, hidden, and the onboarding window then closes (F4)', async () => {
    expect(await windowFacts(aplos)).toHaveLength(1);
    const page = await aplos.app.firstWindow();
    // `Window/finishOnboarding` is a desktop method of the new contract; the bridge name is the eng-host lane's.
    await page.evaluate(() => (window as unknown as { aplos: { invoke(m: string, i: object): Promise<unknown> } }).aplos.invoke('Window/finishOnboarding', {}));
    await expect
      .poll(async () => (await windowFacts(aplos)).filter(w => !isOnboarding(w.url)).length, { timeout: 5_000 })
      .toBe(1);
    // In test mode the mail window is never shown, so at no moment is any window visible; the onboarding window
    // is gone within the fade (120 ms) plus the force-close (300 ms), with generous slack for a loaded machine.
    await expect
      .poll(async () => (await windowFacts(aplos)).filter(w => isOnboarding(w.url)).length, { timeout: 3_000 })
      .toBe(0);
    expect((await windowFacts(aplos)).every(w => !w.visible)).toBe(true);
  });
});
