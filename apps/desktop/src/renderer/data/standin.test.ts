/**
 * The data surface's types against a live stand-in engine (F6), in node with no DOM. Run:
 * `cd apps/desktop && npx tsx --test src/renderer/data/standin.test.ts`.
 *
 * It boots the stand-in in-process the way `renderer/main.tsx` does, reads windows through the F2 typed client, and
 * holds what comes back in exactly the types the hooks expose (`ViewResult`, `RowForSpec`, `HomeSectionKey`,
 * `LowBandView`, `ActResult`'s `Receipt`), so a contract change that breaks a hook's shape fails here and in tsc.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultNow } from '@aplos/contract-fixture';
import { fixtureControl } from '@aplos/contract-fixture/control';
import { connectStandIn } from './standin';
import { UI_SETTINGS_DEFAULTS, WINDOW_MAX_ROWS } from './index';
import type {
  DataApi,
  Frame,
  HomeSectionKey,
  Id,
  LowBandView,
  Receipt,
  RowForSpec,
  SenderGroup,
  ThreadActArgs,
  ThreadRow,
  ViewResult,
  ViewSpec,
  WindowBody,
  WindowFrame,
} from './index';

const HOME = { kind: 'home' } as const satisfies ViewSpec;
const LOW_SENDERS = { kind: 'lowSenders' } as const satisfies ViewSpec;
const HOME_ORDER: readonly HomeSectionKey[] = ['do', 'fromLater', 'update', 'low', 'follow'];

/** A fake-clock stand-in on the demo mailbox, so timers move only when the test says. */
function boot() {
  return connectStandIn({ scenario: 'demo', clock: defaultNow });
}

/** What `useView` would hold for one window: the window body plus its rows from `T/get`. */
function asViewResult<R extends { id: Id }>(window: WindowBody, list: readonly R[]): ViewResult<R> {
  return {
    ids: window.ids,
    position: window.position,
    total: window.total,
    rows: new Map(list.map(row => [row.id, row])),
    sections: window.sections,
    held: window.held ?? [],
    rowType: window.rowType,
    state: window.state,
    status: window.error ? 'failed' : 'live',
    error: window.error ?? null,
    failures: new Map(),
    move: () => undefined,
  };
}

test('the home window reads into the ViewResult and section keys the hooks expose', async () => {
  const { client, close } = boot();
  try {
    const window = await client.api.view.watch({ spec: HOME });
    const { list, notFound } = await client.api.thread.get({ ids: window.ids });
    const view: ViewResult<RowForSpec<typeof HOME>> = asViewResult(window, list);
    const first: ThreadRow | undefined = view.rows.get(view.ids[0]!);

    assert.equal(view.rowType, 'Thread');
    assert.equal(view.status, 'live');
    assert.deepEqual(notFound, []);
    assert.ok(view.ids.length > 0 && view.ids.length <= WINDOW_MAX_ROWS);
    assert.ok(view.total >= view.ids.length);
    assert.equal(view.position, 0);
    assert.ok(first && typeof first.fromName === 'string' && first.workflow && first.rank);
    for (const id of view.ids) assert.ok(view.rows.has(id), `row ${id} came back from Thread/get`);

    // Sections arrive in the documented order, each key one useHome knows.
    const keys = view.sections.map(s => s.key);
    const positions = keys.map(key => HOME_ORDER.indexOf(key as HomeSectionKey));
    assert.ok(
      positions.every(p => p >= 0),
      `known keys only: ${keys.join(', ')}`,
    );
    assert.deepEqual(
      positions,
      [...positions].sort((a, b) => a - b),
    );
    // Runs never overlap and cover the ids, except the count-only Low band.
    const listed = view.sections.filter(s => s.key !== 'low').reduce((n, s) => n + s.count, 0);
    assert.equal(listed, view.ids.length);
    assert.equal(typeof view.state?.seq, 'number');
  } finally {
    close();
  }
});

test('the Low band reads from the home window and the lowSenders window', async () => {
  const { client, close } = boot();
  try {
    const home = await client.api.view.watch({ spec: HOME });
    const low = home.sections.find(s => s.key === 'low');
    const senders = await client.api.view.watch({ spec: LOW_SENDERS });
    const { list } = await client.api.senderGroup.get({ ids: senders.ids });
    const groups: ViewResult<RowForSpec<typeof LOW_SENDERS>> = asViewResult(senders, list);
    const group: SenderGroup | undefined = groups.rows.get(groups.ids[0]!);

    assert.equal(groups.rowType, 'SenderGroup');
    const names = low?.senders ?? [];
    const band: LowBandView = {
      count: low?.count ?? 0,
      names,
      moreSenders: Math.max(0, groups.total - names.length),
    };
    assert.ok(band.names.length <= 3);
    if (band.count > 0) {
      assert.ok(group && group.count > 0);
      assert.equal(
        groups.sections.reduce((n, s) => n + s.count, 0),
        groups.ids.length,
      );
    }
  } finally {
    close();
  }
});

test("api's plain members are the client's methods, and a thread action round-trips", async () => {
  const { client, engine, close } = boot();
  try {
    // Compile-time: the client's own methods satisfy the data surface's members.
    const why: DataApi['thread']['why'] = client.api.thread.why;
    const settingsGet: DataApi['settings']['get'] = client.api.settings.get;
    const followup: DataApi['ai']['followup'] = client.api.ai.followup;

    const window = await client.api.view.watch({ spec: HOME });
    const target = window.ids[0]!;
    const reason = await why({ threadId: target });
    assert.equal(reason.threadId, target);
    assert.equal(typeof reason.sentence, 'string');
    assert.deepEqual((await settingsGet()).ui.dock, UI_SETTINGS_DEFAULTS.dock);
    assert.equal(typeof (await followup({ threadId: target })), 'object');

    // `ThreadActArgs` with its opId is a valid `Thread/act` input.
    const frames: Frame[] = [];
    const stop = client.subscribe(frame => frames.push(frame));
    const args: ThreadActArgs & { opId: string } = {
      opId: 'op-standin-1',
      ids: [target],
      action: { type: 'done' },
    };
    const receipt: Receipt = await client.api.thread.act(args);
    assert.equal(receipt.opId, args.opId);
    assert.equal(receipt.appliedState.dbEpoch, window.state.dbEpoch);
    assert.ok(receipt.appliedState.seq > window.state.seq);

    // The overlay drops once a window frame's state reaches the receipt's (ordered, never equality).
    await fixtureControl(engine).advanceClock({ ms: 300 });
    const update = frames.find(
      (f): f is WindowFrame => f.frame === 'window' && f.windowId === window.windowId,
    );
    stop();
    assert.ok(update, 'a window frame followed the commit');
    assert.ok(update.state.seq >= receipt.appliedState.seq);
    assert.ok(!update.ids.includes(target), 'Done leaves Home');
  } finally {
    close();
  }
});

test('a fresh install serves the ui defaults this surface documents', async () => {
  const { client, close } = connectStandIn({ scenario: 'empty', clock: defaultNow });
  try {
    assert.deepEqual((await client.api.settings.get()).ui, UI_SETTINGS_DEFAULTS);
    const session = await client.api.session.get();
    assert.equal(session.hasAccounts, false);
  } finally {
    close();
  }
});
