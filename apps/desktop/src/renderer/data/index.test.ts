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
  useAgenda,
  useConnection,
  useCounts,
  useHold,
  useHome,
  useMessageBody,
  useOperation,
  usePrefetchIntent,
  useRow,
  useRowState,
  useSession,
  useSettings,
  useSetupStatus,
  useStatus,
  useView,
  UI_SETTINGS_DEFAULTS,
  HARNESS_NOW_LOCAL,
  HARNESS_NOW_MS,
  HARNESS_TIME_ZONE,
  getNow,
  toIsoDate,
  toIsoDateTime,
  setClock,
  undoStack,
  useFrames,
  useNow,
  useUndoTop,
} from './index';
import type {
  AccountState,
  ApiMethodName,
  Citation,
  ConnectFrame,
  DraftRow,
  MessageRow,
  OpId,
  ProgressFrame,
  Receipt,
  SettingsPatch,
  StatusSlotState,
  ThreadRow,
} from './index';
import { keyPrefsFromUi } from '../commands';

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
    // The toast's "Always do this for [sender]" after a correction: absolute, so it never moves a second lane.
    api.thread.act([focused], { kind: 'setLane', lane: 'update', alsoForSender: true });
    prefetch.hover(focused, doNow ? doNow.ids.slice(1, 2) : []);
  }
  // Bulk targets past the 200-row window: the Low sheet's "mark everything done" and "Clear from Home".
  api.thread.act({ spec: { kind: 'home.low' } }, { kind: 'done' });
  api.thread.act({ spec: { kind: 'home' }, group: 'fromLater' }, { kind: 'clearFromHome' });
  if (home.status === 'failed' && home.error) {
    lines.push(home.error.message);
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
  // @ts-expect-error: a selector cannot target the reader's message list.
  api.thread.act({ spec: { kind: 'thread', threadId: 't1' } }, { kind: 'done' });
  return lines;
}

/** Inbox zero: "You handled 12 emails." and "Next: Design review at 2:00 PM" (DESIGN 7.14). */
function inboxZeroExample(now: number): string[] {
  const counts = useCounts();
  const agenda = useAgenda({ from: now, to: now + 12 * 3_600_000 });
  const next = agenda.events.find((e) => !e.allDay && e.start > now);
  const lines = [`You handled ${counts.counts.handledToday} emails.`];
  if (next) {
    lines.push(`Next: ${next.title}`);
  }
  return lines;
}

/** Drafts list and compose: draft rows (not thread rows), upload, forward with the original's attachments, send and Done. */
async function draftsExample(file: Blob, sourceMessageId: string): Promise<string[]> {
  const drafts = useView({ kind: 'drafts' });
  const lines: string[] = [];
  for (const id of drafts.ids) {
    const row: DraftRow | undefined = drafts.rows.get(id);
    if (row) {
      lines.push(`${row.subject} ${row.updatedAt}`);
    }
  }
  // @ts-expect-error: the Drafts view yields draft rows, not thread rows.
  const wrong: ThreadRow | undefined = drafts.rows.get('x');
  void wrong;
  const uploaded = await api.attachment.put(file, 'plan.pdf', 'application/pdf');
  const saved = await api.draft.save({
    accountId: 'a1',
    threadId: 't1',
    source: { messageId: sourceMessageId, mode: 'forward' },
    to: [],
    subject: 'Fwd:',
    html: '',
    attachments: [uploaded.id],
  });
  const sent = await api.submission.send(saved.id, { markDone: true });
  const receipt: Receipt = sent.receipt;
  lines.push(`seq ${receipt.appliedSeq}`);
  return lines;
}

/** FatalScreen: unreachable or parked engine, Restart engine, Copy diagnostics (DESIGN 7.15). */
function fatalExample(): string | null {
  const connection = useConnection();
  switch (connection.state) {
    case 'connecting':
    case 'ready':
      return null;
    case 'unreachable':
      void api.engine.restart();
      return "Aplos can't reach its mail engine.";
    case 'parked':
      void api.diagnostics.copy();
      return connection.reason;
    default: {
      const unreachable: never = connection.state;
      return unreachable;
    }
  }
}

