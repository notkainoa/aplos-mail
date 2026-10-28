#!/usr/bin/env node
// Contrast, coverage and identity checks for the Paper tokens (DESIGN 12.4).
//   --contrast  every declared pair, resolved from tokens.json, meets its WCAG
//               2.x minimum in every mode (APCA Lc printed as advice); the
//               committed contrast-pairs.json must match; and token coverage
//   --identity  ΔE00 of accent, hill, dusk and stamp against DESIGN 12.4's
//               gated reference list (Avec plus the audited brand and link
//               blues), the not-Avec distances, and the shell's Lab b*; every
//               other audited colour is printed as advice and never gated
// Both run by default. Exits 1 on any failure.
// --tokens, --pairs and --refs point at other copies (used by the tests);
// --today YYYY-MM-DD fixes the date used for identity exception review dates.
//
// Coverage: a colour token whose $extensions.aplos.usage includes text or
// nontext must be the foreground of a pair in every mode, unless
// $extensions.aplos.unpairedModes names that mode with a reason. A colour token
// whose usage is only surface, decorative, shadow or overlay must be the
// background of a pair or carry $extensions.aplos.unpairedReason. A colour token
// with no usage fails, and so does a colour literal in a token of another $type.
//
// Pair minimums cannot go below 4.5 (text) or 3 (nontext). The only accepted
// exceptions are those in ALLOWED_EXCEPTIONS below, each with a ratio floor.

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { buildPairs, pairsDocument } from './build-tokens.mjs';
import { apcaLc, contrastRatio, deltaE2000, toHex, toLab } from './color.mjs';
import {
  COLOR_USAGES,
  GENERATED_DIR,
  MODES,
  PAIR_MINIMUMS,
  REFERENCES_PATH,
  TOKENS_PATH,
  aliasPath,
  colorTokens,
  declaredPairs,
  flattenTokens,
  isAlias,
  lookup,
  pairModes,
  readJson,
  solidColor,
} from './tokens-lib.mjs';

const PAIRS_PATH = join(GENERATED_DIR, 'contrast-pairs.json');
const PAIRED_USAGES = ['text', 'nontext'];
const COLOR_LITERAL =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i;

// The only pairs allowed to sit under their minimum. Anything else that
// declares an `exception` in tokens.json fails.
export const ALLOWED_EXCEPTIONS = [
  {
    id: 'line-strong-on-canvas',
    modes: ['light', 'dark'],
    decision: 'DESIGN decision 20',
    floor: 1.3,
  },
];

function pad(text, width) {
  return String(text).padEnd(width);
}

// ---------- contrast ----------

function allowedException(pair) {
  return ALLOWED_EXCEPTIONS.find(
    e =>
      e.id === pair.id &&
      e.modes.includes(pair.mode) &&
      pair.exception &&
      pair.exception.decision === e.decision,
  );
}

// Status of one resolved pair: pass, exception or FAIL (with a note).
function pairStatus(pair, ratio) {
  const floor = PAIR_MINIMUMS[pair.kind];
  if (floor === undefined) {
    return { status: 'FAIL', note: `unknown kind ${pair.kind}; use text or nontext` };
  }
  if (typeof pair.min !== 'number' || pair.min < floor) {
    return {
      status: 'FAIL',
      note: `declared min ${pair.min} is below the ${floor} required for ${pair.kind}`,
    };
  }
  if (ratio >= pair.min) {
    return { status: 'pass' };
  }
  if (!pair.exception) {
    return { status: 'FAIL', note: `${ratio.toFixed(2)} < ${pair.min}` };
  }
  const allowed = allowedException(pair);
  if (!allowed) {
    return {
      status: 'FAIL',
      note: `${ratio.toFixed(2)} < ${pair.min} and its exception is not on the allow-list in check-contrast.mjs`,
    };
  }
  if (ratio < allowed.floor) {
    return {
      status: 'FAIL',
      note: `${ratio.toFixed(2)} is below the ${allowed.floor} floor of its accepted exception`,
    };
  }
  return { status: 'exception' };
}

export function evaluatePairs(pairsDoc) {
  return pairsDoc.pairs.map(pair => {
    const ratio = contrastRatio(pair.fgRgb, pair.bgRgb);
    const lc = apcaLc(pair.fgRgb, pair.bgRgb);
    return { ...pair, ratio, lc, ...pairStatus(pair, ratio) };
  });
}

