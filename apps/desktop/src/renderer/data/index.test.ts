/**
 * F9 data surface tests. Run: `npx tsx --test apps/desktop/src/renderer/data/index.test.ts`.
 *
 * Two halves:
 * 1. Compile-time: example usage for Home, the reader and the status slot must type-check
 *    under `tsc --noEmit -p apps/desktop/tsconfig.json`; `@ts-expect-error` lines pin what
 *    must not compile.
 * 2. Runtime: every stub throws `NotImplementedError` naming lane `ui-shell`, and every
 *    `api` method has a contract mapping.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_HOOK_NEEDS,
  CONTRACT_METHODS,
  DATA_LANE,
  NotImplementedError,
  OperationFailedError,
  api,
  useAccounts,
  useCounts,
  useHold,
  useHome,
  useMessageBody,
  useOperation,
  usePrefetchIntent,
  useRow,
  useSession,
  useSettings,
  useSetupStatus,
  useStatus,
  useView,
} from './index';
import type {
  AccountState,
  ApiMethodName,
  MessageRow,
  OpId,
  StatusSlotState,
  ThreadRow,
} from './index';

// ---------------------------------------------------------------------------
// Compile-time examples (never run past their first hook; they only need to type-check)
// ---------------------------------------------------------------------------

/** Home: sections in order, held labels showing 0, the Low band, triage on keydown, undo and inline errors. */
function homeExample(lastOpId: OpId | undefined): string[] {
  const hold = useHold('home');
  const home = useHome({ holdIds: hold.heldIds });
  const prefetch = usePrefetchIntent();
  const lastOp = useOperation(lastOpId);
  const lines: string[] = [];

  for (const section of home.sections) {
    if (!section.visible) {
      continue;
    }
    const waiting = section.waiting > 0 ? ` · ${section.waiting} new` : '';
    lines.push(`${section.key} ${section.count}${waiting}`);
    for (const id of section.ids) {
      const row: ThreadRow | undefined = home.rows.get(id);
      if (!row) {
        continue;
      }
      const text = row.summary ? row.summary.text : row.subject;
      const chip = row.dueDate && row.dueSource === 'ai' ? `${row.dueDate} (from the email)` : row.dueDate ?? '';
      const failure = home.failures.get(id);
      lines.push(`${row.from.name} ${chip} ${text} ${failure ? failure.message : ''}`);
    }
    if (section.fromLater && section.fromLater.visible) {
      lines.push(`Back from Later ${section.fromLater.count}`);
    }
  }
  if (home.low.count > 0) {
    const more = home.low.moreSenders > 0 ? ` and ${home.low.moreSenders} more` : '';
    lines.push(`Low importance ${home.low.names.join(', ')}${more} ${home.low.count}`);
  }

  const doNow = home.sections.find((s) => s.key === 'do');
  const focused = doNow ? doNow.ids[0] : undefined;
  if (focused) {
    prefetch.focus(focused, doNow ? doNow.ids.slice(1, 2) : []);
    hold.begin('keys', [focused]);
    const result = api.thread.act([focused], { kind: 'later', at: null });
    result.receipt.catch((err: unknown) => {
      if (err instanceof OperationFailedError) {
        lines.push(err.error.message);
      }
    });
    api.thread.act([focused], { kind: 'laneDown', alsoForSender: true });
  }
  const unsubscribe = hold.onRelease(({ ids }) => {
    lines.push(`close ${ids.length}`);
  });
  unsubscribe();

  if (lastOp && lastOp.state === 'confirmed' && lastOp.undoable) {
    api.operation.undo(lastOp.opId);
  }
  if (lastOp && lastOp.state === 'failed') {
    lastOp.retry();
  }
  home.move({ start: 0, end: 60 });

  // @ts-expect-error: unknown action kinds do not compile.
  api.thread.act(['t1'], { kind: 'archiveForever' });
  // @ts-expect-error: lane corrections must say whether they apply to the sender.
  api.thread.act(['t1'], { kind: 'laneUp' });
  return lines;
}

/** Reader: the thread row, its messages, the latest body and the UndoTray; hooks first, commands in handlers. */
function readerExample(threadId: string, submissionId: string | undefined): { lines: string[]; sendReply: () => Promise<void> } {
  const thread = useRow('Thread', threadId);
  const view = useView({ kind: 'thread', threadId });
  const latestId = view.ids[view.ids.length - 1];
  const latest: MessageRow | undefined = latestId ? view.rows.get(latestId) : undefined;
  const body = useMessageBody(latest ? latest.id : undefined);
  const submission = useRow('Submission', submissionId);
  const lines: string[] = [];

  if (thread) {
    lines.push(thread.summary ? thread.summary.text : thread.subject);
    lines.push(thread.partial ? thread.subject : `${thread.subject} · ${thread.messageCount} messages`);
    if (thread.suggestedAction) {
      lines.push(`${thread.suggestedAction.label} Space`);
    }
  }
  if (body.slow) {
    lines.push('Loading…');
  }
  if (body.status === 'failed') {
    body.retry();
  }
  if (submission && submission.state === 'queued') {
    lines.push(`Sending to ${submission.to.map((p) => p.name).join(', ')}`);
  }

  const sendReply = async (): Promise<void> => {
    if (body.status === 'ready' && body.body && body.body.bodyKind === 'html' && latest) {
      const frame = await api.mail.frame({ messageId: latest.id, imagePolicy: 'blocked' });
      lines.push(`${frame.trackersRemoved} trackers removed`);
      await api.mail.releaseFrame(frame.url);
    }
    const saved = await api.draft.save({ accountId: 'a1', threadId, to: [], subject: 'Re:', html: '' });
    const sent = await api.submission.send(saved.id);
    await api.submission.undo(sent.submissionId);
  };

  // @ts-expect-error: a thread row is not a message row.
  const wrong: MessageRow | undefined = useRow('Thread', threadId);
  void wrong;
  // @ts-expect-error: home views yield thread rows, not message rows.
  const wrongRow: MessageRow | undefined = useView({ kind: 'home' }).rows.get('x');
  void wrongRow;
  return { lines, sendReply };
}

