import { loadDevEnv } from '../src/main/env';
import { mkdir, writeFile } from 'node:fs/promises';
import { createGroq } from '../src/main/groq';
import { askModel, devCases } from './quality/cases';
import { loadQualityCases, ORDER, parseSplit, scoreLine } from './quality/splits';

// Under --json the only stdout line is the machine-readable score; everything else goes to stderr.
const json = process.argv.includes('--json');
if (json) console.log = console.error;
loadDevEnv();
const ai = createGroq();
if (!ai.available)
  throw new Error('Set GROQ_API_KEY in the backend environment to run live evaluations.');
const runs = Number(process.argv.find(a => a.startsWith('--runs='))?.split('=')[1] ?? 1);
if (!Number.isInteger(runs) || runs < 1 || runs > 5)
  throw new Error('Use --runs=1 through --runs=5.');
const split = parseSplit(process.argv);
const cases = await loadQualityCases(split);
if (!cases.length) throw new Error(`--split=${split} selected no cases.`);
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
const devIds = new Set(devCases.map(c => c.id));
const report = {
  date: new Date().toISOString(),
  model: process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b',
  askModel,
  provider: 'Groq',
  syntheticContentOnly: true,
  split,
  caseCounts: {
    dev: devCases.length,
    heldout: ORDER.quality.filter(id => !devIds.has(id)).length,
  },
  runs,
  passed: results.filter(r => r.passed).length,
  total: results.length,
  results,
};
const reportFile =
  split === 'all' ? 'artifacts/groq-evaluation.json' : `artifacts/groq-evaluation-${split}.json`;
await mkdir('artifacts', { recursive: true });
await writeFile(reportFile, JSON.stringify(report, null, 2));
console.log(`${report.passed}/${report.total} passed. Report: ${reportFile}`);
if (json) process.stdout.write(`${JSON.stringify(scoreLine(results))}\n`);
// Under --json a printed score line is a successful scorer run; failing cases lower the score but
// do not fail the run.
if (!json && report.passed !== report.total) process.exitCode = 1;
