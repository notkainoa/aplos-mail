import { loadDevEnv } from '../src/main/env';
import { mkdir, writeFile } from 'node:fs/promises';
import { createGroq } from '../src/main/groq';
import { askModel, devCases } from './quality/cases';
import { heldOutCases } from './quality/heldout-cases';
import { parseSplit, qualityCases, selectCases } from './quality/splits';

loadDevEnv();
const ai = createGroq();
if (!ai.available)
  throw new Error('Set GROQ_API_KEY in the backend environment to run live evaluations.');
const runs = Number(process.argv.find(a => a.startsWith('--runs='))?.split('=')[1] ?? 1);
if (!Number.isInteger(runs) || runs < 1 || runs > 5)
  throw new Error('Use --runs=1 through --runs=5.');
const split = parseSplit(process.argv);
// Under --json the only stdout line is the machine-readable score; progress goes to stderr.
const json = process.argv.includes('--json');
if (json) console.log = console.error;
const cases = selectCases(qualityCases, split);
const results: Array<{ id: string; run: number; passed: boolean; ms: number; error?: string }> = [];
for (let run = 1; run <= runs; run++)
  for (const item of cases) {
    const start = performance.now();
    let error: string | undefined;
    try {
      await item.run(ai);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Evaluation failed';
    }
    results.push({
      id: item.id,
      run,
      passed: !error,
      ms: Math.round(performance.now() - start),
      ...(error ? { error } : {}),
    });
    console.log(`${error ? 'FAIL' : 'PASS'} ${run}/${runs} ${item.id}`);
  }
const report = {
  date: new Date().toISOString(),
  model: process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b',
  askModel,
  provider: 'Groq',
  syntheticContentOnly: true,
  split,
  caseCounts: { dev: devCases.length, heldout: heldOutCases.length },
  runs,
  passed: results.filter(r => r.passed).length,
  total: results.length,
  results,
};
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/groq-evaluation.json', JSON.stringify(report, null, 2));
console.log(`${report.passed}/${report.total} passed. Report: artifacts/groq-evaluation.json`);
if (json) {
  const failures = new Map<string, string>();
  for (const r of results) {
    if (r.passed || failures.has(r.id)) continue;
    failures.set(r.id, r.error ?? 'failed');
  }
  const details = [...failures].slice(0, 5).map(([id, message]) => ({ id, message }));
  const score = report.total ? report.passed / report.total : 0;
  process.stdout.write(`${JSON.stringify({ score, details })}\n`);
}
if (report.passed !== report.total) process.exitCode = 1;
