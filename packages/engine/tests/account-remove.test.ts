import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '@aplos/contract/contract-error';
import { handlers } from '../src/methods/account';
import type { MethodContext } from '../src/methods/types';
import type { EngineServices } from '../src/runtime/services';
import type { AccountActorHost } from '../src/ports';
import { laneExtensions } from '../src/index';
// The seed's `conversation` write uses the lazy AI writers; the method loads them itself.
import '../src/ai/impl/ai-writes';
import { openStore, type CommitInput, type StorePort, type StoreWrite } from '../src/store';
import { REMOVE_BATCH, resumeRemovals } from '../src/sync/account-remove';
import { accountIds as listedAccounts } from '../src/sync/account-read';
import { accountIds as viewAccounts } from '../src/views/compile';
import { accountWrite, folderWrites, msg, tempDb, T0 } from './store/helpers';

/*
 * `Account/disconnect` end to end over a real store: every table that holds an account's data is emptied for that
 * account and left as it was for the other one, and anything still waiting to be sent blocks the removal.
 */

// Account ids as the engine mints them (`a` + 20 hex), so a substring check cannot match anything else by accident.
const KEEP = 'a0000000000000000000a';
const GONE = 'a0000000000000000000b';

/**
 * Tables that hold no account's data. Every other table in the schema must get rows from `seedAccount`, and lose
 * exactly the removed account's rows. A new table fails the coverage check until it is seeded here (and its removal
 * handled) or listed below with the reason it holds nothing per account.
 */
const GLOBAL_TABLES: Record<string, string> = {
  changes: 'the change log clients catch up from; the removal writes its own rows',
  commits: 'idempotency keys by opId',
  schema_migrations: 'the schema version',
  file_removals: 'the queue of attachment files to delete (emptied by the removal itself)',
  ai_usage: 'token counts per day, provider and model; no account, no content',
  audit_log: 'which client called which method; the record of the removal itself',
  clients: 'connected listener/MCP clients',
  consent: 'the AI consent the owner gave',
  settings: 'the owner settings document',
};
// The store's own bookkeeping in `meta` (the change sequence moves with every commit); every other key is checked.
const BOOKKEEPING = new Set(['change_floor_seq', 'created_at', 'db_epoch', 'install_salt', 'seq']);
// The FTS5 shadow tables are the index's storage; `messages_fts` itself is checked.
const isShadow = (name: string) => /^messages_fts_(data|idx|config|docsize|content)$/.test(name);

type Db = ReturnType<ReturnType<typeof tempDb>['open']>;