function printPairs(results) {
  const ids = [...new Set(results.map(r => r.id))];
  const header = `${pad('pair', 52)} ${pad('min', 4)} ${MODES.map(m => pad(m, 22)).join(' ')}`;
  console.log(header);
  for (const id of ids) {
    const rows = results.filter(r => r.id === id);
    const cells = MODES.map(mode => {
      const r = rows.find(row => row.mode === mode);
      if (!r) {
        return pad('-', 22);
      }
      const mark = r.status === 'pass' ? '' : r.status === 'exception' ? ' EXC' : ' FAIL';
      return pad(`${r.ratio.toFixed(2)} Lc${r.lc.toFixed(0)}${mark}`, 22);
    });
    console.log(`${pad(id, 52)} ${pad(rows[0].min, 4)} ${cells.join(' ')}`);
  }
}

// Token paths a pair paints underneath its foreground: bg, its mix base, over.
function backgroundPaths(pair) {
  const refs = [typeof pair.bg === 'string' ? pair.bg : pair.bg.mix, pair.over];
  return refs.filter(ref => isAlias(ref)).map(ref => aliasPath(ref));
}

// Modes in which no pair (of the wanted kind) has this token as foreground,
// minus modes excused by $extensions.aplos.unpairedModes.
function unpairedModes(token, pairs, kind) {
  const excused = token.ext.unpairedModes ?? {};
  return MODES.filter(mode => {
    if (typeof excused[mode] === 'string' && excused[mode].trim() !== '') {
      return false;
    }
    return !pairs.some(
      p =>
        aliasPath(p.fg) === token.path && pairModes(p).includes(mode) && (!kind || p.kind === kind),
    );
  });
}

function coverageOf(token, pairs) {
  const usage = token.usage;
  if (!Array.isArray(usage) || usage.length === 0) {
    return [
      `${token.path}: no $extensions.aplos.usage; declare how it is used (${COLOR_USAGES.join(', ')})`,
    ];
  }
  const problems = [];
  const unknown = usage.filter(u => !COLOR_USAGES.includes(u));
  if (unknown.length > 0) {
    problems.push(`${token.path}: unknown usage ${unknown.join(', ')}`);
  }
  if (!usage.some(u => PAIRED_USAGES.includes(u))) {
    const isBackground = pairs.some(p => backgroundPaths(p).includes(token.path));
    const reason = token.ext.unpairedReason;
    if (!isBackground && !(typeof reason === 'string' && reason.trim() !== '')) {
      problems.push(
        `${token.path}: ${usage.join(', ')} colour is the background of no pair; declare a pair or give $extensions.aplos.unpairedReason`,
      );
    }
    return problems;
  }
  if (usage.includes('text')) {
    const missing = unpairedModes(token, pairs, 'text');
    if (missing.length > 0) {
      problems.push(
        `${token.path}: used as text but is the foreground of no text pair in ${missing.join(', ')}`,
      );
    }
  }
  if (usage.includes('nontext')) {
    const missing = unpairedModes(token, pairs);
    if (missing.length > 0) {
      problems.push(
        `${token.path}: used as a non-text foreground but appears in no pair in ${missing.join(', ')}`,
      );
    }
  }
  return problems;
}

function containsColorLiteral(value) {
  if (typeof value === 'string') {
    return COLOR_LITERAL.test(value);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).some(v => containsColorLiteral(v));
  }
  return false;
}

// A colour may only enter through a $type color token, so it cannot dodge
// coverage by being typed as a string, shadow or anything else.
export function colorLiteralProblems(flat) {
  return flat.tokens
    .filter(t => t.type !== 'color')
    .filter(t => [t.value, t.dark, t.more, t.reduced].some(v => containsColorLiteral(v)))
    .map(
      t =>
        `${t.path}: $type ${t.type} holds a colour literal; make it a $type color token (with usage and pairs) and reference it`,
    );
}

export function checkCoverage(flat) {
  const pairs = declaredPairs(flat);
  const problems = colorTokens(flat).flatMap(token => coverageOf(token, pairs));
  return [...problems, ...colorLiteralProblems(flat)];
}

// The committed contrast-pairs.json must be what tokens.json produces now.
export function pairsFileProblems(flat, pairsPath) {
  if (!existsSync(pairsPath)) {
    return [`${pairsPath} is missing; run node apps/desktop/scripts/design/build-tokens.mjs`];
  }
  if (readFileSync(pairsPath, 'utf8') !== buildPairs(flat)) {
    return [
      'contrast-pairs.json is stale (it no longer matches tokens.json); run node apps/desktop/scripts/design/build-tokens.mjs',
    ];
  }
  return [];
}

