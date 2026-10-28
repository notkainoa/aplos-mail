// SQLite floor probe (plans/40-platform-quality.md, ADR 40-4): prints sqlite_version()
// and whether FTS5 contentless_delete=1 works for BOTH runtimes — the system Node that
// runs this script, and Electron's own Node (via scripts/audit/electron-node.mjs). The
// two runtimes ship different SQLite builds, and the engine needs FTS5
// contentless_delete (a SQLite 3.43+ feature), so `npm run check:sqlite` fails with
// exit 1 when Electron's is below the floor or misses the feature. The version
// comparison is exported for scripts/audit/tests/sqlite-floor.test.mjs.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export const SQLITE_FLOOR = '3.43.0';

// Every component is a plain number; "3.43.0" and "3.53.4" compare element by element.
export function sqliteAtLeastFloor(version, floor = SQLITE_FLOOR) {
  const unwrap = value => value.split('.').map(part => Number.parseInt(part, 10));
  const a = unwrap(version);
  const b = unwrap(floor);
  for (const place of [0, 1, 2]) {
    const left = a[place] ?? 0;
    const right = b[place] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

export function probeSqlite(requireFunction = require) {
  const db = new (requireFunction('node:sqlite').DatabaseSync)(':memory:');
  try {
    const version = db.prepare('select sqlite_version() as v').get().v;
    let fts5Delete = false;
    try {
      db.exec("CREATE VIRTUAL TABLE t USING fts5(x, content='', contentless_delete=1)");
      fts5Delete = true;
    } catch {
      fts5Delete = false;
    }
    return { version, fts5Delete };
  } finally {
    db.close();
  }
}

function describe(result) {
  return `SQLite ${result.version}, fts5 contentless_delete: ${result.fts5Delete ? 'yes' : 'no'}`;
}

// One-line JSON probe mode, launched inside Electron's Node:
// ELECTRON_RUN_AS_NODE=1 electron scripts/audit/sqlite-floor.mjs --self
function selfMode() {
  return process.argv[2] === '--self';
}

function main() {
  const system = probeSqlite();
  console.log(`system Node (v${process.versions.node}): ${describe(system)}`);

  const here = join(dirname(fileURLToPath(import.meta.url)), 'electron-node.mjs');
  const self = fileURLToPath(import.meta.url);
  const run = spawnSync(process.execPath, [here, self, '--self'], { encoding: 'utf8' });

  if (run.status !== 0 || run.error) {
    console.error(`Electron Node probe failed (status ${run.error ?? run.status}):`);
    console.error(run.stdout.trim());
    console.error(run.stderr.trim());
    process.exit(1);
  }

  const electron = JSON.parse(run.stdout);
  console.log(`Electron Node (via electron-node.mjs): ${describe(electron)}`);

  if (!electron.fts5Delete) {
    console.error(`Electron is missing FTS5 contentless_delete; floor is ${SQLITE_FLOOR}`);
    process.exit(1);
  }
  if (!sqliteAtLeastFloor(electron.version)) {
    console.error(`Electron SQLite ${electron.version} is below the floor ${SQLITE_FLOOR}`);
    process.exit(1);
  }
}

// Run as a program, not when a test imports the exported helpers.
if (selfMode()) {
  console.log(JSON.stringify(probeSqlite()));
  process.exit(0);
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