function seedAccount(store: StorePort, db: Db, id: string) {
  const own = <T extends object>(w: T) =>
    ('accountId' in w ? { ...w, accountId: id } : w) as unknown as StoreWrite;
  const writes: StoreWrite[] = [
    { ...accountWrite, id, address: `${id}@mail.example` } as StoreWrite,
    ...folderWrites.map(own),
    own(msg('m1', 't1', 0, { hasAttachments: true })),
    own(msg('m2', 't1', 1)),
    own(msg('m3', 't2', 2)),
    { kind: 'body', accountId: id, remoteId: 'm1', body: { text: 'hello' } },
    {
      kind: 'attachments',
      accountId: id,
      remoteId: 'm1',
      list: [{ remotePart: '2', name: 'a.pdf', inline: false }],
    },
    {
      kind: 'attachmentState',
      accountId: id,
      remoteId: 'm1',
      remotePart: '2',
      state: 'present',
      path: `${id}-a.pdf`,
    },
    { kind: 'workflow', accountId: id, remoteThreadId: 't1', patch: { status: 'later' } },
    { kind: 'syncState', accountId: id, scope: 'mail', generation: 2 },
    { kind: 'governor', accountId: id, budget: 'gmail', patch: { cooldownStep: 2 } },
    { kind: 'providerMemory', accountId: id, values: { k: 'v' } },
    { kind: 'syncFailure', accountId: id, item: 'x', failure: { attempts: 1, nextRetryAt: T0 } },
    {
      kind: 'calendar',
      accountId: id,
      remoteId: 'primary',
      name: 'Cal',
      hidden: false,
      readOnly: false,
    },
    {
      kind: 'event',
      accountId: id,
      calendarRemoteId: 'primary',
      remoteId: 'e1',
      rows: [{ status: 'confirmed', allDay: false, startUtc: T0, endUtc: T0 + 1, data: '{}' }],
    },
    {
      kind: 'eventHidden',
      accountId: id,
      calendarRemoteId: 'primary',
      remoteId: 'e1',
      hidden: true,
    },
    {
      kind: 'op',
      opId: `op-${id}`,
      accountId: id,
      opKind: 'archive',
      targets: [`${id}:t1`],
      payload: '{}',
      effect: [
        { kind: 'placements', target: { remoteThreadId: 't1' }, add: [], remove: ['INBOX'] },
      ],
      scope: 'triage',
    },
    { kind: 'meta', key: `replydraft:${id}:t1`, value: 'x' },
    { kind: 'meta', key: `followup:${id}:t1`, value: 'x' },
    { kind: 'meta', key: `plans-empty:${id}:t1`, value: 'x' },
    {
      kind: 'meta',
      key: `calendar.hold.hold-${id}`,
      value: JSON.stringify({
        opId: `hold-${id}`,
        state: 'synced',
        targets: [`${id}:primary:e1`],
        createdAt: T0,
        undoUntil: T0,
      }),
    },
    {
      kind: 'job',
      action: 'enqueue',
      job: {
        kind: 'summary',
        key: `summary:${id}:t1:h`,
        priority: 1,
        payload: JSON.stringify({ accountId: id }),
        nextAt: T0,
      },
    } as StoreWrite,
    {
      kind: 'conversation',
      id: `conv-${id}`,
      data: JSON.stringify({ citations: [{ threadId: `${id}:t1`, quote: 'hello' }] }),
    } as StoreWrite,
  ];
  store.commit({ opId: `seed-${id}`, origin: 'sync', writes });
  const one = (sql: string, ...args: (string | number)[]) =>
    Number(Object.values(db.prepare(sql).get(...args) ?? {})[0]);
  const mid = (remote: string) =>
    one('SELECT id FROM messages WHERE account_id = ? AND remote_id = ?', id, remote);
  const tid = one('SELECT id FROM threads WHERE account_id = ? AND remote_id = ?', id, 't1');
  const run = (sql: string, ...args: (string | number)[]) => db.prepare(sql).run(...args);
  run(
    "INSERT INTO drafts(id, account_id, revision, data, updated_at) VALUES(?, ?, 1, '{}', 1)",
    `d-${id}`,
    id,
  );
  run(
    "INSERT INTO submissions(id, draft_id, account_id, internet_id, not_before, state) VALUES(?, ?, ?, 'i', 1, 'sent')",
    `s-${id}`,
    `d-${id}`,
    id,
  );
  run(
    "INSERT INTO sender_rules(account_id, address_or_domain, action) VALUES(?, 'a.example', 'block')",
    id,
  );
  run(
    "INSERT INTO correspondents(account_id, address, sent_to) VALUES(?, 'friend@mail.example', 1)",
    id,
  );
  run(
    "INSERT INTO notifications(message_id, state, created_at) VALUES(?, 'pending', 1)",
    mid('m1'),
  );
  run(
    "INSERT INTO summaries(thread_id, input_hash, model, text, state, created_at) VALUES(?, 'h', 'm', 't', 'ready', 1)",
    tid,
  );
  run(
    "INSERT INTO plans(account_id, thread_id, input_hash, title, created_at) VALUES(?, ?, 'h', 'Lunch', 1)",
    id,
    tid,
  );
  for (const r of ['m1', 'm2'])
    run("INSERT INTO messages_fts(rowid, subject, people, body) VALUES(?, 's', 'p', 'b')", mid(r));
  run(
    "UPDATE messages SET parts = parts | 8 WHERE account_id = ? AND remote_id IN ('m1', 'm2')",
    id,
  );
}

/** Every non-global table's rows, as JSON per row. */
function dump(db: Db): Map<string, string[]> {
  const names = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all<{ name: string }>()
    .map(t => t.name)
    .filter(n => !n.startsWith('sqlite_') && !isShadow(n) && !(n in GLOBAL_TABLES));
  return new Map(
    names.map(n => [
      n,
      db
        .prepare(n === 'messages_fts' ? `SELECT rowid, * FROM "${n}"` : `SELECT * FROM "${n}"`)
        .all<{ key?: string }>()
        .filter(r => n !== 'meta' || !BOOKKEEPING.has(String(r.key)))
        .map(r => JSON.stringify(r))
        .sort(),
    ]),
  );
}