/** Status slot: exhaustive over the ARCH 6.4 vocabulary, plus counts and the reconnect line. */
function statusSlotExample(): string {
  const slot: StatusSlotState | undefined = useStatus();
  const counts = useCounts();
  if (!slot) {
    return 'No accounts';
  }
  if (slot.reconnectSoon && slot.account && slot.account.reconnectBy !== null) {
    return 'Gmail will ask you to reconnect soon. Reconnect now';
  }
  const status = slot.status;
  switch (status.state) {
    case 'starting':
      return 'Starting…';
    case 'ok':
      return slot.demo ? 'Demo mail. Remove it in Settings.' : '';
    case 'syncing':
      return 'Syncing…';
    case 'backfilling':
      return status.firstWindow ? `Reading your newest mail ${status.n} of ${status.m}` : `Importing ${status.n} of ${status.m}`;
    case 'paused':
      return status.reason === 'daily' ? 'Daily limit reached.' : `Resuming at ${status.until ?? 'later'}.`;
    case 'needsReauth':
      return 'Sign in again. Reconnect';
    case 'needsPermission':
      return 'Permission needed. Reconnect';
    case 'needsAdmin':
      return 'Blocked by your administrator.';
    case 'misconfigured':
      return 'Sign-in is not set up in this build.';
    case 'offline':
      return `Offline · ${status.changesWaiting} changes waiting`;
    case 'error':
      return counts.hidden ? status.message : `${status.message} ${counts.counts.home}`;
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

/** The ARCH 6.4 vocabulary, checked both ways against `AccountState`. */
const ARCH_STATES = [
  'starting',
  'ok',
  'syncing',
  'backfilling',
  'paused',
  'needsReauth',
  'needsPermission',
  'needsAdmin',
  'misconfigured',
  'offline',
  'error',
] as const satisfies readonly AccountState[];
type MissingState = Exclude<AccountState, (typeof ARCH_STATES)[number]>;
const noMissingState: MissingState extends never ? true : false = true;

// ---------------------------------------------------------------------------
// Runtime checks
// ---------------------------------------------------------------------------

function assertNotImplemented(fn: () => unknown, member: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof NotImplementedError, `${member} threw something other than NotImplementedError`);
    assert.equal(err.lane, 'ui-shell');
    assert.equal(err.code, 'NOT_IMPLEMENTED');
    assert.equal(err.member, member);
    assert.match(err.message, /ui-shell/);
    return true;
  });
}

test('the lane marker is ui-shell', () => {
  assert.equal(DATA_LANE, 'ui-shell');
  assert.equal(noMissingState, true);
  assert.equal(ARCH_STATES.length, 11);
});

test('every hook stub throws NotImplemented naming ui-shell', () => {
  const hooks: ReadonlyArray<readonly [string, () => unknown]> = [
    ['useView', () => useView({ kind: 'home' })],
    ['useHome', () => useHome()],
    ['useRow', () => useRow('Thread', 't1')],
    ['useOperation', () => useOperation('op1')],
    ['useHold', () => useHold('home')],
    ['usePrefetchIntent', () => usePrefetchIntent()],
    ['useMessageBody', () => useMessageBody('m1')],
    ['useSession', () => useSession()],
    ['useAccounts', () => useAccounts()],
    ['useStatus', () => useStatus()],
    ['useCounts', () => useCounts()],
    ['useSetupStatus', () => useSetupStatus()],
    ['useSettings', () => useSettings()],
  ];
  for (const [name, call] of hooks) {
    assertNotImplemented(call, name);
  }
  assert.deepEqual(
    hooks.map(([name]) => name).sort(),
    Object.keys(CONTRACT_HOOK_NEEDS).sort(),
    'every hook has a contract-needs entry',
  );
});

test('every api method throws NotImplemented and has a contract mapping', () => {
  const seen: string[] = [];
  for (const [group, methods] of Object.entries(api)) {
    for (const [name, method] of Object.entries(methods as Record<string, () => unknown>)) {
      seen.push(`${group}.${name}`);
      assertNotImplemented(() => method(), `api.${group}.${name}`);
    }
  }
  assert.deepEqual(seen.sort(), Object.keys(CONTRACT_METHODS).sort());
  const names: ApiMethodName[] = ['thread.act', 'operation.undo', 'submission.sendNow', 'ask.run'];
  for (const name of names) {
    assert.ok(CONTRACT_METHODS[name].method.length > 0);
  }
});

test('the examples type-check and stop at the first stub', () => {
  assertNotImplemented(() => homeExample(undefined), 'useHold');
  assertNotImplemented(() => readerExample('t1', undefined), 'useRow');
  assertNotImplemented(() => statusSlotExample(), 'useStatus');
});
