#!/usr/bin/env node
// Path-ownership check (roadmap artifact F10, plan 40 Q1b deliverable 11).
//
// Reads plans/OWNERS.md and fails a change that touches files owned by another lane unless that
// lane approved it. Format of OWNERS.md (full text in scripts/audit/OWNERS-FORMAT.md):
//   - Markdown tables with a Path (or Paths) column and a Lane (or Owner) column, optionally a
//     Thread column (else the "... thread" heading above the table). Other columns and text outside
//     tables are ignored; malformed tables are errors, never silently dropped.
//   - The Path cell holds backticked globs separated by commas or <br>. Globs support "**", "*",
//     "?" and "{a,b}"; write "dir/**" for everything below (a glob ending in "/" is ignored).
//   - Lane "*" or "all" marks a shared path anyone may edit.
//   - The MOST SPECIFIC matching glob wins: longest literal prefix before the first wildcard, then
//     fewer wildcards, then the longer glob. Two different lanes tying is a validation error.
//
// Usage:
//   node scripts/audit/owners-check.mjs [--base <ref>] [--head <ref>] [--lane <lane,...>]
//        [--approved <lane,...>] [--pr <n>] [--owners <file>] [--validate] [--strict]
//        [--trailers] [--json]
//
// The rules are read from the integration branch (the --base ref, else the tip of origin/revamp or
// revamp), never from the change being checked, so a PR cannot edit or delete OWNERS.md to pass.
// Acting lanes: --lane, else the branch name (rv/<lane>/<slug> is that lane; rv/thread/<name> is
// every lane of that thread; in a detached CI checkout GITHUB_HEAD_REF is used). Approvals:
// --approved and the PR labels "lane-approved:<lane>" (--pr, read-only `gh pr view`). Commit trailers
// ("Lane-Approved: <lane>[, <lane>]", covering only the files of their own commit) are written by the
// PR's own author, so they are self-attested and ignored unless --trailers is given.
// Exit codes: 0 ok (no changes, or OWNERS.md missing: pending), 1 violations or invalid OWNERS.md,
// 2 usage or environment error.

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
  const firstWildcard = glob.search(/[*?]/);
  return {
    glob,
    re: globToRegExp(glob),
    prefix: firstWildcard === -1 ? glob.length : firstWildcard,
    wildcards: (glob.match(/\*\*|\*|\?/g) ?? []).length,
    length: glob.length,
  };
}

const bySpecificity = (a, b) =>
  b.prefix - a.prefix || a.wildcards - b.wildcards || b.length - a.length;
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

// Paths that are shared in every OWNERS.md (roadmap section 7: append-only logs; the lockfile only
// changes together with a manifest). An explicit row for the same glob overrides the built-in one.
export const BUILTIN_SHARED = [
  'PROGRESS.md',
  'DECISIONS.md',
  'TODO.md',
  'plans/STATUS.md',
  'package-lock.json',
];

const LANE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED = 'reserved';

/** Splits a table row on unescaped pipes; "\|" is a literal pipe inside a cell (GFM). */
const splitRow = line => {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells = [''];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '|') {
      cells[cells.length - 1] += '|';
      i++;
    } else if (text[i] === '|') cells.push('');
    else cells[cells.length - 1] += text[i];
  }
  return cells.map(cell => cell.trim());
};
const isSeparator = line =>
  /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line.trim()) && line.includes('-');