interface Rig {
  store: StorePort;
  db: Db;
  ctx: MethodContext;
  calls: string[];
  removedFiles: string[];
  cleanup(): void;
}

function rig(): Rig {
  const file = tempDb();
  const store = openStore(file.open(), { now: () => T0, extensions: laneExtensions() });
  const db = file.open();
  const calls: string[] = [];
  const removedFiles: string[] = [];
  const accounts = {
    stop: async (id: string, why: string) => void calls.push(`stop:${id}:${why}`),
    start: async (id: string) => void calls.push(`start:${id}`),
    forgetAccount: async (id: string, kind: string) => void calls.push(`forget:${id}:${kind}`),
    status: () => undefined,
  } as unknown as AccountActorHost;
  const services = {
    store,
    accounts,
    attachmentFiles: { remove: async (path: string) => void removedFiles.push(path) },
    log: { event() {} },
    deadlines: { changed() {}, register: () => () => undefined },
    clock: { now: () => T0 },
  } as unknown as EngineServices;
  const ctx = {
    caller: { kind: 'window', scopes: ['admin'] },
    signal: new AbortController().signal,
    services,
    connectionId: 'c1',
  } as unknown as MethodContext;
  return {
    store,
    db,
    ctx,
    calls,
    removedFiles,
    cleanup() {
      store.close();
      db.close();
      file.cleanup();
    },
  };
}

const disconnect = (r: Rig, accountId: string, opId = 'rm-1') =>
  handlers['Account/disconnect']({ opId, accountId }, r.ctx);

test('Account/disconnect empties every per-account table for that account and leaves the other one untouched', async () => {
  const both = rig();
  const only = rig();
  try {
    seedAccount(both.store, both.db, KEEP);
    seedAccount(both.store, both.db, GONE);
    seedAccount(only.store, only.db, KEEP);
    const before = dump(both.db);
    const reference = dump(only.db);

    // Coverage: every table that is not global holds rows of both accounts before the removal.
    const empty = [...reference].filter(([, rows]) => rows.length === 0).map(([n]) => n);
    assert.deepEqual(
      empty,
      [],
      'seed these tables for an account (and make the removal clear them), or list them in GLOBAL_TABLES',
    );
    for (const [name, rows] of before)
      assert.ok(rows.length > reference.get(name)!.length, `${name} holds rows of both accounts`);

    const receipt = await disconnect(both, GONE);
    assert.equal(receipt.opId, 'rm-1');
    assert.equal(receipt.undoable, false);
    assert.deepEqual(both.calls, [`stop:${GONE}:disconnect`, `forget:${GONE}:google`]);
    assert.deepEqual(both.removedFiles, [`${GONE}-a.pdf`], 'its attachment file is deleted');

    const after = dump(both.db);
    for (const [name, rows] of after) {
      const kept = new Set(before.get(name));
      const changed = rows.filter(r => !kept.has(r));
      assert.deepEqual(changed, [], `${name}: no row of the kept account changed`);
      assert.equal(rows.length, reference.get(name)!.length, `${name}: only the removed rows went`);
      assert.ok(!rows.some(r => r.includes(GONE)), `${name}: nothing names the removed account`);
    }
    assert.equal(
      both.db.prepare('SELECT count(*) AS c FROM file_removals').get()?.c,
      0,
      'the file queue is drained',
    );
  } finally {
    both.cleanup();
    only.cleanup();
  }
});

