import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLog,
  compactLog,
  emptyWorkflowLog,
  keySchemeFor,
  mergeLogs,
  publishLog,
  sameLog,
  threadKey,
  workflowEdit,
  workflowPatch,
  type WorkflowEntry,
  type WorkflowLog,
} from '@aplos/engine/legacy/workflow';
import {
  generateSyncCode,
  normalizeSyncCode,
  openWorkflow,
  sealWorkflow,
  WorkflowCryptoError,
} from '../src/main/workflow-crypto';
import type { Message, Thread } from '@aplos/contract/legacy/types';

const DAY = 86_400_000,
  T0 = Date.parse('2026-10-20T12:00:00Z');
const mail = (id: string, date: string, extra: Partial<Message> = {}): Message => ({
  id,
  from: 'sam@example.test',
  fromName: 'Sam',
  to: ['alex@example.test'],
  date,
  text: 'Hi',
  attachments: [],
  internetId: `<${id}@example.test>`,
  ...extra,
});
const thread = (remoteId: string, patch: Partial<Thread> = {}): Thread => ({
  id: `acct:${remoteId}`,
  accountId: 'acct',
  remoteId,
  subject: 'Hello',
  summary: '',
  messages: [mail(`${remoteId}-1`, '2026-10-01T10:00:00Z')],
  date: '2026-10-01T10:00:00Z',
  unread: false,
  status: 'new',
  importance: 'important',
  bookmarked: false,
  replyStatus: 'none',
  ...patch,
});
const entry = (
  status: 'new' | 'done' | 'later',
  at: number,
  device = 'mac',
  extra = {},
): WorkflowEntry => ({ fields: { status, replyStatus: 'none', ...extra }, at, device });
const publish = (edits: Thread[], opts: Partial<Parameters<typeof publishLog>[0]> = {}) =>
  publishLog({
    remotes: [],
    edits: edits.map((t, i) => workflowEdit(t, T0, i + 1)),
    applied: {},
    threads: [],
    seed: false,
    device: 'mac',
    now: T0,
    ...opts,
  });

test('thread keys are host thread IDs, except IMAP which keys by the root Message-ID every device sees', () => {
  assert.equal(keySchemeFor('google'), 'thread');
  assert.equal(keySchemeFor('microsoft'), 'thread');
  assert.equal(keySchemeFor('jmap'), 'thread');
  assert.equal(keySchemeFor('imap'), 'message');
  assert.equal(threadKey(thread('g1')), 't:g1');
  // Device A indexed the root and a reply; device B only the reply, under a different local key.
  const root = mail('root', '2026-10-01T10:00:00Z'),
    reply = mail('reply', '2026-10-02T10:00:00Z', { references: '<root@example.test>' });
  const a = thread('localA', { messages: [reply, root] }),
    b = thread('localB', { messages: [reply] });
  assert.equal(threadKey(a, 'message'), 'm:root@example.test');
  assert.equal(threadKey(b, 'message'), threadKey(a, 'message'));
  assert.equal(
    threadKey(
      thread('x', { messages: [mail('n', '2026-10-01T10:00:00Z', { internetId: undefined })] }),
      'message',
    ),
    't:x',
    'falls back to the remote ID',
  );
  assert.equal(threadKey(thread('x', { remoteId: undefined, messages: [] })), undefined);
});

