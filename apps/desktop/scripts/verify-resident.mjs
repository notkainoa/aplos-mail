#!/usr/bin/env node
// Resident-mode check (host-2; plan 10 E1 item 4): the app keeps running with no window and a reminder still fires.
// Usage: node apps/desktop/scripts/verify-resident.mjs [path/to/Aplos Mail binary]
//   Launches the built app (apps/desktop/dist) or the given packaged binary headlessly: it execs the binary with
//   APLOS_TEST=1 and a fresh temp APLOS_DATA_DIR through Playwright's _electron.launch, never through `open`, so no
//   window is shown, no Dock icon appears and the real mailbox is never touched. Then it
//     1. waits for the first window and for the demo data,
//     2. schedules a reminder ~60 s ahead on a demo thread through the app's own preload API,
//     3. closes the only window and checks main is still running with no window,
//     4. waits for the recorded line `notification "Aplos Mail reminder"` (no window open),
//   prints one JSON line {"ok":true,"steps":[...]} and exits 0; otherwise {"ok":false,"failed":...} and exits 1.
//   Exit 2 means the build output is missing (run `npm run build -w @aplos/desktop`) or no Electron binary was found.
// Env: ELECTRON_BIN (Electron binary override). Nothing else from the environment reaches the app.
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const require = createRequire(import.meta.url);
const REMINDER_LEAD_MS = 60_000;
const NOTIFICATION_WAIT_MS = 150_000;
const steps = [];
const packaged = process.argv[2] ? resolve(process.argv[2]) : undefined;

// Set once the app has launched; `finish` ends it and removes the temporary data directory on every exit path.
const live = { app: undefined, dataDir: undefined };
const finish = (code, result) => {
  console.log(JSON.stringify(result));
  try {
    live.app?.process().kill('SIGKILL');
  } catch {
    // The app was already closed (the graceful-quit step), so there is no process to kill.
  }
  if (live.dataDir) rmSync(live.dataDir, { recursive: true, force: true });
  process.exit(code);
};
const fail = (step, detail) => finish(1, { ok: false, failed: step, detail, steps });
const pass = step => steps.push(step);

function findExecutable() {
  if (packaged) return existsSync(packaged) ? { executablePath: packaged, args: [] } : undefined;
  if (!existsSync(join(desktop, 'dist', 'main', 'electron.cjs'))) return 'missing-build';
  const candidates = [
    process.env.ELECTRON_BIN,
    join(desktop, 'node_modules', '.bin', 'electron'),
    join(desktop, '..', '..', 'node_modules', '.bin', 'electron'),
  ];
  for (const path of candidates)
    if (path && existsSync(path)) return { executablePath: path, args: [desktop] };
  try {
    return { executablePath: require('electron'), args: [desktop] };
  } catch {
    return undefined;
  }
}

const target = findExecutable();
if (target === 'missing-build')
  finish(2, {
    ok: false,
    failed: 'build',
    detail: 'apps/desktop/dist is missing: run npm run build -w @aplos/desktop',
    steps,
  });
if (!target)
  finish(2, {
    ok: false,
    failed: 'electron',
    detail: 'No Electron binary found (set ELECTRON_BIN).',
    steps,
  });

const { _electron } = await import('@playwright/test');
const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'aplos-resident-')));
live.dataDir = dataDir;
const lines = [];
const waiters = [];
function onOutput(chunk) {
  for (const line of String(chunk).split('\n')) {
    if (!line) continue;
    lines.push(line);
    for (const waiter of waiters) waiter(line);
  }
}
function waitForLine(pattern, ms) {
  return new Promise(resolveLine => {
    const hit = lines.find(line => pattern.test(line));
    if (hit) return resolveLine(hit);
    const timer = setTimeout(() => resolveLine(undefined), ms);
    waiters.push(line => {
      if (!pattern.test(line)) return;
      clearTimeout(timer);
      resolveLine(line);
    });
  });
}