test('Account/disconnect refuses while mail is waiting to go out, lists it, and keeps the account syncing', async () => {
  const r = rig();
  try {
    seedAccount(r.store, r.db, KEEP);
    seedAccount(r.store, r.db, GONE);
    const add = (id: string, state: string) =>
      r.db
        .prepare(
          "INSERT INTO submissions(id, draft_id, account_id, internet_id, not_before, state) VALUES(?, ?, ?, 'i', 1, ?)",
        )
        .run(id, `d-${GONE}`, GONE, state);
    add('s-sched', 'scheduled');
    add('s-q', 'queued');
    add('s-susp', 'suspended');
    add('s-unc', 'uncertain');
    // A failed send does not block: it is deleted with the account (the Settings confirm lists it).
    add('s-fail', 'failed');
    const before = dump(r.db);
    await assert.rejects(
      async () => disconnect(r, GONE),
      (e: unknown) =>
        e instanceof ContractError &&
        e.type === 'conflict' &&
        e.message ===
          'This account still has 4 messages that have not gone out (2 waiting to send, 1 scheduled, 1 that may not have sent). Send or cancel them first, then remove the account.',
    );
    assert.deepEqual(r.calls, [], 'nothing was stopped or forgotten');
    assert.deepEqual(dump(r.db), before, 'nothing was deleted');

    // A message being sent right now gets its own sentence.
    r.db.prepare("UPDATE submissions SET state = 'sending' WHERE id = 's-q'").run();
    await assert.rejects(
      async () => disconnect(r, GONE),
      (e: unknown) => e instanceof ContractError && /being sent/.test(e.message),
    );

    // A calendar change waiting to tell guests counts too; the failed send still does not.
    r.db
      .prepare("UPDATE submissions SET state = 'cancelled' WHERE account_id = ? AND id <> 's-fail'")
      .run(GONE);
    r.db
      .prepare('UPDATE meta SET value = ? WHERE key = ?')
      .run(
        JSON.stringify({ opId: 'h', state: 'queued', targets: [`${GONE}:primary:e1`] }),
        `calendar.hold.hold-${GONE}`,
      );
    await assert.rejects(
      async () => disconnect(r, GONE),
      (e: unknown) =>
        e instanceof ContractError &&
        e.message ===
          'This account still has 1 calendar change for guests. Send or cancel it first, then remove the account.',
    );

    // A hold being sent right now blocks too.
    const hold = (state: string) =>
      r.db
        .prepare('UPDATE meta SET value = ? WHERE key = ?')
        .run(
          JSON.stringify({ opId: 'h', state, targets: [`${GONE}:primary:e1`] }),
          `calendar.hold.hold-${GONE}`,
        );
    hold('syncing');
    await assert.rejects(
      async () => disconnect(r, GONE),
      (e: unknown) => e instanceof ContractError && /1 calendar change for guests/.test(e.message),
    );

    // Once nothing is on its way, it goes, and the failed send and failed calendar change go with it.
    hold('failed');
    await disconnect(r, GONE);
    assert.equal(r.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(GONE), undefined);
    assert.equal(
      r.db.prepare('SELECT count(*) AS c FROM submissions WHERE account_id = ?').get(GONE)?.c,
      0,
    );
    assert.equal(
      r.db.prepare('SELECT 1 FROM meta WHERE key = ?').get(`calendar.hold.hold-${GONE}`),
      undefined,
    );
  } finally {
    r.cleanup();
  }
});

test('Account/disconnect re-checks after stopping the actor: a send queued meanwhile wins and the actor restarts', async () => {
  const r = rig();
  try {
    seedAccount(r.store, r.db, GONE);
    const accounts = r.ctx.services.accounts as unknown as { stop: (id: string) => Promise<void> };
    accounts.stop = async (id: string) => {
      r.calls.push(`stop:${id}`);
      r.db
        .prepare(
          "INSERT INTO submissions(id, draft_id, account_id, internet_id, not_before, state) VALUES('late', ?, ?, 'i', 1, 'queued')",
        )
        .run(`d-${GONE}`, GONE);
    };
    await assert.rejects(
      async () => disconnect(r, GONE),
      (e: unknown) => e instanceof ContractError && e.type === 'conflict',
    );
    assert.deepEqual(r.calls, [`stop:${GONE}`, `start:${GONE}`]);
    assert.ok(r.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(GONE));
  } finally {
    r.cleanup();
  }
});