test('edits are published with the time they were made; Trash, Spam and no-op edits add nothing', () => {
  const later = thread('b', { status: 'later', todo: 'Call Sam', dueDate: '2026-10-25' });
  assert.deepEqual(workflowEdit(later, T0 - 5000, 3), {
    keys: { thread: 't:b', message: 'm:b-1@example.test' },
    fields: { status: 'later', replyStatus: 'none', dueDate: '2026-10-25', todo: 'Call Sam' },
    at: T0 - 5000,
    gen: 3,
  });
  assert.equal(workflowEdit(thread('c', { status: 'trash', todo: 'x' }), T0, 1).fields, undefined);
  const { log } = publishLog({
    remotes: [],
    edits: [
      workflowEdit(later, T0 - 5000, 1),
      workflowEdit(thread('c', { status: 'spam' }), T0, 2),
    ],
    applied: {},
    threads: [],
    seed: false,
    device: 'mac',
    now: T0 + DAY,
  });
  assert.deepEqual(
    log.entries,
    {
      't:b': {
        fields: { status: 'later', replyStatus: 'none', dueDate: '2026-10-25', todo: 'Call Sam' },
        at: T0 - 5000,
        device: 'mac',
      },
    },
    'edit time, not round time',
  );
  const remote: WorkflowLog = {
    version: 1,
    entries: {
      't:b': entry('later', T0 - 9000, 'phone', { dueDate: '2026-10-25', todo: 'Call Sam' }),
    },
  };
  assert.deepEqual(
    publish([later], { remotes: [remote] }).own,
    {},
    'an edit matching the shared state adds nothing',
  );
  // This device applied the phone's entry at T0+50; an edit after that wins although this clock says T0.
  assert.equal(
    publish([thread('b', { status: 'done' })], {
      remotes: [{ version: 1, entries: { 't:b': entry('later', T0 + 50, 'phone') } }],
      applied: { 't:b': `${T0 + 50}:phone` },
    }).log.entries['t:b'].at,
    T0 + 51,
  );
  assert.equal(
    publish([thread('b', { status: 'done' })], {
      remotes: [{ version: 1, entries: { 't:b': entry('later', T0 + 50, 'phone') } }],
    }).log.entries['t:b'].device,
    'phone',
    'an edit made before seeing a newer entry loses to it',
  );
  assert.equal(
    publish([thread('k', { remoteId: undefined, messages: [] })]).log.entries['t:k'],
    undefined,
  );
});

test('the first device seeds its existing Later, todos and reminders; plain threads stay out', () => {
  const threads = [
    thread('a', { status: 'later' }),
    thread('b', { status: 'done' }),
    thread('c', { todo: 'Pay', dueDate: '2026-11-01' }),
    thread('d', { reminderAt: '2026-11-02T09:00:00Z' }),
    thread('e'),
  ];
  const { log, own } = publishLog({
    remotes: [],
    edits: [],
    applied: {},
    threads,
    seed: true,
    device: 'mac',
    now: T0,
  });
  assert.deepEqual(Object.keys(log.entries).sort(), ['t:a', 't:c', 't:d']);
  assert.equal(
    own['t:a'].at,
    Date.parse('2026-10-01T10:00:00Z'),
    'seeded at the last message, so any real edit after triage wins',
  );
  assert.deepEqual(
    Object.keys(
      publishLog({
        remotes: [emptyWorkflowLog()],
        edits: [],
        applied: {},
        threads,
        seed: false,
        device: 'mac',
        now: T0,
      }).log.entries,
    ),
    [],
    'a joining device does not seed',
  );
});

test('merging is last-writer-wins, commutative, associative and idempotent', () => {
  const a: WorkflowLog = {
    version: 1,
    entries: {
      x: entry('done', T0),
      y: entry('later', T0 + 5),
      z: entry('done', T0, 'mac', { todo: 'one' }),
    },
  };
  const b: WorkflowLog = {
    version: 1,
    entries: {
      x: entry('later', T0 + 1, 'phone'),
      w: entry('done', T0, 'phone'),
      z: entry('done', T0, 'mac', { todo: 'two' }),
    },
  };
  const c: WorkflowLog = {
    version: 1,
    entries: { x: entry('new', T0 + 1, 'zed'), y: entry('done', T0 + 2, 'phone') },
  };
  const ab = mergeLogs(a, b);
  assert.equal(ab.entries.x.fields.status, 'later');
  assert.equal(ab.entries.y.fields.status, 'later');
  assert.equal(ab.entries.w.device, 'phone');
  assert.equal(
    ab.entries.z.fields.todo,
    'two',
    'identical time and device fall back to the fields, so both sides agree',
  );
  assert.ok(sameLog(ab, mergeLogs(b, a)));
  assert.ok(sameLog(mergeLogs(mergeLogs(a, b), c), mergeLogs(a, mergeLogs(b, c))));
  assert.ok(sameLog(mergeLogs(a, b, c), mergeLogs(c, a, b)));
  assert.equal(mergeLogs(ab, c).entries.x.device, 'zed', 'ties on time go to the larger device ID');
  assert.ok(sameLog(mergeLogs(ab, ab), ab));
});

