// Proves the built site requests nothing from any host but itself.
//
//   node apps/web/scripts/check-web-external.mjs [distDir] [--static-only] [--allow-host <host>]...
//
// Pass 1 (static): reads every .html, .css, .js, .svg, .json and .webmanifest in distDir.
//   - HTML is tokenised the way a browser does (first duplicate attribute wins, `<img/src=...>` and
//     unquoted values work, entities are decoded). Every resource reference must be relative or
//     https://aplos.email: script, link (any rel that fetches), img, source, srcset, imagesrcset, video,
//     audio, track, iframe (and its srcdoc), object, embed, body/table background, base, SVG image/use/
//     feImage, meta refresh, image meta, a[ping], form action, speculationrules and importmap.
//   - CSS (also inline and in style attributes): url(), @import and image-set(), with CSS escapes decoded.
//   - JS is parsed with the TypeScript parser. A string literal that is a request (fetch, import(),
//     new Worker/WebSocket/EventSource/Request, sendBeacon, XHR open, window.open, src/srcSet/poster/
//     action... properties and assignments, setAttribute, <link rel> hrefs) must be relative or same-origin.
//     Any OTHER absolute http(s)/ws(s) URL literal in JS fails too, unless its host is allowed (www.w3.org
//     namespaces and react.dev error links, or --allow-host). The one exception is a plain `href` property,
//     which is navigation.
//   - Plain <a href> links to other sites are navigation, not requests: they are allowed and listed.
// Pass 2 (dynamic): serves distDir on 127.0.0.1, opens every page in headless Chromium (Playwright) in four
//   views (desktop light 1x, desktop dark 2x, a 480 px window, phone light 3x, phone dark 2x; so media queries, srcset and
//   picture sources are all exercised), scrolls to the bottom, moves the mouse, presses Tab, fast-forwards the
//   page clock by 60 s, emulates print, then hides and closes the page (visibilitychange, pagehide,
//   beforeunload). Requests are watched on the whole browser context, so popups count. Any request to a host
//   other than the local server fails, including failed or blocked ones, websockets, CSP violations and
//   non-local navigations. Requests to other hosts are recorded and then aborted: nothing leaves the machine.
//   https://aplos.email is answered from distDir.
//   NOT covered: anything behind a click or a form submit (tours, demos), Vercel's real headers, a service
//   worker, the live deployment.
// If Playwright or its browser cannot be found, pass 2 is a FAILURE (never a quiet pass). Point the check at a
//   Playwright install with PLAYWRIGHT_FROM=/path/to/node_modules (or CAPTURE_DEPS), or run with --static-only
//   to say explicitly that you only want the static pass.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { decodeCssEscapes, decodeEntities } from './lib/decode.mjs';

const SITE_ORIGIN = 'https://aplos.email';
const BASE = `${SITE_ORIGIN}/`;
const webDir = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const flags = new Set();
const positional = [];
const allowHosts = new Set(['www.w3.org', 'react.dev']);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--allow-host') allowHosts.add(String(argv[++i]).toLowerCase());
  else if (argv[i].startsWith('--')) flags.add(argv[i]);
  else positional.push(argv[i]);
}
const distDir = positional[0] ? resolve(positional[0]) : join(webDir, 'dist');
const rel = p => relative(process.cwd(), p) || '.';

// ---------- URL classification ----------

/** Returns null when the URL is fine for a request, else a short reason. */
function classify(raw, { dataOk = false } = {}) {
  const url = String(raw)
    .replace(/^[\u0000- ]+/, '')
    .replace(/[\u0000- ]+$/, '');
  if (!url || url.startsWith('#')) return null;
  let u;
  try {
    u = new URL(url, BASE);
  } catch {
    return /^([a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(url) ? 'not a valid URL' : null;
  }
  if (u.protocol === 'data:')
    return dataOk ? null : 'data: URL is only allowed for images, fonts and styles';
  if (u.protocol === 'blob:' || u.protocol === 'about:') return null;
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol))
    return `unsupported scheme ${u.protocol}`;
  if (u.origin === SITE_ORIGIN) return null;
  return `points at another host (${u.host || url})`;
}

