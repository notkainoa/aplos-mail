import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../../../../apps/desktop/src/host/sqlite';
import {
  openStore,
  StoreError,
  type CommitExtension,
  type RemoteDraftWrite,
} from '../../src/store';
import { ACCOUNT, T0, accountWrite, msg } from './helpers';

// A lane declares its write kinds by declaration merging, as `outbox/store.ts` will; the union then accepts them. The
// kind is test-only: the augmentation is program-wide, and the real `submission` shape is eng-time's to declare.
interface SubmissionWrite {
  kind: 'testSubmission';
  id: string;
  accountId: string;
  draftId: string;
  notBefore: number;
  state: 'queued' | 'scheduled' | 'sending';
}
declare module '../../src/store/port' {
  interface ExtensionWrites {
    testSubmission: SubmissionWrite;
  }
}

const outbox = (opts: { failOn?: string; forgeThread?: boolean } = {}): CommitExtension => ({
  lane: 'eng-time',
  kinds: ['testSubmission', 'remoteDraft'],
  changeTypes: ['Submission', 'Draft'],
  apply(write, tx) {
    if (write.kind === 'remoteDraft') {
      const w = write as RemoteDraftWrite;
      tx.run(
        `INSERT INTO drafts(id, account_id, revision, data, remote_draft_id, remote_message_id, origin, updated_at)
        VALUES(?, ?, 1, '{}', ?, ?, 'remote', ?)`,
        `remote-${w.remoteDraftId}`,
        w.accountId,
        w.remoteDraftId,
        w.remoteMessageId,
        w.changedAt,
      );
      return tx.mark('Draft', `${w.accountId}:remote-${w.remoteDraftId}`, 'u');
    }
    const w = write as SubmissionWrite;
    if (w.id === opts.failOn) throw new Error('outbox bug');
    tx.run(
      `INSERT INTO submissions(id, draft_id, account_id, internet_id, not_before, state) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state = excluded.state, attempt_at = CASE WHEN excluded.state = 'sending' THEN ? ELSE attempt_at END`,
      w.id,
      w.draftId,
      w.accountId,
      `<${w.id}@mail.example>`,
      w.notBefore,
      w.state,
      tx.now(),
    );
    tx.mark('Submission', w.id, 'u');
    if (opts.forgeThread) tx.mark('Thread', `${ACCOUNT}:t1`, 'u');
  },
});

function open(extensions: CommitExtension[]) {
  const store = openStore(openSqlite(':memory:'), { now: () => T0, extensions });
  store.commit({ opId: 'setup', origin: 'sync', writes: [accountWrite] });
  return store;
}
const sub = (id: string, state: SubmissionWrite['state'] = 'queued'): SubmissionWrite => ({
  kind: 'testSubmission',
  id,
  accountId: ACCOUNT,
  draftId: `d-${id}`,
  notBefore: T0 + 10_000,
  state,
});
const count = (store: ReturnType<typeof open>, table: string) =>
  store.read(q => q.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n);

test('a lane kind commits in the same transaction as store kinds, with one seq and its own change rows (seam 2)', () => {
  const store = open([outbox()]);
  const r = store.commit({
    opId: 'send',
    origin: 'local',
    writes: [msg('m1', 't1', 0), sub('s1'), sub('s1', 'sending')],
  });
  assert.equal(r.seq, 2);
  const page = store.changesSince(1);
  assert.ok(page.status === 'ok');
  assert.ok(page.changes.every(c => c.seq === 2));
  assert.ok(page.changes.some(c => c.type === 'Submission' && c.id === 's1'));
  assert.equal(
    store.read(
      q => q.get<{ attempt_at: number }>('SELECT attempt_at FROM submissions')!.attempt_at,
    ),
    T0,
    'the sending marker',
  );
  store.close();
});

test('an extension that throws mid-commit leaves no row, no change row and no seq bump', () => {
  const store = open([outbox({ failOn: 's2' })]);
  assert.throws(
    () =>
      store.commit({
        opId: 'x',
        origin: 'local',
        writes: [msg('m1', 't1', 0), sub('s1'), sub('s2')],
      }),
    /outbox bug/,
  );
  assert.equal(store.seq(), 1);
  assert.equal(count(store, 'submissions'), 0);
  assert.equal(count(store, 'messages'), 0);
  assert.equal(
    store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM changes WHERE seq > 1')!.n),
    0,
  );
  store.close();
});

test('an extension cannot write change rows for a type it does not own', () => {
  const store = open([outbox({ forgeThread: true })]);
  assert.throws(
    () => store.commit({ opId: 'x', origin: 'local', writes: [sub('s1')] }),
    /may not write Thread/,
  );
  assert.equal(count(store, 'submissions'), 0);
  store.close();
});

test("registration refuses store kinds, another lane's reserved kind, a kind twice and store change types", () => {
  const ext = (lane: string, kinds: string[], changeTypes: string[] = []): CommitExtension => ({
    lane,
    kinds,
    changeTypes,
    apply() {},
  });
  assert.throws(() => open([ext('eng-time', ['message'])]), /store kind message/);
  assert.throws(() => open([ext('eng-ai', ['submission'])]), /reserved for eng-time/);
  assert.throws(() => open([ext('eng-ai', ['job']), ext('eng-ai', ['job'])]), /registered twice/);
  assert.throws(() => open([ext('eng-ai', ['job'], ['Thread'])]), /cannot write Thread/);
  open([ext('eng-ai', ['job', 'aiNewKind'], ['Job'])]).close(); // a new unreserved kind is additive
});

test("remoteDraft, written by the provider actor, needs eng-time's extension; unknown kinds fail", () => {
  const draft: RemoteDraftWrite = {
    kind: 'remoteDraft',
    accountId: ACCOUNT,
    remoteDraftId: 'r1',
    remoteMessageId: 'rm1',
    changedAt: T0,
  };
  const bare = open([]);
  assert.throws(() => bare.commit({ opId: 'd', origin: 'sync', writes: [draft] }), StoreError);
  assert.throws(
    () => bare.commit({ opId: 'd', origin: 'sync', writes: [{ kind: 'nope' } as never] }),
    /No writer for write kind nope/,
  );
  bare.close();
  const store = open([outbox()]);
  store.commit({ opId: 'd', origin: 'sync', writes: [draft] });
  assert.equal(count(store, 'drafts'), 1);
  store.close();
});