test('compaction keeps a floor, so a dropped Done does not bring back an older Later held elsewhere', () => {
  const log: WorkflowLog = {
    version: 1,
    entries: {
      oldDone: entry('done', T0 - 200 * DAY),
      oldLater: entry('later', T0 - 200 * DAY),
      oldTodo: entry('done', T0 - 200 * DAY, 'mac', { todo: 'x' }),
      recent: entry('done', T0 - DAY),
      newest: entry('new', T0),
    },
  };
  const compacted = compactLog(log, T0);
  assert.deepEqual(Object.keys(compacted.entries).sort(), [
    'newest',
    'oldLater',
    'oldTodo',
    'recent',
  ]);
  assert.equal(compacted.floor, T0 - 200 * DAY);
  assert.deepEqual(Object.keys(compactLog(log, T0, 2).entries).sort(), ['newest', 'recent']);
  assert.equal(compactLog(log, T0, 2).floor, T0 - 200 * DAY);
  // x was Later, then Done at T0-190d; compaction drops the Done. A stale copy or an old pending edit with the Later must not return.
  const shared = compactLog(
      { version: 1, entries: { x: entry('done', T0 - 190 * DAY, 'phone') } },
      T0,
    ),
    stale: WorkflowLog = { version: 1, entries: { x: entry('later', T0 - 195 * DAY) } };
  assert.equal(shared.entries.x, undefined);
  assert.equal(mergeLogs(shared, stale).entries.x, undefined);
  assert.equal(mergeLogs(stale, shared).entries.x, undefined);
  assert.equal(
    publish([thread('x', { status: 'later' })], { remotes: [shared], now: T0 }).log.entries['t:x']
      ?.fields.status,
    'later',
    'an edit newer than the floor still counts',
  );
  const old = publishLog({
    remotes: [{ version: 1, entries: {}, floor: T0 - DAY }],
    edits: [workflowEdit(thread('x', { status: 'later' }), T0 - 2 * DAY, 1)],
    applied: {},
    threads: [],
    seed: false,
    device: 'mac',
    now: T0,
  });
  assert.equal(
    old.log.entries['t:x'],
    undefined,
    'an edit older than what was compacted away is not taken in',
  );
  assert.equal(
    mergeLogs(shared, { version: 1, entries: { x: entry('later', T0) } }).entries.x.fields.status,
    'later',
  );
});

test('each winning entry applies once, including to threads that arrive later, and arrivals keep Home state', () => {
  const log: WorkflowLog = {
    version: 1,
    entries: {
      't:a': entry('later', T0, 'phone', { todo: 'Reply' }),
      't:b': entry('done', T0, 'phone'),
    },
  };
  let result = applyLog(log, [thread('a')], {});
  assert.deepEqual(result.patches, [
    { threadId: 'acct:a', patch: { status: 'later', todo: 'Reply' } },
  ]);
  assert.deepEqual(result.applied, { 't:a': `${T0}:phone` });
  assert.deepEqual(
    applyLog(log, [thread('a', { status: 'new' })], result.applied).patches,
    [],
    'not applied twice, so a move back elsewhere sticks',
  );
  result = applyLog(log, [thread('a'), thread('b')], result.applied);
  assert.deepEqual(
    result.patches,
    [{ threadId: 'acct:b', patch: { status: 'done' } }],
    'a thread downloaded after the round that fetched its entry',
  );
  assert.deepEqual(
    applyLog(log, [thread('b')], {}, { skip: new Set(['acct:b']) }),
    { patches: [], applied: {} },
    'a thread edited during the round is left alone and not marked',
  );
  assert.deepEqual(
    applyLog({ version: 1, entries: {} }, [thread('a')], { 't:a': '1:x' }).applied,
    {},
    'marks for compacted keys are dropped',
  );
  const done = entry('done', T0, 'mac', { hiddenFromHome: true, todo: 'Pay' });
  assert.deepEqual(
    workflowPatch(
      done,
      thread('a', {
        messages: [
          mail('a-1', '2026-10-01T10:00:00Z'),
          mail('a-2', new Date(T0 + 1000).toISOString()),
        ],
      }),
    ),
    { todo: 'Pay' },
  );
  assert.deepEqual(
    workflowPatch(
      done,
      thread('a', {
        messages: [
          mail('a-1', '2026-10-01T10:00:00Z'),
          mail('a-2', new Date(T0 + 1000).toISOString(), { sent: true }),
        ],
      }),
    ),
    { status: 'done', hiddenFromHome: true, todo: 'Pay' },
    'own replies do not count as arrivals',
  );
  assert.equal(
    workflowPatch(done, thread('a', { status: 'spam' })),
    undefined,
    'Trash and Spam are left alone',
  );
  assert.deepEqual(
    workflowPatch(entry('new', T0), thread('a', { todo: 'x', reminderFired: true })),
    { todo: undefined, reminderFired: false },
    'cleared fields are patched',
  );
});

