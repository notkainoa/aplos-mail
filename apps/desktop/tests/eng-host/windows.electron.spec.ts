import { expect, test } from '@playwright/test';
import { launchAplos } from '../../../../tests/e2e/support/electron';

// Hidden-Electron smoke for host-1: the real BrowserWindow wiring behind the window controller that windows.test.ts
// covers with fakes. Needs a build (`npm run build`) and APLOS_E2E_ELECTRON=1; launchAplos refuses to run otherwise.
test.skip(process.env.APLOS_E2E_ELECTRON !== '1', 'set APLOS_E2E_ELECTRON=1 (needs a build)');

test('startup opens exactly one hidden window and test hooks are exposed', async () => {
  const aplos = await launchAplos({ env: { APLOS_ONBOARDING_WINDOW: '0' } });
  try {
    const window = await aplos.app.firstWindow();
    await expect(window.locator('#root > *')).toBeAttached();
    expect(
      await aplos.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    ).toBe(1);
    await aplos.assertNoVisibleWindows();
    const hooks = await aplos.app.evaluate(() => {
      const hook = (
        globalThis as { aplosTest?: { notifications: unknown[]; externalLinks: unknown[] } }
      ).aplosTest;
      return hook && { notifications: hook.notifications.length, links: hook.externalLinks.length };
    });
    expect(hooks).toEqual({ notifications: 0, links: 0 });
  } finally {
    await aplos.cleanup();
  }
});

test('window.open is denied: no second window opens and none is visible', async () => {
  const aplos = await launchAplos({ env: { APLOS_ONBOARDING_WINDOW: '0' } });
  try {
    const page = await aplos.app.firstWindow();
    await expect(page.locator('#root > *')).toBeAttached();
    await page.evaluate(() => {
      window.open('https://docs.example/page');
      window.open('mailto:someone@docs.example');
    });
    await page.waitForTimeout(500);
    expect(
      await aplos.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    ).toBe(1);
    await aplos.assertNoVisibleWindows();
  } finally {
    await aplos.cleanup();
  }
});

test('first run opens exactly one window: the welcome window (on by default), and it is hidden', async () => {
  const aplos = await launchAplos();
  try {
    const window = await aplos.app.firstWindow();
    await expect(window.locator('body')).toBeAttached();
    const count = await aplos.app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    );
    expect(count).toBe(1);
    await aplos.assertNoVisibleWindows();
  } finally {
    await aplos.cleanup();
  }
});

test('R2H-5: a renderer permission request and an openExternal call reach no system prompt or browser', async () => {
  const aplos = await launchAplos({ env: { APLOS_ONBOARDING_WINDOW: '0' } });
  try {
    const window = await aplos.app.firstWindow();
    await expect(window.locator('#root > *')).toBeAttached();
    const outcome = await aplos.app.evaluate(async ({ shell, systemPreferences }) => {
      await shell.openExternal('https://accounts.example/o/oauth2?state=probe');
      return {
        mic: await systemPreferences.askForMediaAccess('microphone'),
        links: (globalThis as { aplosTest?: { externalLinks: string[] } }).aplosTest?.externalLinks
          .length,
      };
    });
    expect(outcome).toEqual({ mic: false, links: 1 });
  } finally {
    await aplos.cleanup();
  }
});
