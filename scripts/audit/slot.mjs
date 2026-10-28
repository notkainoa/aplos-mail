#!/usr/bin/env node
// CI slot runner (plan 40 Q3 deliverable 2). Usage: node scripts/audit/slot.mjs <npm-script> [--root <dir>]
// Runs the root package.json script when it exists and propagates its exit code. When it does not
// exist yet, prints "pending: <name> (owner: <lane>)" and exits 0, so a job can be wired before the
// lane that owns the check has landed it. The pending line is also appended to
// $GITHUB_STEP_SUMMARY when that is set, so a green run still lists what did not run. A name that
// is not in the table below is a typo or an unregistered slot and exits 2.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Owners from plans/00-roadmap.md section 2 and the plan that defines each slot.
export const slotOwners = {
  'check:openapi': 'eng-contract / eng-host',
  'check:tokens': 'ui-foundation',
  'check:contrast': 'ui-foundation',
  'check:identity': 'ui-foundation',
  'test:visual': 'ui-foundation',
  'test:perf': 'ui-foundation',
};

export function hasScript(root, name) {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  return Boolean(pkg.scripts && Object.hasOwn(pkg.scripts, name));
}

export function runSlot(name, root, summaryFile = process.env.GITHUB_STEP_SUMMARY) {
  if (!Object.hasOwn(slotOwners, name)) {
    console.error(`unknown slot "${name}"; known slots: ${Object.keys(slotOwners).join(', ')}`);
    return 2;
  }
  if (!hasScript(root, name)) {
    const line = `pending: ${name} (owner: ${slotOwners[name]})`;
    console.log(line);
    if (summaryFile) appendFileSync(summaryFile, `- ${line}\n`);
    return 0;
  }
  const result = spawnSync('npm', ['run', name], { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(`slot ${name}: could not start npm: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf('--root');
  const root =
    rootFlag === -1
      ? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
      : resolve(args.splice(rootFlag, 2)[1]);
  const [name] = args;
  if (!name) {
    console.error('usage: node scripts/audit/slot.mjs <npm-script> [--root <dir>]');
    process.exit(2);
  }
  process.exit(runSlot(name, root));
}
