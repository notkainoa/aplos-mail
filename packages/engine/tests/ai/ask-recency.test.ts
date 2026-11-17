import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isoDate,
  isRecencyQuestion,
  newestFirst,
  topicWords,
  wantsNewest,
} from '../../src/ai/impl/ask-recency';
import { ACCOUNT, msg } from '../store/helpers';
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
  assert.ok(wantsNewest('Anything new today?'));
  assert.ok(wantsNewest('What are my last 3 emails about?'));
  assert.ok(!wantsNewest('the latest invoice from Ada'));
  // Two letters can be the whole topic.
  assert.ok(!wantsNewest('my latest emails from HR'));
  // "last" alone is not recency: a last name is a topic.
  assert.ok(!isRecencyQuestion("What is Ada's last name?"));
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
  assert.deepEqual(order.slice(0, 3), ['Re: Lunch', 'Subject T-thread', 'The account recap']);
  assert.ok(!order.includes('Unsent draft'), 'a draft is not mail in the account');
  assert.match(prompt, /\nNow: \d{4}-\d\d-\d\dT[^\n]*\n\nSources:/);
});

test('Ask/run: the newest mail takes one message per thread and never reads a kept-out account', async () => {
  const t = stubTransport({});
  const w = await world(t);
  seedRecent(w);
  w.store.commit({
    opId: 'busy-and-kept-out',
    origin: 'sync',
    writes: [
      ...[50, 51, 52, 53].map(m => msg(`busy${m}`, 'T-busy', m, { subject: 'Busy thread' })),
      {
        kind: 'account',
        id: 'acct-out',
        provider: 'google',
        address: 'out@mail.example',
        capabilities: {},
        status: { state: 'ok' },
        aiAllowed: false,
      },
      {
        kind: 'folder',
        accountId: 'acct-out',
        remoteId: 'INBOX',
        name: 'Inbox',
        role: 'inbox',
        folderKind: 'system',
      },
      msg('out1', 'T-out', 99, { accountId: 'acct-out', subject: 'Kept out of AI' }),
    ],
  });
  const run = await w.call('Ask/run', { question: 'What are my most recent emails about?' });
  await settle(w, run.runId);
  const prompt = lastPrompt(t);
  const order = [...prompt.matchAll(/Subject: ([^\n]+)/g)].map(m => m[1]);
  assert.equal(order.filter(s => s === 'Busy thread').length, 1, 'one source per thread');
  assert.equal(order[0], 'Busy thread');
  assert.ok(!prompt.includes('Kept out of AI'), 'a kept-out account is never read');
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

test('newestFirst keeps the leading sources, sorts the rest newest first and renumbers', () => {
  const src = (n: number, date?: number) => ({ n, date });
  const out = newestFirst([src(1, 5), src(2, 1), src(3, 9), src(4), src(5, 4)], 1);
  assert.deepEqual(
    out.map(s => [s.n, s.date]),
    [
      [1, 5],
      [2, 9],
      [3, 4],
      [4, 1],
      [5, undefined],
    ],
  );
});

test('a date past what JS holds drops the Date line instead of failing the run', async () => {
  assert.equal(isoDate(9e15), undefined);
  assert.equal(isoDate(Number.NaN), undefined);
  assert.equal(isoDate(0), '1970-01-01T00:00:00.000Z');
  const t = stubTransport({});
  const w = await world(t);
  seedRecent(w);
  w.store.commit({
    opId: 'far-future',
    origin: 'sync',
    writes: [msg('far', 'T-far', 0, { subject: 'From the far future', internalDate: 9e15 })],
  });
  const run = await w.call('Ask/run', { question: 'What are my latest emails about?' });
  await settle(w, run.runId);
  assert.equal(t.calls.length, 1, 'the provider was asked');
  const prompt = lastPrompt(t);
  assert.match(prompt, /\[1\]\nFrom: [^\n]*\nSubject: From the far future\n\n/);
});

test('the newest mail never includes a thread in Trash or Spam', async () => {
  const t = stubTransport({});
  const w = await world(t);
  seedRecent(w);
  w.store.commit({
    opId: 'trashed',
    origin: 'sync',
    writes: [
      {
        kind: 'folder',
        accountId: ACCOUNT,
        remoteId: 'SPAM',
        name: 'Spam',
        role: 'spam',
        folderKind: 'system',
      },
      msg('bin', 'T-bin', 90, { subject: 'Thrown away', folders: [{ folder: 'TRASH' }] }),
      msg('junk', 'T-junk', 91, { subject: 'Filtered out', folders: [{ folder: 'SPAM' }] }),
    ],
  });
  const run = await w.call('Ask/run', { question: 'What are my most recent emails about?' });
  await settle(w, run.runId);
  const prompt = lastPrompt(t);
  assert.ok(!prompt.includes('Thrown away'), 'the newest message is in Trash and stays out');
  assert.ok(!prompt.includes('Filtered out'), 'a thread in Spam stays out');
  assert.match(prompt, /\[1\]\nFrom: [^\n]*\nSubject: Re: Lunch/);
});
