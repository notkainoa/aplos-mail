#!/usr/bin/env node
// Hill-climb scorer: total ESLint suppressions, negated so removing suppressions scores
// higher. Usage:
//   node scripts/audit/hillclimb/scorers/eslint-suppressions.mjs [--file <path>] [--scope <glob>]...
// --scope keeps only suppression entries whose file path matches at least one glob (repeatable);
// --file picks the suppressions JSON (default ./eslint-suppressions.json) so tests use fixtures.
// Prints {"score": <number>, "details": [...]} as the last stdout line, per the scorer contract.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { matchGlob } from '../diffguard.mjs';

export function parseArgs(argv) {
  const options = { file: 'eslint-suppressions.json', scopes: [] };
  const args = [...argv];
  while (args.length) {
    const arg = args.shift();
    if (arg === '--file') options.file = args.shift() ?? missing('--file');
    else if (arg === '--scope') options.scopes.push(args.shift() ?? missing('--scope'));
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

const missing = flag => {
  throw new Error(`${flag} needs a value`);
};

/**
 * Sums suppressions in a parsed { file: { rule: { count } } } object, counting only file keys
 * matching one of `scopes` (all when empty). Returns { score, details } with the ten worst
 * rules first as "<rule>: <total> in <n> files". Every count must be an integer >= 0 — a
 * negative or fractional count is tampering, so it throws rather than scoring. A run that
 * names scopes but matches no suppression entry throws too: a perfect 0 would silently
 * reward a scope that drifted away from the file names it was written for.
 */
export function scoreSuppressions(data, scopes = []) {
  const inScope = file => scopes.length === 0 || scopes.some(glob => matchGlob(file, glob));
  if (scopes.length && !Object.keys(data).some(inScope)) {
    throw new Error(
      `no suppressions entry matches --scope ${scopes.map(s => `"${s}"`).join(', ')}`,
    );
  }
  let total = 0;
  const byRule = new Map();
  for (const [file, rules] of Object.entries(data)) {
    if (!inScope(file)) continue;
    for (const [rule, entry] of Object.entries(rules)) {
      const count = entry?.count;
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`${file}: count for ${rule} must be a non-negative integer`);
      }
      total += count;
      const agg = byRule.get(rule) ?? { count: 0, files: 0 };
      agg.count += count;
      agg.files += 1;
      byRule.set(rule, agg);
    }
  }
  const details = [...byRule.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(
      ([rule, agg]) => `${rule}: ${agg.count} in ${agg.files} file${agg.files === 1 ? '' : 's'}`,
    );
  return { score: -total, details };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const data = JSON.parse(readFileSync(resolve(options.file), 'utf8'));
  console.log(JSON.stringify(scoreSuppressions(data, options.scopes)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`eslint-suppressions scorer: ${error.message}`);
    process.exit(2);
  }
}