/** Reader: the thread row, its messages, the latest body and the UndoTray; hooks first, commands in handlers. */
function readerExample(threadId: string, submissionId: string | undefined): { lines: string[]; sendReply: () => Promise<void> } {
  const thread = useRow('Thread', threadId);
  const threadState = useRowState('Thread', threadId);
  const view = useView({ kind: 'thread', threadId });
  const latestId = view.ids[view.ids.length - 1];
  const latest: MessageRow | undefined = latestId ? view.rows.get(latestId) : undefined;
  const body = useMessageBody(latest ? latest.id : undefined);
  const submission = useRow('Submission', submissionId);
  const lines: string[] = [];

  if (threadState.status === 'notFound' || view.status === 'failed') {
    lines.push('This email is no longer here.');
  }
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
      const frame = await api.mail.frame({ messageId: latest.id, imagePolicy: 'blocked', showQuotes: true });
      lines.push(`${frame.trackersRemoved} trackers removed`);
      if (frame.hasRemoteImages) {
        await api.mail.allowImagesFrom(latest.from.address);
      }
      await api.mail.releaseFrame(frame.url);
    }
    const source = latest ? { messageId: latest.id, mode: 'reply' as const } : undefined;
    const saved = await api.draft.save({ accountId: 'a1', threadId, source, to: [], subject: 'Re:', html: '' });
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

/** Where a citation chip goes on click: a thread for a message, the calendar for an event. */
function citationTarget(c: Citation): string {
  return c.kind === 'message' ? `thread:${c.threadId}` : `event:${c.eventId}`;
}

/** Ask streaming: one run's F1 progress frames, the step line with its count, the answer text, citations. */
function askStreamExample(runId: string): string {
  const { frames, last } = useFrames('progress', { runId });
  let text = '';
  let step = '';
  const sources: string[] = [];
  for (const frame of frames) {
    if (frame.kind === 'step' && frame.step) step = frame.step.count === undefined ? frame.step.text : `${frame.step.text} · ${frame.step.count}`;
    else if (frame.kind === 'text') text += frame.delta ?? '';
    else if (frame.kind === 'citation' && frame.citation) sources.push(citationTarget(frame.citation));
    else if (frame.kind === 'error') return frame.problem?.message ?? '';
  }
  const typed: ProgressFrame | undefined = last;
  useFrames('progress', { source: 'ask' });
  // @ts-expect-error: progress frames cannot be filtered by a field that is not listed.
  useFrames('progress', { seq: 3 });
  return typed?.kind === 'done' ? text : `${step} ${text} ${sources.join(' ')}`;
}

/** The reconnect sheet: "Waiting for Google in your browser…" from the connect frames of one flow; Cancel by id once the handle is gone. */
function reconnectSheetExample(requestId: string): string {
  const last: ConnectFrame | undefined = useFrames('connect', { connectId: requestId }).last;
  if (!last || last.state === 'waiting') {
    void api.account.cancelConnect(requestId);
    return 'Waiting for Google in your browser…';
  }
  if (last.state === 'failed') return last.reasonCode === 'wrongAccount' ? 'That was a different account.' : 'Couldn’t reconnect.';
  return last.state === 'connected' ? 'Reconnected' : '';
}

/** One clock for the now-line and "reconnect within 24 hours"; a settings change Z can undo. */
function clockAndUndoExample(reconnectBy: number): boolean {
  const now = useNow({ granularity: 'minute' });
  const top = useUndoTop();
  const label = top?.kind === 'local' ? `${top.label} · Undo Z` : '';
  const handle = undoStack.push({ label: 'Done is now L', undo: () => api.settings.set({ ui: { keymap: {} } }).then(() => undefined) });
  handle.forget();
  const outcome = undoStack.undoLast();
  if (outcome?.kind === 'operation') void outcome.result.receipt;
  // Object-valued fields are replaced whole (F1), so a width change sends the whole dock.
  const patch: SettingsPatch = { ui: { dock: { ...UI_SETTINGS_DEFAULTS.dock, width: 400 }, palette: { recents: ['mail.done'] } } };
  // @ts-expect-error: a partial dock would wipe `open` and `tab`.
  const partial: SettingsPatch = { ui: { dock: { width: 400 } } };
  void patch;
  void partial;
  void label;
  return reconnectBy - now < 24 * 60 * 60 * 1000;
}

/** The stored ui fields drive the registry's key prefs without an adapter. */
const DEFAULT_KEY_PREFS_FROM_UI = keyPrefsFromUi(UI_SETTINGS_DEFAULTS);

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
    ['useRowState', () => useRowState('Thread', 't1')],
    ['useOperation', () => useOperation('op1')],
    ['useHold', () => useHold('home')],
    ['usePrefetchIntent', () => usePrefetchIntent()],
    ['useMessageBody', () => useMessageBody('m1')],
    ['useSession', () => useSession()],
    ['useConnection', () => useConnection()],
    ['useAccounts', () => useAccounts()],
    ['useStatus', () => useStatus()],
    ['useCounts', () => useCounts()],
    ['useAgenda', () => useAgenda({ from: 0, to: 1 })],
    ['useSetupStatus', () => useSetupStatus()],
    ['useSettings', () => useSettings()],
    ['useFrames', () => useFrames('progress', { runId: 'r1' })],
    ['useNow', () => useNow({ granularity: 'minute' })],
    ['useUndoTop', () => useUndoTop()],
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
  const names: ApiMethodName[] = ['thread.act', 'operation.undo', 'submission.sendNow', 'ask.run', 'attachment.put', 'engine.restart'];
  for (const name of names) {
    assert.ok(CONTRACT_METHODS[name].method.length > 0);
  }
});

