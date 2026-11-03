import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { loadCorpus, type CorpusEntry } from '../../../../packages/mail-html/corpus/index';
import { startCanary, type Canary, type NetLogHit } from './canary';
import { CONDITIONS, launchHarness, pool, type Harness, type LoadRecord } from './support/harness';

// LEAK HARNESS (plan 10 E4, html-2). How to run, from the repo root, headless, no network (about 70-100 s on an idle
// 8-core Mac, 8 minutes at load average 30):
//
//   npx playwright test -c apps/desktop/tests/eng-html/support/playwright.config.ts
//
// (the plan's `APLOS_TEST=1 npx playwright test apps/desktop/tests/eng-html/leak.e2e.ts` works once plat-ci's config
// matches `*.e2e.ts`). Debug knobs: LEAK_LIMIT=<n> first n messages, LEAK_ONLY=<id prefix>, LEAK_CONDITIONS=<n> first n
// conditions, LEAK_DUMP=<file> every load record as JSON.
//
// What it does: starts a hidden Electron (show:false, no Dock item, temp user data, ELECTRON_RUN_AS_NODE removed; never
// the Aplos app or its data) with an HTTP canary on a random loopback port, a DNS canary (`--host-resolver-rules` maps
// each message's `<tag>.canary-dns.example` to the canary and every other name to "not found") and Chromium's net log.
// Every corpus message is sanitized by `@aplos/mail-html` and served by a local stand-in for the aplos-mail:// relay
// (support/frame-server.ts) into a sandboxed iframe (no allow-same-origin) under four conditions: the frame's
// engine-built headers, or a bare document with no policy (the sanitizer alone), each with images off and on. Images
// on means only `img/<n>`, answered from canned bytes; the remote URL is never fetched. A scripted pass focuses the
// frame, hovers links, summaries and images (resting on links in one condition, where Chromium starts its link hints)
// and presses keys; it never clicks. The assertions below are findings if they fail: a canary request, a request that
// is not the document's own route, a canary name in the net log, a navigation, popup or dialog, a storage write, a
// script marker, a CSP violation (the sanitizer must not lean on the policy) or a CSSOM `url()`, `@import` or
// `@font-face` the sanitizer should have removed. Nothing is weakened to hide one; EXPECTED_FAILS is for what DECISIONS
// records as not provable here, with a reason per entry. Needs the Electron binary in node_modules and nothing else.

const CONCURRENCY = 8;

/** A message (or message and condition) a known, recorded gap makes fail. Empty: nothing is excused. */
const EXPECTED_FAILS: { id: string; check: string; reason: string }[] = [];

/** Detector controls: documents loaded as given (no sanitizer, no policy) to prove each channel can see a leak. */
const CONTROLS: Record<string, { id: string; html: string; host?: string }> = {
  http: {
    id: '900-control-http-image',
    html: '<img src="http://127.0.0.1:{{PORT}}/900-control-http-image/pixel" width="9" height="9">',
  },
  dnsImage: {
    id: '901-control-dns-image',
    html: '<img src="http://m901.canary-dns.example/pixel.png" width="9" height="9">',
  },
  dnsPrefetch: {
    id: '902-control-dns-prefetch',
    html: '<link rel="dns-prefetch" href="//m902.canary-dns.example">',
  },
  preconnect: {
    id: '903-control-preconnect',
    html: '<link rel="preconnect" href="http://m903.canary-dns.example">',
  },
  hoverLink: {
    id: '904-control-hover-link',
    html: '<a href="http://m904.canary-dns.example/x" style="display:block;width:600px;height:200px">hover me</a>',
  },
  topAnchor: {
    id: '906-control-top-anchor',
    html: '<p>frame</p>',
    host: '<a href="http://m906.canary-dns.example/x" style="display:block;width:600px;height:100px">a link in the host page</a>',
  },
  script: { id: '905-control-script', html: '<script>window.__pwned = 1</script>' },
};

interface Run {
  entries: CorpusEntry[];
  canary: Canary;
  harness: Harness;
  records: LoadRecord[];
  controls: Map<string, LoadRecord>;
  strayCanary: { condition: string; url: string; host: string | undefined }[];
  netLog: NetLogHit[];
  controlNetLog: NetLogHit[];
  main: Awaited<ReturnType<Harness['mainLog']>>;
  elapsedMs: number;
}