function runContrast(flat, pairsPath) {
  console.log('Contrast (WCAG 2.x; APCA Lc advisory), resolved from tokens.json');
  const results = evaluatePairs(pairsDocument(flat));
  printPairs(results);
  const failures = results.filter(r => r.status === 'FAIL');
  const exceptions = results.filter(r => r.status === 'exception');
  for (const r of exceptions) {
    console.log(
      `Accepted exception: ${r.id} in ${r.mode} at ${r.ratio.toFixed(2)} (${r.exception.decision}): ${r.exception.reason}`,
    );
  }
  for (const r of failures) {
    console.log(`FAIL ${r.id} in ${r.mode}: ${r.note} (${r.fgHex} on ${r.bgHex}) — ${r.usage}`);
  }
  const coverage = checkCoverage(flat);
  for (const problem of coverage) {
    console.log(`FAIL coverage: ${problem}`);
  }
  const stale = pairsFileProblems(flat, pairsPath);
  for (const problem of stale) {
    console.log(`FAIL ${problem}`);
  }
  const passed = results.length - failures.length - exceptions.length;
  console.log(
    `Contrast: ${results.length} checks, ${passed} pass, ${exceptions.length} accepted exception, ${failures.length} fail; coverage ${coverage.length === 0 ? 'ok' : `${coverage.length} problem(s)`}; contrast-pairs.json ${stale.length === 0 ? 'current' : 'stale'}.`,
  );
  return failures.length + coverage.length + stale.length;
}

// ---------- identity ----------

// An identity exception needs a decision reference and a review date that has
// not passed, so it cannot sit in the list unreviewed.
export function identityExceptionProblems(refs, today) {
  return (refs.exceptions ?? []).flatMap(e => {
    const name = `${e.token} ${e.mode} vs ${e.reference}`;
    if (typeof e.decision !== 'string' || e.decision.trim() === '') {
      return [`identity exception ${name} has no decision reference`];
    }
    if (typeof e.reviewBy !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy)) {
      return [`identity exception ${name} has no reviewBy date (YYYY-MM-DD)`];
    }
    if (e.reviewBy < today) {
      return [
        `identity exception ${name} expired on ${e.reviewBy}; settle it (${e.decision}) and remove or renew the entry`,
      ];
    }
    return [];
  });
}

function isExcepted(refs, tokenPath, mode, hex) {
  return (refs.exceptions ?? []).find(
    e =>
      aliasPath(e.token) === tokenPath &&
      e.mode === mode &&
      e.reference.toLowerCase() === hex.toLowerCase(),
  );
}

export function identityResults(flat, refs) {
  const rows = [];
  for (const ref of refs.targets) {
    const token = lookup(flat, ref);
    for (const mode of ['light', 'dark']) {
      const hex = toHex(solidColor(flat, ref, mode));
      for (const reference of refs.references) {
        const de = deltaE2000(hex, reference.hex);
        const exception = isExcepted(refs, token.path, mode, reference.hex);
        const status = de >= refs.threshold ? 'pass' : exception ? 'exception' : 'FAIL';
        rows.push({ token: token.css, mode, hex, reference, de, status, exception });
      }
    }
  }
  return rows;
}

// Nearest colour for anything outside the gate, printed and never failing:
// each gated target against the advisory colours (every audited colour that
// DESIGN 12.4 leaves out, such as Mimestream's system green), and each
// advisory target (the tag colours) against both lists.
export function advisoryResults(flat, refs) {
  const advisoryRefs = refs.advisoryReferences ?? [];
  const nearestOf = (ref, list) =>
    ['light', 'dark'].map(mode => {
      const hex = toHex(solidColor(flat, ref, mode));
      const nearest = list
        .map(reference => ({ reference, de: deltaE2000(hex, reference.hex) }))
        .reduce((a, b) => (b.de < a.de ? b : a));
      return { token: lookup(flat, ref).css, mode, hex, ...nearest };
    });
  const rows =
    advisoryRefs.length > 0 ? refs.targets.flatMap(ref => nearestOf(ref, advisoryRefs)) : [];
  const all = [...refs.references, ...advisoryRefs];
  return [...rows, ...(refs.advisoryTargets?.tokens ?? []).flatMap(ref => nearestOf(ref, all))];
}

// An exception that no gated distance needs (it passes now, or its colour is
// not on the gated list) is stale and must be removed.
export function unusedExceptionProblems(rows, refs) {
  return (refs.exceptions ?? [])
    .filter(e => !rows.some(r => r.status === 'exception' && r.exception === e))
    .map(
      e =>
        `identity exception ${e.token} ${e.mode} vs ${e.reference} is not needed (no gated distance under ${refs.threshold} uses it); remove it`,
    );
}

