import test from 'node:test';
import assert from 'node:assert/strict';
import { providerRequest } from '../src/main/llm';
import {
  describeSummaryError,
  hasRealSummary,
  summaryProvider,
} from '../src/renderer/legacy/summaryText';
import type { Thread } from '@aplos/contract/legacy/types';

const groq = (status: number, headers: Record<string, string> = {}, key = 'test') =>
  providerRequest(
    {
      name: 'Groq',
      env: 'GROQ_API_KEY',
      baseUrl: 'https://groq.example',
      apiKey: key,
      fetch: async () => new Response('{}', { status, headers }),
    },
    'chat',
    undefined,
  ).then(
    () => '',
    (error: Error) => error.message,
  );

test('every provider failure the summary card can hit gets its own reason, naming that provider', async () => {
  const groqInfo = summaryProvider(undefined);
  assert.deepEqual(groqInfo, { label: 'Groq', env: 'GROQ_API_KEY', keyOptional: undefined });
  const messages = [
    await groq(200, {}, ''),
    await groq(401),
    await groq(402),
    await groq(413),
    await groq(429),
    await groq(429, { 'retry-after': '600' }),
    await groq(404),
    'Groq could not complete the request. Check your connection and try again.',
    'Groq returned an invalid response. Please try again.',
  ];
  const titles = messages.map(message => describeSummaryError(message, groqInfo).title);
  assert.ok(!titles.includes('Something went wrong'), titles.join(' | '));
  assert.equal(new Set(titles).size, titles.length);
  assert.equal(
    describeSummaryError('Groq request failed (500). Please try again.', groqInfo).title,
    'Something went wrong',
  );
  // Another provider chosen in Settings → AI is named, with its own key.
  const claude = summaryProvider('anthropic:claude-sonnet-5-5');
  const missing = describeSummaryError(
    'Add your Claude key in Settings → AI to use Claude.',
    claude,
  );
  assert.equal(missing.title, 'Claude isn’t set up');
  assert.match(missing.detail, /Claude key .*Settings → AI/);
  assert.equal(
    describeSummaryError('Claude is overloaded right now. Please try again shortly.', claude).title,
    'Claude is busy right now',
  );
  assert.equal(
    describeSummaryError(
      'Ollama isn’t running at localhost:11434. Open Ollama, or change its address in Settings → AI.',
      summaryProvider('ollama:llama4'),
    ).title,
    'Ollama isn’t running',
  );
});

test('a summary that is only the email’s own text does not count', () => {
  const thread = (summary: string) =>
    ({
      summary,
      messages: [{ text: 'Hi Alex,\nWe are gathering at the garden this Saturday at 10 am.' }],
    }) as Thread;
  assert.equal(hasRealSummary(thread('We are gathering at the garden this Saturday…')), false);
  assert.equal(hasRealSummary(thread('')), false);
  assert.equal(hasRealSummary(thread('Help plant the herb beds Saturday at 10 am')), true);
  // A summary Groq wrote counts even when it repeats a sentence from the email.
  assert.equal(
    hasRealSummary({
      ...thread('We are gathering at the garden this Saturday at 10 am'),
      aiSummary: true,
    }),
    true,
  );
});
