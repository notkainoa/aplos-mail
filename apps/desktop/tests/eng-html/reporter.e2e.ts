import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { loadCorpus } from '../../../../packages/mail-html/corpus/index';

// The engine's reporter (packages/mail-html/assets/reporter.js) and sanitizer in a real Chromium: a hidden Electron
// (support/reporter-app.ts) serves engine documents under the engine's headers and sizes each frame to what it
// reports, as the reader's host does. Run: npx tsx --test apps/desktop/tests/eng-html/reporter.e2e.ts (a few
// seconds; not part of `npm test`). Hidden window, no Dock item, a temp user-data dir, ELECTRON_RUN_AS_NODE removed,
// every host name resolving to "not found".

const nodeRequire = createRequire(import.meta.url);
const electronBinary = nodeRequire('electron') as unknown as string;

interface Report {
  data: { token: string; h: number; w: number; bg: string; ready: boolean; marks: number };
  at: number;
}
type Reports = Record<string, Report[]>;
interface Measured {
  root: number;
  top: number;
  compat: string;
  inner: number;
}
interface Result {
  urls: Record<string, string>;
  before: Reports;
  closed: Reports;
  reopened: Reports;
  settled: Record<string, Measured | null>;
  clobber: Record<string, unknown> | null;
  frames: Record<string, number>;
  frozen: Record<string, boolean>;
}

function safeEnv(clobberFile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const dropped = key === 'ELECTRON_RUN_AS_NODE' || key === 'APLOS_RENDERER_URL';
    if (!dropped && !/_API_KEY$/.test(key)) env[key] = value;
  }
  return { ...env, APLOS_REPORTER_CLOBBER: clobberFile, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
}

/** The corpus's DOM-clobbering message as written (placeholders filled), never sanitized. */
function clobberingMail(): string {
  const corpus = loadCorpus({ canaryOrigin: 'http://127.0.0.1:9' });
  const entry = corpus.find(e => e.id === '064-dom-clobbering');
  if (!entry?.html) throw new Error('064-dom-clobbering is missing from the corpus');
  return entry.html;
}