const stripMarkup = cell =>
  cell
    .replace(/[`*_\\]/g, ' ')
    .trim()
    .toLowerCase();

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

/**
 * Globs of a Path cell. Only the first sentence counts (later prose may mention paths), and
 * "(except ...)" notes are dropped because the more specific row of the other lane already carves
 * those paths out. With backticks only the backticked spans are globs; without, the whole cell is
 * split on commas and <br>.
 */
function extractGlobs(cell) {
  const text = cell.replace(/\((?:except|but not)\b[^)]*\)/gi, '').split(/\.\s+(?=[A-Z])/)[0];
  const ticks = [...text.matchAll(/`([^`]+)`/g)].map(m => m[1]);
  const pieces = ticks.length ? ticks : [text.replace(/<br\s*\/?>/gi, ',')];
  return pieces.flatMap(splitTopLevel).filter(glob => !/^(-|—|–|n\/a)$/i.test(glob));
}

// Strips backticks, escapes and **bold** but keeps a bare "*" (the shared lane).
const cleanCell = cell =>
  cell
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/[`\\]/g, '')
    .trim();
const normalizeLane = cell => {
  const lane = cleanCell(cell).toLowerCase();
  return lane === 'all' ? SHARED : lane;
};

/**
 * Round-2 rows reserve paths for lanes that do not exist this round. The Lane cell is prose
 * ("Round 2 (reserved ...)"), the Path cell has segments separated by ";" that may start with
 * "`lane`:"; a segment without a lane label belongs to the pseudo lane "reserved".
 */
function reservedSegments(pathCell) {
  const first = pathCell.split(/\.\s+(?=[A-Z])/)[0];
  return first.split(';').map(segment => {
    const labelled = segment.match(/^\s*`([a-z0-9-]+)`\s*:(.*)$/s);
    return labelled
      ? { lane: labelled[1], globs: extractGlobs(labelled[2]) }
      : { lane: RESERVED, globs: extractGlobs(segment) };
  });
}

export function parseOwners(text) {
  const rules = [];
  const errors = [];
  const warnings = [];
  const laneThread = new Map();
  const lines = text.split(/\r?\n/);
  let fenced = false;
  let headingThread = '';

  const addRules = (globs, lane, line, where) => {
    for (const raw of globs) {
      if (raw.trim().endsWith('/')) {
        warnings.push(
          `${where}: glob "${raw}" ends with "/" and is ignored; write "${raw.trim()}**" for everything below`,
        );
        continue;
      }
      try {
        for (const expanded of expandBraces(raw))
          rules.push({ ...compileGlob(expanded), lane, line });
      } catch (error) {
        errors.push(`${where}: ${error.message}`);
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (heading) {
      headingThread = heading[1].match(/^(.*\S)\s+thread$/i)?.[1] ?? '';
      continue;
    }
    if (!line.includes('|') || !lines[i + 1]?.includes('|') || !isSeparator(lines[i + 1])) continue;
    const start = i + 1;
    if (!line.trim().startsWith('|'))
      errors.push(`line ${start}: table header must start with "|"`);
    const header = splitRow(line).map(stripMarkup);
    const pathCol = header.findIndex(h => h === 'path' || h === 'paths');
    const laneCol = header.includes('lane') ? header.indexOf('lane') : header.indexOf('owner');
    const threadCol = header.indexOf('thread');
    if (pathCol !== -1 && laneCol === -1)
      errors.push(`line ${start}: table has a Path column but no Lane column`);
    if (laneCol !== -1 && pathCol === -1)
      errors.push(`line ${start}: table has a Lane column but no Path column`);
    let row = i + 2;
    for (
      ;
      row < lines.length &&
      lines[row].trim() &&
      !/^#{1,6}\s/.test(lines[row]) &&
      !/^\s*(```|~~~)/.test(lines[row]);
      row++
    ) {
      if (pathCol === -1 || laneCol === -1) continue;
      const where = `line ${row + 1}`;
      if (!lines[row].trim().startsWith('|')) {
        errors.push(
          `${where}: table row must start with "|" (a row without it is dropped from the table)`,
        );
        continue;
      }
      const cells = splitRow(lines[row]);
      if (cells.length !== header.length) {
        errors.push(
          `${where}: row has ${cells.length} cell(s) but the header has ${header.length} (unescaped or escaped "|" inside a cell?)`,
        );
        continue;
      }
      const laneCell = cleanCell(cells[laneCol]);
      if (/^round\s*2\b|reserved/i.test(laneCell)) {
        for (const { lane, globs } of reservedSegments(cells[pathCol]))
          addRules(globs, lane, row + 1, where);
        continue;
      }
      const lane = normalizeLane(cells[laneCol]);
      const globs = extractGlobs(cells[pathCol]);
      if (!globs.length) continue;
      if (!lane) {
        errors.push(`${where}: row has paths but no lane`);
        continue;
      }
      if (lane !== SHARED && !LANE_NAME.test(lane)) {
        errors.push(
          `${where}: invalid lane "${lane}" (a lane is a lowercase slug such as eng-store, or * for shared)`,
        );
        continue;
      }
      const thread = threadCol === -1 ? headingThread : cleanCell(cells[threadCol]);
      if (thread && lane !== SHARED) {
        const known = laneThread.get(lane);
        if (known && known !== thread)
          errors.push(`${where}: lane ${lane} is in thread "${thread}" but earlier in "${known}"`);
        else laneThread.set(lane, thread);
      }
      addRules(globs, lane, row + 1, where);
    }
    i = row - 1;
  }
  if (!rules.length)
    errors.push('no ownership rows found (need a table with Path and Lane columns)');
  for (const glob of BUILTIN_SHARED) {
    if (!rules.some(rule => rule.glob === glob))
      rules.push({ ...compileGlob(glob), lane: SHARED, line: 0, builtin: true });
  }
  // The same glob given to two different lanes is a tie by construction.
  const seen = new Map();
  for (const rule of rules) {
    const earlier = seen.get(rule.glob);
    if (earlier && earlier.lane !== rule.lane) {
      errors.push(
        `tie: glob ${rule.glob} is listed for ${earlier.lane} (line ${earlier.line}) and ${rule.lane} (line ${rule.line})`,
      );
    } else if (!earlier) seen.set(rule.glob, rule);
  }
  const lanes = new Set(rules.map(rule => rule.lane).filter(lane => lane !== SHARED));
  return { rules, errors, warnings, laneThread, lanes };
}

