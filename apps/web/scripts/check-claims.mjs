// Checks that every claim shown on the site has proof, and that the copy keeps to the owner's decisions.
//
//   node apps/web/scripts/check-claims.mjs [--production] [--src <dir|file>]... [--claims claims.json]
//                                          [--status provider-status.json] [--today YYYY-MM-DD] [--repo <dir>]
//
// Copy marks a claim with data-claim="<id>" (several ids separated by spaces). apps/web/claims.json lists
// every claim with its evidence. Always fails on:
//   - an id used in copy but missing from claims.json, a data-claim written in a way this check cannot read
//     (an expression, a spread of a variable, a boolean attribute), or a missing, malformed or duplicate registry;
//   - a placeholder ("[contact email]", TODO, TBD, "to be added", lorem ipsum) in any copy file;
//   - banned wording in any copy file, .css included, after normalising the text (entities, \u escapes, soft
//     hyphens, non-breaking hyphens and inline tags such as <wbr /> or <Key>A</Key> cannot hide a phrase):
//     the owner's voice rules (airmail, magic, AI-powered, copilot, "hold A and say it", "smart" and "beta" as
//     labels, sparkle/wand/star glyphs and icons) and the owner's scope decisions (no Windows or Linux, no
//     Outlook/iCloud/Fastmail/IMAP, no macOS 12, no GitHub, no "updates install themselves").
//     A line can opt out of one rule with a comment `claims-allow: <rule-id>` on that line or the line above;
//     the rule ids are printed with each failure.
// Fails only with --production (or VERCEL_ENV=production) when a used claim is not verified or its evidence is
// stale; otherwise those claims are printed as warnings.
//
// NOTE for whoever tags claims: Vercel production builds run this strict. A claim that is only "pending" (for
// example a Gmail availability claim whose only proof is a future live smoke run) fails the production build
// if it is tagged in copy. Either leave such a claim untagged, or register it with dated "owner" evidence
// (the owner's decision note) and status "verified", or wire the live runner first. This check does not
// weaken that on its own.
//
// Rules for a used claim to count as verified:
//   - status is "verified" and verifiedAt is a YYYY-MM-DD date;
//   - "live" evidence (ref = provider name, e.g. "gmail"): provider-status.json must show that provider
//     passing, checked within maxAgeDays (null = any age) and not in the future. Accepted shapes:
//       { "gmail": { "status": "pass", "checkedAt": "2026-10-27T10:00:00Z" } }  or
//       { "providers": { "gmail": { ... } } }; status may be "pass"/"passed"/"ok"/true; the time key may be
//       checkedAt, at, passedAt, verifiedAt, lastPassedAt or timestamp. If `status` is present it alone
//       decides; a contradictory `ok` or `passed` next to a failing status is a failure;
//   - "owner" evidence: the ref must carry a dated note (YYYY-MM-DD); with maxAgeDays that date must be recent;
//   - "design", "fact", "test" evidence: with status "verified" it counts; with maxAgeDays, verifiedAt must be
//     recent. A "test" ref that looks like a file path must exist in the repo (a missing file is a warning,
//     and a failure with --production).
//   - Proof on another branch: the site can ship from a branch that does not carry the app (main carries only
//     the site until the app ships). claims.json may then name `"proofSource": { "branch", "commit", "note" }`,
//     the commit whose tree holds the test files. A test file missing from this checkout is looked up there
//     with git: present = fine; absent = the usual failure; that commit not in this clone at all (Vercel's
//     shallow clone of main) = a warning that names the commit, never a quiet pass.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { decodeCssEscapes, decodeEntities, decodeJsEscapes } from './lib/decode.mjs';

const webDir = resolve(import.meta.dirname, '..');
let repoRoot = resolve(webDir, '../..');

