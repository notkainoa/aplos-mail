#!/usr/bin/env node
// Path-ownership check (roadmap artifact F10, plan 40 Q1b deliverable 11).
//
// Reads plans/OWNERS.md and fails a change that touches files owned by another lane unless that
// lane approved it. Format of OWNERS.md (full text in scripts/audit/OWNERS-FORMAT.md):
//   - Markdown tables with a header row naming the columns Path (or Paths), Lane and Thread
//     (case-insensitive; other columns are ignored; text outside tables is ignored).
//   - The Path cell holds backticked globs separated by commas or <br>. Globs support "**", "*",
//     "?" and "{a,b}". A trailing "/" means "everything below".
//   - Lane "*" or "all" marks a shared path anyone may edit.
//   - The MOST SPECIFIC matching glob wins: longest literal prefix before the first wildcard, then
//     fewer wildcards, then the longer glob. Two different lanes tying is a validation error.
//
// Usage:
//   node scripts/audit/owners-check.mjs [--base <ref>] [--head <ref>] [--lane <lane,...>]
//        [--approved <lane,...>] [--pr <n>] [--owners <file>] [--validate] [--strict] [--json]
//
// Acting lanes: --lane, else the branch name (rv/<lane>/<slug> is that lane; rv/thread/<name> is
// every lane whose Thread column names that thread; in a detached CI checkout GITHUB_HEAD_REF is
// used). Approvals: --approved, "Lane-Approved: <lane>" commit trailers in base..head, and with
// --pr the PR labels "lane-approved:<lane>" (read-only `gh pr view`).
// Exit codes: 0 ok (or OWNERS.md missing: pending), 1 violations or invalid OWNERS.md, 2 usage or
// environment error.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_OWNERS = 'plans/OWNERS.md';
const SHARED = '*';
const MAX_ROWS = 40;

// ---------- globs ----------

export function expandBraces(glob) {
  const open = glob.indexOf('{');
  if (open === -1) {
    if (glob.includes('}')) throw new Error(`unbalanced "}" in glob ${glob}`);
    return [glob];
  }
  let depth = 0;
  let start = open + 1;
  const parts = [];
  for (let i = open; i < glob.length; i++) {
    const c = glob[i];
    if (c === '{') depth++;
    else if (c === ',' && depth === 1) {
      parts.push(glob.slice(start, i));
      start = i + 1;
    } else if (c === '}' && --depth === 0) {
      parts.push(glob.slice(start, i));
      const head = glob.slice(0, open);
      const tail = glob.slice(i + 1);
      return parts.flatMap(part => expandBraces(head + part + tail));
    }
  }
  throw new Error(`unbalanced "{" in glob ${glob}`);
}

