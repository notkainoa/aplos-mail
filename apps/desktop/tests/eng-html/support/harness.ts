import { _electron, type ElectronApplication, type Frame, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { MailHtmlResult } from '@aplos/engine/ports/content';
import type { CorpusEntry } from '../../../../../packages/mail-html/corpus/index';
import { mailHtml } from '../../../../../packages/mail-html/src/index';
import { hostResolverRules, scanNetLog, type Canary, type NetLogHit } from '../canary';
import { startFrameServer, type FrameServer } from './frame-server';
import { injectReporter, type ProbeReport } from './probe-reporter';

// Drives a hidden Electron (the app's own Chromium) over every corpus message, sanitized, served into a sandboxed
// iframe by a local stand-in for the `aplos-mail://` relay. See ../leak.e2e.ts for how to run it.

/** One message must finish (open, load, interact, report) within this, or it is recorded as an error and abandoned. */
const LOAD_DEADLINE_MS = 25_000;

const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const mainFile = join(import.meta.dirname, 'harness-main.cjs');

export interface Condition {
  name: string;
  /**
   * How long the pointer rests on each of the first links. Chromium starts a preconnect to a link's host only after a
   * short dwell, so the pass that looks for it (once per message) rests; the others sweep.
   */
  dwellMs: number;
  /** Serve the engine's headers (true) or a bare document with no policy (false): the sanitizer alone. */
  csp: boolean;
  /** `allow` rewrites listed remote images to `img/<n>`; `block` leaves none. */
  images: boolean;
}

export const CONDITIONS: readonly Condition[] = [
  { name: 'frame/images-off', dwellMs: 150, csp: true, images: false },
  { name: 'frame/images-on', dwellMs: 0, csp: true, images: true },
  { name: 'bare/images-off', dwellMs: 0, csp: false, images: false },
  { name: 'bare/images-on', dwellMs: 0, csp: false, images: true },
];

export interface LoadRecord {
  id: string;
  condition: string;
  token: string;
  contentsId: number;
  bodyKind: 'html' | 'text';
  remoteImages: number;
  cids: number;
  trackersRemoved: number;
  /** Every request the page (all frames) reported to Playwright. */
  requests: string[];
  report: ProbeReport | null;
  console: { type: string; text: string }[];
  popups: string[];
  /** The renderer crashed (a resource-exhaustion message can do that; it is not a leak). */
  crashed: boolean;
  dialogs: string[];
  navigations: string[];
  pageErrors: string[];
  error?: string;
  retried?: boolean;
  /** Not loaded: with images on the document equals the images-off one (no remote image to rewrite). */
  skipped?: boolean;
  /** Canary requests that arrived while this condition ran and name this message. */
  canaryHits: number;
  /** Where the time went, for tuning the run. */
  ms: { open: number; load: number; interact: number };
}

interface LoadSpec {
  id: string;
  /** Wait this long after load instead of the usual settle time (controls: Chromium's link hints come late). */
  holdMs?: number;
  deadlineMs?: number;
  hostHtml?: string;
  dwellMs: number;
  condition: string;
  html: string | undefined;
  csp: boolean;
  remoteImages: number;
  cids: number;
  trackersRemoved: number;
}

export interface Harness {
  app: ElectronApplication;
  frames: FrameServer;
  /** The `webRequest` records, popups and navigations the harness's main process saw. */
  mainLog: () => Promise<{
    requests: { contents: number; url: string; method: string; resourceType: string }[];
    popups: { opener: number; url: string }[];
    navigations: { contents: number; url: string; isMainFrame: boolean }[];
  }>;
  run: (entry: CorpusEntry, condition: Condition, forgiving?: boolean) => Promise<LoadRecord>;
  /** Positive controls: loads a document as given (no sanitizer, no policy). */
  runRaw: (id: string, html: string, hostHtml?: string) => Promise<LoadRecord>;
  /** Quits Electron (which finalizes the net log), then reads the log and lists every event naming a canary. */
  finish: () => Promise<NetLogHit[]>;
  /** Quits Electron and removes the temp directories without reading the log. */
  dispose: () => Promise<void>;
}

export interface HarnessOptions {
  /** Every message and control that owns a canary host. */
  entries: readonly { id: string }[];
  canary: Canary;
  /** Extra Chromium switches (the mitigation under test, or none for the positive control). */
  switches?: string[];
  /** Milliseconds to let a page settle after load and after the scripted interaction. */
  settleMs?: number;
}

function safeEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  }
  // Blank, not removed: a repo .env must never reach this process, and no key is needed.
  for (const key of ['GROQ_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'])
    env[key] = '';
  return { ...env, APLOS_TEST: '1', TZ: 'UTC', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
}

function renderEntry(entry: CorpusEntry, condition: Condition): MailHtmlResult {
  return mailHtml.render({
    html: entry.html,
    text: entry.text,
    cids: entry.cids,
    imagePolicy: condition.images ? 'allow' : 'block',
    findQuery: entry.findQuery,
  });
}

