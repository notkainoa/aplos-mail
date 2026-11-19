#!/usr/bin/env node
// Stale scratch sweep. `npm run scratch:sweep` REPORTS what would be removed; only
//   npm run scratch:sweep -- --delete
// actually deletes (or: node scripts/audit/scratch-sweep.mjs --delete, --yes is an alias and
// --dry-run is accepted as a no-op). Usage:
//   node scripts/audit/scratch-sweep.mjs [--dir <path>] [--max-age-hours <n>] [--delete|--yes|--dry-run]
//
// A candidate is ONLY a top-level entry of --dir (default os.tmpdir()) that is a DIRECTORY whose
// name matches scratchNamePattern (aplos-scratch-<purpose>-<6 random>) AND that contains a
// readable .aplos-scratch.json marker written by scratchDir(). Files, sockets, symlinks,
// unmarked dirs and every other "aplos-*" name — other agents' working dirs, logs, sockets —
// are never candidates. A marked dir is still kept when its owning pid is alive with a matching
// process start key (a recycled pid has a different key; an undeterminable key keeps the dir),
// when it is this process's own registered scratch, when another uid owns it, or when its
// newest mtime — over a bounded recursive lstat walk, so runs that write deep are not swept
// mid-run — is younger than --max-age-hours (default 4, minimum 1; env
// APLOS_SCRATCH_MAX_AGE_HOURS when the flag is absent). A walk that hits the entry or depth cap
// is treated as fresh. Always exits 0 except on bad arguments (exit 2).
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isRegisteredScratch,
  processStartKey,
  scratchMarkerName,
  scratchNamePattern,
} from './scratch.mjs';

export const defaultMaxAgeHours = 4;
export const walkEntryCap = 5000;
export const walkDepthCap = 6;
const hourMs = 60 * 60 * 1000;

// Newest mtime and rough byte count of an entry, by bounded recursive lstat walk (symlinks are
// never followed). Hitting the entry cap or the depth cap sets capped: callers treat the entry
// as fresh, because what was not walked may be live work.
function measure(path, stat, lstat, caps) {
  let newest = stat.mtimeMs;
  let bytes = stat.size;
  let visited = 1;
  let capped = false;
  const stack = [[path, 0]];
  while (stack.length > 0 && !capped) {
    const [dir, depth] = stack.pop();
    if (depth >= caps.depth) {
      capped = true;
      break;
    }
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (visited >= caps.entries) {
        capped = true;
        break;
      }
      visited++;
      const childPath = join(dir, name);
      let child;
      try {
        child = lstat(childPath);
      } catch {
        continue; // raced away between readdir and lstat
      }
      if (child.mtimeMs > newest) newest = child.mtimeMs;
      bytes += child.size;
      if (child.isDirectory()) stack.push([childPath, depth + 1]);
    }
  }
  return { newest, bytes, capped };
}

const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

// The marker must parse to an object; anything else (missing file, bad JSON, a JSON scalar) is
// not provably ours.
function readMarker(path) {
  try {
    const marker = JSON.parse(readFileSync(join(path, scratchMarkerName), 'utf8'));
    return marker !== null && typeof marker === 'object' && !Array.isArray(marker) ? marker : null;
  } catch {
    return null;
  }
}

// True when the pid in the marker is plausibly still the process that created the dir. A dead
// pid, or a live pid whose start key differs from the marker's (a recycled pid), means the owner
// is gone. Anything unverifiable — malformed pid, EPERM, a start key we cannot compute or that
// the marker never recorded — keeps the dir.
function ownerAlive(marker, kill, startKey) {
  const pid = marker.pid;
  if (!Number.isInteger(pid) || pid <= 0) return true;
  let alive;
  try {
    kill(pid, 0);
    alive = true;
  } catch (error) {
    alive = error?.code !== 'ESRCH';
  }
  if (!alive) return false;
  const key = startKey(pid);
  if (key === null || marker.startedAt == null) return true;
  return key === marker.startedAt;
}

// The fate of one pattern-named entry: { bytes } when it is a stale dir provably created by
// scratchDir() — a real directory owned by this uid, not this process's registered scratch,
// carrying a readable marker whose owner is gone, and old by the bounded walk — else null,
// which the caller counts as kept.
function staleCandidate(path, stat, ctx) {
  if (!stat.isDirectory() || (ctx.uid !== null && stat.uid !== ctx.uid)) return null;
  if (isRegisteredScratch(path)) return null;
  const marker = readMarker(path);
  if (!marker || ownerAlive(marker, ctx.kill, ctx.startKey)) return null;
  const { newest, bytes, capped } = measure(path, stat, ctx.lstat, ctx.caps);
  return capped || newest > ctx.cutoff ? null : { bytes };
}

