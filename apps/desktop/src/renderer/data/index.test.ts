/**
 * F9 data surface tests. Run: `cd apps/desktop && npx tsx --test src/renderer/data/index.test.ts`.
 *
 * Two halves:
 * 1. Compile-time: example usage for Home, the reader and the status slot, in the contract's types, must type-check
 *    under `tsc --noEmit -p apps/desktop/tsconfig.json`; `@ts-expect-error` lines pin what must not compile, and the
 *    `Equals` checks pin that `api` is the F2 client's surface.
 * 2. Runtime: every stub throws `NotImplementedError` naming lane `ui-shell`, and every `api` method maps onto a
 *    registered contract method of the same name.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getMethod, methodNames, UiSettings as UiSettingsSchema } from '@aplos/contract';
import type { Api as ClientApi } from '@aplos/contract/client';
import {
  CONTRACT_HOOK_NEEDS,
  CONTRACT_METHODS,
  DATA_LANE,
  NotImplementedError,
  OperationFailedError,
  api,
  useAccounts,
  useAccountsLoaded,
  useAgenda,
  useConnection,
  useConsent,
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
  ConnectionState,
  DueSource,
  KnownValues,
  Lane,
  Citation,
  ConnectFrame,
  ContractMethodOf,
  DataApi,
  Draft,
  HomeView,
  Message,
  OpId,
  Output,
  ProgressFrame,
  Receipt,
  SettingsPatch,
  StatusSlotState,
  ThreadRow,
  UiSettings,
} from './index';
import { keyPrefsFromUi } from '../commands';
import type { DueSource as UiDueSource, Lane as UiLane } from '../ui/props';

// ---------------------------------------------------------------------------
// Compile-time: `api` is the F2 client's surface
// ---------------------------------------------------------------------------

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Plain calls are the client's own members, so they cannot drift. */
const sameAsClient: [
  Equals<DataApi['thread']['why'], ClientApi['thread']['why']>,
  Equals<DataApi['mail']['frame'], ClientApi['mail']['frame']>,
  Equals<DataApi['blob']['put'], ClientApi['blob']['put']>,
  Equals<DataApi['consent']['grant'], ClientApi['consent']['grant']>,
  Equals<DataApi['engine']['restart'], ClientApi['engine']['restart']>,
  Equals<DataApi['thread']['open'], ClientApi['thread']['open']>,
  Equals<DataApi['ai']['cancel'], ClientApi['ai']['cancel']>,
  Equals<DataApi['operation']['retry'], ClientApi['operation']['retry']>,
  Equals<DataApi['account']['discover'], ClientApi['account']['discover']>,
] = [true, true, true, true, true, true, true, true, true];

/** Commands return the client's result; only the fresh `opId` or `requestId` becomes optional. */
const commandResults: [
  Equals<ReturnType<DataApi['draft']['set']>, Promise<Output<'Draft/set'>>>,
  Equals<ReturnType<DataApi['submission']['set']>, Promise<Output<'Submission/set'>>>,
  Equals<ReturnType<DataApi['settings']['set']>, Promise<Output<'Settings/set'>>>,
  Equals<ReturnType<DataApi['ai']['transcribe']>, Promise<Output<'Ai/transcribe'>>>,
  Equals<ContractMethodOf<'messageBody.prefetch'>, 'MessageBody/prefetch'>,
  Equals<ReturnType<DataApi['search']['remote']>, Promise<Output<'Search/remote'>>>,
  Equals<ReturnType<DataApi['ai']['dismissFollowup']>, Promise<Output<'Ai/dismissFollowup'>>>,
] = [true, true, true, true, true, true, true];

/**
 * `ui/props.ts` keeps `Lane` and `DueSource` closed (components never import renderer/data) and screens narrow the
 * contract's open enums to them; these pin the closed sets to the contract's known values, so neither can drift.
 * `ConnectionState` is derived from the contract's `engine` desktop event the same way.
 */
const closedSetsMatch: [
  Equals<KnownValues<Lane>, UiLane>,
  Equals<KnownValues<DueSource>, UiDueSource>,
  Equals<ConnectionState, 'connecting' | 'ready' | 'unreachable' | 'parked'>,
] = [true, true, true];

// ---------------------------------------------------------------------------
// Compile-time examples (never run past their first hook; they only need to type-check)
// ---------------------------------------------------------------------------