async function run() {
  // Only what the app needs: no keys, no tokens, nothing from the caller's environment.
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '',
    APLOS_TEST: '1',
    APLOS_DATA_DIR: dataDir,
    // This suite drives the legacy engine (`state.get`), no longer the default: pinned until the legacy code goes.
    APLOS_ENGINE: 'legacy',
  };
  live.app = await _electron.launch({
    executablePath: target.executablePath,
    args: target.args,
    env,
  });
  live.app.process().stdout?.on('data', onOutput);
  live.app.process().stderr?.on('data', onOutput);
  const page = await live.app.firstWindow();
  pass('window opened');

  const state = await page.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const next = await window.aplos.invoke('state.get');
      if (next?.threads?.length)
        return {
          threads: next.threads.length,
          id: next.threads[0].id,
          notifications: next.settings.notifications,
        };
      await new Promise(done => setTimeout(done, 200));
    }
    return undefined;
  });
  if (!state) return fail('demo data', 'The demo mailbox never loaded.');
  if (!state.notifications)
    return fail('notifications', 'Notifications are off in the demo settings.');
  pass(`demo data: ${state.threads} threads`);

  const reminderAt = new Date(Date.now() + REMINDER_LEAD_MS).toISOString();
  await page.evaluate(
    ([id, at]) =>
      window.aplos.invoke('thread.update', {
        ids: [id],
        patch: { status: 'later', reminderAt: at },
      }),
    [state.id, reminderAt],
  );
  pass('reminder scheduled for +60 s');

  const pid = live.app.process().pid;
  await page.evaluate(() => window.close());
  const windowsLeft = await waitForNoWindows();
  if (windowsLeft !== 0) return fail('close window', `${windowsLeft} window(s) still open`);
  pass('only window closed');

  const alive = await live.app.evaluate(({ app: electron }) => ({
    ready: electron.isReady(),
    pid: process.pid,
  }));
  if (!alive.ready || alive.pid !== pid)
    return fail('main alive', 'main did not answer after the window closed');
  const dock = await live.app.evaluate(({ app: electron }) => electron.dock?.isVisible() ?? null);
  if (dock === true) return fail('accessory policy', 'The Dock icon is visible with no window.');
  pass(`main alive with no window (dock visible: ${dock})`);

  const hit = await waitForLine(/notification "Aplos Mail reminder"/, NOTIFICATION_WAIT_MS);
  if (!hit)
    return fail('reminder', 'No reminder notification within 150 s while no window was open.');
  pass('reminder fired with no window open');
  const stillNone = await live.app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
  );
  if (stillNone !== 0) return fail('no window shown', `${stillNone} window(s) appeared`);
  pass('no window appeared');
  // A graceful quit with no window open ends the process within the 3 s drain plus slack, and frees the data lock.
  if (!existsSync(join(dataDir, 'run', 'aplos.lock')))
    return fail('lock', 'run/aplos.lock was not taken while the app ran.');
  pass('run/aplos.lock held while running');
  const quitStart = Date.now();
  await cleanup();
  if (Date.now() - quitStart > 10_000) return fail('quit', 'The quit took longer than 10 s.');
  pass(`quit with no window in ${Date.now() - quitStart} ms`);
  if (existsSync(join(dataDir, 'run', 'aplos.lock')))
    return fail('lock', 'run/aplos.lock was left behind after a graceful quit.');
  pass('lock released on quit');
  finish(0, { ok: true, steps });
}

async function waitForNoWindows() {
  let count = -1;
  for (let i = 0; i < 100; i++) {
    count = await live.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    if (count === 0) break;
    await new Promise(done => setTimeout(done, 100));
  }
  return count;
}

async function cleanup() {
  try {
    await Promise.race([live.app?.close(), new Promise(done => setTimeout(done, 20_000))]);
  } catch {
    live.app?.process().kill('SIGKILL');
  }
}

try {
  await run();
} catch (error) {
  await cleanup();
  fail('error', error instanceof Error ? error.message.split('\n')[0] : String(error));
}
