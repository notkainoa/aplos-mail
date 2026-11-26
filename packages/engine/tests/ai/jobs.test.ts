import test from 'node:test';
import assert from 'node:assert/strict';
import { jobFor, type Job } from '../../src/ai/jobs';
import type { LaneInput } from '../../src/ports';
import { JOBS, loadJobCases, type JobCase } from './jobs-corpus';

function fromPerson(c: JobCase) {
  if (c.job === 'newPerson') return true;
  const { list, from } = c.input.message;
  const local = (from?.address.split('@')[0] ?? '').normalize('NFKC').replace(/[^a-z0-9]/gi, '');
  const noReply = /^(no|donot)repl(y|ies)/i.test(local);
  const bulk = Boolean(
    list.listId ||
    list.listUnsubscribe ||
    list.precedence ||
    (list.autoSubmitted && !/^no$/i.test(list.autoSubmitted)),
  );
  return (c.input.knownCorrespondent || c.input.userReplied) && !bulk && !noReply;
}

const percent = (right: number, total: number) =>
  total ? `${((100 * right) / total).toFixed(1)}%` : 'n/a';

test('six-job corpus accuracy and safety', () => {
  const cases = loadJobCases();
  const rows = cases.map(c => ({ c, result: jobFor(c.input) }));
  console.log('Job       | Easy correct/total | Hard correct/total | Overall correct/total');
  for (const job of [...JOBS, 'overall'] as const) {
    const group = rows.filter(row => job === 'overall' || row.c.job === job);
    const cells = [false, true, undefined].map(hard => {
      const subset = group.filter(row => hard === undefined || row.c.hard === hard);
      const right = subset.filter(row => row.result.job === row.c.job).length;
      return `${right}/${subset.length} (${percent(right, subset.length)})`;
    });
    console.log(`${job.padEnd(9)} | ${cells.join(' | ')}`);
  }
  const sure = rows.filter(row => row.result.confidence === 'sure');
  const correctSure = sure.filter(row => row.result.job === row.c.job).length;
  const people = rows.filter(row => fromPerson(row.c));
  const hiddenPeople = people.filter(row => ['other', 'record'].includes(row.result.job));
  console.log(
    `Sure accuracy: ${correctSure}/${sure.length} (${percent(correctSure, sure.length)})`,
  );
  console.log(`Sure share: ${sure.length}/${rows.length} (${percent(sure.length, rows.length)})`);
  console.log(`Person -> other/record: ${hiddenPeople.length}/${people.length}`);
  assert.ok(sure.length > 0, 'Sure accuracy must not be vacuous');
  assert.ok(correctSure / sure.length >= 0.95, 'At least 95% of sure answers must be right');
  assert.deepEqual(
    hiddenPeople.map(row => row.c.id),
    [],
  );
  for (const { c, result } of rows) {
    assert.ok(JOBS.includes(result.job));
    assert.ok(['sure', 'unsure'].includes(result.confidence));
    assert.ok(result.confidence === 'sure' || result.job !== 'other', c.id);
    assert.deepEqual(jobFor(c.input), result);
  }
});

function input(text = ''): LaneInput {
  return {
    message: {
      from: { address: 'alex@sender.example' },
      to: [{ address: 'me@home.example' }],
      cc: [],
      subject: '',
      date: 0,
      list: {},
      flags: { seen: false, flagged: false, draft: false, fromMe: false },
      roles: ['inbox'],
    },
    self: ['me@home.example'],
    knownCorrespondent: false,
    userReplied: false,
    userEndedThread: false,
    text,
  };
}

test('new person mail stays visible without mutating its input', () => {
  for (const text of [
    '',
    'Hello there',
    'This is a receipt',
    'Sale this week',
    'FYI: it changed',
  ]) {
    const value = input(text);
    const before = structuredClone(value);
    const result = jobFor(value);
    assert.ok(!['other', 'record'].includes(result.job));
    assert.deepEqual(value, before);
    assert.equal(result.job, 'newPerson');
    if (!text) assert.equal(result.confidence, 'unsure');
  }
  const value = input();
  value.message.from = undefined;
  value.text = undefined;
  assert.equal(jobFor(value).confidence, 'unsure');
});