/** A row's main line is its subject; the summary follows it (owner decision 2026-11-16). */
function primaryLine(row: ThreadRow): string {
  return row.subject;
}

/** One line per visible Home section and per row in it, with the due chip and the inline failure. */
function sectionLines(home: HomeView): string[] {
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
      const { dueDate, dueSource } = row.workflow;
      const chip = dueDate && dueSource === 'ai' ? `${dueDate} (from the email)` : (dueDate ?? '');
      const failure = home.failures.get(id);
      lines.push(`${row.fromName} ${chip} ${primaryLine(row)} ${failure ? failure.message : ''}`);
    }
    if (section.fromLater && section.fromLater.visible) {
      lines.push(`Back from Later ${section.fromLater.count}`);
    }
  }
  return lines;
}

/** Home: sections in order, held labels showing 0, the Low band, triage on keydown, undo and inline errors. */
function homeExample(lastOpId: OpId | undefined): string[] {
  const hold = useHold('home');
  const home = useHome({ holdIds: hold.heldIds });
  const prefetch = usePrefetchIntent();
  const lastOp = useOperation(lastOpId);
  const lines: string[] = [];

  lines.push(...sectionLines(home));
  if (home.low.count > 0) {
    const more = home.low.moreSenders > 0 ? ` and ${home.low.moreSenders} more` : '';
    lines.push(`Low importance ${home.low.names.join(', ')}${more} ${home.low.count}`);
  }

  const doNow = home.sections.find(s => s.key === 'do');
  const focused = doNow ? doNow.ids[0] : undefined;
  if (focused) {
    prefetch.focus(focused, doNow ? doNow.ids.slice(1, 2) : []);
    hold.begin('keys', [focused]);
    // L then Someday: Later with no `until`.
    const result = api.thread.act({ ids: [focused], action: { type: 'later' } });
    result.receipt.catch((err: unknown) => {
      if (err instanceof OperationFailedError) {
        lines.push(err.error.message);
      }
    });
    api.thread.act({
      ids: [focused],
      action: { type: 'laneStep', direction: 'down', alsoForSender: true },
    });
    // The toast's "Always do this for [sender]" after a correction: absolute, so it never moves a second lane.
    api.thread.act({
      ids: [focused],
      action: { type: 'lane', lane: 'update', alsoForSender: true },
    });
    prefetch.hover(focused, doNow ? doNow.ids.slice(1, 2) : []);
  }
  // Bulk targets past the 200-row window, at the state the owner saw: the Low sheet's "mark everything done" and
  // "Clear from Home" (Later with no date).
  if (home.state) {
    const atState = home.state;
    api.thread.act({
      selector: { spec: { kind: 'homeSection', section: 'low' }, atState },
      action: { type: 'done' },
    });
    api.thread.act({
      selector: { spec: { kind: 'home' }, section: 'fromLater', atState },
      action: { type: 'later' },
    });
    const reader = { kind: 'thread', threadId: 't1' } as const;
    // @ts-expect-error: a selector cannot target the reader's message list.
    api.thread.act({ selector: { spec: reader, atState }, action: { type: 'done' } });
  }
  if (home.status === 'failed' && home.error) {
    lines.push(home.error.message);
  }
  const unsubscribe = hold.onRelease(({ ids }) => {
    lines.push(`close ${ids.length}`);
  });
  unsubscribe();

  if (lastOp && lastOp.state === 'confirmed' && lastOp.undoable) {
    api.operation.undo({ opId: lastOp.opId });
  }
  if (lastOp && lastOp.state === 'failed') {
    lastOp.retry();
  }
  home.move({ start: 0, end: 60 });

  // @ts-expect-error: unknown action types do not compile.
  api.thread.act({ ids: ['t1'], action: { type: 'archiveForever' } });
  // @ts-expect-error: the discriminator is `type`, as in the contract.
  api.thread.act({ ids: ['t1'], action: { kind: 'done' } });
  // @ts-expect-error: a lane step says which way.
  api.thread.act({ ids: ['t1'], action: { type: 'laneStep' } });
  return lines;
}