let run: Run;

function controlDocument(html: string, port: number): string {
  return `<!doctype html><html><head></head><body>${html.replace('{{PORT}}', String(port))}</body></html>`;
}

test.beforeAll(async () => {
  test.setTimeout(900_000);
  const started = Date.now();
  const canary = await startCanary();
  const limit = Number(process.env.LEAK_LIMIT) || undefined;
  const entries = loadCorpus({ canaryOrigin: canary.origin })
    .slice(0, limit)
    .filter(entry => !process.env.LEAK_ONLY || entry.id.startsWith(process.env.LEAK_ONLY));
  canary.track([...entries, ...Object.values(CONTROLS)]);
  const sturdy = entries.filter(entry => !isHeavy(entry));
  const heavy = entries.filter(isHeavy);
  const harness = await launchHarness({ entries, canary });
  const records: LoadRecord[] = [];
  const strayCanary: Run['strayCanary'] = [];
  try {
    for (const condition of CONDITIONS.slice(0, Number(process.env.LEAK_CONDITIONS) || undefined)) {
      const from = canary.hits.length;
      await pool(sturdy, CONCURRENCY, async entry => {
        records.push(await harness.run(entry, condition));
      });
      await pool(heavy, 2, async entry => {
        records.push(await harness.run(entry, condition, true));
      });
      await new Promise(resolve => setTimeout(resolve, 300));
      const phase = records.filter(r => r.condition === condition.name);
      const sum = (key: 'open' | 'load' | 'interact') =>
        Math.round(phase.reduce((n, r) => n + r.ms[key], 0) / 1000);
      console.log(
        `phase ${condition.name} (sum of open ${sum('open')}s load ${sum('load')}s interact ${sum('interact')}s) done at ${Math.round((Date.now() - started) / 1000)}s`,
      );
      for (const hit of canary.hits.slice(from).filter(h => h.fromBrowser)) {
        const owner = records.find(r => r.id === hit.messageId && r.condition === condition.name);
        if (owner) owner.canaryHits += 1;
        else strayCanary.push({ condition: condition.name, url: hit.url, host: hit.headers.host });
      }
    }
    if (process.env.LEAK_DUMP)
      writeFileSync(process.env.LEAK_DUMP, JSON.stringify(records, null, 1));
    const main = await harness.mainLog();
    const netLog = await harness.finish();
    const { controls, controlNetLog } = await runControls(canary);
    run = {
      entries,
      canary,
      harness,
      records,
      controls,
      controlNetLog,
      strayCanary,
      netLog,
      main,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    await harness.dispose();
    await canary.close();
    throw error;
  }
});

/** A second hidden Electron, so the controls' deliberate leaks stay out of the corpus run's net log. */
async function runControls(canary: Canary) {
  const harness = await launchHarness({ entries: Object.values(CONTROLS), canary });
  const controls = new Map<string, LoadRecord>();
  try {
    for (const control of Object.values(CONTROLS)) {
      const html = controlDocument(control.html, canary.port);
      controls.set(control.id, await harness.runRaw(control.id, html, control.host));
    }
  } catch (error) {
    await harness.dispose();
    throw error;
  }
  return { controls, controlNetLog: await harness.finish() };
}

test.afterAll(async () => {
  await run?.canary.close();
});

/** Messages built to exhaust a renderer (and the synthetic stress messages) run two at a time, so a crash hurts no neighbour. */
const HEAVY_CLASSES = ['css-layout-abuse', 'resource-exhaustion', 'deep-nesting', 'huge-line'];
function isHeavy(entry: CorpusEntry): boolean {
  return entry.generated || entry.classes.some(name => HEAVY_CLASSES.includes(name));
}

function excused(id: string, check: string): boolean {
  return EXPECTED_FAILS.some(entry => entry.id === id && entry.check === check);
}

function frameOnly(record: LoadRecord): boolean {
  return record.condition.startsWith('frame/');
}

/** True for the requests a frame legitimately makes: its host page, its document, and its own `img/<n>` and `cid/<n>`. */
function isOwnRoute(url: string, record: LoadRecord, origin: string): boolean {
  if (/^(data|about|blob):/.test(url)) return true;
  const own = new RegExp(
    `^${origin.replaceAll('.', '\\.')}/(host|m)/${record.token}(/doc|/img/(\\d+)|/cid/(\\d+))?$`,
  );
  const match = own.exec(url);
  if (!match) return false;
  if (match[3] !== undefined) return Number(match[3]) < record.remoteImages;
  if (match[4] !== undefined) return Number(match[4]) < record.cids;
  return true;
}

function summarize(items: string[]): string {
  return items.length === 0 ? 'none' : `\n  ${items.join('\n  ')}`;
}

test('the corpus leaks nothing: every message, sanitized, in a sandboxed frame', async () => {
  await test.step('the harness ran every message in every condition', () => {
    const html = run.records.filter(r => r.bodyKind === 'html' && !r.skipped);
    const skipped = run.records.filter(r => r.skipped).length;
    const text = run.records.filter(r => r.bodyKind === 'text');
    const heavyIds = new Set(run.entries.filter(isHeavy).map(entry => entry.id));
    const failed = html.filter(r => r.error || r.crashed || !r.report || !r.report.ready);
    const broken = failed.filter(r => !heavyIds.has(r.id));
    // Stress messages may exhaust their own renderer; that is a denial of service inside one frame, recorded, not a leak.
    const exhausted = failed.filter(r => heavyIds.has(r.id));
    console.log(
      `renderer exhausted by stress messages: ${exhausted.map(r => `${r.id} [${r.condition}] ${r.crashed ? 'crashed' : (r.error ?? 'no report')}`).join('; ') || 'none'}`,
    );
    console.log(
      `leak harness: ${run.entries.length} messages x ${CONDITIONS.length} conditions in ${Math.round(run.elapsedMs / 1000)}s; ` +
        `${html.length} frames (${skipped} images-on loads skipped: same document as images-off), ${text.length} plain-text (no frame); canary hits ${run.canary.hits.length}; ` +
        `net-log canary events ${run.netLog.length}; webRequest records ${run.main.requests.length}`,
    );
    if (!process.env.LEAK_LIMIT && !process.env.LEAK_ONLY)
      expect.soft(run.entries.length).toBeGreaterThanOrEqual(130);
    expect
      .soft(html.length + skipped)
      .toBeGreaterThan(run.entries.length * CONDITIONS.length * 0.9);
    expect
      .soft(
        broken.map(r => `${r.id} [${r.condition}] ${r.error ?? 'no report'}`),
        `loads without a report:${summarize(broken.map(r => `${r.id} [${r.condition}] ${r.error ?? 'no report'}`))}`,
      )
      .toEqual([]);
  });

  await test.step('positive controls: each detector sees a leak that is let through on purpose', () => {
    const control = (key: string) => run.controls.get(CONTROLS[key].id)!;
    const hitsFor = (id: string) =>
      run.canary.hits.filter(hit => hit.messageId === id && hit.fromBrowser);
    const netFor = (id: string) => run.controlNetLog.filter(hit => hit.messageId === id);
    expect
      .soft(hitsFor(CONTROLS.http.id).length, 'canary sees a direct request')
      .toBeGreaterThan(0);
    expect
      .soft(
        control('http').requests.some(url => url.includes('/900-control-http-image/')),
        'Playwright sees it',
      )
      .toBe(true);
    expect
      .soft(
        hitsFor(CONTROLS.dnsImage.id).length,
        'canary sees a request through the DNS mapping, named by Host',
      )
      .toBeGreaterThan(0);
    expect
      .soft(netFor(CONTROLS.dnsImage.id).length, 'net log names the canary host of a request')
      .toBeGreaterThan(0);
    expect
      .soft(control('script').report?.pwned, 'a script that runs is visible to the reporter')
      .toBe('number');
    expect.soft(control('script').report?.newGlobals).toContain('__pwned');
    console.log(
      `controls: dns-prefetch seen in net log ${netFor(CONTROLS.dnsPrefetch.id).length > 0}, ` +
        `preconnect ${netFor(CONTROLS.preconnect.id).length > 0}, a link inside the sandboxed frame ${netFor(CONTROLS.hoverLink.id).length > 0}, a link in the host page ${netFor(CONTROLS.topAnchor.id).length > 0}`,
    );
    expect
      .soft(netFor(CONTROLS.dnsPrefetch.id).length, 'net log sees a <link rel=dns-prefetch>')
      .toBeGreaterThan(0);
  });

  await test.step('no message reaches the canary, with images off or on, with or without the frame policy', () => {
    const leaks = run.records
      .filter(r => r.canaryHits > 0 && !excused(r.id, 'canary'))
      .map(r => `${r.id} [${r.condition}] ${r.canaryHits} request(s)`);
    const stray = run.strayCanary.map(hit => `[${hit.condition}] ${hit.host ?? ''}${hit.url}`);
    const browserOnly = run.canary.hits.filter(hit => !hit.fromBrowser).length;
    console.log(
      `canary: ${run.canary.hits.length} requests (${browserOnly} not from a browser: instrumentation noise)`,
    );
    expect.soft(leaks, `canary requests by message:${summarize(leaks)}`).toEqual([]);
    expect.soft(stray, `canary requests naming no message:${summarize(stray)}`).toEqual([]);
  });

  await test.step("requests are only the frame's own routes: images off none, images on only rewritten img/<n>", () => {
    const origin = run.harness.frames.origin;
    const byContents = new Map(run.records.map(r => [r.contentsId, r]));
    const offenders: string[] = [];
    for (const record of run.records) {
      for (const url of record.requests) {
        if (!isOwnRoute(url, record, origin) && !excused(record.id, 'requests'))
          offenders.push(`${record.id} [${record.condition}] page saw ${url.slice(0, 140)}`);
      }
    }
    for (const request of run.main.requests) {
      const record = byContents.get(request.contents);
      // Requests from the control windows and from windows closed before the log was read are checked in their own test.
      if (record && !isOwnRoute(request.url, record, origin) && !excused(record.id, 'requests'))
        offenders.push(
          `${record.id} [${record.condition}] webRequest saw ${request.resourceType} ${request.url.slice(0, 140)}`,
        );
    }
    const stray = run.harness.frames.requests
      .filter(r => r.kind === 'stray' && r.fromBrowser)
      .map(
        r =>
          `${r.status} ${r.path} (referer ${r.headers.referer ?? 'none'}, ${r.headers['sec-fetch-dest'] ?? '?'})`,
      );
    expect
      .soft([...new Set(offenders)], `unexpected requests:${summarize([...new Set(offenders)])}`)
      .toEqual([]);
    expect.soft(stray, `paths the frame server did not issue:${summarize(stray)}`).toEqual([]);
  });

  await test.step("Chromium's net log names no canary host: no DNS lookup, prefetch, preconnect or connection", () => {
    const hits = run.netLog
      .filter(hit => !excused(hit.messageId ?? '', 'netlog'))
      .map(hit => `${hit.messageId ?? '(canary port)'} ${hit.event} ${hit.name}`);
    const unique = [...new Set(hits)];
    expect.soft(unique, `net-log events naming a canary:${summarize(unique)}`).toEqual([]);
  });

  await test.step('no navigation of the top frame, no popup, no dialog', () => {
    const problems: string[] = [];
    for (const record of run.records) {
      const host = run.harness.frames.hostUrl(record.token);
      for (const url of record.navigations)
        if (url !== host)
          problems.push(
            `${record.id} [${record.condition}] top frame went to ${url.slice(0, 120)}`,
          );
      for (const url of record.popups)
        problems.push(`${record.id} [${record.condition}] popup ${url.slice(0, 120)}`);
      for (const dialog of record.dialogs)
        problems.push(`${record.id} [${record.condition}] dialog ${dialog}`);
      for (const message of record.pageErrors)
        problems.push(`${record.id} [${record.condition}] host page error ${message}`);
    }
    const byContents = new Map(run.records.map(r => [r.contentsId, r]));
    for (const popup of run.main.popups) {
      const record = byContents.get(popup.opener);
      if (record)
        problems.push(
          `${record.id} [${record.condition}] window.open handler saw ${popup.url.slice(0, 120)}`,
        );
    }
    for (const nav of run.main.navigations) {
      const record = byContents.get(nav.contents);
      if (record && nav.isMainFrame && nav.url !== run.harness.frames.hostUrl(record.token))
        problems.push(
          `${record.id} [${record.condition}] will-frame-navigate to ${nav.url.slice(0, 120)}`,
        );
    }
    expect.soft(problems, `navigation, popups, dialogs:${summarize(problems)}`).toEqual([]);
  });

  await test.step('an opaque-origin frame can write no localStorage, sessionStorage, cookie or IndexedDB', () => {
    const problems: string[] = [];
    for (const record of run.records) {
      const storage = record.report?.storage;
      if (!storage) continue;
      if (record.report?.origin !== 'null')
        problems.push(`${record.id} [${record.condition}] origin is ${record.report?.origin}`);
      if (!storage.localStorage.startsWith('threw'))
        problems.push(`${record.id} [${record.condition}] localStorage ${storage.localStorage}`);
      if (!storage.sessionStorage.startsWith('threw'))
        problems.push(
          `${record.id} [${record.condition}] sessionStorage ${storage.sessionStorage}`,
        );
      if (!storage.cookie.startsWith('threw'))
        problems.push(`${record.id} [${record.condition}] cookie ${storage.cookie}`);
      if (storage.indexedDB === 'opened')
        problems.push(`${record.id} [${record.condition}] indexedDB opened`);
    }
    expect.soft(problems, `storage:${summarize(problems)}`).toEqual([]);
  });

  await test.step('no script of a message runs: no marker, no new global, no script-class violation', () => {
    const problems: string[] = [];
    for (const record of run.records) {
      const report = record.report;
      if (!report) continue;
      if (report.pwned !== 'undefined')
        problems.push(`${record.id} [${record.condition}] window.__pwned is ${report.pwned}`);
      if (report.newGlobals.length > 0)
        problems.push(
          `${record.id} [${record.condition}] new globals ${report.newGlobals.slice(0, 5).join(',')}`,
        );
      if (report.name !== '') problems.push(`${record.id} [${record.condition}] window.name set`);
      const blocked = record.console.filter(m =>
        /Blocked script execution|Refused to execute|Executing inline/.test(m.text),
      );
      for (const message of blocked)
        problems.push(`${record.id} [${record.condition}] ${message.text.slice(0, 120)}`);
    }
    expect.soft(problems, `script execution:${summarize(problems)}`).toEqual([]);
  });

  await test.step('the sanitizer does not lean on the frame policy: no CSP violation in a sanitized document', () => {
    const problems: string[] = [];
    for (const record of run.records.filter(frameOnly)) {
      for (const violation of record.report?.violations ?? [])
        problems.push(`${record.id} [${record.condition}] ${violation}`);
      for (const message of record.console.filter(m => m.text.startsWith('Refused to')))
        problems.push(`${record.id} [${record.condition}] ${message.text.slice(0, 140)}`);
    }
    expect
      .soft([...new Set(problems)], `policy violations:${summarize([...new Set(problems)])}`)
      .toEqual([]);
  });

  await test.step("Chromium's CSSOM agrees with the sanitizer: no url(), @import or @font-face outside img/<n> and cid/<n>", () => {
    const origin = run.harness.frames.origin;
    const problems: string[] = [];
    for (const record of run.records) {
      const report = record.report;
      if (!report) continue;
      const base = `${origin}/m/${record.token}/doc`;
      for (const entry of report.cssUrls) {
        const raw = entry.slice(entry.indexOf('|') + 1);
        const absolute = (() => {
          try {
            return new URL(raw, base).href;
          } catch {
            return raw;
          }
        })();
        if (
          !isOwnRoute(absolute, record, origin) ||
          /\/(host|doc)/.test(absolute.slice(origin.length))
        )
          problems.push(`${record.id} [${record.condition}] CSSOM holds ${entry.slice(0, 140)}`);
      }
      if (report.importRules > 0)
        problems.push(`${record.id} [${record.condition}] ${report.importRules} @import rule(s)`);
      if (report.fontFaceRules > 0)
        problems.push(
          `${record.id} [${record.condition}] ${report.fontFaceRules} @font-face rule(s)`,
        );
      if (report.fonts > 0)
        problems.push(
          `${record.id} [${record.condition}] ${report.fonts} font face(s) in document.fonts`,
        );
    }
    expect
      .soft([...new Set(problems)], `CSS disagreements:${summarize([...new Set(problems)])}`)
      .toEqual([]);
  });
});
