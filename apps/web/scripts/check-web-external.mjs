// Proves the built site requests nothing from any host but itself.
//
//   node apps/web/scripts/check-web-external.mjs [distDir] [--static-only] [--require-browser]
//
// Pass 1 (static): reads every .html, .css, .js (and .svg) in distDir. Every resource reference must be
// relative, or absolute only as https://aplos.email. Plain <a href> links to other sites are navigation, not
// requests: they are allowed and listed in the summary.
// Pass 2 (dynamic): serves distDir on 127.0.0.1, opens every page in headless Chromium (Playwright),
// scrolls to the bottom, waits for the network to go quiet and fails on any request (including blocked or
// failed ones, websockets and CSP violations) to a host other than the local server. https://aplos.email is
// answered from distDir, so nothing leaves the machine.
// If Playwright or its browser cannot be found, pass 2 prints a loud SKIPPED line (not a pass) unless
// --require-browser is given, which turns the skip into a failure.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const SITE_ORIGIN = 'https://aplos.email';
const webDir = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const positional = args.filter(a => !a.startsWith('--'));
const distDir = positional[0] ? resolve(positional[0]) : join(webDir, 'dist');
const rel = p => relative(process.cwd(), p) || '.';

// ---------- static pass ----------

const LINK_RESOURCE_RELS = new Set([
  'stylesheet',
  'preload',
  'modulepreload',
  'icon',
  'apple-touch-icon',
  'apple-touch-icon-precomposed',
  'mask-icon',
  'manifest',
  'prefetch',
  'preconnect',
  'dns-prefetch',
]);
const IMAGE_META = new Set([
  'og:image',
  'og:image:url',
  'og:image:secure_url',
  'twitter:image',
  'twitter:image:src',
]);