// ---------- arguments ----------
const argv = process.argv.slice(2);
const opts = { production: false, src: [], claims: null, status: null, today: null };
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--production') opts.production = true;
  else if (a === '--src') opts.src.push(resolve(argv[++i]));
  else if (a === '--claims') opts.claims = resolve(argv[++i]);
  else if (a === '--status') opts.status = resolve(argv[++i]);
  else if (a === '--today') opts.today = argv[++i];
  else if (a === '--repo') repoRoot = resolve(argv[++i]);
  else {
    console.error(`Unknown argument: ${a}`);
    process.exit(2);
  }
}
const production = opts.production || process.env.VERCEL_ENV === 'production';
const roots = opts.src.length
  ? opts.src
  : [
      join(webDir, 'src'),
      join(webDir, 'index.html'),
      join(webDir, 'download'),
      join(webDir, 'privacy'),
      join(webDir, 'terms'),
      join(webDir, 'public'),
    ];
const claimsPath = opts.claims ?? join(webDir, 'claims.json');
const statusPath = opts.status ?? join(webDir, 'provider-status.json');
const rel = p => relative(process.cwd(), p) || '.';
const todayStr = opts.today ?? new Date().toISOString().slice(0, 10);
const DAY = 86400000;
const isDate = s =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const ageDays = from => Math.floor((Date.parse(todayStr) - Date.parse(from)) / DAY);

const errors = []; // always fatal
const warnings = [];
const err = m => errors.push(m);

// ---------- copy files ----------
const COPY_EXT = /\.(tsx?|html?|css|svg)$/i;
function collect(path, out) {
  if (!existsSync(path)) return;
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      collect(join(path, name), out);
    }
  } else if (COPY_EXT.test(path) && !/\.d\.ts$/.test(path)) out.push(path);
}
const files = [];
for (const r of roots) {
  if (!existsSync(r)) err(`Source path not found: ${rel(r)}`);
  collect(r, files);
}

const lineOf = (text, index) => {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) n += 1;
  return n;
};
const isTs = f => /\.tsx?$/i.test(f);
const isHtml = f => /\.html?$/i.test(f);

// ---------- reading each file: data-claim uses and visible-text pieces ----------
// A "piece" is a run of visible text: { text, line, tight }. tight = it continues the previous piece with no
// gap (JSX text next to an inline element or {' '}). Copy files are read once; hits come from raw lines and
// from the joined pieces.
const used = new Map(); // id -> [{file, line}]
const useId = (id, file, line) => {
  if (!used.has(id)) used.set(id, []);
  used.get(id).push({ file, line });
};
const parsed = new Map(); // file -> { text, lines, pieces }

function claimIds(file, line, value) {
  const ids = String(value).split(/\s+/).filter(Boolean);
  if (ids.length === 0) err(`${rel(file)}:${line} data-claim is empty`);
  for (const id of ids) useId(id, file, line);
}