export function notAvecResults(flat, refs) {
  const rows = [];
  for (const check of refs.notAvec.checks) {
    const token = lookup(flat, check.token);
    for (const mode of ['light', 'dark']) {
      const hex = toHex(solidColor(flat, check.token, mode));
      for (const refHex of check.references) {
        const de = deltaE2000(hex, refHex);
        rows.push({ token: token.css, mode, hex, refHex, de, pass: de >= refs.notAvec.minimum });
      }
    }
  }
  return rows;
}

export function shellResults(flat, refs) {
  return ['light', 'dark'].map(mode => {
    const hex = toHex(solidColor(flat, refs.shell.token, mode));
    const [, , b] = toLab(hex);
    return { mode, hex, b, pass: b < refs.shell.maxB };
  });
}

function runIdentity(flat, refs, today) {
  console.log(`Identity (ΔE00, minimum ${refs.threshold})`);
  const rows = identityResults(flat, refs);
  const nearest = new Map();
  for (const row of rows) {
    const key = `${row.token} ${row.mode}`;
    if (!nearest.has(key) || nearest.get(key).de > row.de) {
      nearest.set(key, row);
    }
  }
  for (const [key, row] of nearest) {
    console.log(
      `  ${pad(key, 16)} ${row.hex}  nearest ${row.de.toFixed(2)} ${row.reference.name} ${row.reference.hex}`,
    );
  }
  const failures = rows.filter(r => r.status === 'FAIL');
  for (const r of rows.filter(row => row.status === 'exception')) {
    console.log(
      `Accepted exception (${r.exception.status}): ${r.token} ${r.mode} ${r.de.toFixed(2)} from ${r.reference.name} ${r.reference.hex}`,
    );
  }
  for (const r of failures) {
    console.log(
      `FAIL identity: ${r.token} ${r.mode} ${r.hex} is ${r.de.toFixed(2)} from ${r.reference.name} ${r.reference.hex}`,
    );
  }

  const expired = [
    ...identityExceptionProblems(refs, today),
    ...unusedExceptionProblems(rows, refs),
  ];
  for (const problem of expired) {
    console.log(`FAIL ${problem}`);
  }
  const advisory = advisoryResults(flat, refs);
  if (advisory.length > 0) {
    console.log(
      'Advisory, not gated (DESIGN 12.4 gates only Avec and the audited brand and link blues; tags are outside the gate)',
    );
    for (const r of advisory) {
      const flag = r.de < refs.threshold ? ` (under ${refs.threshold})` : '';
      console.log(
        `  ${pad(`${r.token} ${r.mode}`, 18)} ${r.hex}  nearest ${r.de.toFixed(2)} ${r.reference.name} ${r.reference.hex}${flag}`,
      );
    }
  }

  console.log(`Not Avec (DESIGN 2.3, minimum ${refs.notAvec.minimum})`);
  const avec = notAvecResults(flat, refs);
  for (const r of avec) {
    console.log(
      `  ${pad(`${r.token} ${r.mode}`, 16)} ${r.hex} vs ${r.refHex}: ${r.de.toFixed(2)}${r.pass ? '' : ' FAIL'}`,
    );
  }

  console.log('Shell Lab b* (must be below 0)');
  const shell = shellResults(flat, refs);
  for (const r of shell) {
    console.log(`  ${pad(r.mode, 6)} ${r.hex}: b* ${r.b.toFixed(2)}${r.pass ? '' : ' FAIL'}`);
  }
  const failed =
    failures.length +
    expired.length +
    avec.filter(r => !r.pass).length +
    shell.filter(r => !r.pass).length;
  const excepted = rows.filter(r => r.status === 'exception').length;
  console.log(
    `Identity: ${rows.length + avec.length + shell.length} checks, ${excepted} accepted exception, ${failed} fail.`,
  );
  return failed;
}

// ---------- driver ----------

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export function run(args) {
  const flat = flattenTokens(readJson(resolve(argValue(args, '--tokens') ?? TOKENS_PATH)));
  const doContrast = args.includes('--contrast') || !args.includes('--identity');
  const doIdentity = args.includes('--identity') || !args.includes('--contrast');
  let failures = 0;
  if (doContrast) {
    failures += runContrast(flat, resolve(argValue(args, '--pairs') ?? PAIRS_PATH));
  }
  if (doIdentity) {
    const today = argValue(args, '--today') ?? new Date().toISOString().slice(0, 10);
    failures += runIdentity(
      flat,
      readJson(resolve(argValue(args, '--refs') ?? REFERENCES_PATH)),
      today,
    );
  }
  console.log(failures === 0 ? 'All design checks passed.' : `${failures} design check(s) failed.`);
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
