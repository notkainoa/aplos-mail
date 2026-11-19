import { expect, test } from '@playwright/test';
import { launchAplos } from './support/electron';

// launchAplos() itself refuses to run unless APLOS_E2E_ELECTRON=1, so any other *.electron.spec.ts
// is safe too; this skip only turns the refusal into a visible "skipped".
// Turns on once F8 (APLOS_TEST / APLOS_DATA_DIR honoured in main/lifecycle.ts: isolated data,
// no single-instance lock, no Dock or menu-bar item, hidden windows) has landed. Without it the
// launch would open a real, visible window on a shared Mac.
test.skip(
  process.env.APLOS_E2E_ELECTRON !== '1',
  'Electron test mode (F8: APLOS_TEST / APLOS_DATA_DIR, hidden windows) has not landed; set APLOS_E2E_ELECTRON=1 once it has',
);

test('electron app starts hidden on an isolated data directory', async () => {
  const aplos = await launchAplos();
  try {
    const window = await aplos.app.firstWindow();
    await expect(window.locator('#root > *')).toBeAttached();
    await aplos.assertNoVisibleWindows();
  } finally {
    await aplos.cleanup();
  }
});