// True only when the remove call succeeded AND a following lstat reports the path gone
// (ENOENT). A throw, or a path that is still there, means the entry is not counted as removed.
function removeVerified(path, remove, lstat) {
  try {
    remove(path, { recursive: true, force: true, maxRetries: 3 });
    lstat(path);
    return false;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

/**
 * Sweeps stale scratch dirs out of `dir`. Options: dir, maxAgeHours (floored at 1), now,
 * delete (default false: report only — nothing is removed unless delete is true; dryRun is
 * accepted as its inverse for compatibility), walkEntryCap/walkDepthCap (bounded walk tuning),
 * and injectables remove, lstat, kill and startKey for tests. Returns
 * { removed, kept, failed, bytesFreedApprox }: in report mode removed lists the dirs that would
 * be deleted; in delete mode removed lists only removals verified gone, failed lists the rest.
 */
export function sweepStaleScratch(options = {}) {
  const dir = options.dir ?? tmpdir();
  // A NaN or non-numeric age would make every `newest > cutoff` comparison false, i.e. every
  // dir stale: anything not a finite number falls back to the default, never to 'sweep all'.
  const requested = Number(options.maxAgeHours ?? defaultMaxAgeHours);
  const maxAgeHours = Number.isFinite(requested) ? Math.max(1, requested) : defaultMaxAgeHours;
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  // --dry-run is a veto: `--delete --dry-run` must report, never remove. Legacy callers that only
  // pass dryRun: false still delete.
  const del =
    options.delete === undefined
      ? options.dryRun === false
      : options.delete === true && options.dryRun !== true;
  const remove = options.remove ?? rmSync;
  const lstat = options.lstat ?? lstatSync;
  const ctx = {
    uid: currentUid(),
    cutoff: nowMs - maxAgeHours * hourMs,
    kill: options.kill ?? ((pid, signal) => process.kill(pid, signal)),
    startKey: options.startKey ?? (pid => processStartKey(pid)),
    lstat,
    caps: {
      entries: options.walkEntryCap ?? walkEntryCap,
      depth: options.walkDepthCap ?? walkDepthCap,
    },
  };
  const removed = [];
  const failed = [];
  let kept = 0;
  let bytesFreedApprox = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { removed, kept, failed, bytesFreedApprox };
  }
  for (const entry of entries) {
    if (!scratchNamePattern.test(entry.name)) continue;
    const path = join(dir, entry.name);
    let stat;
    try {
      stat = lstat(path);
    } catch {
      continue; // raced away between readdir and lstat
    }
    const candidate = staleCandidate(path, stat, ctx);
    if (candidate === null) {
      kept++;
      continue;
    }
    if (!del || removeVerified(path, remove, lstat)) {
      removed.push(path);
      bytesFreedApprox += candidate.bytes;
    } else {
      failed.push(path);
    }
  }
  return { removed, kept, failed, bytesFreedApprox };
}

const number = (flag, value, min) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${flag} needs a number >= ${min}, got "${value}"`);
  }
  return parsed;
};

// A --dir must be a real directory we can trust not to be the user's world: refuse a symlink,
// refuse what realpath maps to /, the home directory or an ancestor of it, and refuse anything
// with fewer than two segments.
function checkDir(dir) {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    throw new Error(`--dir ${dir} does not exist`);
  }
  if (stat.isSymbolicLink()) throw new Error(`--dir ${dir} is a symlink`);
  if (!stat.isDirectory()) throw new Error(`--dir ${dir} is not a directory`);
  let real;
  try {
    real = realpathSync(dir);
  } catch {
    throw new Error(`--dir ${dir} cannot be resolved`);
  }
  let home;
  try {
    home = realpathSync(homedir());
  } catch {
    home = resolve(homedir());
  }
  if (real === home || home.startsWith(real + sep)) {
    throw new Error(`--dir ${dir} is the home directory or an ancestor of it`);
  }
  if (real.split(sep).filter(Boolean).length < 2) {
    throw new Error(`--dir ${dir} is too shallow to sweep`);
  }
  return dir;
}

export function parseArgs(argv, env = process.env) {
  const options = { delete: false, dryRun: false, dir: null, maxAgeHours: null };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--delete' || arg === '--yes') options.delete = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--max-age-hours') options.maxAgeHours = number(arg, args.shift(), 1);
    else if (arg === '--dir') {
      const dir = args.shift();
      if (!dir) throw new Error('--dir needs a value');
      options.dir = checkDir(dir);
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (options.maxAgeHours === null && env.APLOS_SCRATCH_MAX_AGE_HOURS) {
    options.maxAgeHours = number('APLOS_SCRATCH_MAX_AGE_HOURS', env.APLOS_SCRATCH_MAX_AGE_HOURS, 1);
  }
  if (options.maxAgeHours === null) options.maxAgeHours = defaultMaxAgeHours;
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`scratch-sweep: ${error.message}`);
    process.exit(2);
  }
  const result = sweepStaleScratch(options);
  const mb = (result.bytesFreedApprox / (1024 * 1024)).toFixed(1);
  if (!options.delete || options.dryRun) {
    console.log(
      `scratch-sweep: ${result.removed.length} stale dir(s) (~${mb} MB); rerun with --delete to remove`,
    );
    for (const path of result.removed.slice(0, 20)) {
      console.log(`  ${basename(path)}`);
    }
  } else {
    const failed = result.failed.length > 0 ? `; ${result.failed.length} removal(s) failed` : '';
    console.log(
      `scratch-sweep: removed ${result.removed.length} stale dir(s), freed ~${mb} MB${failed}`,
    );
  }
  process.exit(0);
}