test('history overrides weak automation and service addresses', () => {
  for (const history of ['knownCorrespondent', 'userReplied'] as const) {
    const value = input('Could you review this?');
    value[history] = true;
    value.message.from = { address: 'billing@sender.example' };
    value.message.list = { listUnsubscribe: '<https://sender.example/leave>' };
    value.message.roles = ['inbox', 'category.updates'];
    assert.equal(jobFor(value).job, 'ask');
  }
});

test('conflicting or forged bulk signals cannot hide a personal request', () => {
  const value = input('Could you confirm the meeting?');
  value.message.list = { precedence: 'bulk', listId: '(present)' };
  assert.deepEqual(jobFor(value), { job: 'ask', confidence: 'unsure' });
  value.text = 'Hello';
  assert.deepEqual(jobFor(value), { job: 'ask', confidence: 'unsure' });
});

test('an old request in a reply subject is not a confident new ask', () => {
  const value = input('Everything is complete.');
  value.knownCorrespondent = true;
  value.userReplied = true;
  value.message.subject = 'Re: Could you sign this?';
  assert.deepEqual(jobFor(value), { job: 'update', confidence: 'sure' });
});

test('automated job signals and conflicts', () => {
  const examples: [string, Job][] = [
    ['Your payment failed', 'update'],
    ['Your receipt', 'record'],
    ['Weekly newsletter', 'read'],
    ['A discount coupon', 'other'],
    ['Could you confirm your payment?', 'ask'],
  ];
  for (const [text, job] of examples) {
    const value = input(text);
    value.message.from = { address: 'no-reply@sender.example' };
    assert.equal(jobFor(value).job, job);
  }
  const value = input('Could you review this discount?');
  value.knownCorrespondent = true;
  assert.deepEqual(jobFor(value), { job: 'ask', confidence: 'unsure' });
  value.text = '> Could you review this?';
  assert.equal(jobFor(value).confidence, 'unsure');
});

test('unknown nonautomated senders are new people even when asking a question', () => {
  const value = input('Could you tell me more?');
  assert.deepEqual(jobFor(value), { job: 'newPerson', confidence: 'sure' });
  value.message.list = { listUnsubscribe: '<https://sender.example/leave>' };
  assert.deepEqual(jobFor(value), { job: 'ask', confidence: 'unsure' });
});

test('known personal updates, questions and documentary conflicts', () => {
  const value = input('The rehearsal went well.');
  value.knownCorrespondent = true;
  assert.deepEqual(jobFor(value), { job: 'update', confidence: 'sure' });
  value.text = 'Are you attending?';
  assert.equal(jobFor(value).job, 'ask');
  value.text = 'The signed copy is attached.';
  assert.deepEqual(jobFor(value), { job: 'update', confidence: 'unsure' });
  value.text = 'See you by tomorrow';
  assert.equal(jobFor(value).job, 'ask');
});

test('editorial, promotional, app and structured mail use distinct signal families', () => {
  const value = input('This edition contains essays.');
  value.message.from = { address: 'news@sender.example' };
  value.message.list = { precedence: 'bulk', listId: '(present)' };
  assert.deepEqual(jobFor(value), { job: 'read', confidence: 'sure' });
  value.text = 'A discount coupon';
  assert.deepEqual(jobFor(value), { job: 'other', confidence: 'sure' });
  value.message.from = { address: 'notifications@sender.example' };
  value.text = 'Activity in the application';
  assert.deepEqual(jobFor(value), { job: 'other', confidence: 'sure' });
  value.text = 'Your receipt';
  assert.deepEqual(jobFor(value), { job: 'record', confidence: 'sure' });
  value.text = 'A refund receipt';
  assert.deepEqual(jobFor(value), { job: 'update', confidence: 'unsure' });
  value.text = 'Details attached';
  for (const kind of ['delivery', 'reservation'] as const) {
    value.structured = [{ kind }];
    assert.equal(jobFor(value).job, 'update');
  }
  value.structured = [{ kind: 'bill', final: true }];
  assert.equal(jobFor(value).job, 'record');
  value.structured = [{ kind: 'bill', due: '2027-01-10' }];
  assert.equal(jobFor(value).job, 'ask');
  value.structured = [{ kind: 'invite' }];
  assert.equal(jobFor(value).job, 'ask');
});