function readTs(file, text) {
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lineAt = pos => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const handled = []; // [start, end) ranges where a data-claim was understood
  const pieces = [];
  const stringLike = n =>
    ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null;
  const isClaimName = n => /^data-claim$/i.test(n && (n.text ?? n.escapedText ?? ''));
  const literalValue = (init, where) => {
    const expr = init && ts.isJsxExpression(init) ? init.expression : init;
    const v = expr ? stringLike(expr) : null;
    if (v === null)
      err(
        `${rel(file)}:${lineAt(where.getStart(sf))} data-claim uses an expression (${(expr ?? where).getText(sf).slice(0, 60)}); use a literal id`,
      );
    return v;
  };

  const visit = node => {
    if (ts.isJsxAttribute(node) && isClaimName(node.name)) {
      handled.push([node.getStart(sf), node.getEnd()]);
      if (!node.initializer)
        err(`${rel(file)}:${lineAt(node.getStart(sf))} data-claim has no value`);
      else {
        const v = literalValue(node.initializer, node);
        if (v !== null) claimIds(file, lineAt(node.getStart(sf)), v);
      }
      return;
    }
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isStringLiteral(node.name) || ts.isIdentifier(node.name)) &&
      isClaimName(node.name)
    ) {
      handled.push([node.getStart(sf), node.getEnd()]);
      const v = literalValue(node.initializer, node);
      if (v !== null) claimIds(file, lineAt(node.getStart(sf)), v);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      /^setAttribute$/.test(
        ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '',
      ) &&
      node.arguments[0] &&
      /^data-claim$/i.test(stringLike(node.arguments[0]) ?? '')
    ) {
      handled.push([node.getStart(sf), node.getEnd()]);
      const v = node.arguments[1] ? stringLike(node.arguments[1]) : null;
      if (v === null)
        err(
          `${rel(file)}:${lineAt(node.getStart(sf))} data-claim set from an expression; use a literal id`,
        );
      else claimIds(file, lineAt(node.getStart(sf)), v);
      return;
    }
    if (ts.isJsxText(node)) {
      pieces.push({
        text: decodeEntities(node.text).text,
        line: lineAt(node.getStart(sf)),
        tight: true,
      });
    } else if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      !(node.parent && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)))
    ) {
      const inJsx =
        node.parent &&
        ts.isJsxExpression(node.parent) &&
        node.parent.parent &&
        (ts.isJsxElement(node.parent.parent) || ts.isJsxFragment(node.parent.parent));
      pieces.push({ text: node.text, line: lineAt(node.getStart(sf)), tight: Boolean(inJsx) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Any other mention of data-claim (a spread of a variable, dataset.claim, a boolean attribute...) is unreadable.
  const blanked = text
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/[^\n]*/g, m => m.replace(/[^\n]/g, ' '));
  for (const m of blanked.matchAll(/data-?claim|dataset\s*(?:\.|\[\s*['"])claim/gi)) {
    if (!handled.some(([a, b]) => m.index >= a && m.index < b))
      err(
        `${rel(file)}:${lineOf(text, m.index)} data-claim used in a form this check cannot read; write data-claim="id"`,
      );
  }
  return pieces;
}

function readHtml(file, text) {
  const blank = s => s.replace(/[^\n]/g, ' ');
  const clean = text
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, blank);
  // data-claim attributes (any case, quoted or not)
  const found = new Set();
  const attrRe = /data-claim(?![\w-])\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+))/gi;
  for (const m of clean.matchAll(attrRe)) {
    found.add(m.index);
    claimIds(file, lineOf(text, m.index), decodeEntities(m[1] ?? m[2] ?? m[3]).text);
  }
  for (const m of clean.matchAll(/data-?claim/gi))
    if (!found.has(m.index))
      err(
        `${rel(file)}:${lineOf(text, m.index)} data-claim used in a form this check cannot read; write data-claim="id"`,
      );
  // visible text and text-bearing attributes
  const pieces = [];
  let offset = 0;
  for (const part of clean.split(/(<[^>]*>)/)) {
    if (part.startsWith('<') && part.endsWith('>')) {
      for (const m of part.matchAll(
        /\b(alt|title|aria-label|aria-description|placeholder|content)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
      ))
        pieces.push({
          text: decodeEntities(m[2] ?? m[3]).text,
          line: lineOf(text, offset),
          tight: false,
        });
    } else if (part.trim()) {
      pieces.push({ text: decodeEntities(part).text, line: lineOf(text, offset), tight: true });
    }
    offset += part.length;
  }
  return pieces;
}

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const pieces = isTs(file) ? readTs(file, text) : isHtml(file) ? readHtml(file, text) : [];
  parsed.set(file, { text, lines: text.split('\n'), pieces });
}

// ---------- text rules ----------
const GLYPHS = '✨⭐★☆✦✧🌟🪄❇✩✪✫✬✭✮✯✰⚝💫🔮';
const RULES = [
  { id: 'airmail', re: /air[\s-]?mail/i },
  { id: 'magic', re: /\bmagic/i },
  { id: 'ai-powered', re: /\bai[\s-]*powered\b/i },
  { id: 'copilot', re: /\bco-?pilot\b/i },
  { id: 'hold-a-and-say-it', re: /\bhold\s+a\s+and\s+say\s+it\b/i },
  { id: 'smart-label', re: /\bsmart\b/i },
  { id: 'beta-badge', re: /\bbeta\b/i },
  { id: 'sparkle-glyph', re: new RegExp(`[${GLYPHS}]`, 'u') },
  { id: 'sparkle-icon', re: /sparkle|magic-?wand|\bwands?\b|\bstars?\b/i },
  { id: 'sparkle-icon', re: /\bWand[A-Z]|\bStar[A-Z][a-z]|[a-z]Stars?\b/ },
  { id: 'windows', re: /\bWindows\b/ },
  { id: 'linux', re: /\blinux\b/i },
  { id: 'installer-formats', re: /\bappimage\b|\.exe\b/i },
  { id: 'later-providers', re: /\b(?:outlook|icloud|fastmail|imap|(?:microsoft|office)\s*365)\b/i },
  { id: 'old-macos', re: /\bmac\s?os\s*(?:x\s*)?(?:12|11|10)\b|\bmonterey\b|\bbig sur\b/i },
  { id: 'github', re: /\bgithub\b/i },
  {
    id: 'auto-update',
    re: /\bupdates?\s+(?:install|download|apply)\s+(?:themselves|automatically)\b|\bauto-?updat\w*|\bupdates?\s+itself\b|\bkeeps?\s+itself\s+up\s+to\s+date\b|\bautomatic(?:ally)?\s+updates?\b|\bupdates?\s+automatically\b/i,
  },
];
// Placeholders only count in visible text, so ordinary code brackets cannot trigger them.
const PLACEHOLDER_RULES = [
  {
    id: 'placeholder',
    re: /(?<![\w)\]])\[(?!(?:data|aria)-|[a-z-]+=)[^[\]\n]*[A-Za-z][^[\]\n]*\]/,
  },
  { id: 'placeholder', re: /\bto be (?:added|confirmed|decided|written|filled in|determined)\b/i },
  { id: 'placeholder', re: /\b(?:TODO|TBD|TBA|FIXME|XXX)\b/ },
  { id: 'placeholder', re: /lorem ipsum/i },
];