/** Inbox zero: "You handled 12 emails." and "Next: Design review at 2:00 PM" (DESIGN 7.14). */
function inboxZeroExample(now: number): string[] {
  const counts = useCounts();
  const agenda = useAgenda({ kind: 'events', from: now, to: now + 12 * 3_600_000 });
  const next = agenda.events.find(e => !e.allDay && e.start.type === 'utc' && e.start.utc > now);
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
    const row: Draft | undefined = drafts.rows.get(id);
    if (row) {
      lines.push(`${row.subject} ${row.updatedAt}`);
    }
  }
  // @ts-expect-error: the Drafts view yields draft rows, not thread rows.
  const wrong: ThreadRow | undefined = drafts.rows.get('x');
  void wrong;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const uploaded = await api.blob.put(
    { bytes, mime: 'application/pdf', name: 'plan.pdf' },
    { transfer: [bytes.buffer as ArrayBuffer] },
  );
  const saved = await api.draft.set({
    fields: {
      accountId: 'a1',
      mode: 'forward',
      threadId: 't1',
      replyToMessageId: sourceMessageId,
      to: [],
      cc: [],
      bcc: [],
      subject: 'Fwd:',
      html: '',
      attachments: [
        {
          id: 'plan',
          name: 'plan.pdf',
          mime: 'application/pdf',
          size: uploaded.size,
          blobId: uploaded.blobId,
        },
      ],
      signature: true,
    },
  });
  // ⌘⇧Return: send and Done in one operation.
  const sent = await api.submission.set({
    action: {
      type: 'send',
      draftId: saved.draft.id,
      revision: saved.draft.revision,
      alsoDone: true,
    },
  });
  const receipt: Receipt = sent.receipt;
  lines.push(`seq ${receipt.appliedState.seq} queued ${sent.submission.queuedAt}`);
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
      return connection.canRetry ? connection.reason : null;
    default: {
      const unreachable: never = connection.state;
      return unreachable;
    }
  }
}