test('Account/disconnect: an unknown account is notFound, and a retry of a finished removal returns its receipt', async () => {
  const r = rig();
  try {
    seedAccount(r.store, r.db, GONE);
    await assert.rejects(
      async () => disconnect(r, 'a0000000000000000000z'),
      (e: unknown) => e instanceof ContractError && e.type === 'notFound',
    );
    const first = await disconnect(r, GONE, 'rm-x');
    assert.deepEqual(await disconnect(r, GONE, 'rm-x'), first);
    await assert.rejects(
      async () => disconnect(r, GONE, 'rm-y'),
      (e: unknown) => e instanceof ContractError && e.type === 'notFound',
    );
  } finally {
    r.cleanup();
  }
});

/** No row of any table (the journal in `meta` included) names the account. */
function namesNothing(db: Db, id: string) {
  for (const [name, rows] of dump(db))
    assert.ok(!rows.some(r => r.includes(id)), `${name}: nothing names the removed account`);
}

/** `extra` more threads of one message each, for a mailbox too big for one short transaction. */
function seedThreads(store: StorePort, id: string, extra: number) {
  const writes: StoreWrite[] = [];
  for (let i = 0; i < extra; i++)
    writes.push({ ...msg(`bulk${i}`, `bulk-t${i}`, 10 + i), accountId: id } as StoreWrite);
  store.commit({ opId: `bulk-${id}`, origin: 'sync', writes });
}

/** Counts the removal's own batch commits and can fail the `n`th, the way a quit mid-removal would. */
function batchCommits(store: StorePort, id: string, failAt?: number) {
  const commit = store.commit.bind(store);
  const counter = { batches: 0, restore: () => void (store.commit = commit) };
  store.commit = (input: CommitInput) => {
    if (input.opId.startsWith(`account-remove:${id}:`) && ++counter.batches === failAt)
      throw new Error('the app quit');
    return commit(input);
  };
  return counter;
}

const journalOf = (db: Db, id: string) =>
  db.prepare('SELECT value FROM meta WHERE key = ?').get(`account.removing.${id}`);

test('a sign-in that could not be forgotten is reported, kept in the journal, and forgotten at the next start', async () => {
  const r = rig();
  try {
    seedAccount(r.store, r.db, KEEP);
    seedAccount(r.store, r.db, GONE);
    const accounts = r.ctx.services.accounts as unknown as {
      forgetAccount: (id: string, kind: string) => Promise<void>;
    };
    accounts.forgetAccount = async () => {
      throw new Error('the keychain is locked');
    };
    const receipt = await disconnect(r, GONE);
    assert.equal(receipt.signInKept, true, 'the result says the sign-in is still stored');
    assert.equal(r.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(GONE), undefined);
    assert.ok(journalOf(r.db, GONE), 'the journal keeps the step that is left');

    // The next start: the keychain answers again, and the sweep finishes the removal.
    accounts.forgetAccount = async (id, kind) => void r.calls.push(`forget:${id}:${kind}`);
    await resumeRemovals(r.ctx.services);
    assert.deepEqual(r.calls, [`stop:${GONE}:disconnect`, `forget:${GONE}:google`]);
    assert.equal(journalOf(r.db, GONE), undefined);
    namesNothing(r.db, GONE);

    // Nothing is left to do: a later start forgets nothing more.
    await resumeRemovals(r.ctx.services);
    assert.equal(r.calls.length, 2);
  } finally {
    r.cleanup();
  }
});

test('a removal a quit interrupts stays hidden everywhere, and the next start finishes it', async () => {
  const r = rig();
  try {
    seedAccount(r.store, r.db, KEEP);
    seedAccount(r.store, r.db, GONE);
    seedThreads(r.store, GONE, REMOVE_BATCH * 2);
    const quit = batchCommits(r.store, GONE, 2);
    await assert.rejects(async () => disconnect(r, GONE), /the app quit/);
    quit.restore();

    // Half its mail is still stored, but no account list, start-up, view or Account/get shows the account again.
    const left = r.db.prepare('SELECT count(*) AS c FROM threads WHERE account_id = ?').get(GONE);
    assert.ok(Number(left?.c) > 0, 'the removal really was cut short');
    assert.deepEqual(listedAccounts(r.store), [KEEP]);
    assert.deepEqual(
      r.store.read(q => viewAccounts(q)),
      [KEEP],
    );
    assert.deepEqual(
      r.store.read(q => viewAccounts(q, GONE)),
      [],
    );
    const got = await handlers['Account/get']({ ids: [GONE] }, r.ctx);
    assert.deepEqual(got.notFound, [GONE]);
    assert.deepEqual(r.calls, [`stop:${GONE}:disconnect`], 'nothing was forgotten yet');

    await resumeRemovals(r.ctx.services);
    assert.equal(r.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(GONE), undefined);
    assert.deepEqual(r.calls, [`stop:${GONE}:disconnect`, `forget:${GONE}:google`]);
    // Files go before their rows, so the resumed run deletes the same file again (removing is idempotent).
    assert.deepEqual(
      [...new Set(r.removedFiles)],
      [`${GONE}-a.pdf`],
      'its attachment file is deleted',
    );
    namesNothing(r.db, GONE);
    assert.deepEqual(listedAccounts(r.store), [KEEP]);
  } finally {
    r.cleanup();
  }
});

