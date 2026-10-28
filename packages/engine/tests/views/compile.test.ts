import test from 'node:test';
import assert from 'node:assert/strict';
import type { ViewSpec } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { StoreReader } from '../../src/store';
import { compileView, hasViewKind, registerViewKind } from '../../src/views/registry';
import { ftsQuery } from '../../src/views/search';
import { startOfDay, localDay, addDays } from '../../src/views/sections';
import type { ViewEnv, ViewPlan } from '../../src/views/specs';
import { expected, load } from './reference';
import { makeWorld, ACCOUNTS } from './world';

/*
 * views-1: every built-in spec, compiled to keyset SQL, gives the slow reference's rows, order, sections and counts on
 * seeded random mailboxes, read in small pages so every keyset continuation is exercised. The environments sit on
 * DST changes, including Havana's, where local midnight happens twice.
 */

const ENVS: { name: string; env: ViewEnv }[] = [
  {
    name: 'Los Angeles, eve of the DST change',
    env: { now: Date.UTC(2026, 10, 1, 5, 0), zone: 'America/Los_Angeles', followUpDays: 3 },
  },
  {
    name: 'London, half past midnight on the DST change',
    env: { now: Date.UTC(2026, 9, 24, 23, 30), zone: 'Europe/London', followUpDays: 2 },
  },
  {
    name: 'Havana, an hour before the doubled midnight',
    env: { now: Date.UTC(2026, 10, 1, 3, 0), zone: 'America/Havana', followUpDays: 5 },
  },
];
const SEEDS = [1, 2, 3];

function specs(q: StoreReader): ViewSpec[] {
  const threads = q
    .all<{ id: string }>(
      "SELECT account_id || ':' || remote_id AS id FROM threads ORDER BY id LIMIT 4",
    )
    .map(r => r.id);
  const out: ViewSpec[] = [
    { kind: 'home' },
    ...ACCOUNTS.map(accountId => ({ kind: 'home', accountId }) as const),
    ...(['do', 'update', 'low', 'follow'] as const).map(
      section => ({ kind: 'homeSection', section }) as const,
    ),
    { kind: 'homeSection', section: 'do', accountId: 'imap:2' },
    { kind: 'oneByOne', section: 'update' },
    { kind: 'lowSenders' },
    { kind: 'lowBySender' },
    { kind: 'lowBySender', accountId: 'acct-1' },
    { kind: 'label', folderId: 'acct-1:Label_1' },
    { kind: 'label', folderId: 'acct-1:Label_empty' },
    { kind: 'label', folderId: 'acct-1:no-such-label' },
    { kind: 'label', folderId: 'imap:2:Projects' },
    { kind: 'label', folderId: 'acct-1:TRASH' },
    { kind: 'later' },
    { kind: 'later', accountId: 'acct-1' },
    { kind: 'bookmarks' },
    { kind: 'replyState', status: 'needsReply' },
    { kind: 'replyState', status: 'awaitingReply', accountId: 'imap:2' },
    { kind: 'done' },
    { kind: 'done', accountId: 'acct-1' },
    { kind: 'drafts' },
    { kind: 'drafts', accountId: 'imap:2' },
    { kind: 'scheduled' },
    ...threads.map(threadId => ({ kind: 'thread', threadId }) as const),
  ];
  for (const role of [
    'inbox',
    'all',
    'sent',
    'trash',
    'spam',
    'archive',
    'starred',
    'important',
  ] as const)
    for (const accountId of [undefined, ...ACCOUNTS])
      out.push({ kind: 'mailbox', role, accountId });
  const queries = [
    { text: 'budget' },
    { text: 'bud' },
    { text: 'garden harbor' },
    // FTS5 syntax in user text is searched as words, never parsed.
    { text: '"budget"' },
    { text: 'inv*' },
    { text: '-garden' },
    { text: 'budget OR' },
    { text: 'NEAR(budget' },
    { text: 'col:invoice' },
    { text: '"' },
    { text: '* ^ ( )' },
    { text: 'budget', from: 'ada' },
    { text: '', to: 'ben' },
    { text: '', subject: 'harbor' },
    { text: 'invoice', in: 'inbox' },
    { text: 'maple', in: 'trash' },
    { text: 'maple', is: ['unread' as const], hasAttachment: false },
    { text: '', is: ['unread' as const] },
    { text: '', is: ['flagged' as const, 'bookmarked' as const] },
    { text: '', in: 'later' },
    { text: '', in: 'done', is: ['read' as const] },
    { text: '', in: 'starred' },
    { text: '', in: 'spam' },
    { text: '', in: 'archive' },
    { text: '', in: 'all', is: ['unread' as const] },
    { text: 'budget', in: 'archive' },
    { text: 'invoice', in: 'all' },
    // Typed but unsearchable words match nothing; control characters are dropped.
    { text: '???' },
    { text: '', from: '--' },
    { text: 'bud\u0000get' },
    // Non-ASCII subjects fold like the index does.
    { text: '', subject: 'Harbór' },
    { text: '', in: 'acct-1:Label_1', hasAttachment: false },
    { text: '', in: 'imap:2:Projects' },
    { text: '', after: '2026-10-25', before: '2026-10-30' },
    { text: 'review', after: '2026-10-31' },
  ];
  for (const query of queries) out.push({ kind: 'search', query });
  out.push({ kind: 'search', query: { text: 'budget' }, accountId: 'imap:2' });
  // A folder place of another account matches nothing.
  out.push({ kind: 'search', query: { text: '', in: 'acct-1:Label_1' }, accountId: 'imap:2' });
  return out;
}

