import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { FolderRole } from '../../src/ports/provider';
import { HDR } from '../../src/store/commit';
import { listHeaders } from '../../src/store/ingest';
import { JOBS, loadJobCases, type Job, type JobCase } from './jobs-corpus';

const ROLES: readonly FolderRole[] = [
  'inbox',
  'sent',
  'drafts',
  'trash',
  'spam',
  'archive',
  'starred',
  'important',
  'all',
  'category.personal',
  'category.social',
  'category.promotions',
  'category.updates',
  'category.forums',
];

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function string(value: unknown): asserts value is string {
  assert.equal(typeof value, 'string');
  assert.ok((value as string).trim().length > 0);
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function reservedHost(host: string) {
  assert.match(host, /\.(?:example|test)$/i, `Non-reserved host: ${host}`);
}

function email(value: unknown) {
  string(value);
  assert.match(value, /^[^\s@<>]+@[^\s@<>]+$/);
  reservedHost(value.split('@')[1]);
}

function address(value: unknown) {
  const a = object(value);
  email(a.address);
  if (a.name !== undefined) string(a.name);
}

function optionalStrings(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (value[key] !== undefined) assert.equal(typeof value[key], 'string', key);
  }
}

function booleans(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) assert.equal(typeof value[key], 'boolean', key);
}

function validStoredHeaders(list: Record<string, unknown>) {
  const bits =
    (list.listId === undefined ? 0 : HDR.list) |
    (list.precedence === undefined ? 0 : HDR.bulk) |
    (list.autoSubmitted === undefined ? 0 : HDR.autoSubmitted);
  const urls =
    typeof list.listUnsubscribe === 'string'
      ? [...list.listUnsubscribe.matchAll(/<([^<>]*)>/g)]
          .map(match => match[1].trim())
          .filter(Boolean)
      : [];
  const oneClick = list.listUnsubscribePost === 'List-Unsubscribe=One-Click';
  const auth =
    urls.length && list.authenticated === true
      ? 1
      : urls.length && list.authenticated === false
        ? 0
        : null;
  const stored = listHeaders(bits, urls.length ? JSON.stringify({ urls, oneClick }) : null, auth);
  const expected = Object.fromEntries(
    Object.entries(stored).filter(([, value]) => value !== undefined),
  );
  assert.deepEqual(list, expected, 'Headers must match the values produced by ingest');
}

function validMessage(value: unknown) {
  const m = object(value);
  address(m.from);
  array(m.to).forEach(address);
  array(m.cc).forEach(address);
  string(m.subject);
  assert.equal(typeof m.date, 'number');
  assert.ok(Number.isFinite(m.date));
  optionalStrings(m, ['snippet', 'internetId']);
  const flags = object(m.flags);
  booleans(flags, ['seen', 'flagged', 'draft', 'fromMe']);
  assert.equal(flags.draft, false, 'laneInput selects a non-draft message');
  assert.equal(flags.fromMe, false, 'laneInput selects an inbound message');
  if (flags.answered !== undefined) booleans(flags, ['answered']);
  for (const role of array(m.roles)) assert.ok(ROLES.includes(role as FolderRole));
  const list = object(m.list);
  optionalStrings(list, [
    'listUnsubscribe',
    'listUnsubscribePost',
    'listId',
    'precedence',
    'autoSubmitted',
  ]);
  if (list.authenticated !== undefined) booleans(list, ['authenticated']);
  validStoredHeaders(list);
}