function normalize(s) {
  return s
    .normalize('NFKC')
    .replace(/[­​-‏⁠﻿]/g, '')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ');
}

const hits = new Map(); // key -> hit
function addHit(file, line, rule, match) {
  const { lines } = parsed.get(file);
  const marker = `${lines[line - 1] ?? ''}\n${lines[line - 2] ?? ''}`;
  const allow = /claims-allow:\s*([\w,\s-]+)/.exec(marker)?.[1] ?? '';
  if (allow.split(/[\s,]+/).includes(rule)) return;
  const key = `${file}:${line}:${rule}`;
  if (!hits.has(key))
    hits.set(key, { file, line, rule, match: match.replace(/\s+/g, ' ').trim().slice(0, 40) });
}

for (const [file, { text, pieces }] of parsed) {
  // 1. raw lines: catches identifiers, class names, comments, CSS (escapes decoded)
  text.split('\n').forEach((raw, i) => {
    let line = decodeJsEscapes(raw);
    line = decodeEntities(line).text;
    if (extname(file).toLowerCase() === '.css') line = decodeCssEscapes(line);
    line = normalize(line);
    for (const r of RULES) {
      const m = r.re.exec(line);
      if (m) addHit(file, i + 1, r.id, m[0]);
    }
  });
  // 2. visible text, joined two ways so inline tags and {' '} cannot split a phrase
  if (pieces.length) {
    for (const tight of [false, true]) {
      let joined = '';
      const starts = [];
      for (const p of pieces) {
        if (!(tight && p.tight)) joined += '\n';
        starts.push({ at: joined.length, line: p.line });
        joined += normalize(p.text);
      }
      const lineAt = idx => {
        let line = starts[0].line;
        for (const s of starts) {
          if (s.at > idx) break;
          line = s.line;
        }
        return line;
      };
      for (const r of [...RULES, ...PLACEHOLDER_RULES]) {
        const re = new RegExp(
          r.re.source,
          r.re.flags.includes('g') ? r.re.flags : `${r.re.flags}g`,
        );
        for (const m of joined.matchAll(re)) addHit(file, lineAt(m.index), r.id, m[0]);
      }
    }
  }
}
for (const h of [...hits.values()].sort(
  (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule),
)) {
  const glyph =
    h.rule === 'sparkle-glyph' ? ` U+${h.match.codePointAt(0).toString(16).toUpperCase()}` : '';
  const kind = h.rule === 'placeholder' ? 'placeholder' : 'banned phrase';
  err(
    `${rel(h.file)}:${h.line} ${kind} "${h.match}"${glyph} [${h.rule}]${basename(h.file) === 'Privacy.tsx' && h.rule === 'placeholder' ? ' (Privacy.tsx must have no placeholders)' : ''}`,
  );
}