test('the examples type-check and stop at the first stub', () => {
  assertNotImplemented(() => homeExample(undefined), 'useHold');
  assertNotImplemented(() => readerExample('t1', undefined), 'useRow');
  assertNotImplemented(() => statusSlotExample(), 'useStatus');
  assertNotImplemented(() => inboxZeroExample(0), 'useCounts');
  assertNotImplemented(() => fatalExample(), 'useConnection');
});

test('the stream, clock and undo examples stop at the first stub', () => {
  assertNotImplemented(() => askStreamExample('r1'), 'useFrames');
  assertNotImplemented(() => reconnectSheetExample('q1'), 'useFrames');
  assertNotImplemented(() => clockAndUndoExample(0), 'useNow');
});

test('the clock and the undo stack are stubs that name ui-shell', () => {
  assertNotImplemented(() => getNow(), 'getNow');
  assertNotImplemented(() => setClock({ now: () => 0 }), 'setClock');
  assertNotImplemented(() => undoStack.push({ label: 'Done is now L', undo: () => undefined }), 'undoStack.push');
  assertNotImplemented(() => undoStack.undoLast(), 'undoStack.undoLast');
  assertNotImplemented(() => undoStack.peek(), 'undoStack.peek');
});

// F1's UiSettings defaults (eng-contract f1-gaps, packages/contract/src/schemas/settings.ts field comments and
// tests/fixtures.ts). Until @aplos/contract is in this tree, this copy is the check; at the swap it becomes
// `UI_SETTINGS_DEFAULTS satisfies import('@aplos/contract').UiSettings` (data/README "Provisional types").
const F1_UI_DEFAULTS = {
  theme: 'system',
  density: 'default',
  keyHints: 'tooltip',
  singleKeys: true,
  holdMs: 250,
  dock: { open: false, tab: 'ask' },
  keymap: {},
  sidebarMinimised: false,
  swipe: true,
  swipeDirection: 'doneRight',
  zen: false,
  sendSound: true,
  devDetails: false,
  lastAccount: 'all',
  palette: { recents: [] },
  calendar: {},
} as const;

test('the ui defaults are F1 UiSettings field for field and map onto the registry prefs', () => {
  assert.deepEqual(UI_SETTINGS_DEFAULTS, F1_UI_DEFAULTS);
  assert.equal(UI_SETTINGS_DEFAULTS.dock.open, false, 'the dock is closed on first run (decision 9)');
  assert.deepEqual(DEFAULT_KEY_PREFS_FROM_UI, { singleKeyShortcuts: true, holdThresholdMs: 250, swapTriageArrows: false, keymap: {} });
  const swapped = keyPrefsFromUi({ ...UI_SETTINGS_DEFAULTS, swipeDirection: 'doneLeft', keymap: { 'mail.done': [{ chord: 'y' }] } });
  assert.equal(swapped.swapTriageArrows, true);
  assert.deepEqual(swapped.keymap, { 'mail.done': [{ chord: 'y' }] });
});

test('epoch to ISO conversion is local with an offset, never UTC', () => {
  const ms = new Date(2026, 9, 29, 22, 30, 5).getTime(); // 10:30 PM local: UTC is already the 30th west of Greenwich
  assert.equal(toIsoDate(ms), '2026-10-29');
  const iso = toIsoDateTime(ms);
  assert.match(iso, /^2026-10-29T22:30:05[+-]\d{2}:\d{2}$/);
  assert.equal(new Date(iso).getTime(), ms, 'the offset round-trips');
  assert.equal(HARNESS_TIME_ZONE, 'America/Los_Angeles');
  assert.equal(HARNESS_NOW_LOCAL, '2026-10-29T10:00:00');
  assert.equal(new Date(`${HARNESS_NOW_LOCAL}-07:00`).getTime(), HARNESS_NOW_MS, 'October 29 2026 is PDT');
});

test('the drafts example stops at the first stub', async () => {
  await assert.rejects(draftsExample(new Blob([]), 'm1'), (err: unknown) => err instanceof NotImplementedError && err.member === 'useView');
});