export function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function compileGlob(raw) {
  let glob = raw.trim().replace(/^\.?\//, '');
  if (glob.endsWith('/')) glob += '**';
  const firstWildcard = glob.search(/[*?]/);
  return {
    glob,
    re: globToRegExp(glob),
    prefix: firstWildcard === -1 ? glob.length : firstWildcard,
    wildcards: (glob.match(/\*\*|\*|\?/g) ?? []).length,
    length: glob.length,
  };
}

const bySpecificity = (a, b) => b.prefix - a.prefix || a.wildcards - b.wildcards || b.length - a.length;
const sameSpecificity = (a, b) => bySpecificity(a, b) === 0;

/** Returns null (unowned), { rule } or { ambiguous: true, rules } for the best matching rule. */
export function resolveOwner(rules, file) {
  const matches = rules.filter(rule => rule.re.test(file)).sort(bySpecificity);
  if (!matches.length) return null;
  const top = matches.filter(rule => sameSpecificity(rule, matches[0]));
  const lanes = [...new Set(top.map(rule => rule.lane))];
  if (lanes.length > 1) return { ambiguous: true, rules: top, lanes };
  return { rule: top[0] };
}

// ---------- OWNERS.md parsing ----------

const splitRow = line => {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.map(cell => cell.trim());
};
const isSeparator = line => /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line.trim()) && line.includes('-');
const stripMarkup = cell => cell.replace(/[`*_\\]/g, ' ').trim().toLowerCase();

function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const c of text) {
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (c === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else current += c;
  }
  out.push(current);
  return out.map(s => s.trim()).filter(Boolean);
}

function extractGlobs(cell) {
  const ticks = [...cell.matchAll(/`([^`]+)`/g)].map(m => m[1]);
  const pieces = ticks.length ? ticks : [cell.replace(/<br\s*\/?>/gi, ',')];
  return pieces.flatMap(splitTopLevel).filter(glob => !/^(-|—|–|n\/a)$/i.test(glob));
}

// Strips backticks, escapes and **bold** but keeps a bare "*" (the shared lane).
const cleanCell = cell => cell.replace(/\*\*(.+?)\*\*/g, '$1').replace(/[`\\]/g, '').trim();
const normalizeLane = cell => {
  const lane = cleanCell(cell).toLowerCase();
  return lane === 'all' ? SHARED : lane;
};

export function parseOwners(text) {
  const rules = [];
  const errors = [];
  const laneThread = new Map();
  const lines = text.split(/\r?\n/);
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
    if (fenced || !lines[i].trim().startsWith('|') || !lines[i + 1] || !isSeparator(lines[i + 1])) continue;
    const header = splitRow(lines[i]).map(stripMarkup);
    const pathCol = header.findIndex(h => h === 'path' || h === 'paths');
    const laneCol = header.indexOf('lane');
    const threadCol = header.indexOf('thread');
    let row = i + 2;
    for (; row < lines.length && lines[row].trim().startsWith('|'); row++) {
      if (pathCol === -1 || laneCol === -1) continue;
      const cells = splitRow(lines[row]);
      const lane = normalizeLane(cells[laneCol] ?? '');
      const thread = threadCol === -1 ? '' : cleanCell(cells[threadCol] ?? '');
      const where = `line ${row + 1}`;
      const globs = extractGlobs(cells[pathCol] ?? '');
      if (!globs.length) continue;
      if (!lane) {
        errors.push(`${where}: row has paths but no lane`);
        continue;
      }
      if (thread && lane !== SHARED) {
        const known = laneThread.get(lane);
        if (known && known !== thread) errors.push(`${where}: lane ${lane} is in thread "${thread}" but earlier in "${known}"`);
        else laneThread.set(lane, thread);
      }
      for (const raw of globs) {
        try {
          for (const expanded of expandBraces(raw)) rules.push({ ...compileGlob(expanded), lane, line: row + 1 });
        } catch (error) {
          errors.push(`${where}: ${error.message}`);
        }
      }
    }
    if (pathCol !== -1 && laneCol === -1) errors.push(`line ${i + 1}: table has a Path column but no Lane column`);
    i = row - 1;
  }
  if (!rules.length) errors.push('no ownership rows found (need a table with Path and Lane columns)');
  // The same glob given to two different lanes is a tie by construction.
  const seen = new Map();
  for (const rule of rules) {
    const earlier = seen.get(rule.glob);
    if (earlier && earlier.lane !== rule.lane) {
      errors.push(`tie: glob ${rule.glob} is listed for ${earlier.lane} (line ${earlier.line}) and ${rule.lane} (line ${rule.line})`);
    } else if (!earlier) seen.set(rule.glob, rule);
  }
  const lanes = new Set(rules.map(rule => rule.lane).filter(lane => lane !== SHARED));
  return { rules, errors, laneThread, lanes };
}

// ---------- git and CLI plumbing ----------

class UsageError extends Error {}

function git(args, cwd, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (allowFail) return null;
    throw new UsageError(`git ${args.join(' ')} failed: ${String(error.stderr ?? error.message).trim()}`);
  }
}

const VALUE_OPTIONS = new Set(['base', 'head', 'lane', 'approved', 'pr', 'owners']);
const FLAG_OPTIONS = new Set(['validate', 'strict', 'json', 'help']);

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [name, inline] = arg.startsWith('--') ? arg.slice(2).split(/=(.*)/s) : [null];
    if (name && FLAG_OPTIONS.has(name)) opts[name] = true;
    else if (name && VALUE_OPTIONS.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      opts[name] = value;
    } else throw new UsageError(`unknown argument ${arg} (see the header of scripts/audit/owners-check.mjs)`);
  }
  return opts;
}

const csv = value => String(value ?? '').split(/[,\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
const normalizeName = name => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function lanesForThread(name, laneThread) {
  const wanted = normalizeName(name);
  return [...laneThread]
    .filter(([, thread]) => {
      const t = normalizeName(thread);
      return t === wanted || t.startsWith(`${wanted} `);
    })
    .map(([lane]) => lane);
}

function actingLanes(opts, cwd, { lanes: known, laneThread }) {
  if (opts.lane) {
    const lanes = csv(opts.lane);
    const unknown = lanes.filter(lane => !known.has(lane));
    if (unknown.length) throw new UsageError(`unknown lane ${unknown.join(', ')}; known lanes: ${[...known].join(', ')}`);
    return lanes;
  }
  let branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim();
  if (branch === 'HEAD') branch = process.env.GITHUB_HEAD_REF || 'HEAD';
  const thread = branch.match(/^rv\/thread\/(.+)$/);
  if (thread) {
    const lanes = lanesForThread(thread[1], laneThread);
    if (!lanes.length) throw new UsageError(`no lanes belong to thread "${thread[1]}" in OWNERS.md; pass --lane`);
    return lanes;
  }
  const lane = branch.match(/^rv\/([^/]+)\/.+$/)?.[1];
  if (lane && known.has(lane)) return [lane];
  throw new UsageError(`cannot tell the acting lane from branch "${branch}"; pass --lane <lane> (known lanes: ${[...known].join(', ')})`);
}

function defaultBase(head, cwd) {
  for (const ref of ['origin/revamp', 'revamp']) {
    const base = git(['merge-base', head, ref], cwd, { allowFail: true })?.trim();
    if (base) return base;
  }
  throw new UsageError('cannot find origin/revamp or revamp to diff against; pass --base <ref>');
}

/** Every path touched between base and head; a rename counts both its old and new path. */
function changedFiles(base, head, cwd) {
  const tokens = git(['diff', '--name-status', '-M', '-z', `${base}...${head}`], cwd).split('\0');
  const files = new Set();
  for (let i = 0; i < tokens.length && tokens[i]; ) {
    const status = tokens[i++];
    const count = /^[RC]/.test(status) ? 2 : 1;
    for (let k = 0; k < count; k++) files.add(tokens[i++]);
  }
  return [...files].sort();
}

function approvals(opts, base, head, cwd) {
  const found = new Map();
  const add = (lanes, source) => lanes.forEach(lane => found.has(lane) || found.set(lane, source));
  add(csv(opts.approved), '--approved');
  const trailers = git(['log', '--format=%(trailers:key=Lane-Approved,valueonly)', `${base}..${head}`], cwd);
  add(csv(trailers), 'trailer');
  if (opts.pr) {
    let labels;
    try {
      const out = execFileSync('gh', ['pr', 'view', String(opts.pr), '--json', 'labels'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      labels = JSON.parse(out).labels.map(label => label.name);
    } catch (error) {
      throw new UsageError(`could not read labels of PR ${opts.pr} with gh: ${String(error.stderr ?? error.message).trim()}`);
    }
    add(labels.map(l => l.match(/^lane-approved:(.+)$/i)?.[1]).filter(Boolean).map(l => l.toLowerCase()), 'PR label');
  }
  return found;
}

// ---------- modes ----------

const pad = (rows) => {
  const widths = rows[0].map((_, col) => Math.max(...rows.map(row => String(row[col]).length)));
  return rows.map(row => '  ' + row.map((cell, col) => String(cell).padEnd(widths[col])).join('  ').trimEnd()).join('\n');
};

function topAreas(files) {
  const counts = new Map();
  for (const file of files) {
    const parts = file.split('/');
    const area = parts.length > 2 && ['apps', 'packages'].includes(parts[0]) ? parts.slice(0, 2).join('/') : parts[0];
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function runValidate(parsed, opts, cwd, out) {
  const errors = [...parsed.errors];
  const tracked = git(['ls-files', '-z'], cwd).split('\0').filter(Boolean);
  const unowned = [];
  const tieFiles = new Map();
  for (const file of tracked) {
    const owner = resolveOwner(parsed.rules, file);
    if (!owner) unowned.push(file);
    else if (owner.ambiguous) tieFiles.set(owner.lanes.join(' vs '), [...(tieFiles.get(owner.lanes.join(' vs ')) ?? []), file]);
  }
  for (const [lanes, files] of tieFiles) errors.push(`tie between ${lanes} on ${files.length} file(s), e.g. ${files[0]}`);
  const areas = topAreas(unowned);
  const result = { mode: 'validate', ok: !errors.length && !(opts.strict && unowned.length), errors, trackedFiles: tracked.length, unowned: unowned.length, unownedAreas: Object.fromEntries(areas), unownedFiles: unowned };
  if (opts.json) return out(JSON.stringify(result, null, 2)), result.ok;
  out(`owners-check --validate: ${parsed.rules.length} rule(s), ${new Set(parsed.rules.map(r => r.lane)).size} lane(s), ${tracked.length} tracked file(s)`);
  if (errors.length) out(`errors (${errors.length}):\n${errors.map(e => `  ${e}`).join('\n')}`);
  if (unowned.length) {
    out(`warning: ${unowned.length} tracked file(s) match no glob:\n${pad(areas.map(([area, n]) => [area, n]))}`);
    out(unowned.slice(0, 15).map(f => `    ${f}`).join('\n') + (unowned.length > 15 ? `\n    ... and ${unowned.length - 15} more (use --json for all)` : ''));
  }
  out(result.ok ? `OK: OWNERS.md is valid${unowned.length ? ` (${unowned.length} unowned file(s), pass --strict to fail on them)` : ''}` : `FAIL: ${errors.length ? `${errors.length} error(s)` : `${unowned.length} unowned file(s) under --strict`}`);
  return result.ok;
}

function runCheck(parsed, opts, cwd, out) {
  const head = opts.head ?? 'HEAD';
  const base = opts.base ?? defaultBase(head, cwd);
  const lanes = actingLanes(opts, cwd, parsed);
  const approved = approvals(opts, base, head, cwd);
  const files = changedFiles(base, head, cwd);
  const violations = [];
  for (const file of files) {
    const owner = resolveOwner(parsed.rules, file);
    if (!owner) violations.push({ file, owner: null, reason: 'unowned' });
    else if (owner.ambiguous) violations.push({ file, owner: owner.lanes.join(' vs '), reason: 'ambiguous' });
    else {
      const lane = owner.rule.lane;
      if (lane !== SHARED && !lanes.includes(lane) && !approved.has(lane)) violations.push({ file, owner: lane, reason: 'other-lane' });
    }
  }
  const ok = !violations.length;
  const result = { mode: 'check', ok, base, head, actingLanes: lanes, approvedLanes: Object.fromEntries(approved), changedFiles: files, violations };
  if (opts.json) return out(JSON.stringify(result, null, 2)), ok;
  out(`owners-check: acting lane(s) ${lanes.join(', ')}; ${files.length} changed file(s) in ${base.slice(0, 10)}...${head}`);
  if (approved.size) out(`approved: ${[...approved].map(([lane, source]) => `${lane} (${source})`).join(', ')}`);
  if (!ok) {
    const shown = violations.slice(0, MAX_ROWS);
    out(pad([['FILE', 'OWNER', 'ACTING'], ...shown.map(v => [v.file, v.owner ?? '(unowned)', lanes.join(',')])]));
    if (violations.length > shown.length) out(`  ... and ${violations.length - shown.length} more (use --json for all)`);
    if (violations.some(v => v.reason === 'unowned')) out('Unowned file(s): ask the Integrator to add them to plans/OWNERS.md.');
    if (violations.some(v => v.reason === 'ambiguous')) out('Ambiguous file(s): two lanes own the same path equally; the Integrator must fix plans/OWNERS.md.');
    if (violations.some(v => v.reason === 'other-lane')) out('Other-lane file(s): get the owning lane to approve (commit trailer "Lane-Approved: <lane>", --approved <lane>, or PR label "lane-approved:<lane>").');
  }
  out(ok ? `OK: ${files.length} file(s) within ${lanes.join(', ')}, shared or approved` : `FAIL: ${violations.length} of ${files.length} changed file(s) outside lane ${lanes.join(', ')}`);
  return ok;
}

export function main(argv, { cwd = process.cwd(), out = console.log } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    out('usage: node scripts/audit/owners-check.mjs [--base <ref>] [--head <ref>] [--lane <lane,...>] [--approved <lane,...>] [--pr <n>] [--owners <file>] [--validate] [--strict] [--json]');
    return 0;
  }
  const root = git(['rev-parse', '--show-toplevel'], cwd).trim();
  const ownersPath = opts.owners ? path.resolve(cwd, opts.owners) : path.join(root, DEFAULT_OWNERS);
  if (!existsSync(ownersPath)) {
    if (opts.owners) throw new UsageError(`owners file ${opts.owners} not found`);
    out(opts.json ? JSON.stringify({ pending: true, ok: true, message: `plans/OWNERS.md not on this branch yet` }) : 'pending: plans/OWNERS.md not on this branch yet');
    return 0;
  }
  const parsed = parseOwners(readFileSync(ownersPath, 'utf8'));
  if (!opts.validate && parsed.errors.length) {
    out(`owners-check: ${path.relative(root, ownersPath)} is invalid:\n${parsed.errors.map(e => `  ${e}`).join('\n')}\nRun with --validate for details.`);
    return 1;
  }
  const ok = opts.validate ? runValidate(parsed, opts, root, out) : runCheck(parsed, opts, root, out);
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`owners-check: ${error.message}`);
    process.exitCode = 2;
  }
}