test('a retry from Settings after an interrupted removal finishes it and answers with the first receipt', async () => {
  const r = rig();
  try {
    seedAccount(r.store, r.db, GONE);
    seedThreads(r.store, GONE, REMOVE_BATCH);
    const quit = batchCommits(r.store, GONE, 1);
    await assert.rejects(async () => disconnect(r, GONE), /the app quit/);
    quit.restore();
    const seq = r.db.prepare("SELECT seq FROM commits WHERE op_id = 'rm-1'").get()?.seq;
    const receipt = await disconnect(r, GONE);
    assert.deepEqual(receipt.appliedState, { dbEpoch: r.store.dbEpoch, seq });
    assert.equal(receipt.signInKept, undefined);
    namesNothing(r.db, GONE);
  } finally {
    r.cleanup();
  }
});

test('a large account is removed in short batches that yield to the event loop, hidden from the first one', async () => {
  const r = rig();
  try {
    seedAccount(r.store, r.db, KEEP);
    seedAccount(r.store, r.db, GONE);
    seedThreads(r.store, GONE, REMOVE_BATCH * 10);
    const count = batchCommits(r.store, GONE);
    let ticks = 0;
    let listed = 0;
    const iv = setInterval(() => {
      ticks++;
      if (listedAccounts(r.store).includes(GONE)) listed++;
      if (r.store.read(q => viewAccounts(q)).includes(GONE)) listed++;
    }, 1);
    try {
      await disconnect(r, GONE);
    } finally {
      clearInterval(iv);
    }
    assert.ok(count.batches >= 10, `deleted in batches (${count.batches} commits)`);
    assert.ok(ticks > 0, 'a 1 ms timer fired while the batches ran');
    assert.equal(listed, 0, 'no account list showed it while it was being removed');
    namesNothing(r.db, GONE);
    assert.equal(
      r.db.prepare('SELECT count(*) AS c FROM threads WHERE account_id = ?').get(KEEP)?.c,
      2,
    );
  } finally {
    r.cleanup();
  }
});

test('an attachment file that cannot be deleted keeps its rows: the account stays hidden and a Retry finishes it', async () => {
  const r = rig();
  try {
    seedAccount(r.store, r.db, KEEP);
    seedAccount(r.store, r.db, GONE);
    const files = r.ctx.services.attachmentFiles as unknown as {
      remove: (p: string) => Promise<void>;
    };
    const remove = files.remove;
    files.remove = async () => {
      throw new Error('io');
    };
    await assert.rejects(
      async () => disconnect(r, GONE),
      (e: unknown) => e instanceof ContractError && e.type === 'unavailable',
    );
    assert.ok(
      r.db.prepare('SELECT 1 FROM attachments WHERE path = ?').get(`${GONE}-a.pdf`),
      'the row that names the file is kept',
    );
    assert.deepEqual(listedAccounts(r.store), [KEEP], 'still hidden');
    assert.deepEqual(r.calls, [`stop:${GONE}:disconnect`], 'the sign-in is not forgotten yet');

    files.remove = remove;
    await disconnect(r, GONE);
    assert.deepEqual(r.removedFiles, [`${GONE}-a.pdf`]);
    assert.deepEqual(r.calls, [`stop:${GONE}:disconnect`, `forget:${GONE}:google`]);
    namesNothing(r.db, GONE);
  } finally {
    r.cleanup();
  }
});