/** Reader: the thread row, its messages, the latest body and the UndoTray; hooks first, commands in handlers. */
function readerExample(
  threadId: string,
  submissionId: string | undefined,
): { lines: string[]; sendReply: () => Promise<void> } {
  const thread = useRow('Thread', threadId);
  const threadState = useRowState('Thread', threadId);
  const view = useView({ kind: 'thread', threadId });
  const latestId = view.ids[view.ids.length - 1];
  const latest: Message | undefined = latestId ? view.rows.get(latestId) : undefined;
  const body = useMessageBody(latest ? latest.id : undefined);
  const submission = useRow('Submission', submissionId);
  const lines: string[] = [];

  if (threadState.status === 'notFound' || view.status === 'failed') {
    lines.push('This email is no longer here');
  }
  if (thread) {
    lines.push(primaryLine(thread));
    lines.push(
      thread.partial ? thread.subject : `${thread.subject} · ${thread.messageCount} messages`,
    );
    if (thread.summary.action) {
      lines.push(`${thread.summary.action.label} Space`);
    }
  }
  if (body.slow) {
    lines.push('Loading…');
  }
  if (body.status === 'failed') {
    body.retry();
  }
  if (submission && submission.state === 'queued') {
    lines.push(`Sending to ${submission.toNames.join(', ')}`);
  }

  const sendReply = async (): Promise<void> => {
    if (body.status === 'ready' && body.body && body.body.bodyKind === 'html' && latest) {
      const frame = await api.mail.frame({
        messageId: latest.id,
        imagePolicy: 'block',
        quotesOpen: true,
      });
      lines.push(`${frame.trackersRemoved} trackers removed`);
      if (frame.hasRemoteImages && latest.from) {
        await api.mail.allowImages({ sender: latest.from.address, allow: true });
      }
      await api.mail.release({ url: frame.url });
    }
    const saved = await api.draft.set({
      fields: {
        accountId: 'a1',
        mode: 'reply',
        threadId,
        ...(latest ? { replyToMessageId: latest.id } : {}),
        to: [],
        cc: [],
        bcc: [],
        subject: 'Re:',
        html: '',
        attachments: [],
        signature: true,
      },
    });
    const sent = await api.submission.set({
      action: { type: 'send', draftId: saved.draft.id, revision: saved.draft.revision },
    });
    await api.submission.set({ action: { type: 'undo', submissionId: sent.submission.id } });
  };

  // @ts-expect-error: a thread row is not a message.
  const wrong: Message | undefined = useRow('Thread', threadId);
  void wrong;
  // @ts-expect-error: home views yield thread rows, not messages.
  const wrongRow: Message | undefined = useView({ kind: 'home' }).rows.get('x');
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
  if (slot.reconnectSoon && slot.account && slot.account.health.reconnectBy !== undefined) {
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
      return status.of === undefined
        ? `Importing ${status.done}`
        : `Importing ${status.done} of ${status.of}`;
    case 'paused':
      return status.class === 'daily' ? 'Daily limit reached.' : `Resuming at ${status.until}.`;
    case 'needsReauth':
      return 'Sign in again. Reconnect';
    case 'needsPermission':
      return `Permission needed. Reconnect (${status.missingScopes.length})`;
    case 'needsAdmin':
      return 'Blocked by your administrator.';
    case 'misconfigured':
      return 'Sign-in is not set up in this build.';
    case 'offline':
      return `Offline · ${slot.account?.pendingChanges ?? 0} changes waiting`;
    case 'error':
      return counts.hidden ? (slot.reasonCode ?? 'unknown') : `${counts.counts.home}`;
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

/** Ask streaming: one run's progress frames, the step line with its count, the answer text, citations. */
function askStreamExample(runId: string): string {
  const { frames, last } = useFrames('progress', { runId });
  let text = '';
  let step = '';
  const sources: string[] = [];
  for (const frame of frames) {
    if (frame.kind === 'step' && frame.step)
      step =
        frame.step.count === undefined
          ? frame.step.text
          : `${frame.step.text} · ${frame.step.count}`;
    else if (frame.kind === 'text') text += frame.delta ?? '';
    else if (frame.kind === 'citation' && frame.citation)
      sources.push(citationTarget(frame.citation));
    else if (frame.kind === 'error') return frame.problem?.message ?? '';
  }
  const typed: ProgressFrame | undefined = last;
  useFrames('progress', { source: 'ask' });
  // @ts-expect-error: progress frames cannot be filtered by a field that is not listed.
  useFrames('progress', { seq: 3 });
  return typed?.kind === 'done' ? text : `${step} ${text} ${sources.join(' ')}`;
}

/** The reconnect sheet: "Waiting for Google in your browser…" from the connect frames of one flow; Cancel by id. */
function reconnectSheetExample(connectId: string): string {
  const last: ConnectFrame | undefined = useFrames('connect', { connectId }).last;
  if (!last || last.state === 'waiting') {
    void api.account.cancelConnect({ connectId });
    return 'Waiting for Google in your browser…';
  }
  if (last.state === 'failed')
    return last.reasonCode === 'auth.wrongAccount'
      ? 'That was a different account.'
      : 'Couldn’t reconnect.';
  return last.state === 'connected' ? 'Reconnected' : '';
}

/** One clock for the now-line and "reconnect within 24 hours"; a settings change Z can undo; the consent card. */
function clockAndUndoExample(reconnectBy: number): boolean {
  const now = useNow({ granularity: 'minute' });
  const top = useUndoTop();
  const consent = useConsent();
  const label = top?.kind === 'local' ? `${top.label} · Undo Z` : '';
  const handle = undoStack.push({
    label: 'Done is now L',
    undo: () => api.settings.set({ patch: { ui: { keymap: {} } } }).then(() => undefined),
  });
  handle.forget();
  const outcome = undoStack.undoLast();
  if (outcome?.kind === 'operation') void outcome.result.receipt;
  if (consent?.needsReconsent) {
    void api.consent.grant({
      scope: 'background',
      version: consent.currentVersion,
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
    });
  }
  // Object-valued fields are replaced whole (F1), so a width change sends the whole dock.
  const patch: SettingsPatch = {
    ui: { dock: { ...UI_SETTINGS_DEFAULTS.dock, width: 400 }, palette: { recents: ['mail.done'] } },
  };
  // @ts-expect-error: a partial dock would wipe `open` and `tab`.
  const partial: SettingsPatch = { ui: { dock: { width: 400 } } };
  void patch;
  void partial;
  void label;
  return reconnectBy - now < 24 * 60 * 60 * 1000;
}

/** The stored ui fields drive the registry's key prefs without an adapter, the contract's type included. */
const DEFAULT_KEY_PREFS_FROM_UI = keyPrefsFromUi(UI_SETTINGS_DEFAULTS);
const keyPrefsFromStored = (ui: UiSettings) => keyPrefsFromUi(ui);

/** The ARCH 6.4 vocabulary, checked both ways against the contract's `AccountState`. */
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
    assert.ok(
      err instanceof NotImplementedError,
      `${member} threw something other than NotImplementedError`,
    );
    assert.equal(err.lane, 'ui-shell');
    assert.equal(err.code, 'NOT_IMPLEMENTED');
    assert.equal(err.member, member);
    assert.match(err.message, /ui-shell/);
    return true;
  });
}