export async function launchHarness(options: HarnessOptions): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-leak-'));
  const netLog = join(dir, 'net-log.json');
  const frames = await startFrameServer();
  const app = await _electron.launch({
    args: [
      mainFile,
      `--user-data-dir=${join(dir, 'user-data')}`,
      `--host-resolver-rules=${hostResolverRules(options.entries, options.canary.port)}`,
      `--log-net-log=${netLog}`,
      '--no-proxy-server',
      ...(options.switches ?? []),
    ],
    cwd: repoRoot,
    env: safeEnvironment(),
    timeout: 30_000,
  });
  const settle = options.settleMs ?? 100;
  let closed = false;
  let windowCount = 0;

  /** A fresh hidden window per message. Its page is found by a unique `#mark` in its blank URL, so opens can overlap. */
  async function openWindow(): Promise<{ page: Page; contentsId: number }> {
    const mark = `w${(windowCount += 1)}`;
    const contentsId = await app.evaluate(
      async ({ BrowserWindow }, { tag, size }) => {
        const window = new BrowserWindow({
          show: false,
          useContentSize: true,
          enableLargerThanScreen: true,
          width: size.width,
          height: size.height,
          webPreferences: { backgroundThrottling: false },
        });
        await window.loadURL(`about:blank#${tag}`);
        return window.webContents.id;
      },
      { tag: mark, size: VIEW },
    );
    for (let attempt = 0; attempt < 500; attempt++) {
      const page = app.windows().find(candidate => candidate.url().endsWith(`#${mark}`));
      if (page) return { page, contentsId };
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`no page for window ${mark}`);
  }

  /** Loads one document into a sandboxed frame and records everything that happened around it. */
  async function load(spec: LoadSpec): Promise<LoadRecord> {
    const record: LoadRecord = {
      ...emptyRecord(spec.id, spec.condition),
      bodyKind: spec.html === undefined ? 'text' : 'html',
      remoteImages: spec.remoteImages,
      cids: spec.cids,
      trackersRemoved: spec.trackersRemoved,
    };
    // Plain text never reaches a frame: the host escapes it into its own DOM.
    if (spec.html === undefined) return record;
    record.token = frames.register({
      html: injectReporter(spec.html),
      csp: spec.csp,
      remoteImages: spec.remoteImages,
      cids: spec.cids,
      hostHtml: spec.hostHtml,
    });
    const t0 = Date.now();
    const { page, contentsId } = await openWindow();
    record.ms.open = Date.now() - t0;
    record.contentsId = contentsId;
    watch(page, record);
    const drive = async () => {
      await page.goto(frames.hostUrl(record.token), { waitUntil: 'load', timeout: 20_000 });
      record.ms.load = Date.now() - t0 - record.ms.open;
      await page.waitForTimeout(spec.holdMs ?? settle);
      await interact(page, record.token, spec.dwellMs);
      record.ms.interact = Date.now() - t0 - record.ms.open - record.ms.load;
      await page.waitForTimeout(settle);
      record.report = (await page.evaluate('window.collect()')) as ProbeReport | null;
    };
    try {
      await withDeadline(
        drive(),
        spec.deadlineMs ?? LOAD_DEADLINE_MS,
        `${spec.id} did not finish in ${spec.deadlineMs ?? LOAD_DEADLINE_MS} ms`,
      );
    } catch (error) {
      record.error = error instanceof Error ? error.message.slice(0, 300) : String(error);
    } finally {
      // A hung renderer would never answer page.close(), so the window is destroyed from the main process.
      await app
        .evaluate(
          ({ webContents }, id) => webContents.fromId(id)?.close({ waitForBeforeUnload: false }),
          contentsId,
        )
        .catch(() => undefined);
    }
    return record;
  }

  /** A renderer shared with a crashing neighbour can die or hang with it, so a failed load gets one more try. */
  async function run(
    entry: CorpusEntry,
    condition: Condition,
    forgiving = false,
  ): Promise<LoadRecord> {
    const first = await runOnce(entry, condition, forgiving);
    // A message built to exhaust a renderer is allowed to hang or crash it once; it is not retried.
    if ((!first.error && !first.crashed) || forgiving) return first;
    const second = await runOnce(entry, condition, forgiving);
    second.retried = true;
    return second;
  }

  function runOnce(
    entry: CorpusEntry,
    condition: Condition,
    forgiving: boolean,
  ): Promise<LoadRecord> {
    const result = renderEntry(entry, condition);
    // Images on changes nothing for a message with no remote image: the same document would be loaded twice.
    if (condition.images && sameAsImagesOff(entry, condition, result))
      return Promise.resolve(skipped(entry, condition));
    return load({
      id: entry.id,
      deadlineMs: forgiving ? 10_000 : undefined,
      dwellMs: condition.dwellMs,
      condition: condition.name,
      html: result.bodyKind === 'html' ? result.document : undefined,
      csp: condition.csp,
      remoteImages: condition.images ? result.remoteImages.length : 0,
      cids: entry.cids.length,
      trackersRemoved: result.trackersRemoved,
    });
  }

  function sameAsImagesOff(
    entry: CorpusEntry,
    condition: Condition,
    result: MailHtmlResult,
  ): boolean {
    const off = renderEntry(entry, { ...condition, images: false });
    return (
      result.bodyKind === 'html' && off.bodyKind === 'html' && off.document === result.document
    );
  }

  function skipped(entry: CorpusEntry, condition: Condition): LoadRecord {
    return { ...emptyRecord(entry.id, condition.name), skipped: true, bodyKind: 'html' };
  }

  async function quit(): Promise<void> {
    if (closed) return;
    closed = true;
    await app.close().catch(() => undefined);
    await frames.close();
  }

  return {
    app,
    frames,
    mainLog: () =>
      app.evaluate(() => {
        const log = (globalThis as unknown as { leakHarness: unknown }).leakHarness;
        return JSON.parse(JSON.stringify(log));
      }),
    run,
    runRaw: (id, html, hostHtml) =>
      load({
        hostHtml,
        id,
        dwellMs: 200,
        holdMs: 1500,
        condition: 'raw',
        html,
        csp: false,
        remoteImages: 0,
        cids: 0,
        trackersRemoved: 0,
      }),
    async finish() {
      await quit();
      const hits = scanNetLog(await readFile(netLog, 'utf8'), options.entries, options.canary.port);
      await rm(dir, { recursive: true, force: true });
      return hits;
    },
    async dispose() {
      await quit();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function watch(page: Page, record: LoadRecord): void {
  page.on('request', request => record.requests.push(request.url()));
  page.on('websocket', socket => record.requests.push(socket.url()));
  page.on('console', message => {
    if (record.console.length < 40)
      record.console.push({ type: message.type(), text: message.text().slice(0, 300) });
  });
  page.on('crash', () => {
    record.crashed = true;
  });
  page.on('popup', popup => record.popups.push(popup.url()));
  page.on('dialog', dialog => {
    record.dialogs.push(`${dialog.type()}: ${dialog.message().slice(0, 100)}`);
    void dialog.dismiss().catch(() => undefined);
  });
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) record.navigations.push(frame.url());
  });
  page.on('pageerror', error => record.pageErrors.push(error.message.slice(0, 200)));
}