/** Returns null when the URL is fine, else a short reason. */
function classify(raw, { dataOk = false } = {}) {
  const url = String(raw).trim();
  if (!url || url.startsWith('#')) return null;
  if (/^data:/i.test(url)) return dataOk ? null : 'data: URL is only allowed for images and fonts';
  if (/^(blob:|about:)/i.test(url)) return null;
  if (/^https:\/\/aplos\.email(?:[/?#]|$)/i.test(url)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) {
    const host = url
      .replace(/^[a-z][a-z0-9+.-]*:/i, '')
      .replace(/^\/\//, '')
      .split(/[/?#]/)[0];
    return `points at another host (${host || url})`;
  }
  return null;
}

function blankComments(text, pattern) {
  return text.replace(pattern, m => m.replace(/[^\n]/g, ' '));
}
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+)))?/g;
  let m;
  while ((m = re.exec(src))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return attrs;
}

function srcsetUrls(value) {
  const urls = [];
  const re = /(\S+?)(?:\s+[\d.]+[wx])?\s*(?:,\s*|$)/g;
  let m;
  while ((m = re.exec(value)) && m[0]) urls.push(m[1].replace(/,$/, ''));
  return urls;
}

function scanCss(css, file, push, baseLine = 1) {
  const text = blankComments(css, /\/\*[\s\S]*?\*\//g);
  const add = (url, index, kind) => {
    const why = classify(url, { dataOk: true });
    if (why) push({ file, line: baseLine + lineOf(text, index) - 1, kind, url, why });
  };
  let m;
  const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;
  while ((m = urlRe.exec(text))) add(m[1] ?? m[2] ?? m[3] ?? '', m.index, 'css url()');
  const importRe = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)')/gi;
  while ((m = importRe.exec(text))) add(m[1] ?? m[2], m.index, 'css @import');
  const imageSetRe = /image-set\(\s*(?:"([^"]*)"|'([^']*)')/gi;
  while ((m = imageSetRe.exec(text))) add(m[1] ?? m[2], m.index, 'css image-set()');
}

// A JS string literal; n is the number of the group holding its opening quote.
const jsStr = (n = 1) => '(["\'`])((?:\\\\.|(?!\\' + n + ')[^\\\\])*)\\' + n;
const JS_STR = jsStr(1);
const JS_PATTERNS = [
  [
    'fetch()',
    new RegExp(String.raw`\b(?:fetch|importScripts)\s*\(\s*(?:new\s+URL\(\s*)?${JS_STR}`, 'g'),
  ],
  ['import()', new RegExp(String.raw`\bimport\s*\(\s*${JS_STR}`, 'g')],
  [
    'constructor',
    new RegExp(
      String.raw`\bnew\s+(?:Worker|SharedWorker|EventSource|WebSocket|Request)\s*\(\s*(?:new\s+URL\(\s*)?${JS_STR}`,
      'g',
    ),
  ],
  [
    'XMLHttpRequest.open()',
    new RegExp(String.raw`\.open\(\s*(["'])[A-Za-z]+\1\s*,\s*${jsStr(2)}`, 'g'),
  ],
  ['sendBeacon()', new RegExp(String.raw`\bsendBeacon\s*\(\s*${JS_STR}`, 'g')],
  ['.src =', new RegExp(String.raw`\.(?:src|srcset|poster)\s*=(?!=)\s*${JS_STR}`, 'g')],
  [
    'setAttribute(src)',
    new RegExp(
      String.raw`\.setAttribute\(\s*["'](?:src|srcset|poster|data)["']\s*,\s*${JS_STR}`,
      'g',
    ),
  ],
  ['import from', new RegExp(String.raw`\b(?:from|import)\s*${JS_STR}`, 'g')],
];

function unescapeJs(s) {
  return s
    .replace(/\\\//g, '/')
    .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function scanJs(js, file, push, mentioned, baseLine = 1) {
  const flagged = new Set();
  for (const [kind, re] of JS_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(js))) {
      // The URL literal is the last two groups; for the .open() pattern the method string comes first.
      const body = m[m.length - 1];
      const url = unescapeJs(body);
      const why = classify(url, { dataOk: true });
      if (why) {
        const key = `${m.index}:${url}`;
        if (!flagged.has(key)) {
          flagged.add(key);
          push({ file, line: baseLine + lineOf(js, m.index) - 1, kind: `js ${kind}`, url, why });
        }
        flagged.add(url);
      }
    }
  }
  // Absolute URL literals that are not requests (XML namespaces, error-message links...): evidence only.
  const litRe = /["'`](https?:\/\/[^\s"'`\\]+)/g;
  let m;
  while ((m = litRe.exec(js))) {
    if (flagged.has(unescapeJs(m[1]))) continue;
    let host;
    try {
      host = new URL(m[1]).host;
    } catch {
      continue;
    }
    mentioned.set(host, (mentioned.get(host) ?? 0) + 1);
  }
}

function scanHtml(htmlRaw, file, push, links, mentioned) {
  const html = blankComments(htmlRaw, /<!--[\s\S]*?-->/g);
  const check = (url, index, kind, opts) => {
    const why = classify(url, opts);
    if (why) push({ file, line: lineOf(html, index), kind, url, why });
  };
  // Inline scripts and styles.
  const blockRe = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  let b;
  while ((b = blockRe.exec(html))) {
    const attrs = parseAttrs(b[2]);
    const bodyStart = b.index + b[0].indexOf('>') + 1;
    const startLine = lineOf(html, bodyStart);
    if (b[1].toLowerCase() === 'style') scanCss(b[3], file, push, startLine);
    else if (!attrs.src && !/json/i.test(attrs.type ?? ''))
      scanJs(b[3], file, push, mentioned, startLine);
  }
  const tagRe =
    /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=`]+))?)*)\s*\/?>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[1].toLowerCase();
    const a = parseAttrs(m[2]);
    const at = m.index;
    if (a.style) scanCss(a.style, file, push, lineOf(html, at));
    switch (tag) {
      case 'script':
        if (a.src !== undefined) check(a.src, at, '<script src>');
        break;
      case 'link': {
        const rels = (a.rel ?? '').toLowerCase().split(/\s+/);
        if (a.href !== undefined && rels.some(r => LINK_RESOURCE_RELS.has(r)))
          check(a.href, at, `<link rel=${a.rel}>`, { dataOk: rels.includes('icon') });
        break;
      }
      case 'img':
      case 'source':
        if (a.src !== undefined) check(a.src, at, `<${tag} src>`, { dataOk: true });
        if (a.srcset !== undefined)
          for (const u of srcsetUrls(a.srcset)) check(u, at, `<${tag} srcset>`, { dataOk: true });
        break;
      case 'video':
      case 'audio':
      case 'track':
        if (a.src !== undefined) check(a.src, at, `<${tag} src>`);
        if (a.poster !== undefined) check(a.poster, at, `<${tag} poster>`, { dataOk: true });
        break;
      case 'iframe':
      case 'embed':
        if (a.src !== undefined) check(a.src, at, `<${tag} src>`);
        break;
      case 'object':
        if (a.data !== undefined) check(a.data, at, '<object data>');
        break;
      case 'input':
        if ((a.type ?? '').toLowerCase() === 'image' && a.src !== undefined)
          check(a.src, at, '<input type=image src>', { dataOk: true });
        break;
      case 'base':
        if (a.href !== undefined) check(a.href, at, '<base href>');
        break;
      case 'image':
      case 'use': {
        const href = a.href ?? a['xlink:href'];
        if (href !== undefined) check(href, at, `<${tag} href>`, { dataOk: true });
        break;
      }
      case 'meta': {
        if ((a['http-equiv'] ?? '').toLowerCase() === 'refresh') {
          const u = /url\s*=\s*['"]?([^'";]+)/i.exec(a.content ?? '');
          if (u) check(u[1], at, '<meta refresh>');
        }
        const name = (a.property ?? a.name ?? '').toLowerCase();
        if (IMAGE_META.has(name) && a.content !== undefined) check(a.content, at, `<meta ${name}>`);
        break;
      }
      case 'a':
      case 'area':
        if (
          a.href &&
          /^(https?:)?\/\//i.test(a.href.trim()) &&
          !/^https:\/\/aplos\.email(?:[/?#]|$)/i.test(a.href.trim())
        )
          links.push({ file, url: a.href.trim() });
        break;
      default:
    }
  }
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function staticPass() {
  const findings = [];
  const links = [];
  const mentioned = new Map();
  const push = f => findings.push({ ...f, file: rel(f.file) });
  const files = walk(distDir).filter(f => /\.(html?|css|m?js|svg)$/i.test(f));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const ext = extname(file).toLowerCase();
    if (ext === '.css') scanCss(text, file, push);
    else if (ext === '.js' || ext === '.mjs') scanJs(text, file, push, mentioned);
    else scanHtml(text, file, push, links, mentioned);
  }
  return { files, findings, links, mentioned };
}

// ---------- dynamic pass ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** Maps a URL path to a file inside distDir, or null. */
function resolveFile(pathname) {
  let p;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const full = resolve(distDir, '.' + p);
  if (full !== distDir && !full.startsWith(distDir + sep)) return null;
  if (existsSync(full) && statSync(full).isDirectory()) {
    const index = join(full, 'index.html');
    return existsSync(index) ? index : null;
  }
  return existsSync(full) ? full : null;
}

function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const file = resolveFile(url.pathname);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res
      .writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      })
      .end(readFileSync(file));
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok(server)));
}

function loadPlaywright() {
  const tries = [
    import.meta.url,
    process.env.PLAYWRIGHT_FROM &&
      pathToFileURL(resolve(process.env.PLAYWRIGHT_FROM, 'noop.js')).href,
    process.env.CAPTURE_DEPS && pathToFileURL(resolve(process.env.CAPTURE_DEPS, 'noop.js')).href,
    pathToFileURL(
      '/Users/knewton/.t3/worktrees/aplos-mail/rv-plat-ci-e2e-base/node_modules/noop.js',
    ).href,
  ].filter(Boolean);
  for (const base of tries) {
    try {
      return createRequire(base)('playwright');
    } catch {
      // try the next place
    }
  }
  return null;
}

function pageUrls() {
  return walk(distDir)
    .filter(f => /\.html?$/i.test(f))
    .map(f => {
      const r = relative(distDir, f).split(sep).join('/');
      return r === 'index.html' ? '/' : r.endsWith('/index.html') ? `/${r.slice(0, -10)}` : `/${r}`;
    });
}

async function dynamicPass() {
  const pw = loadPlaywright();
  if (!pw) return { skipped: 'playwright not found' };
  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    try {
      browser = await pw.chromium.launch({ headless: true });
    } catch (e) {
      return { skipped: `browser could not start: ${String(e.message).split('\n')[0]}` };
    }
    const pages = [];
    for (const path of pageUrls()) {
      const offenders = new Map(); // url -> how
      const siteServed = new Set();
      const notes = [];
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        serviceWorkers: 'block',
      });
      const page = await context.newPage();
      const inspect = (url, how) => {
        let u;
        try {
          u = new URL(url);
        } catch {
          return;
        }
        if (['data:', 'blob:', 'about:'].includes(u.protocol)) return;
        if (u.origin === origin || u.origin === origin.replace('http', 'ws')) return;
        if (u.origin === SITE_ORIGIN) return;
        if (!offenders.has(url)) offenders.set(url, how);
      };
      await context.route('**/*', route => {
        const u = new URL(route.request().url());
        if (u.origin === SITE_ORIGIN) {
          const file = resolveFile(u.pathname);
          siteServed.add(route.request().url());
          if (file) {
            return route.fulfill({
              status: 200,
              contentType: MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
              body: readFileSync(file),
            });
          }
          return route.fulfill({ status: 404, body: 'not found' });
        }
        return route.continue();
      });
      page.on('request', req => inspect(req.url(), 'request'));
      page.on('requestfailed', req => inspect(req.url(), 'failed request'));
      page.on('websocket', ws => inspect(ws.url(), 'websocket'));
      page.on('response', res => {
        if (res.status() >= 400 && res.url().startsWith(origin))
          notes.push(`local ${res.status()}: ${res.url().slice(origin.length)}`);
      });
      page.on('console', msg => {
        const t = msg.text();
        if (/content security policy|refused to (load|connect|frame)/i.test(t))
          offenders.set(`CSP console message: ${t.slice(0, 160)}`, 'csp');
      });
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', e => {
          (window.__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`);
        });
      });
      let error = null;
      let links = [];
      try {
        await page.goto(origin + path, { waitUntil: 'load', timeout: 30000 });
        await page.evaluate(async () => {
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          let y = 0;
          for (let i = 0; i < 300 && y < document.documentElement.scrollHeight; i += 1) {
            window.scrollTo(0, y);
            y += 400;
            await sleep(60);
          }
          window.scrollTo(0, document.documentElement.scrollHeight);
        });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(500);
        links = await page.$$eval('a[href], area[href]', els => els.map(e => e.href));
        const csp = await page.evaluate(() => window.__csp ?? []);
        for (const c of csp) offenders.set(`CSP violation: ${c}`, 'csp');
      } catch (e) {
        error = String(e.message).split('\n')[0];
      }
      await context.close();
      pages.push({
        path,
        offenders: [...offenders],
        siteServed: [...siteServed],
        links: [...new Set(links)].filter(l => /^https?:/i.test(l) && new URL(l).origin !== origin),
        notes,
        error,
      });
    }
    return { pages, origin };
  } finally {
    await browser?.close();
    server.close();
  }
}

