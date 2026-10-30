#!/usr/bin/env node
// Stale scratch sweep. Usage:
//   node scripts/audit/scratch-sweep.mjs [--dir <path>] [--max-age-hours <n>] [--prefix <p> ...] [--dry-run]
// Removes top-level entries of --dir (default os.tmpdir()) whose name starts with one of the
// prefixes (default "aplos-") and whose newest mtime is older than --max-age-hours (default 4,
// env APLOS_SCRATCH_MAX_AGE_HOURS when the flag is absent). For a directory the newest mtime is
// taken over the dir itself and its direct children, so a dir whose own mtime is old but whose
// files are still being written is kept. Entries are removed only when they are owned by the
// current uid, are not symlinks (lstat, never followed) and are not this process's own
// registered scratch. Everything else in /tmp — other apps, sockets, worktrees — is untouched.
// Always exits 0 except on bad arguments (exit 2).
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRegisteredScratch } from './scratch.mjs';

export const defaultMaxAgeHours = 4;
export const defaultPrefixes = ['aplos-'];
const hourMs = 60 * 60 * 1000;

// Newest mtime and rough byte count of an entry: itself plus, for a directory, its direct
// children (no recursion — "approx" is fine and keeps the sweep cheap on deep trees).
function measure(path, stat, lstat) {
  let newest = stat.mtimeMs;
  let bytes = stat.size;
  if (stat.isDirectory()) {
    let names;
    try {
      names = readdirSync(path);
    } catch {
      names = [];
    }
    for (const name of names) {
      try {
        const child = lstat(join(path, name));
        newest = Math.max(newest, child.mtimeMs);
        bytes += child.size;
      } catch {
        // Entry raced away between readdir and lstat.
      }
    }
  }
  return { newest, bytes };
}

const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

/**
 * Sweeps stale scratch entries out of `dir`. Options: dir, maxAgeHours, prefixes, now,
 * dryRun (report without deleting), remove (rmSync-compatible, injectable) and lstat
 * (injectable for tests). Returns { removed, kept, bytesFreedApprox } where removed lists
 * the paths that were — or in dry-run would be — deleted and kept counts matching entries
 * that survived.
 */
export function sweepStaleScratch(options = {}) {
  const dir = options.dir ?? tmpdir();
  const maxAgeHours = options.maxAgeHours ?? defaultMaxAgeHours;
  const prefixes = options.prefixes ?? defaultPrefixes;
  const now = options.now ?? Date.now();
  const dryRun = options.dryRun ?? false;
  const remove = options.remove ?? rmSync;
  const lstat = options.lstat ?? lstatSync;
  const uid = currentUid();
  const cutoff = now - maxAgeHours * hourMs;
  const removed = [];
  let kept = 0;
  let bytesFreedApprox = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { removed, kept, bytesFreedApprox };
  }
  for (const entry of entries) {
    if (!prefixes.some(prefix => entry.name.startsWith(prefix))) continue;
    const path = join(dir, entry.name);
    let stat;
    try {
      stat = lstat(path);
    } catch {
      continue; // raced away between readdir and lstat
    }
    if (stat.isSymbolicLink() || (uid !== null && stat.uid !== uid) || isRegisteredScratch(path)) {
      kept++;
      continue;
    }
    const { newest, bytes } = measure(path, stat, lstat);
    if (newest > cutoff) {
      kept++;
      continue;
    }
    removed.push(path);
    bytesFreedApprox += bytes;
    if (!dryRun) {
      try {
        remove(path, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // Best effort: a stubborn entry is reported but never fails the sweep.
      }
    }
  }
  return { removed, kept, bytesFreedApprox };
}

const number = (flag, value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} needs a positive number, got "${value}"`);
  }
  return parsed;
};

export function parseArgs(argv, env = process.env) {
  const options = { dryRun: false, prefixes: [], dir: null, maxAgeHours: null };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--max-age-hours') options.maxAgeHours = number(arg, args.shift());
    else if (arg === '--prefix') {
      const prefix = args.shift();
      if (!prefix) throw new Error('--prefix needs a value');
      options.prefixes.push(prefix);
    } else if (arg === '--dir') {
      const dir = args.shift();
      if (!dir) throw new Error('--dir needs a value');
      options.dir = dir;
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (options.maxAgeHours === null && env.APLOS_SCRATCH_MAX_AGE_HOURS) {
    options.maxAgeHours = number('APLOS_SCRATCH_MAX_AGE_HOURS', env.APLOS_SCRATCH_MAX_AGE_HOURS);
  }
  if (options.maxAgeHours === null) options.maxAgeHours = defaultMaxAgeHours;
  if (options.prefixes.length === 0) options.prefixes = defaultPrefixes;
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`scratch-sweep: ${error.message}`);
    console.error(
      'usage: node scripts/audit/scratch-sweep.mjs [--dir <path>] [--max-age-hours <n>] [--prefix <p> ...] [--dry-run]',
    );
    process.exit(2);
  }
  const result = sweepStaleScratch(options);
  const mb = (result.bytesFreedApprox / (1024 * 1024)).toFixed(1);
  const verb = options.dryRun ? 'would remove' : 'removed';
  console.log(`scratch-sweep: ${verb} ${result.removed.length} item(s), freed ~${mb} MB`);
  if (options.dryRun) {
    for (const path of result.removed.slice(0, 20)) {
      console.log(`  ${basename(path)}`);
    }
  }
  process.exit(0);
}
