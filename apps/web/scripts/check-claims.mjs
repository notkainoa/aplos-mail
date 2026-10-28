// Checks that every claim shown on the site has proof, and that the copy has no banned wording.
//
//   node apps/web/scripts/check-claims.mjs [--production] [--src <dir|file>]... [--claims claims.json]
//                                          [--status provider-status.json] [--today YYYY-MM-DD]
//
// Copy marks a claim with data-claim="<id>" (several ids separated by spaces). apps/web/claims.json lists
// every claim with its evidence. Always fails on: an id used in copy but missing from claims.json, a
// malformed or duplicate row, a placeholder or "to be added" marker in Privacy.tsx, or a banned phrase in
// any copy file. Fails only with --production (or VERCEL_ENV=production) when a used claim is not verified
// or its evidence is stale; otherwise those claims are printed as warnings.
//
// Rules for a used claim to count as verified:
//   - status is "verified" and verifiedAt is a YYYY-MM-DD date;
//   - "live" evidence (ref = provider name, e.g. "gmail"): provider-status.json must show that provider
//     passing, checked within maxAgeDays (null = any age). Accepted shapes:
//       { "gmail": { "status": "pass", "checkedAt": "2026-10-27T10:00:00Z" } }  or
//       { "providers": { "gmail": { ... } } }; status may be "pass"/"passed"/"ok"/true; the time key may be
//       checkedAt, at, passedAt, verifiedAt, lastPassedAt or timestamp;
//   - "owner" evidence: the ref must carry a dated note (YYYY-MM-DD); with maxAgeDays that date must be recent;
//   - "design", "fact", "test" evidence: with status "verified" it counts; with maxAgeDays, verifiedAt must be
//     recent. A "test" ref that looks like a file path must exist in the repo (a missing file is a warning,
//     and a failure with --production).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

const webDir = resolve(import.meta.dirname, '..');
const repoRoot = resolve(webDir, '../..');

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
function collect(path, out) {
  if (!existsSync(path)) return;
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      collect(join(path, name), out);
    }
  } else if (/\.(tsx?|html)$/i.test(path) && !/\.d\.ts$/.test(path)) out.push(path);
}
const files = [];
for (const r of roots) {
  if (!existsSync(r)) err(`Source path not found: ${rel(r)}`);
  collect(r, files);
}

const used = new Map(); // id -> [{file, line}]
const lineOf = (text, index) => text.slice(0, index).split('\n').length;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const re = /data-claim\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(["'`])([^"'`]*)\3\s*\}|(\{[^}]*\}))/g;
  let m;
  while ((m = re.exec(text))) {
    const where = { file, line: lineOf(text, m.index) };
    if (m[5] !== undefined) {
      err(`${rel(file)}:${where.line} data-claim uses an expression (${m[5]}); use a literal id`);
      continue;
    }
    const ids = (m[1] ?? m[2] ?? m[4] ?? '').split(/\s+/).filter(Boolean);
    if (ids.length === 0) err(`${rel(file)}:${where.line} data-claim is empty`);
    for (const id of ids) {
      if (!used.has(id)) used.set(id, []);
      used.get(id).push(where);
    }
  }
}

// ---------- banned phrases ----------
const BANNED = [
  'airmail',
  'magic',
  'ai-powered',
  'copilot',
  'hold a and say it',
  'windows and linux',
  '✨',
  '⭐',
  '★',
  '☆',
  '✦',
  '✧',
  '\u{1F31F}',
];
const sparkle = new Set(BANNED.filter(b => b.codePointAt(0) > 0x2000));
const bannedHits = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lower = text.toLowerCase();
  for (const phrase of BANNED) {
    let at = lower.indexOf(phrase);
    while (at !== -1) {
      bannedHits.push({
        file,
        line: lineOf(text, at),
        phrase: sparkle.has(phrase)
          ? `glyph U+${phrase.codePointAt(0).toString(16).toUpperCase()}`
          : phrase,
      });
      at = lower.indexOf(phrase, at + phrase.length);
    }
  }
}
bannedHits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
for (const h of bannedHits) err(`${rel(h.file)}:${h.line} banned phrase "${h.phrase}"`);

// ---------- Privacy.tsx placeholders ----------
for (const file of files.filter(f => basename(f) === 'Privacy.tsx')) {
  const text = readFileSync(file, 'utf8');
  const tba = /to be added/i.exec(text);
  if (tba) err(`${rel(file)}:${lineOf(text, tba.index)} contains a "to be added" marker`);
  // Placeholders are "[...]" in visible text, so look only inside string literals and JSX text.
  const spans = [];
  const strRe = /(["'])((?:\\.|(?!\1)[^\\\n])*)\1|(`)((?:\\.|[^\\`])*)`/g;
  let m;
  while ((m = strRe.exec(text))) spans.push({ at: m.index, body: m[2] ?? m[4] });
  const jsxRe = />([^<>{}]+)</g;
  while ((m = jsxRe.exec(text))) if (!/[;=]/.test(m[1])) spans.push({ at: m.index, body: m[1] });
  for (const s of spans) {
    const ph = /(?<![\w)\]])\[[^[\]\n]*[A-Za-z][^[\]\n]*\]/.exec(s.body);
    if (ph) err(`${rel(file)}:${lineOf(text, s.at)} placeholder ${ph[0]} in copy`);
  }
}

// ---------- claims.json ----------
const PAGES = new Set(['landing', 'download', 'privacy']);
const KINDS = new Set(['design', 'test', 'live', 'owner', 'fact']);
let claims = [];
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
          bad('"pages" must be a non-empty list of landing, download, privacy');
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
    err(`${rel(where[0].file)}:${where[0].line} data-claim "${id}" is not in claims.json`);

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
const passed = v =>
  v === true ||
  ['pass', 'passed', 'ok'].includes(String(v?.status ?? v?.passed ?? '').toLowerCase()) ||
  v?.passed === true ||
  v?.ok === true;
const stamp = v => {
  for (const k of ['checkedAt', 'at', 'passedAt', 'verifiedAt', 'lastPassedAt', 'timestamp']) {
    if (typeof v?.[k] === 'string' && !Number.isNaN(Date.parse(v[k]))) return v[k].slice(0, 10);
  }
  return null;
};

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
        const when = stamp(entry);
        if (!when) worsen('unproven', `live ${e.ref}: passing but has no timestamp`);
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
        warns.push(`test file ${first} not found`);
        if (production) worsen('unproven', `test file ${first} not found`);
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