// ---------- claims.json ----------
const PAGES = new Set(['landing', 'download', 'privacy', 'terms']);
const KINDS = new Set(['design', 'test', 'live', 'owner', 'fact']);
let claims = [];
let proofSource = null;
if (!existsSync(claimsPath)) {
  err(`${rel(claimsPath)} not found (the claims registry is required)`);
} else {
  let doc;
  try {
    doc = JSON.parse(readFileSync(claimsPath, 'utf8'));
  } catch (e) {
    err(`${rel(claimsPath)} is not valid JSON: ${e.message}`);
  }
  if (doc) {
    if (doc.version !== 1) err(`${rel(claimsPath)}: "version" must be 1`);
    if (doc.proofSource !== undefined) {
      const p = doc.proofSource;
      if (
        !p ||
        typeof p !== 'object' ||
        typeof p.branch !== 'string' ||
        !p.branch.trim() ||
        typeof p.commit !== 'string' ||
        !/^[0-9a-f]{40}$/.test(p.commit)
      )
        err(
          `${rel(claimsPath)}: "proofSource" needs a "branch" name and a full 40-character "commit"`,
        );
      else proofSource = p;
    }
    if (!Array.isArray(doc.claims)) err(`${rel(claimsPath)}: "claims" must be an array`);
    else {
      const seen = new Set();
      doc.claims.forEach((c, i) => {
        const at = `claims[${i}]${c && typeof c.id === 'string' ? ` (${c.id})` : ''}`;
        const bad = msg => err(`${rel(claimsPath)} ${at}: ${msg}`);
        if (!c || typeof c !== 'object' || Array.isArray(c)) return bad('not an object');
        if (typeof c.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id))
          bad('"id" must be a kebab-case string');
        else if (seen.has(c.id)) bad('duplicate id');
        else seen.add(c.id);
        if (typeof c.says !== 'string' || !c.says.trim()) bad('"says" must be a non-empty string');
        if (!Array.isArray(c.pages) || c.pages.length === 0 || !c.pages.every(p => PAGES.has(p)))
          bad('"pages" must be a non-empty list of landing, download, privacy, terms');
        if (!Array.isArray(c.evidence) || c.evidence.length === 0)
          bad('"evidence" must be a non-empty list');
        else
          c.evidence.forEach((e, j) => {
            if (!e || !KINDS.has(e.kind))
              bad(`evidence[${j}].kind must be design, test, live, owner or fact`);
            else if (typeof e.ref !== 'string' || !e.ref.trim())
              bad(`evidence[${j}].ref must be a non-empty string`);
            const age = e?.maxAgeDays;
            if (age !== undefined && age !== null && !(typeof age === 'number' && age > 0))
              bad(`evidence[${j}].maxAgeDays must be a positive number or null`);
          });
        if (c.status !== 'verified' && c.status !== 'pending')
          bad('"status" must be verified or pending');
        if (c.verifiedAt !== null && c.verifiedAt !== undefined && !isDate(c.verifiedAt))
          bad('"verifiedAt" must be YYYY-MM-DD or null');
        if (c.status === 'verified' && !isDate(c.verifiedAt))
          bad('a verified claim needs "verifiedAt" (YYYY-MM-DD)');
        if (c.note !== undefined && typeof c.note !== 'string') bad('"note" must be a string');
      });
      claims = doc.claims.filter(c => c && typeof c.id === 'string');
    }
  }
}
const byId = new Map();
for (const c of claims) if (!byId.has(c.id)) byId.set(c.id, c);
for (const [id, where] of used)
  if (!byId.has(id))
    for (const w of where) err(`${rel(w.file)}:${w.line} data-claim "${id}" is not in claims.json`);