function isNavigationAway(raw) {
  try {
    const u = new URL(
      String(raw)
        .replace(/^[\u0000- ]+/, '')
        .trim(),
      BASE,
    );
    return /^https?:$/.test(u.protocol) && u.origin !== SITE_ORIGIN ? u.href : null;
  } catch {
    return null;
  }
}

const lineOfText = (text, index) => {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) n += 1;
  return n;
};

/** Parses srcset / imagesrcset candidate by candidate (URL, then an optional descriptor up to a comma). */
function srcsetUrls(value) {
  const urls = [];
  let i = 0;
  const s = String(value);
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i += 1;
    let j = i;
    while (j < s.length && !/\s/.test(s[j])) j += 1;
    let url = s.slice(i, j);
    i = j;
    if (!url) break;
    if (url.endsWith(',')) url = url.replace(/,+$/, '');
    else {
      // descriptor: everything up to the next comma outside parentheses
      let depth = 0;
      while (i < s.length && !(s[i] === ',' && depth === 0)) {
        if (s[i] === '(') depth += 1;
        else if (s[i] === ')') depth -= 1;
        i += 1;
      }
    }
    if (url) urls.push(url);
  }
  return urls;
}

// ---------- CSS ----------

const blankComments = (text, pattern) => text.replace(pattern, m => m.replace(/[^\n]/g, ' '));
const CSS_STR = String.raw`"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'`;

function scanCss(css, file, push, baseLine = 1) {
  const text = blankComments(css, /\/\*[\s\S]*?\*\//g);
  const seen = new Set();
  const add = (rawUrl, index, kind) => {
    const url = decodeCssEscapes(rawUrl);
    const why = classify(url, { dataOk: true });
    const key = `${index}:${url}:${kind}`;
    if (why && !seen.has(key)) {
      seen.add(key);
      push({ file, line: baseLine + lineOfText(text, index) - 1, kind, url, why });
    }
  };
  // Run once on the text as written and once with escapes decoded (catches `\75rl(`).
  for (const source of [text, decodeCssEscapes(text)]) {
    let m;
    const urlRe = new RegExp(
      String.raw`url\(\s*(?:${CSS_STR}|((?:\\[\s\S]|[^)\\"'\s])*))\s*\)`,
      'gi',
    );
    while ((m = urlRe.exec(source))) add(m[1] ?? m[2] ?? m[3] ?? '', m.index, 'css url()');
    const importRe = new RegExp(String.raw`@import\s*(?:${CSS_STR})`, 'gi');
    while ((m = importRe.exec(source))) add(m[1] ?? m[2], m.index, 'css @import');
    const setRe = /(?:-webkit-)?image-set\(/gi;
    while ((m = setRe.exec(source))) {
      let depth = 1;
      let i = setRe.lastIndex;
      while (i < source.length && depth > 0) {
        if (source[i] === '(') depth += 1;
        else if (source[i] === ')') depth -= 1;
        i += 1;
      }
      const inner = source.slice(setRe.lastIndex, i);
      const strRe = new RegExp(CSS_STR, 'g');
      let s;
      while ((s = strRe.exec(inner))) add(s[1] ?? s[2], m.index, 'css image-set()');
    }
  }
}

// ---------- JS ----------

const REQUEST_CALLS = new Map([
  ['fetch', [0]],
  ['importscripts', [0]],
  ['sendbeacon', [0]],
  ['open', [0, 1]], // XMLHttpRequest.open(method, url) and window.open(url)
  ['worker', [0]],
  ['sharedworker', [0]],
  ['eventsource', [0]],
  ['websocket', [0]],
  ['request', [0]],
  ['audio', [0]],
]);
const URL_PROPS = new Set([
  'src',
  'srcset',
  'poster',
  'data',
  'imagesrcset',
  'action',
  'formaction',
  'ping',
  'background',
]);
const SRCSET_PROPS = new Set(['srcset', 'imagesrcset']);
const URL_ATTRS = new Set([...URL_PROPS, 'href', 'xlink:href']);
// rels that never fetch anything
const NAV_RELS = new Set([
  'canonical',
  'alternate',
  'author',
  'license',
  'help',
  'next',
  'prev',
  'search',
  'me',
  'bookmark',
  'nofollow',
  'noopener',
  'noreferrer',
  'external',
  'tag',
  'privacy-policy',
  'terms-of-service',
]);
const fetchingRel = relValue =>
  String(relValue ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .some(r => !NAV_RELS.has(r));

const nameOf = n => {
  if (!n) return '';
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
    return n.text;
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression))
    return n.argumentExpression.text;
  if (ts.isParenthesizedExpression(n)) return nameOf(n.expression);
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.CommaToken)
    return nameOf(n.right); // (0, fetch)(...)
  return '';
};

