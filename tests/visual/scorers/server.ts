import { chromium, type Browser } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { repoRoot } from '../support/paths';
import { log } from './common';
import { explicitPort, scorerEnv, VITE_NAMES } from './env';
import { killGroup, onShutdown } from './lifecycle';

// Starts the harness's Vite gallery on a free port, as playwright.config.ts does (same command), and
// stops it again. Vite and Chromium get an allow-listed environment only (env.ts), never process.env.
// An explicit APLOS_VISUAL_PORT that already answers is reused, unless SCORER_ISOLATED is set (the
// hill-climb harness): then the port is ignored and the scorer always starts its own server, because
// whatever answers on 127.0.0.1 may be another worktree's code. The default port 4427 is never reused.

export interface GalleryServer {
  origin: string;
  stop: () => void;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

const PAGE = '/tests/visual/gallery/index.html';

async function waitUntilUp(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vite exited with code ${child.exitCode}`);
    if (await answers(url)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`gallery server did not answer at ${url} within ${timeoutMs} ms`);
}

export async function startGalleryServer(): Promise<GalleryServer> {
  const explicit = explicitPort(process.env);
  if (explicit && (await answers(`http://127.0.0.1:${explicit}${PAGE}`)))
    return { origin: `http://127.0.0.1:${explicit}`, stop: () => undefined };

  const port = explicit || (await freePort());
  const origin = `http://127.0.0.1:${port}`;
  const args = ['vite', '--config', 'tests/visual/vite.config.ts', '--port', String(port)];
  const child = spawn('npx', [...args, '--strictPort', '--host', '127.0.0.1'], {
    cwd: repoRoot,
    // Its own process group, so npx and the vite under it stop together.
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: scorerEnv(process.env, {
      names: VITE_NAMES,
      claude: false,
      set: { APLOS_VISUAL_PORT: String(port) },
    }),
  });
  child.stderr?.on('data', chunk => log(String(chunk).trimEnd()));
  const stop = (): void => {
    killGroup(child.pid, 'SIGTERM');
  };
  // Last resort on any way out of this process: nothing in the group may outlive the scorer.
  process.once('exit', () => killGroup(child.pid, 'SIGKILL'));
  const forget = onShutdown(stop);
  try {
    await waitUntilUp(`${origin}${PAGE}`, child, 120_000);
  } catch (error) {
    stop();
    forget();
    throw error;
  }
  log(`gallery server on ${origin}`);
  return {
    origin,
    stop: () => {
      stop();
      forget();
    },
  };
}

/** Headless Chromium that closes on a signal too (Playwright's own signal handlers are off). */
export async function launchBrowser(): Promise<Browser> {
  const browser = await chromium.launch({
    headless: true,
    // Chromium gets the same allow-list, not the scorer's whole environment.
    env: scorerEnv(process.env, { claude: false }),
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  onShutdown(() => browser.close());
  return browser;
}