// ---------- git and CLI plumbing ----------

class UsageError extends Error {}

function git(args, cwd, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (allowFail) return null;
    throw new UsageError(
      `git ${args.join(' ')} failed: ${String(error.stderr ?? error.message).trim()}`,
    );
  }
}

const VALUE_OPTIONS = new Set(['base', 'head', 'lane', 'approved', 'pr', 'owners']);
const FLAG_OPTIONS = new Set(['validate', 'strict', 'json', 'help', 'trailers', 'no-trailers']);

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [name, inline] = arg.startsWith('--') ? arg.slice(2).split(/=(.*)/s) : [null];
    if (name === 'no-trailers') opts.trailers = false;
    else if (name && FLAG_OPTIONS.has(name)) opts[name] = true;
    else if (name && VALUE_OPTIONS.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      opts[name] = value;
    } else
      throw new UsageError(
        `unknown argument ${arg} (see the header of scripts/audit/owners-check.mjs)`,
      );
  }
  return opts;
}

const csv = value =>
  String(value ?? '')
    .split(/[,\s]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
const normalizeName = name =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Lanes of rv/thread/<name>: the threads named exactly <name> (punctuation and case ignored), else
 * the one thread whose name starts with <name> as whole words ("platform" is "Platform and
 * website"). A prefix that fits several threads ("ui") is an error. A lane whose own name is <name>
 * also counts (rv/thread/integrator acts as lane integrator).
 */
function lanesForThread(name, laneThread, known) {
  const wanted = normalizeName(name);
  const entries = [...laneThread].map(([lane, thread]) => [lane, normalizeName(thread)]);
  const exact = entries.filter(([, thread]) => thread === wanted);
  const pool = exact.length
    ? exact
    : entries.filter(([, thread]) => thread.startsWith(`${wanted} `));
  const threads = new Set(pool.map(([, thread]) => thread));
  if (threads.size > 1)
    throw new UsageError(
      `thread "${name}" is ambiguous (it fits ${[...threads].join(', ')}); use the full thread name`,
    );
  const lanes = pool.map(([lane]) => lane);
  for (const lane of known)
    if (normalizeName(lane) === wanted && !lanes.includes(lane)) lanes.push(lane);
  return lanes;
}

function currentBranch(cwd) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim();
  return branch === 'HEAD' ? process.env.GITHUB_HEAD_REF || 'HEAD' : branch;
}

function actingLanes(opts, branch, { lanes: known, laneThread }) {
  if (opts.lane) {
    const lanes = csv(opts.lane);
    const unknown = lanes.filter(lane => !known.has(lane));
    if (unknown.length)
      throw new UsageError(
        `unknown lane ${unknown.join(', ')}; known lanes: ${[...known].join(', ')}`,
      );
    return lanes;
  }
  const thread = branch.match(/^rv\/thread\/(.+)$/);
  if (thread) {
    const lanes = lanesForThread(thread[1], laneThread, known);
    if (!lanes.length)
      throw new UsageError(`no lanes belong to thread "${thread[1]}" in OWNERS.md; pass --lane`);
    return lanes;
  }
  const lane = branch.match(/^rv\/([^/]+)\/.+$/)?.[1];
  if (lane && known.has(lane)) return [lane];
  throw new UsageError(
    `cannot tell the acting lane from branch "${branch}"; pass --lane <lane> (known lanes: ${[...known].join(', ')})`,
  );
}

/** The branch the rules are read from (its tip, like CODEOWNERS) and the merge-base to diff from. */
function integrationRef(cwd) {
  for (const ref of ['origin/revamp', 'revamp'])
    if (git(['rev-parse', '--verify', '-q', `${ref}^{commit}`], cwd, { allowFail: true }))
      return ref;
  return null;
}
const NO_REF = 'cannot find origin/revamp or revamp to diff against; pass --base <ref>';

/** Every path touched between base and head; a rename counts both its old and new path. */
function nameStatusFiles(output) {
  const tokens = output.split('\0');
  const files = new Set();
  for (let i = 0; i < tokens.length && tokens[i];) {
    const status = tokens[i++];
    const count = /^[RC]/.test(status) ? 2 : 1;
    for (let k = 0; k < count; k++) files.add(tokens[i++]);
  }
  return files;
}
const changedFiles = (base, head, cwd) =>
  [...nameStatusFiles(git(['diff', '--name-status', '-M', '-z', `${base}...${head}`], cwd))].sort();

/** Approvals that cover the whole change: --approved and PR labels. */
function globalApprovals(opts, cwd) {
  const found = new Map();
  const add = (lanes, source) => lanes.forEach(lane => found.has(lane) || found.set(lane, source));
  add(csv(opts.approved), '--approved');
  if (opts.pr) {
    let labels;
    try {
      const out = execFileSync('gh', ['pr', 'view', String(opts.pr), '--json', 'labels'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      labels = JSON.parse(out).labels.map(label => label.name);
    } catch (error) {
      throw new UsageError(
        `could not read labels of PR ${opts.pr} with gh: ${String(error.stderr ?? error.message).trim()}`,
      );
    }
    add(
      labels
        .map(l => l.match(/^lane-approved:(.+)$/i)?.[1])
        .filter(Boolean)
        .map(l => l.toLowerCase()),
      'PR label',
    );
  }
  return found;
}

/**
 * Trailers of every non-merge commit in base..head, with the files that commit touched. A
 * "Lane-Approved: a, b" trailer lists lanes separated by commas; an item that is not a single
 * known lane name approves nothing and is reported. "Owners-Exempt: phase-0" marks a restructure
 * commit (honoured only when the integrator lane approved it, see runCheck).
 */
function commitTrailers(base, head, cwd, knownLanes) {
  const commits = [];
  const ignored = [];
  const shas = git(['rev-list', '--no-merges', `${base}..${head}`], cwd)
    .split('\n')
    .filter(Boolean);
  for (const sha of shas) {
    const raw = git(
      [
        'log',
        '-1',
        '--format=%(trailers:key=Lane-Approved,valueonly,unfold)%x00%(trailers:key=Owners-Exempt,valueonly,unfold)',
        sha,
      ],
      cwd,
    );
    const [approvedRaw, exemptRaw = ''] = raw.split('\0');
    const approves = new Set();
    for (const item of approvedRaw
      .split(/[\n,]/)
      .map(v => v.trim())
      .filter(Boolean)) {
      if (LANE_NAME.test(item) && knownLanes.has(item)) approves.add(item);
      else ignored.push({ commit: sha.slice(0, 7), value: item });
    }
    const files = nameStatusFiles(
      git(['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-M', '-z', sha], cwd),
    );
    commits.push({
      sha: sha.slice(0, 7),
      approves,
      exempt: /^\s*phase-0\s*$/i.test(exemptRaw.trim()),
      files,
    });
  }
  return { commits, ignored };
}

// ---------- modes ----------

const pad = rows => {
  const widths = rows[0].map((_, col) => Math.max(...rows.map(row => String(row[col]).length)));
  return rows
    .map(
      row =>
        '  ' +
        row
          .map((cell, col) => String(cell).padEnd(widths[col]))
          .join('  ')
          .trimEnd(),
    )
    .join('\n');
};

function topAreas(files) {
  const counts = new Map();
  for (const file of files) {
    const parts = file.split('/');
    const area =
      parts.length > 2 && ['apps', 'packages'].includes(parts[0])
        ? parts.slice(0, 2).join('/')
        : parts[0];
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
    else if (owner.ambiguous)
      tieFiles.set(owner.lanes.join(' vs '), [
        ...(tieFiles.get(owner.lanes.join(' vs ')) ?? []),
        file,
      ]);
  }
  for (const [lanes, files] of tieFiles)
    errors.push(`tie between ${lanes} on ${files.length} file(s), e.g. ${files[0]}`);
  const areas = topAreas(unowned);
  const warnings = parsed.warnings;
  const result = {
    mode: 'validate',
    ok: !errors.length && !(opts.strict && unowned.length),
    errors,
    warnings,
    trackedFiles: tracked.length,
    unowned: unowned.length,
    unownedAreas: Object.fromEntries(areas),
    unownedFiles: unowned,
  };
  if (opts.json) return (out(JSON.stringify(result, null, 2)), result.ok);
  out(
    `owners-check --validate: ${parsed.rules.length} rule(s), ${new Set(parsed.rules.map(r => r.lane)).size} lane(s), ${tracked.length} tracked file(s)`,
  );
  if (errors.length) out(`errors (${errors.length}):\n${errors.map(e => `  ${e}`).join('\n')}`);
  if (warnings.length)
    out(`warnings (${warnings.length}):\n${warnings.map(w => `  ${w}`).join('\n')}`);
  if (unowned.length) {
    out(
      `warning: ${unowned.length} tracked file(s) match no glob:\n${pad(areas.map(([area, n]) => [area, n]))}`,
    );
    out(
      unowned
        .slice(0, 15)
        .map(f => `    ${f}`)
        .join('\n') +
        (unowned.length > 15
          ? `\n    ... and ${unowned.length - 15} more (use --json for all)`
          : ''),
    );
  }
  out(
    result.ok
      ? `OK: OWNERS.md is valid${unowned.length ? ` (${unowned.length} unowned file(s), pass --strict to fail on them)` : ''}`
      : `FAIL: ${errors.length ? `${errors.length} error(s)` : `${unowned.length} unowned file(s) under --strict`}`,
  );
  return result.ok;
}

function runCheck(parsed, opts, cwd, out, rulesRef) {
  const head = opts.head ?? 'HEAD';
  const base = opts.base ?? git(['merge-base', head, rulesRef], cwd).trim();
  const files = changedFiles(base, head, cwd);
  const finish = (result, text) => {
    if (opts.json) out(JSON.stringify(result, null, 2));
    else out(text);
    return result.ok;
  };
  if (!files.length)
    return finish(
      { mode: 'check', ok: true, base, head, changedFiles: [], violations: [] },
      `OK: no changed files in ${base.slice(0, 10)}...${head}`,
    );
  const branch = currentBranch(cwd);
  if (!opts.lane && /^(revamp|main)$/.test(branch) && !process.env.GITHUB_BASE_REF) {
    return finish(
      { mode: 'check', ok: true, skipped: true, base, head, changedFiles: files, violations: [] },
      `skipped: ${branch} is an integration branch; ownership is checked on pull requests (pass --lane to check anyway)`,
    );
  }
  const lanes = actingLanes(opts, branch, parsed);
  const approved = globalApprovals(opts, cwd);
  const exemptAllowed = lanes.includes('integrator') || approved.has('integrator');
  const trailers =
    opts.trailers === true
      ? commitTrailers(base, head, cwd, parsed.lanes)
      : { commits: [], ignored: [] };
  const trailerSources = new Map();
  // A file is covered by trailers when it was touched by at least one commit and every commit that
  // touched it approves the owning lane (or is an authorised phase-0 commit).
  const coveredByTrailer = (file, owner) => {
    const touching = trailers.commits.filter(commit => commit.files.has(file));
    const covered =
      touching.length > 0 &&
      touching.every(
        commit => (owner && commit.approves.has(owner)) || (commit.exempt && exemptAllowed),
      );
    if (covered)
      for (const commit of touching)
        trailerSources.set(`${owner ?? 'phase-0'} (trailer ${commit.sha})`, true);
    return covered;
  };
  const violations = [];
  for (const file of files) {
    const owner = resolveOwner(parsed.rules, file);
    if (!owner) {
      if (!coveredByTrailer(file, null)) violations.push({ file, owner: null, reason: 'unowned' });
    } else if (owner.ambiguous) {
      if (!coveredByTrailer(file, null))
        violations.push({ file, owner: owner.lanes.join(' vs '), reason: 'ambiguous' });
    } else {
      const lane = owner.rule.lane;
      if (
        lane !== SHARED &&
        !lanes.includes(lane) &&
        !approved.has(lane) &&
        !coveredByTrailer(file, lane)
      )
        violations.push({ file, owner: lane, reason: 'other-lane' });
    }
  }
  const ok = !violations.length;
  const approvals = [
    ...[...approved].map(([lane, source]) => `${lane} (${source})`),
    ...trailerSources.keys(),
  ];
  const result = {
    mode: 'check',
    ok,
    base,
    head,
    actingLanes: lanes,
    approvals,
    ignoredTrailers: trailers.ignored,
    changedFiles: files,
    violations,
  };
  if (opts.json) return (out(JSON.stringify(result, null, 2)), ok);
  out(
    `owners-check: acting lane(s) ${lanes.join(', ')}; ${files.length} changed file(s) in ${base.slice(0, 10)}...${head}`,
  );
  if (approvals.length) out(`approved: ${approvals.join(', ')}`);
  for (const { commit, value } of trailers.ignored)
    out(`ignored Lane-Approved value in ${commit}: "${value}" is not a single known lane name`);
  if (!ok) {
    const shown = violations.slice(0, MAX_ROWS);
    out(
      pad([
        ['FILE', 'OWNER', 'ACTING'],
        ...shown.map(v => [v.file, v.owner ?? '(unowned)', lanes.join(',')]),
      ]),
    );
    if (violations.length > shown.length)
      out(`  ... and ${violations.length - shown.length} more (use --json for all)`);
    if (violations.some(v => v.reason === 'unowned'))
      out('Unowned file(s): ask the Integrator to add them to plans/OWNERS.md.');
    if (violations.some(v => v.reason === 'ambiguous'))
      out(
        'Ambiguous file(s): two lanes own the same path equally; the Integrator must fix plans/OWNERS.md.',
      );
    if (violations.some(v => v.reason === 'other-lane'))
      out(
        'Other-lane file(s): get the owning lane to approve (PR label "lane-approved:<lane>" or --approved <lane>; a "Lane-Approved: <lane>" commit trailer counts only with --trailers, and it is self-attested).',
      );
  }
  out(
    ok
      ? `OK: ${files.length} file(s) within ${lanes.join(', ')}, shared or approved`
      : `FAIL: ${violations.length} of ${files.length} changed file(s) outside lane ${lanes.join(', ')}`,
  );
  return ok;
}

export function main(argv, { cwd = process.cwd(), out = console.log } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    out(
      'usage: node scripts/audit/owners-check.mjs [--base <ref>] [--head <ref>] [--lane <lane,...>] [--approved <lane,...>] [--pr <n>] [--owners <file>] [--validate] [--strict] [--trailers] [--json]',
    );
    return 0;
  }
  const root = git(['rev-parse', '--show-toplevel'], cwd).trim();
  const pending = () => {
    out(
      opts.json
        ? JSON.stringify({
            pending: true,
            ok: true,
            message: `${DEFAULT_OWNERS} not on this branch yet`,
          })
        : `pending: ${DEFAULT_OWNERS} not on this branch yet`,
    );
    return 0;
  };
  // The change check enforces the rules of the integration branch (the --base ref, or the tip of
  // origin/revamp), never the head's own copy: a PR cannot delete or rewrite OWNERS.md to pass.
  const rulesRef = opts.validate ? undefined : (opts.base ?? integrationRef(root));
  if (!opts.validate && !rulesRef && (opts.owners || existsSync(path.join(root, DEFAULT_OWNERS))))
    throw new UsageError(NO_REF);
  let text;
  let label = DEFAULT_OWNERS;
  if (opts.owners) {
    const file = path.resolve(cwd, opts.owners);
    if (!existsSync(file)) throw new UsageError(`owners file ${opts.owners} not found`);
    text = readFileSync(file, 'utf8');
    label = path.relative(root, file);
  } else if (opts.validate) {
    const file = path.join(root, DEFAULT_OWNERS);
    if (!existsSync(file)) return pending();
    text = readFileSync(file, 'utf8');
  } else {
    text = rulesRef
      ? git(['show', `${rulesRef}:${DEFAULT_OWNERS}`], root, { allowFail: true })
      : null;
    if (text === null) return pending();
    label = `${rulesRef}:${DEFAULT_OWNERS}`;
  }
  const parsed = parseOwners(text);
  if (!opts.validate && parsed.errors.length) {
    out(
      `owners-check: ${label} is invalid:\n${parsed.errors.map(e => `  ${e}`).join('\n')}\nRun with --validate for details.`,
    );
    return 1;
  }
  const ok = opts.validate
    ? runValidate(parsed, opts, root, out)
    : runCheck(parsed, opts, root, out, rulesRef);
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
