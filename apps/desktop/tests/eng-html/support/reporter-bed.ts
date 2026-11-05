import { _electron, type ElectronApplication, type Frame, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { frameHeaders } from '../../../../../packages/mail-html/src/frame/headers';
import { reporterHash } from '../../../../../packages/mail-html/src/frame/reporter';

// A bed for the frame's real reporter in the app's own Chromium: a hidden Electron window (show:false, no Dock
// item, temp user data, ELECTRON_RUN_AS_NODE removed, loopback only) with a host page that mounts the document in
// `<iframe sandbox="allow-scripts allow-popups">` the way the reader does, receives what the reporter posts, and can
// follow it (sizing the frame to each reported height, as the host does). The document is served at `/<token>/` so
// the reporter finds its token in its own path, with the engine's headers or none.

const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const mainFile = join(import.meta.dirname, 'harness-main.cjs');
const WIDTH = 600;
/** A host that follows the reporter stops following after this many reports (a letter that grows for ever). */
export const FOLLOW_CAP = 300;

export interface Report {
  token: unknown;
  h: number;
  w: number;
  bg: string;
  ready: boolean;
  marks: number;
}

export interface OpenOptions {
  /** The frame's document: the sanitizer's output plus the reporter, or any raw document. */
  document: string;
  /** Serve the engine's headers (CSP with the reporter's hash) or nothing. Default: the engine's. */
  headers?: 'engine' | 'none';
  /** The frame's height before the first report. */
  height?: number;
  /** Size the frame to every reported height, as the reader does. Default: yes. */
  follow?: boolean;
  /** Space above the frame in px: the frame sits below the host window's fold, off screen, with no scrolling. */
  below?: number;
}

export interface Opened {
  token: string;
  page: Page;
  frame: Frame;
  /** Every message the host received from the frame's window, in order. */
  reports: () => Promise<Report[]>;
  /** The frame element's current height in px. */
  frameHeight: () => Promise<number>;
  /** True once the host stopped following a runaway letter. */
  capped: () => Promise<boolean>;
  /** Waits for the number of reports to stop changing (or for `ms`), then returns them. */
  settled: (ms?: number) => Promise<Report[]>;
}

export interface Bed {
  open: (options: OpenOptions) => Promise<Opened>;
  dispose: () => Promise<void>;
}

function environment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  }
  for (const key of ['GROQ_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'])
    env[key] = '';
  return { ...env, APLOS_TEST: '1', TZ: 'UTC', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
}

function hostPage(
  token: string,
  options: Required<Pick<OpenOptions, 'height' | 'follow' | 'below'>>,
): string {
  return `<!doctype html><meta charset="utf-8"><title>host</title>
<body style="margin:0"><div style="height:${options.below}px"></div><iframe id="f" sandbox="allow-scripts allow-popups" src="/${token}/"
  style="border:0;display:block;width:${WIDTH}px;height:${options.height}px"></iframe>
<script>
window.reports = [];
window.capped = false;
addEventListener('message', function (e) {
  var f = document.getElementById('f');
  if (e.source !== f.contentWindow) return;
  window.reports.push(e.data);
  if (${options.follow} && !window.capped && typeof e.data.h === 'number') {
    f.style.height = e.data.h + 'px';
    if (window.reports.length >= ${FOLLOW_CAP}) window.capped = true;
  }
});
</script>`;
}

export async function launchBed(): Promise<Bed> {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-reporter-'));
  const hash = await reporterHash();
  const pages = new Map<string, { document: string; headers: 'engine' | 'none'; host: string }>();
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    const match = /^\/(host\/)?([0-9a-f]{32})\/?$/.exec(path);
    const entry = match ? pages.get(match[2]) : undefined;
    if (!match || !entry) return void response.writeHead(404).end();
    if (match[1]) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(entry.host);
      return;
    }
    const base: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
    const headers = entry.headers === 'engine' ? { ...frameHeaders(hash), ...base } : base;
    response.writeHead(200, headers).end(entry.document);
  });
  await new Promise<void>(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const app: ElectronApplication = await _electron.launch({
    args: [mainFile, `--user-data-dir=${join(dir, 'user-data')}`, '--no-proxy-server'],
    cwd: repoRoot,
    env: environment(),
    timeout: 30_000,
  });
  let windows = 0;

  async function newPage(): Promise<Page> {
    const mark = `r${(windows += 1)}`;
    await app.evaluate(async ({ BrowserWindow }, tag) => {
      const window = new BrowserWindow({
        show: false,
        width: 900,
        height: 900,
        webPreferences: { backgroundThrottling: false },
      });
      await window.loadURL(`about:blank#${tag}`);
    }, mark);
    for (let attempt = 0; attempt < 500; attempt++) {
      const page = app.windows().find(candidate => candidate.url().endsWith(`#${mark}`));
      if (page) return page;
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    throw new Error(`no page for window ${mark}`);
  }

  async function open(options: OpenOptions): Promise<Opened> {
    const token = randomBytes(16).toString('hex');
    const host = hostPage(token, {
      height: options.height ?? 100,
      follow: options.follow ?? true,
      below: options.below ?? 0,
    });
    pages.set(token, { document: options.document, headers: options.headers ?? 'engine', host });
    const page = await newPage();
    await page.goto(`${origin}/host/${token}`, { waitUntil: 'load' });
    const frame = page.frames().find(candidate => candidate.url().includes(`/${token}/`));
    if (!frame) throw new Error('the frame did not mount');
    const reports = () => page.evaluate('window.reports') as Promise<Report[]>;
    const settled = async (ms = 4_000) => {
      let last = -1;
      let quiet = 0;
      for (let waited = 0; waited < ms && quiet < 400; waited += 100) {
        await page.waitForTimeout(100);
        const count = (await reports()).length;
        quiet = count === last && count > 0 ? quiet + 100 : 0;
        last = count;
      }
      return reports();
    };
    return {
      token,
      page,
      frame,
      reports,
      settled,
      frameHeight: () =>
        page.evaluate("document.getElementById('f').offsetHeight") as Promise<number>,
      capped: () => page.evaluate('window.capped') as Promise<boolean>,
    };
  }

  return {
    open,
    async dispose() {
      await app.close().catch(() => undefined);
      await new Promise<void>(resolveClose => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      });
      await rm(dir, { recursive: true, force: true });
    },
  };
}