test('the lane marker is ui-shell and the type checks hold', () => {
  assert.equal(DATA_LANE, 'ui-shell');
  assert.equal(noMissingState, true);
  assert.equal(ARCH_STATES.length, 11);
  assert.ok([...sameAsClient, ...commandResults, ...closedSetsMatch].every(Boolean));
  assert.equal(typeof keyPrefsFromStored, 'function');
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
    ['useAccountsLoaded', () => useAccountsLoaded()],
    ['useStatus', () => useStatus()],
    ['useCounts', () => useCounts()],
    ['useAgenda', () => useAgenda({ kind: 'events', from: 0, to: 1 })],
    ['useSetupStatus', () => useSetupStatus()],
    ['useSettings', () => useSettings()],
    ['useConsent', () => useConsent()],
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

test('every api method throws NotImplemented and is the contract method of the same name', () => {
  const seen: string[] = [];
  const registered = new Set<string>(methodNames);
  for (const [group, methods] of Object.entries(api)) {
    for (const [verb, method] of Object.entries(methods as Record<string, () => unknown>)) {
      const name = `${group}.${verb}` as ApiMethodName;
      seen.push(name);
      assertNotImplemented(() => method(), `api.${name}`);
      const ref = CONTRACT_METHODS[name];
      const expected = `${group[0]!.toUpperCase()}${group.slice(1)}/${verb}`;
      assert.equal(ref.method, expected, `${name} maps onto the client method of the same name`);
      assert.ok(registered.has(ref.method), `${ref.method} is a registered contract method`);
      assert.equal(
        ref.kind === 'native',
        getMethod(ref.method).host === 'desktop',
        `${name} is native exactly when main serves it`,
      );
    }
  }
  assert.deepEqual(seen.sort(), Object.keys(CONTRACT_METHODS).sort());
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
  assertNotImplemented(() => reconnectSheetExample('c1'), 'useFrames');
  assertNotImplemented(() => clockAndUndoExample(0), 'useNow');
});

test('the clock and the undo stack are stubs that name ui-shell', () => {
  assertNotImplemented(() => getNow(), 'getNow');
  assertNotImplemented(() => setClock({ now: () => 0 }), 'setClock');
  assertNotImplemented(
    () => undoStack.push({ label: 'Done is now L', undo: () => undefined }),
    'undoStack.push',
  );
  assertNotImplemented(() => undoStack.undoLast(), 'undoStack.undoLast');
  assertNotImplemented(() => undoStack.peek(), 'undoStack.peek');
});

test('the ui defaults pass the contract schema and map onto the registry prefs', () => {
  assert.ok(UiSettingsSchema.safeParse(UI_SETTINGS_DEFAULTS).success);
  assert.equal(
    UI_SETTINGS_DEFAULTS.dock.open,
    false,
    'the dock is closed on first run (decision 9)',
  );
  assert.deepEqual(DEFAULT_KEY_PREFS_FROM_UI, {
    singleKeyShortcuts: true,
    holdThresholdMs: 250,
    swapTriageArrows: false,
    keymap: {},
  });
  const swapped = keyPrefsFromUi({
    ...UI_SETTINGS_DEFAULTS,
    swipeDirection: 'doneLeft',
    keymap: { 'mail.done': [{ chord: 'y' }] },
  });
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
  assert.equal(
    new Date(`${HARNESS_NOW_LOCAL}-07:00`).getTime(),
    HARNESS_NOW_MS,
    'October 29 2026 is PDT',
  );
});

test('the drafts example stops at the first stub', async () => {
  await assert.rejects(
    draftsExample(new Blob([]), 'm1'),
    (err: unknown) => err instanceof NotImplementedError && err.member === 'useView',
  );
});