async function runApp(): Promise<Result> {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-reporter-'));
  try {
    const main = join(dir, 'main', 'main.cjs');
    const clobberFile = join(dir, 'clobber.html');
    await writeFile(clobberFile, clobberingMail());
    await build({
      entryPoints: [join(import.meta.dirname, 'support', 'reporter-app.ts')],
      outfile: main,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['electron'],
      logLevel: 'silent',
    });
    const args = [
      main,
      `--user-data-dir=${join(dir, 'user-data')}`,
      '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ];
    const child = spawn(electronBinary, args, {
      env: safeEnv(clobberFile),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => (out += chunk));
    child.stderr.on('data', chunk => (err += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
    await new Promise(resolve => child.once('exit', resolve));
    clearTimeout(timer);
    const line = out.split('\n').find(l => l.startsWith('REPORTER-RESULT '));
    if (!line) throw new Error(`no result\n${out}\n${err.slice(-2000)}`);
    return JSON.parse(line.slice('REPORTER-RESULT '.length)) as Result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const last = (reports: Reports, name: string) => reports[name]?.at(-1)?.data;

const tokenOf = (url: string) => url.slice('aplos-mail://m/'.length, -1);

test('the reporter and sanitizer in a hidden Chromium', { timeout: 60_000 }, async t => {
  const r = await runApp();
  const SIX = ['token', 'h', 'w', 'bg', 'ready', 'marks'];

  await t.test('every document reports, only the six keys, its own token, never h 0', () => {
    for (const [name, url] of Object.entries(r.urls)) {
      const reports = r.before[name] ?? [];
      assert.ok(reports.length > 0, `${name} reported`);
      for (const { data } of reports) {
        assert.deepEqual(Object.keys(data), SIX, name);
        assert.equal(data.token, tokenOf(url), name);
        assert.ok(data.h > 0 && data.h <= 1_000_000, `${name}: h ${data.h}`);
        assert.equal(data.w, 600, name);
      }
    }
  });

  await t.test(
    'engine documents lay out in standards mode; the quirks control fills its frame',
    () => {
      for (const [name, measured] of Object.entries(r.settled)) {
        if (name === 'quirksRaw') continue;
        assert.equal(measured?.compat, 'CSS1Compat', name);
      }
      assert.equal(r.settled.quirksRaw?.compat, 'BackCompat');
      assert.equal(last(r.before, 'shortLetter')?.h, 86, 'a short letter is its own height');
      assert.ok(
        (last(r.before, 'quirksRaw')?.h ?? 0) >= 150,
        'in quirks mode the root is at least the frame (150 px), so it could never shrink',
      );
    },
  );

  await t.test('a closed <details> reports a smaller height, and an opened one a larger', () => {
    const open = last(r.before, 'details')?.h ?? 0;
    const closed = last(r.closed, 'details')?.h ?? 0;
    const reopened = last(r.reopened, 'details')?.h ?? 0;
    assert.ok(open > 2_000, `open ${open}`);
    assert.ok(closed < 300, `closed ${closed}`);
    assert.equal(reopened, open);
  });

  await t.test(
    'letters styled in vh settle at a fixed height; raw 100vh grows with its frame',
    () => {
      const fixed: Record<string, number> = { vh100: 832, vh150: 1286, vhStyle: 822 };
      for (const [name, height] of Object.entries(fixed)) {
        const heights = new Set(r.reopened[name].map(report => report.data.h));
        assert.deepEqual([...heights], [height], `${name} reported only its fixed height`);
        assert.equal(r.frames[name], height, `${name}: the frame is that tall`);
        assert.equal(r.settled[name]?.root, height, name);
        assert.ok(r.reopened[name].length < 20, `${name}: ${r.reopened[name].length} reports`);
      }
      // Positive control: without the rewrite the letter follows its frame (the host's growth loop).
      const raw = r.reopened.vhRaw.map(report => report.data.h);
      assert.ok(raw.length >= 4, `${raw.length} raw reports`);
      assert.ok(
        raw.every((h, i) => i === 0 || h >= raw[i - 1]),
        raw.join(' '),
      );
      assert.ok(raw.at(-1)! >= raw[0] + 96, `grew from ${raw[0]} to ${raw.at(-1)}`);
    },
  );

  await t.test('no mail rule outranks the measuring layer; unsanitized, the same rules do', () => {
    assert.equal(last(r.before, 'outrank')?.h, 86, 'measured like any short letter');
    assert.equal(r.settled.outrank?.root, 86);
    assert.equal(r.settled.outrank?.top, 0, 'no margin pushes the letter below what is measured');
    assert.ok((last(r.before, 'outrankRaw')?.h ?? 0) > 2_000, 'the control is not measured short');
  });

  await t.test('the paper: the root’s colour when the body’s is transparent', () => {
    assert.equal(last(r.before, 'rootPaper')?.bg, 'rgb(18, 52, 86)');
    assert.equal(last(r.before, 'bodyPaper')?.bg, 'rgb(250, 250, 250)');
    assert.equal(last(r.before, 'noPaper')?.bg, 'rgba(0, 0, 0, 0)');
  });

  await t.test(
    'DOM clobbering (the corpus’s 064, unsanitized): the reporter still reports true values',
    () => {
      const facts = r.clobber!;
      // What the markup did, in Chromium: document named properties shadow the built-ins the old reporter read.
      assert.equal(facts.documentAddEventListener, 'object', '<embed name=addEventListener>');
      assert.equal(facts.documentBodyIsBody, false, '<img name=body>');
      assert.equal(facts.documentElementIsRoot, false, '<img name=documentElement>');
      assert.equal(facts.documentFonts, false, '<img name=fonts>');
      // What it cannot do: the window's own properties win over its named properties.
      assert.equal(facts.windowResizeObserver, 'function', '<embed name=ResizeObserver>');
      assert.equal(facts.windowGetComputedStyle, 'function');
      assert.equal(facts.windowInnerWidth, 'number', '<a id=innerWidth>');
      assert.equal(facts.windowParentIsParent, true, '<iframe name=parent>, <a id=parent>');
      assert.equal(facts.windowLocation, 'string', '<iframe name=location>');
      assert.equal(facts.windowDocumentCtor, 'function');
      assert.equal(facts.windowObject, 'function');
      const report = last(r.before, 'clobber');
      assert.equal(report?.h, facts.root, 'the real root’s height');
      assert.equal(report?.token, tokenOf(r.urls.clobber));
      assert.equal(report?.marks, 0);
    },
  );
});