// ---------- evaluate used claims ----------
let providerStatus = null;
if (existsSync(statusPath)) {
  try {
    providerStatus = JSON.parse(readFileSync(statusPath, 'utf8'));
  } catch (e) {
    err(`${rel(statusPath)} is not valid JSON: ${e.message}`);
  }
}
function providerEntry(name) {
  const table = providerStatus?.providers ?? providerStatus;
  return table && typeof table === 'object' ? table[name] : undefined;
}
const PASS_WORDS = new Set(['pass', 'passed', 'ok', 'success']);
/** `status` decides when present; otherwise `passed`, then `ok`. Nothing can turn an explicit failure into a pass. */
function passed(v) {
  if (v === true) return true;
  if (!v || typeof v !== 'object') return false;
  if (v.status !== undefined)
    return v.status === true || PASS_WORDS.has(String(v.status).toLowerCase());
  if (v.passed !== undefined)
    return v.passed === true || PASS_WORDS.has(String(v.passed).toLowerCase());
  return v.ok === true;
}
const stamp = v => {
  for (const k of ['checkedAt', 'at', 'passedAt', 'verifiedAt', 'lastPassedAt', 'timestamp']) {
    if (typeof v?.[k] === 'string' && !Number.isNaN(Date.parse(v[k]))) return v[k];
  }
  return null;
};