/** The whole view through `rows`, `size` rows at a time from each page's last point. */
function readAll(plan: ViewPlan, q: StoreReader, size: number): string[] {
  const out: string[] = [];
  let page = plan.rows(q, undefined, size);
  while (page.length) {
    out.push(...page.map(r => r.id));
    page = plan.rows(q, page[page.length - 1].at, size);
  }
  return out;
}

const label = (spec: ViewSpec) => JSON.stringify(spec);

for (const { name, env } of ENVS)
  for (const seed of SEEDS)
    test(`every spec matches the reference (${name}, seed ${seed})`, () => {
      const world = makeWorld(seed * 7919, env.now);
      try {
        world.store.read(q => {
          const data = load(q);
          let nonEmpty = 0;
          for (const spec of specs(q)) {
            const plan = compileView(spec, env);
            const want = expected(data, spec, env, {
              fts: spec.kind === 'search' && !!ftsQuery(spec.query),
              startOf: day => startOfDay(day, env.zone),
            });
            const got = readAll(plan, q, 7);
            assert.deepEqual(got, want.ids, `rows of ${label(spec)}`);
            const layout = plan.layout(q);
            assert.equal(layout.total, want.total, `total of ${label(spec)}`);
            assert.deepEqual(layout.sections, want.sections, `sections of ${label(spec)}`);
            if (got.length) nonEmpty++;
            for (const [i, id] of got.entries()) {
              if (got.indexOf(id) !== i) continue;
              const at = plan.locate(q, id);
              assert.equal(at?.index, i, `locate ${id} in ${label(spec)}`);
              assert.deepEqual(
                plan.rows(q, at!.at, 3).map(r => r.id),
                got.slice(i + 1, i + 4),
                `resume after ${id} in ${label(spec)}`,
              );
            }
          }
          // The data really exercises the views: most specs have rows.
          assert.ok(nonEmpty > 60, `only ${nonEmpty} specs had rows`);
        });
      } finally {
        world.cleanup();
      }
    });

test('a row not in the view is not located; an unknown thread is notFound', () => {
  const env = ENVS[0].env;
  const world = makeWorld(5, env.now, 30);
  try {
    world.store.read(q => {
      const inbox = compileView({ kind: 'mailbox', role: 'inbox' }, env);
      assert.equal(inbox.locate(q, 'acct-1:nope'), undefined);
      assert.equal(inbox.locate(q, 'nobody:t1'), undefined);
      const reader = compileView({ kind: 'thread', threadId: 'acct-1:missing' }, env);
      assert.throws(
        () => reader.rows(q, undefined, 10),
        (e: unknown) => e instanceof ContractError && e.type === 'notFound',
      );
    });
  } finally {
    world.cleanup();
  }
});

test('no compiled statement uses OFFSET, and every one prepares', () => {
  const env = ENVS[0].env;
  const world = makeWorld(9, env.now, 40);
  try {
    world.store.read(q => {
      for (const spec of specs(q)) {
        for (const s of compileView(spec, env).statements(q)) {
          assert.doesNotMatch(s.sql, /\bOFFSET\b/i, label(spec));
          q.all(s.sql, ...s.params);
        }
      }
    });
  } finally {
    world.cleanup();
  }
});

test('Later groups follow local days across DST changes', () => {
  // America/Havana: on 2026-11-01 clocks go back from 01:00 to 00:00, so midnight happens twice.
  const havana = startOfDay('2026-11-01', 'America/Havana');
  assert.equal(localDay(havana, 'America/Havana'), '2026-11-01');
  assert.equal(localDay(havana - 1, 'America/Havana'), '2026-10-31');
  assert.equal(havana, Date.UTC(2026, 10, 1, 4, 0)); // the first midnight, still on daylight time (UTC-4)
  // Los Angeles: 2026-11-01 lasts 25 hours.
  const la = (d: string) => startOfDay(d, 'America/Los_Angeles');
  assert.equal(la('2026-11-02') - la('2026-11-01'), 25 * 3_600_000);
  assert.equal(la('2026-03-09') - la('2026-03-08'), 23 * 3_600_000);
  assert.equal(addDays('2026-10-31', 7), '2026-11-07');
});

test('the registry refuses a kind twice and answers unsupported for one nobody registered', () => {
  assert.ok(hasViewKind('home'));
  assert.throws(() => registerViewKind('home', () => undefined as never), /registered twice/);
  assert.ok(!hasViewKind('events'));
  assert.throws(
    () => compileView({ kind: 'conversations' }, ENVS[0].env),
    (e: unknown) => e instanceof ContractError && e.type === 'unsupported',
  );
});