function objectProp(obj, name) {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && nameOf(p.name).toLowerCase() === name) return p.initializer;
  }
  return null;
}

const ABS_URL_RE = /\b(?:https?|wss?):\/\/[^\s"'`<>\\)]*/gi;

function scanJs(js, file, push, ctx, baseLine = 1) {
  const sf = ts.createSourceFile(file, js, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const lineAt = node => baseLine + sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;

  const request = (node, text, kind, srcset = false) => {
    const urls = srcset ? srcsetUrls(text) : [text];
    for (const url of urls) {
      const why = classify(url, { dataOk: true });
      if (why) push({ file, line: lineAt(node), kind: `js ${kind}`, url, why });
    }
  };

  const literal = (node, text) => {
    const p = node.parent;
    let handled = false;
    if (p && (ts.isCallExpression(p) || ts.isNewExpression(p))) {
      const idx = p.arguments?.indexOf(node) ?? -1;
      const isImport = ts.isCallExpression(p) && p.expression.kind === ts.SyntaxKind.ImportKeyword;
      const callee = isImport ? 'import' : nameOf(p.expression).toLowerCase();
      if (idx >= 0 && (isImport ? idx === 0 : REQUEST_CALLS.get(callee)?.includes(idx))) {
        request(node, text, `${callee}()`);
        handled = true;
      } else if (idx === 1 && callee === 'setattribute') {
        const attr =
          p.arguments[0] && ts.isStringLiteral(p.arguments[0]) ? p.arguments[0].text : '';
        if (URL_ATTRS.has(attr.toLowerCase())) {
          request(node, text, `setAttribute(${attr})`, SRCSET_PROPS.has(attr.toLowerCase()));
          handled = true;
        }
      }
    } else if (
      p &&
      (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) &&
      p.moduleSpecifier === node
    ) {
      request(node, text, 'import from');
      handled = true;
    } else if (p && ts.isPropertyAssignment(p) && p.initializer === node) {
      const key = nameOf(p.name).toLowerCase();
      if (URL_PROPS.has(key)) {
        request(node, text, `${key}:`, SRCSET_PROPS.has(key));
        handled = true;
      } else if (key === 'href') {
        const relNode = objectProp(p.parent, 'rel');
        const relText = relNode && ts.isStringLiteralLike(relNode) ? relNode.text : null;
        if (relText !== null && fetchingRel(relText)) request(node, text, `href: (rel ${relText})`);
        else if (relNode && relText === null) request(node, text, 'href: (computed rel)');
        else {
          const nav = isNavigationAway(text);
          if (nav) ctx.links.push({ file, url: nav });
        }
        handled = true;
      }
    } else if (
      p &&
      ts.isBinaryExpression(p) &&
      p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      p.right === node
    ) {
      const key = nameOf(p.left).toLowerCase();
      const target = ts.isPropertyAccessExpression(p.left) ? p.left.expression.getText(sf) : '';
      if (URL_PROPS.has(key) || (key === 'href' && !/\blocation\b/.test(target))) {
        request(node, text, `.${key} =`, SRCSET_PROPS.has(key));
        handled = true;
      } else if (key === 'href') {
        const nav = isNavigationAway(text);
        if (nav) ctx.links.push({ file, url: nav });
        handled = true;
      }
    }
    if (handled) return;
    // Not a known request or link context. CSS inside a string, then any absolute URL at all.
    if (/url\(|@import/i.test(text)) scanCss(text, file, push, lineAt(node));
    for (const m of text.matchAll(ABS_URL_RE)) {
      let host = '';
      try {
        host = new URL(m[0]).host.toLowerCase();
      } catch {
        // empty or computed host, e.g. "https://" + name
      }
      if (host === 'aplos.email') continue;
      if (host && allowHosts.has(host)) ctx.mentioned.set(host, (ctx.mentioned.get(host) ?? 0) + 1);
      else
        push({
          file,
          line: lineAt(node),
          kind: 'js URL literal',
          url: m[0],
          why: host
            ? `absolute URL to ${host} outside a link; make it an <a href> or pass --allow-host`
            : 'absolute URL with a computed host',
        });
    }
  };

  const visit = node => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      literal(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// ---------- HTML ----------

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noembed', 'noframes']);

/** A small HTML tokenizer that follows the spec's attribute rules. Yields start tags and raw-text bodies. */
function* tokens(html) {
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) return;
    i = lt;
    const next = html[i + 1] ?? '';
    if (html.startsWith('<!--', i)) {
      const e = html.indexOf('-->', i + 4);
      i = e === -1 ? n : e + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', i)) {
      const e = html.indexOf(']]>', i);
      i = e === -1 ? n : e + 3;
      continue;
    }
    if (next === '!' || next === '?' || next === '/') {
      const e = html.indexOf('>', i);
      i = e === -1 ? n : e + 1;
      continue;
    }
    if (!/[a-zA-Z]/.test(next)) {
      i += 1;
      continue;
    }
    const start = i;
    let j = i + 1;
    while (j < n && !/[\s/>]/.test(html[j])) j += 1;
    const tag = html.slice(i + 1, j).toLowerCase();
    const attrs = new Map();
    const unknown = [];
    while (j < n) {
      while (j < n && /[\s/]/.test(html[j])) j += 1;
      if (j >= n) break;
      if (html[j] === '>') {
        j += 1;
        break;
      }
      const s = j;
      j += 1;
      while (j < n && !/[\s/>=]/.test(html[j])) j += 1;
      const name = html.slice(s, j).toLowerCase();
      while (j < n && /\s/.test(html[j])) j += 1;
      let value = '';
      if (html[j] === '=') {
        j += 1;
        while (j < n && /\s/.test(html[j])) j += 1;
        if (html[j] === '"' || html[j] === "'") {
          const q = html[j];
          let e = html.indexOf(q, j + 1);
          if (e === -1) e = n;
          value = html.slice(j + 1, e);
          j = e + 1;
        } else {
          const vs = j;
          while (j < n && !/[\s>]/.test(html[j])) j += 1;
          value = html.slice(vs, j);
        }
      }
      if (!attrs.has(name)) {
        const d = decodeEntities(value);
        attrs.set(name, d.text);
        for (const ent of d.unknown) unknown.push({ name, ent });
      }
    }
    i = j;
    let body = null;
    if (RAW_TEXT.has(tag)) {
      const close = new RegExp(`</${tag}(?=[\\s/>])`, 'i');
      const m = close.exec(html.slice(i));
      const end = m ? i + m.index : n;
      body = { text: html.slice(i, end), index: i };
      const gt = html.indexOf('>', end);
      i = m ? (gt === -1 ? n : gt + 1) : n;
    }
    yield { tag, attrs, unknown, index: start, body };
  }
}

const JS_TYPES = /^(?:|module|(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/jsx)$/i;

function jsonStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(v => jsonStrings(v, out));
  else if (value && typeof value === 'object')
    Object.values(value).forEach(v => jsonStrings(v, out));
  return out;
}

function scanJsonUrls(text, file, push, kind, baseLine = 1) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return;
  }
  for (const s of jsonStrings(doc)) {
    if (!/^([a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(s.trim())) continue;
    const why = classify(s, { dataOk: true });
    if (why) push({ file, line: baseLine, kind, url: s, why });
  }
}

function scanHtml(html, file, push, ctx, baseLine = 1) {
  const lineAt = index => baseLine + lineOfText(html, index) - 1;
  for (const t of tokens(html)) {
    const { tag, attrs: a, index } = t;
    const line = lineAt(index);
    const check = (url, kind, opts) => {
      if (url === undefined) return;
      const why = classify(url, opts);
      if (why) push({ file, line, kind, url, why });
    };
    for (const { name, ent } of t.unknown) {
      if (
        URL_ATTRS.has(name) ||
        ['style', 'content', 'srcdoc', 'imagesrcset', 'data'].includes(name)
      )
        push({ file, line, kind: `<${tag} ${name}>`, url: ent, why: 'unrecognised HTML entity' });
    }
    const style = a.get('style');
    if (style) scanCss(style, file, push, line);
    switch (tag) {
      case 'script': {
        const type = (a.get('type') ?? '').trim();
        if (a.has('src')) check(a.get('src'), '<script src>');
        if (a.has('href')) check(a.get('href'), '<script href>');
        if (t.body) {
          const bodyLine = lineAt(t.body.index);
          if (/^(speculationrules|importmap)$/i.test(type))
            scanJsonUrls(t.body.text, file, push, `<script type=${type}>`, bodyLine);
          else if (!a.has('src') && JS_TYPES.test(type))
            scanJs(t.body.text, file, push, ctx, bodyLine);
        }
        break;
      }
      case 'style':
        if (t.body) scanCss(t.body.text, file, push, lineAt(t.body.index));
        break;
      case 'link': {
        const relAttr = a.get('rel') ?? '';
        if (fetchingRel(relAttr)) {
          check(a.get('href'), `<link rel=${relAttr}>`, {
            dataOk: /\b(icon|stylesheet|apple-touch-icon|mask-icon)\b/i.test(relAttr),
          });
          for (const u of srcsetUrls(a.get('imagesrcset') ?? ''))
            check(u, `<link imagesrcset>`, { dataOk: true });
        }
        break;
      }
      case 'img':
      case 'source':
      case 'image':
        check(a.get('src'), `<${tag} src>`, { dataOk: true });
        for (const u of srcsetUrls(a.get('srcset') ?? ''))
          check(u, `<${tag} srcset>`, { dataOk: true });
        if (tag === 'image')
          check(a.get('href') ?? a.get('xlink:href'), '<image href>', { dataOk: true });
        break;
      case 'use':
      case 'feimage':
        check(a.get('href') ?? a.get('xlink:href'), `<${tag} href>`, { dataOk: true });
        break;
      case 'video':
      case 'audio':
      case 'track':
        check(a.get('src'), `<${tag} src>`);
        check(a.get('poster'), `<${tag} poster>`, { dataOk: true });
        break;
      case 'iframe':
        check(a.get('src'), '<iframe src>');
        if (a.has('srcdoc')) scanHtml(a.get('srcdoc'), file, push, ctx, line);
        break;
      case 'embed':
        check(a.get('src'), '<embed src>');
        break;
      case 'object':
        check(a.get('data'), '<object data>');
        break;
      case 'input':
        if ((a.get('type') ?? '').toLowerCase() === 'image')
          check(a.get('src'), '<input type=image src>', { dataOk: true });
        check(a.get('formaction'), '<input formaction>');
        break;
      case 'button':
        check(a.get('formaction'), '<button formaction>');
        break;
      case 'form':
        check(a.get('action'), '<form action>');
        break;
      case 'base':
        check(a.get('href'), '<base href>');
        break;
      case 'body':
      case 'table':
      case 'tr':
      case 'td':
      case 'th':
        check(a.get('background'), `<${tag} background>`, { dataOk: true });
        break;
      case 'meta': {
        if ((a.get('http-equiv') ?? '').toLowerCase() === 'refresh') {
          // "5", "5; url=x", "5, x", "5; x": whatever follows the delay is the target.
          const target = (a.get('content') ?? '')
            .replace(/^[\s\d.]*/, '')
            .replace(/^[;,]?\s*/, '')
            .replace(/^url\s*=\s*/i, '')
            .replace(/^['"]/, '')
            .replace(/['"]\s*$/, '');
          if (target) check(target, '<meta refresh>');
        }
        const name = (a.get('property') ?? a.get('name') ?? '').toLowerCase();
        if (/image|video|audio|player|logo|icon|tile/.test(name))
          check(a.get('content'), `<meta ${name}>`);
        break;
      }
      case 'a':
      case 'area': {
        const nav = a.has('href') ? isNavigationAway(a.get('href')) : null;
        if (nav) ctx.links.push({ file, url: nav });
        for (const u of (a.get('ping') ?? '').split(/\s+/).filter(Boolean))
          check(u, `<${tag} ping>`);
        break;
      }
      default:
    }
  }
}

// ---------- static pass ----------

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
  const ctx = { links: [], mentioned: new Map() };
  const push = f => findings.push({ ...f, file: rel(f.file) });
  const files = walk(distDir).filter(f => /\.(html?|css|m?js|cjs|svg|json|webmanifest)$/i.test(f));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const ext = extname(file).toLowerCase();
    if (ext === '.css') scanCss(text, file, push);
    else if (['.js', '.mjs', '.cjs'].includes(ext)) scanJs(text, file, push, ctx);
    else if (['.json', '.webmanifest'].includes(ext)) scanJsonUrls(text, file, push, 'json URL');
    else scanHtml(text, file, push, ctx);
  }
  return { files, findings, links: ctx.links, mentioned: ctx.mentioned };
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
  if (process.env.CHECK_WEB_EXTERNAL_NO_PLAYWRIGHT === '1') return null; // test hook
  const bases = [
    import.meta.url,
    pathToFileURL(resolve(webDir, '../../package.json')).href,
    process.env.PLAYWRIGHT_FROM &&
      pathToFileURL(resolve(process.env.PLAYWRIGHT_FROM, 'noop.js')).href,
    process.env.CAPTURE_DEPS && pathToFileURL(resolve(process.env.CAPTURE_DEPS, 'noop.js')).href,
  ].filter(Boolean);
  for (const base of bases) {
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

const VIEWS = [
  {
    name: 'desktop light 1x',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  },
  {
    name: 'desktop dark 2x',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  },
  {
    name: 'narrow window 480',
    viewport: { width: 480, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  },
  {
    name: 'phone light 3x',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    colorScheme: 'light',
    isMobile: true,
    hasTouch: true,
  },
  {
    name: 'phone dark 2x',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
  },
];

async function visit(browser, origin, path, view) {
  const offenders = new Map(); // url -> how
  const siteServed = new Set();
  const notes = [];
  const wsOrigin = origin.replace('http', 'ws');
  const { name: viewName, ...viewOptions } = view;
  const context = await browser.newContext({ ...viewOptions, serviceWorkers: 'block' });
  let page = null;
  const inspect = (url, how) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (['data:', 'blob:', 'about:'].includes(u.protocol)) return;
    if (u.origin === origin || u.origin === wsOrigin || u.origin === SITE_ORIGIN) return;
    if (!offenders.has(url)) offenders.set(url, how);
  };
  await context.route('**/*', route => {
    const url = route.request().url();
    const u = new URL(url);
    if (u.origin === SITE_ORIGIN) {
      const file = resolveFile(u.pathname);
      siteServed.add(url);
      if (file) {
        return route.fulfill({
          status: 200,
          contentType: MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
          body: readFileSync(file),
        });
      }
      return route.fulfill({ status: 404, body: 'not found' });
    }
    if (u.origin !== origin) {
      inspect(url, 'request'); // record, then abort: nothing leaves the machine
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  await context.routeWebSocket?.(/.*/, ws => {
    inspect(ws.url(), 'websocket');
    if (ws.url().startsWith(wsOrigin)) ws.connectToServer();
    else ws.close();
  });
  context.on('request', req => inspect(req.url(), 'request'));
  context.on('requestfailed', req => inspect(req.url(), 'failed request'));
  context.on('response', res => {
    if (res.status() >= 400 && res.url().startsWith(origin))
      notes.push(`local ${res.status()}: ${res.url().slice(origin.length)}`);
  });
  context.on('console', msg => {
    const t = msg.text();
    if (/content security policy|refused to (load|connect|frame)/i.test(t))
      offenders.set(`CSP console message: ${t.slice(0, 160)}`, 'csp');
  });
  context.on('page', p => {
    p.on('websocket', ws => inspect(ws.url(), 'websocket'));
    if (page && p !== page) notes.push('a popup or new tab was opened by the page');
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', e => {
      (window.__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  page = await context.newPage();
  page.on('websocket', ws => inspect(ws.url(), 'websocket'));
  let error = null;
  let links = [];
  let clock = true;
  try {
    // The clock keeps running in real time until we jump it, so timers fire normally and then early.
    await page.clock.install();
  } catch {
    clock = false;
  }
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
    for (let i = 1; i <= 5; i += 1) await page.mouse.move(i * (view.viewport.width / 6), 120 * i);
    for (let i = 0; i < 12; i += 1) await page.keyboard.press('Tab');
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (clock) await page.clock.runFor(60000).catch(() => {});
    else await page.waitForTimeout(4000);
    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(300);
    await page.emulateMedia({ media: 'screen' });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(300);
    links = await page.$$eval('a[href], area[href]', els => els.map(e => e.href));
    const csp = await page.evaluate(() => window.__csp ?? []);
    for (const c of csp) offenders.set(`CSP violation: ${c}`, 'csp');
    // Leaving the page: the classic place for beacons.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
    });
    await page.waitForTimeout(300);
    await page.close({ runBeforeUnload: true });
    await new Promise(r => setTimeout(r, 500));
  } catch (e) {
    error = String(e.message).split('\n')[0];
  }
  await context.close();
  return {
    view: viewName,
    path,
    offenders: [...offenders],
    siteServed: [...siteServed],
    links: [...new Set(links)].filter(l => /^https?:/i.test(l) && new URL(l).origin !== origin),
    notes: [...new Set(notes)],
    clock,
    error,
  };
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
    const results = [];
    for (const path of pageUrls())
      results.push(...(await Promise.all(VIEWS.map(view => visit(browser, origin, path, view)))));
    return { results, origin };
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
const stat = flags.has('--dynamic-only')
  ? { files: [], findings: [], links: [], mentioned: new Map() }
  : staticPass();
console.log(
  flags.has('--dynamic-only')
    ? "Static pass: not run (--dynamic-only, for the checker's own tests)"
    : `Static pass: scanned ${stat.files.length} files in ${rel(distDir)}`,
);
if (stat.findings.length === 0)
  console.log('  PASS: every resource reference is relative or https://aplos.email');
else {
  failed = true;
  const seen = new Set();
  for (const f of stat.findings) {
    const line = `  FAIL ${f.file}:${f.line} ${f.kind} ${f.url} (${f.why})`;
    if (!seen.has(line)) {
      seen.add(line);
      console.log(line);
    }
  }
}
if (stat.mentioned.size) {
  console.log('  Allowed hosts that appear only as text in JS (not requests):');
  for (const [host, n] of [...stat.mentioned].sort()) console.log(`    ${host} (${n})`);
}
const uniqueLinks = new Map();
for (const l of stat.links) {
  if (!uniqueLinks.has(l.url)) uniqueLinks.set(l.url, new Set());
  uniqueLinks.get(l.url).add(rel(l.file));
}
console.log(`  Outbound links (navigation, allowed): ${uniqueLinks.size}`);
for (const [url, files] of [...uniqueLinks].sort())
  console.log(`    ${url}  [${[...files].join(', ')}]`);

if (flags.has('--static-only')) {
  console.log('Dynamic pass: not run (--static-only was given)');
} else {
  const dyn = await dynamicPass();
  if (dyn.skipped) {
    failed = true;
    console.log(`Dynamic pass: SKIPPED (${dyn.skipped}) -- this is NOT a pass`);
    console.log(
      '  FAIL: the browser pass could not run. Install Playwright with Chromium, or point PLAYWRIGHT_FROM at a',
    );
    console.log(
      '        node_modules that has it. Use --static-only only if you really want the static pass alone.',
    );
  } else {
    console.log(
      `Dynamic pass: ${dyn.results.length} page view(s) in headless Chromium against ${dyn.origin}`,
    );
    const linkSet = new Set();
    for (const r of dyn.results) {
      const bad = r.offenders.length > 0 || r.error;
      if (bad) failed = true;
      console.log(`  ${bad ? 'FAIL' : 'PASS'} ${r.path} [${r.view}]`);
      if (r.error) console.log(`    error: ${r.error}`);
      if (!r.clock)
        console.log('    warn: page.clock is not available; waited in real time instead');
      for (const [url, how] of r.offenders) console.log(`    ${how}: ${url}`);
      for (const u of r.siteServed) console.log(`    note: ${u} answered from dist (same site)`);
      for (const n of r.notes) console.log(`    warn: ${n}`);
      for (const l of r.links) linkSet.add(`${r.path}  ${l}`);
    }
    console.log(`  Rendered outbound links (navigation, allowed): ${linkSet.size}`);
    for (const l of [...linkSet].sort()) console.log(`    ${l}`);
  }
}
console.log(failed ? 'RESULT: FAIL' : 'RESULT: OK');
process.exit(failed ? 1 : 0);