// ---------- report ----------

if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
  console.error(`FAIL: ${rel(distDir)} does not exist. Build the site first (npm run web:build).`);
  process.exit(1);
}

let failed = false;
const stat = staticPass();
console.log(`Static pass: scanned ${stat.files.length} files in ${rel(distDir)}`);
if (stat.findings.length === 0)
  console.log('  PASS: every resource reference is relative or https://aplos.email');
else {
  failed = true;
  for (const f of stat.findings)
    console.log(`  FAIL ${f.file}:${f.line} ${f.kind} ${f.url} (${f.why})`);
}
if (stat.mentioned.size) {
  console.log('  Absolute URLs inside JS or inline code that are not requests (info only):');
  for (const [host, n] of [...stat.mentioned].sort()) console.log(`    ${host} (${n})`);
}
const uniqueLinks = new Map();
for (const l of stat.links) {
  if (!uniqueLinks.has(l.url)) uniqueLinks.set(l.url, new Set());
  uniqueLinks.get(l.url).add(rel(l.file));
}
console.log(`  Outbound <a href> links (navigation, allowed): ${uniqueLinks.size}`);
for (const [url, files] of [...uniqueLinks].sort())
  console.log(`    ${url}  [${[...files].join(', ')}]`);

if (flags.has('--static-only')) {
  console.log('Dynamic pass: not run (--static-only)');
} else {
  const dyn = await dynamicPass();
  if (dyn.skipped) {
    console.log(`Dynamic pass: SKIPPED (${dyn.skipped}) -- this is NOT a pass`);
    if (flags.has('--require-browser')) {
      failed = true;
      console.log('  FAIL: --require-browser was given');
    }
  } else {
    console.log(
      `Dynamic pass: ${dyn.pages.length} page(s) in headless Chromium against ${dyn.origin}`,
    );
    for (const p of dyn.pages) {
      const bad = p.offenders.length > 0 || p.error;
      if (bad) failed = true;
      console.log(`  ${bad ? 'FAIL' : 'PASS'} ${p.path}`);
      if (p.error) console.log(`    error: ${p.error}`);
      for (const [url, how] of p.offenders) console.log(`    ${how}: ${url}`);
      for (const u of p.siteServed) console.log(`    note: ${u} answered from dist (same site)`);
      for (const n of p.notes) console.log(`    warn: ${n}`);
      for (const l of p.links) console.log(`    outbound link (navigation, allowed): ${l}`);
    }
  }
}
console.log(failed ? 'RESULT: FAIL' : 'RESULT: OK');
process.exit(failed ? 1 : 0);