const HOVER_SELECTOR = 'a[href], area[href], summary, img, [tabindex]';
const MAX_HOVERS = 30;
const MAX_DWELLS = 12;
const VIEW = { width: 1000, height: 1600 };
const KEYS = ['Tab', 'Tab', 'Shift+Tab', 'Space', 'ArrowDown', 'j', 'Escape', 'End'];

interface HoverTarget {
  x: number;
  y: number;
  link: boolean;
}

/** Where the pointer should rest: the middle of each link, summary and image the frame shows, in document order. */
function hoverTargets(frame: Frame): Promise<HoverTarget[]> {
  return frame.evaluate(
    ([selector, max, height]) => {
      const targets: { x: number; y: number; link: boolean }[] = [];
      for (const element of document.querySelectorAll(selector as string)) {
        const rect = element.getBoundingClientRect();
        const y = rect.top + Math.min(rect.height, 40) / 2;
        const visible = rect.width > 0 && rect.height > 0 && rect.left >= 0 && y >= 0;
        if (visible && y < (height as number) && rect.left < 1000)
          targets.push({
            x: rect.left + Math.min(rect.width, 80) / 2,
            y,
            link: element.matches('a[href], area[href]'),
          });
        if (targets.length >= (max as number)) break;
      }
      return targets;
    },
    [HOVER_SELECTOR, MAX_HOVERS, VIEW.height],
  );
}

/**
 * The scripted interaction: focus the frame, hover every link (and summaries and images), press keys. It never clicks.
 * The window is made tall so every target is on screen and one query finds them all.
 */
async function interact(page: Page, token: string, dwellMs: number): Promise<void> {
  const frame = page.frames().find(candidate => candidate.url().includes(`/m/${token}/doc`));
  if (!frame) return;
  await page.evaluate("document.getElementById('f').focus()");
  const targets = await hoverTargets(frame).catch(() => []);
  let dwells = 0;
  for (const target of targets) {
    await page.mouse.move(target.x, target.y);
    if (dwellMs > 0 && target.link && dwells++ < MAX_DWELLS) await page.waitForTimeout(dwellMs);
  }
  for (const key of KEYS) await page.keyboard.press(key).catch(() => undefined);
}

/** Runs `worker` over `items`, `size` at a time. */
export async function pool<T>(
  items: readonly T[],
  size: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(lanes);
}

function emptyRecord(id: string, condition: string): LoadRecord {
  return {
    id,
    condition,
    token: '',
    contentsId: 0,
    bodyKind: 'text',
    remoteImages: 0,
    cids: 0,
    trackersRemoved: 0,
    requests: [],
    report: null,
    console: [],
    popups: [],
    crashed: false,
    dialogs: [],
    navigations: [],
    pageErrors: [],
    canaryHits: 0,
    ms: { open: 0, load: 0, interact: 0 },
  };
}

function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