const git = args => {
  try {
    execFileSync('git', args, { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
let proofCommitHere = null;
/** 'present' | 'absent' | 'unreachable' (the proof commit is not in this clone). */
function atProofCommit(path) {
  proofCommitHere ??= git(['cat-file', '-e', `${proofSource.commit}^{commit}`]);
  if (!proofCommitHere) return 'unreachable';
  return git(['cat-file', '-e', `${proofSource.commit}:${path}`]) ? 'present' : 'absent';
}

/** Returns { state: 'verified'|'pending'|'stale'|'unproven', reasons: [] , warns: [] }. */
function evaluate(c) {
  const reasons = [];
  const warns = [];
  let state = 'verified';
  const rank = { verified: 0, stale: 1, unproven: 2, pending: 3 };
  const worsen = (s, why) => {
    reasons.push(why);
    if (rank[s] > rank[state]) state = s;
  };
  if (c.status !== 'verified') worsen('pending', 'status is pending');
  for (const e of c.evidence ?? []) {
    const max = e.maxAgeDays ?? null;
    if (e.kind === 'live') {
      const entry = providerEntry(e.ref.trim().toLowerCase());
      if (!providerStatus) worsen('unproven', `live ${e.ref}: no provider-status.json`);
      else if (entry === undefined)
        worsen('unproven', `live ${e.ref}: not in provider-status.json`);
      else if (!passed(entry)) worsen('unproven', `live ${e.ref}: not passing`);
      else {
        const at = stamp(entry);
        const when = at?.slice(0, 10);
        if (!at) worsen('unproven', `live ${e.ref}: passing but has no timestamp`);
        else if (Date.parse(at) > Date.parse(todayStr) + 2 * DAY)
          worsen('unproven', `live ${e.ref}: timestamp ${at} is in the future`);
        else if (max !== null && ageDays(when) > max)
          worsen('stale', `live ${e.ref}: last pass ${when} is older than ${max} days`);
      }
    } else if (e.kind === 'owner') {
      const m = /\d{4}-\d{2}-\d{2}/.exec(e.ref);
      if (!m || !isDate(m[0])) worsen('unproven', 'owner evidence has no dated note');
      else if (max !== null && ageDays(m[0]) > max)
        worsen('stale', `owner note ${m[0]} is older than ${max} days`);
    } else if (
      c.status === 'verified' &&
      max !== null &&
      isDate(c.verifiedAt) &&
      ageDays(c.verifiedAt) > max
    ) {
      worsen('stale', `${e.kind} evidence verified ${c.verifiedAt}, older than ${max} days`);
    }
    if (e.kind === 'test') {
      const first = e.ref
        .trim()
        .split(/\s+/)[0]
        .replace(/[:#].*$/, '');
      if (
        (first.includes('/') || /\.(m?[jt]sx?|json|md)$/.test(first)) &&
        !existsSync(resolve(repoRoot, first))
      ) {
        const there = proofSource ? atProofCommit(first) : 'absent';
        const at = proofSource && `${proofSource.branch} at ${proofSource.commit.slice(0, 12)}`;
        if (there === 'unreachable')
          warns.push(
            `test file ${first} is not in this checkout; its proof is on ${at}, which this clone lacks`,
          );
        else if (there === 'absent') {
          const why = proofSource
            ? `test file ${first} not found here or on ${at}`
            : `test file ${first} not found`;
          warns.push(why);
          if (production) worsen('unproven', why);
        }
      }
    }
  }
  return { state, reasons, warns };
}

const rows = [];
for (const [id, where] of [...used].sort()) {
  const c = byId.get(id);
  if (!c) {
    rows.push({ id, pages: '?', state: 'MISSING', reasons: ['not in claims.json'], where });
    continue;
  }
  const ev = evaluate(c);
  rows.push({ id, pages: (c.pages ?? []).join(','), state: ev.state, reasons: ev.reasons, where });
  for (const w of ev.warns) warnings.push(`claim ${id}: ${w}`);
  if (production && ev.state !== 'verified')
    err(
      `claim "${id}" is ${ev.state} (${ev.reasons.join('; ')}) and --production / VERCEL_ENV=production is set`,
    );
  else if (ev.state !== 'verified')
    warnings.push(`claim "${id}" is ${ev.state}: ${ev.reasons.join('; ')}`);
}
const unusedIds = claims.filter(c => !used.has(c.id)).map(c => c.id);

// ---------- report ----------
const pad = (s, n) => String(s).padEnd(n);
const wId = Math.max(5, ...rows.map(r => r.id.length));
const wPages = Math.max(5, ...rows.map(r => r.pages.length));
console.log(
  `Claims check (${production ? 'production' : 'preview'}), ${files.length} copy files, ${claims.length} claims, ${used.size} used`,
);
if (rows.length) {
  console.log(`${pad('claim', wId)}  ${pad('pages', wPages)}  ${pad('state', 9)}  used in`);
  for (const r of rows)
    console.log(
      `${pad(r.id, wId)}  ${pad(r.pages, wPages)}  ${pad(r.state, 9)}  ${r.where.map(w => `${basename(w.file)}:${w.line}`).join(', ')}`,
    );
}
if (unusedIds.length) console.log(`Not used in copy: ${unusedIds.join(', ')}`);
for (const w of warnings) console.log(`WARN ${w}`);
for (const e of errors) console.log(`FAIL ${e}`);
console.log(
  errors.length
    ? `RESULT: FAIL (${errors.length} problem${errors.length === 1 ? '' : 's'})`
    : `RESULT: OK${warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? '' : 's'})` : ''}`,
);
process.exit(errors.length ? 1 : 0);
