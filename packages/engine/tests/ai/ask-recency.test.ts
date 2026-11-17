import assert from 'node:assert/strict';
import test from 'node:test';
import { isRecencyQuestion, topicWords, wantsNewest } from '../../src/ai/impl/ask-recency';
import { msg } from '../store/helpers';
import { lastPrompt, seedMail, settle, stubTransport, world, type World } from './harness';

/**
 * Ask's "most recent" questions (2026-11-17 retest): asked for the three most recent emails, Ask skipped one sent
 * minutes earlier, because retrieval matched the question's filler words and the prompt carried no dates.
 */

/** Older mail full of the question's own words, then a short reply sent just now that shares none of them. */
const seedRecent = (w: World) => {
  seedMail(w);
  w.store.commit({
    opId: 'recent',
    origin: 'sync',
    writes: [
      msg('old1', 'T-old1', 1, {
        subject: 'What are the most recent account emails about',
        snippet: 'Three emails about this account.',
      }),
      msg('old2', 'T-old2', 2, {
        subject: 'The account recap',
        snippet: 'What are the three most recent emails about this account?',
      }),
      msg('d1', 'T-draft', 30, {
        subject: 'Unsent draft',
        snippet: 'Still writing',
        flags: { seen: true, flagged: false, draft: true, fromMe: true },
        folders: [{ folder: 'DRAFT' }],
      }),
      msg('sent1', 'T-sent', 20, {
        subject: 'Re: Lunch',
        snippet: 'Sounds good, Thursday works.',
        flags: { seen: true, flagged: false, draft: false, fromMe: true },
        folders: [{ folder: 'SENT' }],
      }),
    ],
  });
};

test('recency words and topic words are told apart', () => {
  assert.ok(isRecencyQuestion('What are the three most recent emails in this account about?'));
  assert.ok(isRecencyQuestion('anything new today?'));
  assert.ok(!isRecencyQuestion('What did Ada say about the invoice?'));
  assert.deepEqual(topicWords('What are the three most recent emails in this account about?'), []);
  assert.deepEqual(topicWords("What's the latest from Ada about the invoice?"), ['ada', 'invoice']);
  assert.ok(wantsNewest('Summarize my latest emails'));
  assert.ok(!wantsNewest('the latest invoice from Ada'));
});

test('Ask/run: "most recent" answers from the newest mail, newest first, with dates and no drafts', async () => {
  const t = stubTransport({});
  const w = await world(t);
  seedRecent(w);
  const run = await w.call('Ask/run', {
    question: 'What are the three most recent emails in this account about?',
  });
  await settle(w, run.runId);
  const prompt = lastPrompt(t);
  // The reply sent minutes ago leads, though it shares no word with the question.
  assert.match(prompt, /\[1\]\nFrom: [^\n]*\nSubject: Re: Lunch\nDate: \d{4}-\d\d-\d\dT/);
  const order = [...prompt.matchAll(/Subject: ([^\n]+)/g)].map(m => m[1]);
  assert.deepEqual(order.slice(0, 3), ['Re: Lunch', 'Subject T-thread', 'Invoice due Friday']);
  assert.ok(!order.includes('Unsent draft'), 'a draft is not mail in the account');
  assert.match(prompt, /\nNow: \d{4}-\d\d-\d\dT/);
});

test('Ask/run: "the latest about X" keeps keyword retrieval but lists the hits newest first', async () => {
  const t = stubTransport({});
  const w = await world(t);
  seedRecent(w);
  w.store.commit({
    opId: 'invoices',
    origin: 'sync',
    writes: [
      msg('inv-old', 'T-inv-old', 3, { subject: 'Invoice archive', snippet: 'Old invoice.' }),
      msg('inv-new', 'T-inv-new', 40, { subject: 'Invoice reminder', snippet: 'New invoice.' }),
    ],
  });
  const run = await w.call('Ask/run', { question: 'What is the latest invoice?' });
  await settle(w, run.runId);
  const order = [...lastPrompt(t).matchAll(/Subject: ([^\n]+)/g)].map(m => m[1]);
  assert.equal(order[0], 'Invoice reminder');
  assert.ok(!order.includes('Re: Lunch'), 'a topic question is not padded with unrelated new mail');
  const dates = [...lastPrompt(t).matchAll(/Date: ([^\n]+)/g)].map(m => Date.parse(m[1]));
  assert.deepEqual(
    dates,
    [...dates].sort((a, b) => b - a),
  );
});