test('sync codes are grouped, unambiguous and forgiving to type', () => {
  const code = generateSyncCode();
  assert.match(code, /^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.notEqual(generateSyncCode(), code);
  assert.equal(normalizeSyncCode(` ${code.toLowerCase().replace(/-/g, ' ')} `), code);
  assert.equal(
    normalizeSyncCode(code.replace(/-/g, '').replace(/0/g, 'o').replace(/1/g, 'l')),
    code,
  );
  const typos = [...'0123456789ABCDEFGHJKMNPQRSTVWXYZ']
    .filter(c => c !== code[0])
    .map(c => c + code.slice(1));
  assert.ok(
    typos.filter(t => {
      try {
        normalizeSyncCode(t);
        return false;
      } catch (e) {
        return /typo/.test(String(e));
      }
    }).length >= 29,
    'the check symbols catch a mistyped symbol',
  );
  assert.throws(() => normalizeSyncCode('ABCD-EFGH'), /28 letters/);
  assert.throws(() => normalizeSyncCode(`${code.slice(0, -1)}U`), /28 letters/);
});

test('sealed workflow data round-trips and rejects the wrong code, tampering and oversize input', () => {
  const code = generateSyncCode(),
    log: WorkflowLog = {
      version: 1,
      entries: {
        't:a': entry('later', T0, 'mac', {
          todo: 'Ünïcode todo',
          reminderAt: '2026-10-21T09:00:00Z',
        }),
      },
      floor: T0 - DAY,
    };
  const blob = sealWorkflow(log, code);
  assert.match(blob, /^APLOS-WF1\.[\w-]+\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.ok(!blob.includes('todo') && !blob.includes('acct'), 'no plaintext');
  assert.notEqual(sealWorkflow(log, code), blob, 'fresh salt and IV each time');
  assert.deepEqual(openWorkflow(blob, code.toLowerCase()), log);
  assert.throws(
    () => openWorkflow(blob, generateSyncCode()),
    (e: unknown) =>
      e instanceof WorkflowCryptoError &&
      e.reason === 'code' &&
      /This sync code does not match/.test(e.message),
  );
  const parts = blob.split('.'),
    body = Buffer.from(parts[4], 'base64url');
  body[3] ^= 1;
  assert.throws(
    () => openWorkflow([...parts.slice(0, 4), body.toString('base64url')].join('.'), code),
    (e: unknown) => e instanceof WorkflowCryptoError && e.reason === 'damaged',
  );
  const iv = Buffer.from(parts[3], 'base64url');
  iv[0] ^= 1;
  assert.throws(
    () => openWorkflow([...parts.slice(0, 3), iv.toString('base64url'), parts[4]].join('.'), code),
    (e: unknown) => e instanceof WorkflowCryptoError && e.reason === 'damaged',
    'the header is authenticated',
  );
  assert.throws(() => openWorkflow(parts.slice(0, 4).join('.'), code), /damaged/);
  assert.throws(() => openWorkflow('hello', code), /not Aplos workflow data/);
  assert.throws(() => openWorkflow(blob.replace('WF1', 'WF2'), code), /newer version/);
  assert.throws(
    () => openWorkflow('x'.repeat(2_000_001), code),
    (e: unknown) => e instanceof WorkflowCryptoError && e.reason === 'size',
  );
  // A full log of 20,000 entries still fits the size cap.
  const big: WorkflowLog = {
    version: 1,
    entries: Object.fromEntries(
      Array.from({ length: 20_000 }, (_, i) => [
        `t:18f${i.toString(16).padStart(13, '0')}`,
        {
          fields: {
            status: i % 2 ? 'done' : 'later',
            replyStatus: 'none',
            ...(i % 3 ? {} : { todo: `Follow up ${i}` }),
          },
          at: T0 + i,
          device: 'mac-1234',
        },
      ]),
    ),
  };
  assert.equal(Object.keys(openWorkflow(sealWorkflow(big, code), code).entries).length, 20_000);
});

test('a log over the plaintext limit is refused when sealing, and a valid one over a reader limit is "size", not damaged', () => {
  const code = generateSyncCode(),
    log: WorkflowLog = {
      version: 1,
      entries: { 't:a': entry('later', T0, 'mac', { todo: 'x'.repeat(5000) }) },
    };
  assert.throws(
    () => sealWorkflow(log, code, 1000),
    (e: unknown) => e instanceof WorkflowCryptoError && e.reason === 'size',
    'compresses below the sealed cap, but readers would refuse it',
  );
  assert.throws(
    () => openWorkflow(sealWorkflow(log, code), code, 1000),
    (e: unknown) => e instanceof WorkflowCryptoError && e.reason === 'size',
  );
});