function validInput(value: unknown) {
  const input = object(value);
  validMessage(input.message);
  const self = array(input.self);
  assert.ok(self.length > 0);
  self.forEach(email);
  booleans(input, ['knownCorrespondent', 'userReplied', 'userEndedThread']);
  assert.ok(!input.userEndedThread || input.userReplied, 'Ending a thread requires a sent reply');
  string(input.text);
  assert.ok(input.text.length < 600, 'Body must be short');
  if (input.structured === undefined) return;
  for (const value of array(input.structured)) {
    const hint = object(value);
    assert.ok(['invite', 'delivery', 'reservation', 'bill'].includes(hint.kind as string));
    if (hint.final !== undefined) booleans(hint, ['final']);
    if (hint.due !== undefined) {
      string(hint.due);
      assert.match(hint.due, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(new Date(hint.due).toISOString().slice(0, 10), hint.due);
    }
  }
}

function safeEmails(value: string) {
  for (const match of value.matchAll(/[\w.!#$%&'*+/=?^`{|}~-]+@([a-z\d.-]+\.[a-z]+)/gi)) {
    reservedHost(match[1].replace(/\.$/, ''));
  }
}

function safeText(value: string) {
  for (const part of value.split(/[\s<>"'()[\],;]+/)) {
    const token = part.replace(/[.!?:]+$/, '');
    if (token.includes('://')) {
      assert.equal(token.split('://').length, 2, 'A URL token must contain exactly one scheme');
      const url = new URL(token);
      assert.ok(['http:', 'https:'].includes(url.protocol));
      reservedHost(url.hostname.replace(/\.$/, ''));
      safeEmails(decodeURIComponent(url.pathname + url.search + url.hash));
    } else if (token.includes('@')) {
      safeEmails(token);
    } else {
      const host = /^((?:[a-z\d-]+\.)+[a-z]{2,})(?=[/:?#]|$)/i.exec(token);
      const filename = /^[^.]+\.(pdf|csv|png|jpg|txt|ics|zip)$/i.test(token);
      if (host && (!filename || /^www\./i.test(token))) reservedHost(host[1]);
    }
  }
}

function safeStrings(value: unknown) {
  if (Array.isArray(value)) {
    value.forEach(safeStrings);
  } else if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(safeStrings);
  } else if (typeof value === 'string' && !ROLES.includes(value as FolderRole)) {
    safeText(value);
  }
}

function validCase(value: unknown, job: Job) {
  const c = object(value);
  string(c.id);
  assert.match(c.id, new RegExp(`^${job}-\\d{2}$`));
  assert.ok(JOBS.includes(c.job as Job));
  assert.equal(c.job, job);
  booleans(c, ['hard']);
  string(c.why);
  assert.match(c.why, /^[^.!?\n]+[.!?]$/, 'Why must be one sentence');
  validInput(c.input);
  safeStrings(c);
}

for (const job of JOBS) {
  test(`jobs corpus: ${job} has valid cases matching its file`, () => {
    const file = new URL(`./jobs-corpus/${job}.json`, import.meta.url);
    const cases = array(JSON.parse(readFileSync(file, 'utf8')));
    assert.ok(cases.length >= 40);
    for (const c of cases) {
      const id = object(c).id;
      assert.doesNotThrow(() => validCase(c, job), String(id));
    }
    assert.ok(cases.some(c => object(c).hard === true));
  });
}

test('jobs corpus: coverage, unique ids and unique emails', () => {
  const cases = loadJobCases();
  assert.ok(cases.length >= 240);
  assert.ok(cases.filter(c => c.hard).length >= cases.length / 3);
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
  const emails = cases.map(c =>
    JSON.stringify([
      c.input.message.from?.address.toLowerCase(),
      c.input.message.subject,
      c.input.text,
    ]),
  );
  assert.equal(new Set(emails).size, cases.length);
  assert.deepEqual(loadJobCases(), cases);
  assert.deepEqual([...new Set(cases.map(c => c.input.self.join(',')))], ['me@home.example']);
});

function senderDomain(c: JobCase) {
  const sender = c.input.message.from?.address;
  assert.ok(sender, c.id);
  const [local, domain] = sender.toLowerCase().split('@');
  assert.doesNotMatch(local, /\d$/, `Numbered sender local part: ${c.id}`);
  return domain;
}

function diverseSignals(cases: JobCase[]) {
  const jobsByDomain = new Map<string, Set<Job>>();
  for (const job of JOBS) {
    const rows = cases.filter(c => c.job === job);
    assert.ok(new Set(rows.map(senderDomain)).size >= 8, `${job}: too few sender domains`);
    const roleCounts = new Map<string, number>();
    for (const c of rows) {
      const domain = senderDomain(c);
      const jobs = jobsByDomain.get(domain) ?? new Set<Job>();
      jobs.add(job);
      jobsByDomain.set(domain, jobs);
      const roles = JSON.stringify([...new Set(c.input.message.roles)].sort());
      roleCounts.set(roles, (roleCounts.get(roles) ?? 0) + 1);
    }
    for (const count of roleCounts.values()) {
      assert.ok(count <= rows.length * 0.6, `${job}: a role set covers more than 60%`);
    }
  }
  assert.ok(
    [...jobsByDomain.values()].filter(jobs => jobs.size >= 2).length >= 6,
    'Too few sender domains shared across jobs',
  );
}

test('jobs corpus: sender domains and role sets cannot stand in for the job', () => {
  diverseSignals(loadJobCases());
});

function sharedHeaderValues(cases: JobCase[]) {
  const values = new Map<string, { count: number; jobs: Set<Job> }>();
  for (const c of cases) {
    for (const [header, value] of Object.entries(c.input.message.list)) {
      const key = JSON.stringify([header, value]);
      const usage = values.get(key) ?? { count: 0, jobs: new Set<Job>() };
      usage.count++;
      usage.jobs.add(c.job);
      values.set(key, usage);
    }
  }
  for (const [key, usage] of values) {
    assert.ok(usage.count <= 5 || usage.jobs.size > 1, `Header value identifies one job: ${key}`);
  }
}

test('jobs corpus: frequently used header values occur across jobs', () => {
  sharedHeaderValues(loadJobCases());
});

test('header shape guard rejects values ingest normalizes or cannot produce', () => {
  validStoredHeaders({});
  validStoredHeaders({
    listUnsubscribe: '<https://garden.example/leave>',
    listUnsubscribePost: 'List-Unsubscribe=One-Click',
    authenticated: true,
  });
  for (const list of [
    { precedence: 'list' },
    { precedence: 'junk' },
    { autoSubmitted: 'auto-replied' },
    { listId: '<notices.garden.example>' },
    { listUnsubscribe: 'mailto:leave@garden.example' },
    { listUnsubscribePost: 'One-Click' },
    { authenticated: 'true' },
    { authenticated: true },
    { authenticated: false },
    { listUnsubscribePost: 'List-Unsubscribe=One-Click' },
    { listUnsubscribe: '< >', authenticated: true },
  ]) {
    assert.throws(() => validStoredHeaders(list));
  }
});

test('header shortcut guard rejects values used more than five times in only one job', () => {
  for (const header of [
    'precedence',
    'autoSubmitted',
    'listId',
    'listUnsubscribe',
    'listUnsubscribePost',
  ] as const) {
    const cases = structuredClone(loadJobCases());
    const rows = cases.filter(c => c.job === 'read').slice(0, 6);
    for (const c of rows) c.input.message.list[header] = 'unique';
    assert.throws(() => sharedHeaderValues(cases), header);
  }
  sharedHeaderValues([]);
  sharedHeaderValues(loadJobCases().slice(0, 5));
});

test('shortcut guards reject homogeneous domains, numbered senders and dominant role sets', () => {
  const original = loadJobCases();
  const mutations: ((cases: JobCase[]) => void)[] = [
    cases => {
      for (const c of cases.filter(c => c.job === 'ask')) {
        c.input.message.from = { address: 'wren@single.example' };
      }
    },
    cases => {
      cases[0].input.message.from = { address: 'wren16@courtyard.example' };
    },
    cases => {
      const rows = cases.filter(c => c.job === 'read');
      for (const c of rows.slice(0, Math.floor(rows.length * 0.6) + 1)) {
        c.input.message.roles = ['inbox'];
      }
    },
    cases => {
      for (const c of cases) {
        const sender = c.input.message.from;
        assert.ok(sender);
        sender.address = sender.address.replace('@', `@${c.job.toLowerCase()}.`);
      }
    },
  ];
  for (const mutate of mutations) {
    const cases = structuredClone(original);
    mutate(cases);
    assert.throws(() => diverseSignals(cases));
  }
  assert.throws(() => diverseSignals([]));
});

test('jobs corpus validation rejects empty and malformed inputs', () => {
  for (const value of [null, [], {}, '', { message: {} }]) {
    assert.throws(() => validCase(value, 'ask'));
  }
  const original = loadJobCases()[0];
  const mutations: ((c: ReturnType<typeof loadJobCases>[number]) => void)[] = [
    c => {
      c.job = 'other';
    },
    c => {
      c.why = 'Two sentences. Not one.';
    },
    c => {
      c.input.text = '';
    },
    c => {
      c.input.text = 'x'.repeat(600);
    },
    c => {
      c.input.message.roles = ['invalid' as FolderRole];
    },
    c => {
      c.input.structured = [{ kind: 'invalid' as 'bill' }];
    },
    c => {
      c.input.userEndedThread = true;
      c.input.userReplied = false;
    },
    c => {
      c.input.message.flags.draft = true;
    },
    c => {
      c.input.message.flags.fromMe = true;
    },
  ];
  for (const mutate of mutations) {
    const c = structuredClone(original);
    mutate(c);
    assert.throws(() => validCase(c, 'ask'));
  }
});

test('jobs corpus preserves the hard contrast pairs and first-contact facts', () => {
  const cases = loadJobCases();
  const byId = (id: string) => {
    const c = cases.find(c => c.id === id);
    assert.ok(c, id);
    assert.equal(c.hard, true, id);
    return c;
  };
  const approval = byId('ask-01');
  const fyi = byId('update-01');
  assert.equal(approval.input.message.from?.address, fyi.input.message.from?.address);
  assert.equal(approval.input.knownCorrespondent, true);
  assert.equal(fyi.input.knownCorrespondent, true);
  assert.equal(
    byId('other-02').input.message.from?.address,
    byId('update-05').input.message.from?.address,
  );
  for (const id of ['update-02', 'update-03', 'update-04', 'other-01', 'newPerson-01']) byId(id);
  for (const c of cases.filter(c => c.job === 'newPerson')) {
    assert.equal(c.input.knownCorrespondent, false, c.id);
    assert.equal(c.input.userReplied, false, c.id);
  }
});

test('reserved-domain validation covers nested headers and free text', () => {
  safeStrings({
    text: 'See https://garden.example/path and write wren.alder@home.test.',
    sentence: 'Visit https://garden.example.',
    file: 'Download https://garden.example/receipt.pdf.',
    commaPath: 'Download https://garden.example/files/report,receipt.pdf.',
    attachments: 'report.pdf table.csv photo.png image.jpg notes.txt event.ics archive.zip',
    adjacent: '[a](https://garden.example),[b](https://pond.test/receipt.pdf)',
    listId: '<news.garden.example>',
    roles: ['category.personal'],
    handle: 'https://garden.example/@gardens @gardens',
    encodedEmail: 'https://garden.example/contact/person%40garden.example',
    mailto: 'mailto:person@garden.example',
    emailPath: 'https://garden.example/contact/person@garden.example',
    amount: '$12.50',
    coordinate: '-122.4194',
  });
  for (const value of [
    { subject: 'Visit https://outside.invalid/path' },
    { input: { text: 'Contact person@outside.invalid' } },
    { snippet: 'See www.outside.invalid' },
    { list: { listUnsubscribe: '<mailto:leave@outside.invalid>' } },
    { list: { listId: '<news.outside.invalid>' } },
    { text: 'See https://garden.example.outside.invalid/path' },
    { text: 'See ftp://outside.invalid/path' },
    { text: 'Visit https://outside.invalid.' },
    { text: 'Download https://outside.invalid/receipt.pdf.' },
    { text: 'See https://garden.example/contact/person@outside.invalid' },
    { text: '[a](https://garden.example),[b](https://outside.invalid)' },
    { text: 'https://garden.example,https://outside.invalid' },
    { text: 'https://garden.examplehttps://outside.invalid' },
    { text: '[a](https://outside.invalid),[b](https://garden.example)' },
    { text: 'https://outside.invalid,https://garden.example' },
    { text: 'https://outside.invalidhttps://garden.example' },
    { text: 'outside.invalidhttps://garden.example' },
    { text: 'outside.invalid' },
    { text: 'https://garden.example%2ecom/' },
    { text: 'https://garden.example,outside.invalid' },
    { text: 'www.vendor.zip' },
    { text: 'www.outside.invalid/help' },
    { text: 'www.outside.invalid:8080' },
    { text: 'vendor.report.pdf' },
    { text: 'https://garden.example/contact/person%40outside.invalid' },
    { text: 'https://garden.example/?email=person%40outside.invalid' },
    { text: 'https://garden.example/#person%40outside.invalid' },
    { text: 'https://garden.example/%ZZ' },
    { text: 'https://' },
    { text: 'ftp://garden.example/path' },
  ]) {
    assert.throws(() => safeStrings(value));
  }
});
