import { loadDevEnv } from '../src/main/env';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Conversation } from '@aplos/contract/legacy/types';
import { createService } from '../src/main/service';
import { createGoogle } from '../src/main/google';
import { createGroq } from '../src/main/groq';
import { defaultAskModel, parseAskModel } from '@aplos/contract/legacy/ask';
import { loadAskCases, parseSplit, pickOnly, scoreLine } from './quality/splits';

/**
 * An explicit live check of Ask's agent loop against Groq on fresh original demo mail in a temporary
 * folder. Nothing is sent and no real mailbox is touched. Usage: npm run eval:ask -- --model=openrouter:anthropic/claude-haiku-5.5
 * (provider:model; Groq is the default and the key for the chosen provider must be in the environment).
 * --split=dev|heldout|all picks the case set, --only=N picks a single case within it, --json prints
 * one final {"score": 0..1, "details": [...]} line on stdout for the hill-climb scorer.
 */
// Under --json the only stdout line is the machine-readable score; everything else goes to stderr.
const json = process.argv.includes('--json');
if (json) console.log = console.error;
loadDevEnv();
const groq = createGroq();
const model = process.argv.find(a => a.startsWith('--model='))?.slice(8) ?? defaultAskModel;
if (!parseAskModel(model))
  throw new Error('Give --model as provider:model, e.g. groq:openai/gpt-oss-120b.');
const split = parseSplit(process.argv);
const questions = pickOnly(
  await loadAskCases(split),
  process.argv.find(a => a.startsWith('--only='))?.slice(7),
);
const dataDir = await mkdtemp(join(tmpdir(), 'aplos-ask-live-'));
const service = await createService({
  dataDir,
  google: await createGoogle({ dataDir, clientId: '' }),
  groq,
});
let usage: { calls?: number; prompt?: number; completion?: number } = {};
service.subscribe(event => {
  const p = event.payload as {
    type?: string;
    step?: { tool: string; label: string; status: string };
    calls?: number;
    prompt?: number;
    completion?: number;
  };
  if (event.type === 'ai.progress' && p?.type === 'usage') usage = p;
  if (event.type === 'ai.progress' && p?.step?.tool === 'wait' && p.step.status === 'running')
    console.log(`  … ${p.step.label}`);
});
let failed = 0;
const failures: { id: string; message: string }[] = [];
try {
  await service.invoke('settings.update', { patch: { askModel: model } });
  const before = (await service.invoke('state.get')) as {
    drafts: unknown[];
    threads: { id: string; status: string }[];
  };
  for (const question of questions) {
    const started = performance.now();
    try {
      const conversation = (await service.invoke('ai.ask', {
        message: question.message,
        timeZone: 'America/Los_Angeles',
        ...question.extra,
      })) as Conversation;
      const answer = conversation.messages.at(-1)!;
      console.log(
        `\n» ${question.message}  (${Math.round(performance.now() - started)} ms, ${usage.calls} calls, ${usage.prompt} prompt + ${usage.completion} output tokens)`,
      );
      for (const s of answer.steps ?? [])
        console.log(
          `  · ${s.label}${s.count !== undefined ? ` · ${s.count}` : ''}${s.status === 'error' ? ' (error)' : ''}`,
        );
      console.log(`  ${answer.content.replace(/\n/g, '\n  ')}`);
      if (answer.citations?.length) console.log(`  cites: ${answer.citations.join(', ')}`);
      if (answer.proposal)
        console.log(
          `  draft card: to=${answer.proposal.to ?? ''} subject=${answer.proposal.subject ?? ''}`,
        );
      if (answer.event)
        console.log(
          `  event card: ${answer.event.title} ${answer.event.start} → ${answer.event.end} guests=${answer.event.guests?.join(', ')}`,
        );
      if (answer.triage)
        console.log(`  triage card: ${answer.triage.action} ${answer.triage.threadIds.join(', ')}`);
    } catch (error) {
      failed++;
      failures.push({ id: question.id, message: (error as Error).message });
      console.log(`\n» ${question.message}\n  FAILED: ${(error as Error).message}`);
    }
  }
  const after = (await service.invoke('state.get')) as {
    drafts: unknown[];
    threads: { id: string; status: string }[];
  };
  const unchanged =
    JSON.stringify(after.drafts) === JSON.stringify(before.drafts) &&
    JSON.stringify(after.threads.map(t => [t.id, t.status])) ===
      JSON.stringify(before.threads.map(t => [t.id, t.status]));
  console.log(
    `\n${model} (${split}): ${questions.length - failed}/${questions.length} answered; drafts and threads unchanged: ${unchanged}`,
  );
} finally {
  await service.close();
  await rm(dataDir, { recursive: true, force: true });
}
if (json) {
  const errors = new Map(failures.map(f => [f.id, f.message]));
  const results = questions.map(q => ({
    id: q.id,
    passed: !errors.has(q.id),
    error: errors.get(q.id),
  }));
  process.stdout.write(`${JSON.stringify(scoreLine(results))}\n`);
}
// Under --json a printed score line is a successful scorer run; failing cases lower the score but
// do not fail the run.
if (failed && !json) process.exitCode = 1;
