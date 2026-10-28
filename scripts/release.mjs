// Cuts a release: bumps the version in package.json, apps/desktop/package.json and package-lock.json,
// commits, tags vX.Y.Z and prints the push command. It never pushes. See RELEASING.md.
// Usage: npm run release -- <patch|minor|major|X.Y.Z> [--dry-run] [--allow-branch]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bump = args.find(arg => !arg.startsWith('--'));
const git = (...command) => execFileSync('git', command, { cwd: root, encoding: 'utf8' }).trim();
const fail = message => {
  console.error(`release: ${message}`);
  process.exit(1);
};
const read = file => JSON.parse(readFileSync(join(root, file), 'utf8'));
const write = (file, data) => writeFileSync(join(root, file), JSON.stringify(data, null, 2) + '\n');

const desktop = read('apps/desktop/package.json');
const current = desktop.version;
const parts = current.split('.').map(Number);
const next =
  bump === 'major'
    ? `${parts[0] + 1}.0.0`
    : bump === 'minor'
      ? `${parts[0]}.${parts[1] + 1}.0`
      : bump === 'patch'
        ? `${parts[0]}.${parts[1]}.${parts[2] + 1}`
        : bump;
if (!next || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next))
  fail('give patch, minor, major or a version like 0.2.0.');
if (next === current) fail(`already at ${current}.`);
const tag = `v${next}`;

if (git('status', '--porcelain'))
  fail(
    'commit or set aside your changes first; the release commit should contain only the version bump.',
  );
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main' && !args.includes('--allow-branch'))
  fail(`you are on ${branch}; release from main (or pass --allow-branch).`);
if (git('tag', '--list', tag)) fail(`tag ${tag} already exists.`);

console.log(`release: ${current} → ${next}${dryRun ? ' (dry run, nothing written)' : ''}`);
if (dryRun) process.exit(0);

const rootPackage = read('package.json');
rootPackage.version = next;
write('package.json', rootPackage);
desktop.version = next;
write('apps/desktop/package.json', desktop);
const lock = read('package-lock.json');
lock.version = next;
lock.packages[''].version = next;
lock.packages['apps/desktop'].version = next;
write('package-lock.json', lock);

git('add', 'package.json', 'apps/desktop/package.json', 'package-lock.json');
git('commit', '-m', `Release ${tag}`);
git('tag', '-a', tag, '-m', `Aplos Mail ${next}`);
console.log(
  `release: committed and tagged ${tag}. Push to start the release build (a draft GitHub Release):\n\n  git push --atomic origin ${branch} ${tag}\n`,
);
