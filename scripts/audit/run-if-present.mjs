// Run a root npm script if it exists; otherwise print "pending: <name>" and succeed.
// Lets `npm run check` and CI name checks that other lanes add later (format:check, owners:check).
// Usage: node scripts/audit/run-if-present.mjs <script-name>
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const name = process.argv[2];
if (!name) {
  console.error('usage: run-if-present.mjs <npm-script-name>');
  process.exit(2);
}

const { scripts = {} } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
if (!(name in scripts)) {
  console.log(`pending: ${name}`);
  process.exit(0);
}

const result = spawnSync('npm', ['run', name], { stdio: 'inherit' });
process.exit(result.status ?? 1);
