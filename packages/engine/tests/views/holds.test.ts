import test from 'node:test';
import assert from 'node:assert/strict';
import {
  growSections,
  holdIds,
  HOLD_LAPSE_MS,
  HOLD_LIMIT,
  lapseHolds,
  newHolds,
  placeHeld,
  releaseHolds,
  touchHolds,
} from '../../src/views/holds';
import { BIG_NOW } from './big';
import { incoming, patch, worldEngine, type TestEngine } from './harness';

/*
 * views-2 holds (DESIGN section 5 rule 6): a row being triaged keeps its slot while the list reshuffles around it, until
 * released or 2 s after the last activity signal. The unit tests cover the placement; the engine tests the frames.
 */

test('placeHeld puts a held row back in its slot, even when the view dropped it', () => {
  const prev = ['a', 'b', 'c', 'd'];
  const held = new Set(['b']);
  assert.deepEqual(placeHeld(['a', 'c', 'd', 'e'], prev, held, 4).ids, ['a', 'b', 'c', 'd']);
  assert.deepEqual(placeHeld(['x', 'a', 'b', 'c'], prev, held, 4).ids, ['x', 'b', 'a', 'c']);
  assert.deepEqual(placeHeld(['a', 'b', 'c', 'd'], prev, new Set(), 4).ids, ['a', 'b', 'c', 'd']);
});

test('placeHeld ignores a hold on a row that was never shown, and caps at the limit', () => {
  assert.deepEqual(placeHeld(['a', 'b'], ['a', 'b'], new Set(['zzz']), 2).ids, ['a', 'b']);
  const out = placeHeld(['a', 'b', 'c'], ['a', 'b', 'c'], new Set(['a', 'c']), 3);
  assert.deepEqual(out.ids, ['a', 'b', 'c']);
  assert.deepEqual(out.kept.sort(), ['a', 'c']);
  assert.deepEqual(placeHeld(['b', 'c', 'd'], ['a', 'b', 'c'], new Set(['a']), 3).ids, [
    'a',
    'b',
    'c',
  ]);
});

test('holds lapse two seconds after the last activity signal', () => {
  const holds = newHolds();
  holdIds(holds, ['a'], 1_000);
  assert.equal(lapseHolds(holds, 1_000 + HOLD_LAPSE_MS - 1), false);
  touchHolds(holds, 2_500);
  assert.equal(lapseHolds(holds, 1_000 + HOLD_LAPSE_MS), false, 'activity pushed the lapse out');
  assert.equal(lapseHolds(holds, 2_500 + HOLD_LAPSE_MS), true);
  assert.equal(holds.ids.size, 0);
  holdIds(holds, ['a', 'b'], 0);
  releaseHolds(holds, ['a']);
  assert.deepEqual([...holds.ids], ['b']);
  releaseHolds(holds);
  assert.equal(holds.ids.size, 0);
});

test('growSections adds a departed row to the section it sits in and shifts the later ones', () => {
  const sections = [
    { key: 'do', start: 0, count: 3 },
    { key: 'low', start: 3, count: 9, senders: ['x'] },
    { key: 'follow', start: 3, count: 2 },
  ];
  assert.deepEqual(growSections(sections, 1), [
    { key: 'do', start: 0, count: 4 },
    { key: 'low', start: 4, count: 9, senders: ['x'] },
    { key: 'follow', start: 4, count: 2 },
  ]);
  assert.deepEqual(growSections(sections, 4)[2], { key: 'follow', start: 3, count: 3 });
});

async function withWorld(fn: (t: Awaited<ReturnType<typeof worldEngine>>) => Promise<void>) {
  const t = await worldEngine();
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

const framesOf = (t: TestEngine, id: string) => t.windowFrames(id);

test('a held row keeps its slot after it leaves the view, and the window reconciles on release', async () => {
  await withWorld(async t => {
    const win = await t.call('View/watch', { spec: { kind: 'done' } });
    const held = win.ids[1]!;
    await t.call('View/hold', { windowId: win.windowId, ids: [held] });
    t.commit([patch(held, { status: 'later' })]);
    t.commit([patch(win.ids[3]!, { bookmarked: true })]);
    await t.advance(300);
    const frames = framesOf(t, win.windowId);
    assert.ok(frames.length > 0);
    for (const f of frames) assert.equal(f.ids[1], held, 'a held row stays where it was');
    assert.deepEqual(frames.at(-1)!.held, [held]);
    assert.equal(frames.at(-1)!.total, win.total, 'the held row still counts while it is shown');
    await t.call('View/release', { windowId: win.windowId, ids: [held] });
    await t.advance(300);
    const last = framesOf(t, win.windowId).at(-1)!;
    assert.ok(!last.ids.includes(held), 'once released, the window reconciles');
    assert.equal(last.held, undefined);
    assert.equal(last.total, win.total - 1);
  });
});

test('holdIds on watch hold from the first frame', async () => {
  await withWorld(async t => {
    const first = await t.call('View/query', { spec: { kind: 'done' } });
    const held = first.ids[0]!;
    const win = await t.call('View/watch', { spec: { kind: 'done' }, holdIds: [held] });
    t.commit([patch(held, { status: 'later' })]);
    await t.advance(300);
    for (const f of framesOf(t, win.windowId)) assert.equal(f.ids[0], held);
    await t.call('View/release', { windowId: win.windowId });
    await t.advance(300);
    assert.ok(!framesOf(t, win.windowId).at(-1)!.ids.includes(held));
  });
});

test('a held row does not move when rows arrive above it', async () => {
  await withWorld(async t => {
    const win = await t.call('View/watch', { spec: { kind: 'done' }, limit: 20 });
    const held = win.ids[2]!;
    await t.call('View/hold', { windowId: win.windowId, ids: [held] });
    const arrivals = ['n1', 'n2'];
    for (const [i, name] of arrivals.entries()) {
      t.commit([incoming(name, { date: BIG_NOW + i })]);
      t.commit([patch(`acct-1:${name}`, { status: 'done' })]);
      await t.advance(300);
    }
    const frames = framesOf(t, win.windowId);
    assert.ok(frames.length >= 2);
    for (const f of frames) assert.equal(f.ids[2], held);
    assert.ok(frames.at(-1)!.ids.includes('acct-1:n2'), 'the arrivals are there around it');
  });
});

test('holds lapse two seconds after the last activity, and a ping extends them', async () => {
  await withWorld(async t => {
    const win = await t.call('View/watch', { spec: { kind: 'done' } });
    const held = win.ids[1]!;
    await t.call('View/hold', { windowId: win.windowId, ids: [held] });
    t.commit([patch(held, { status: 'later' })]);
    await t.advance(1_500);
    assert.ok(framesOf(t, win.windowId).every(f => f.ids[1] === held));
    await t.call('View/hold', { windowId: win.windowId, ids: [held] });
    await t.advance(1_500);
    assert.ok(
      framesOf(t, win.windowId).every(f => f.ids[1] === held),
      'the ping at 1.5 s kept it past 2 s',
    );
    await t.advance(1_000);
    const last = framesOf(t, win.windowId).at(-1)!;
    assert.ok(!last.ids.includes(held), 'idle for 2 s: the hold lapsed and the window reconciled');
    assert.equal(last.held, undefined);
  });
});

test('Home keeps sections consistent around a held row that left the view', async () => {
  await withWorld(async t => {
    const win = await t.call('View/watch', { spec: { kind: 'home' }, limit: 200 });
    const doNow = win.sections.find(s => s.key === 'do')!;
    const held = win.ids[1]!;
    await t.call('View/hold', { windowId: win.windowId, ids: [held] });
    t.commit([patch(held, { status: 'done' })]);
    await t.advance(300);
    const last = framesOf(t, win.windowId).at(-1)!;
    assert.equal(last.ids[1], held);
    const rows = last.sections.filter(s => s.senders === undefined);
    assert.equal(
      rows.reduce((n, s) => n + s.count, 0),
      last.total,
      'section counts add up to the total',
    );
    const now = last.sections.find(s => s.key === 'do')!;
    assert.equal(now.count, doNow.count, 'the held row still belongs to Do now while it is shown');
    let next = 0;
    for (const s of rows) {
      assert.equal(s.start, next, `${s.key} starts where the previous section ended`);
      next += s.count;
    }
  });
});

/** The section key an index falls in, by the boundaries a frame reports. */
function sectionAt(
  sections: { key: string; start: number; count: number; senders?: unknown }[],
  at: number,
) {
  return sections.find(s => s.senders === undefined && at >= s.start && at < s.start + s.count)
    ?.key;
}

test('Home keeps neighbours under the right header when a held row changes section', async () => {
  await withWorld(async t => {
    const win = await t.call('View/watch', { spec: { kind: 'home' }, limit: 200 });
    const doNow = win.sections.find(s => s.key === 'do')!;
    assert.ok(doNow.count > 3, 'the seeded Home has several Do now rows');
    const held = win.ids[1]!;
    await t.call('View/hold', { windowId: win.windowId, ids: [held] });
    t.commit([patch(held, { lane: 'update' })]);
    await t.advance(300);
    const last = framesOf(t, win.windowId).at(-1)!;
    assert.equal(last.ids[1], held, 'the held row stays in its slot');
    const fresh = await t.call('View/query', { spec: { kind: 'home' }, limit: 200 });
    assert.equal(last.total, fresh.total, 'a move between sections does not change the total');
    // What a fresh read shows, with the held row taken out of where the view puts it and set back in its slot.
    const sectionsOf = (w: { ids: string[]; sections: Parameters<typeof sectionAt>[0] }) =>
      w.ids.map((_, at) => sectionAt(w.sections, at));
    const fromAt = fresh.ids.indexOf(held);
    const wantIds = fresh.ids.filter((_, at) => at !== fromAt);
    const wantSections = sectionsOf(fresh).filter((_, at) => at !== fromAt);
    wantIds.splice(1, 0, held);
    wantSections.splice(1, 0, 'do');
    assert.deepEqual(last.ids, wantIds);
    assert.deepEqual(sectionsOf(last), wantSections, 'every row sits under its own header');
  });
});

test('the held set is capped, keeping the most recent holds', () => {
  const holds = newHolds();
  const ids = Array.from({ length: HOLD_LIMIT + 100 }, (_, i) => `t${i}`);
  holdIds(holds, ids, 0);
  assert.equal(holds.ids.size, HOLD_LIMIT);
  assert.ok(holds.ids.has('t299') && !holds.ids.has('t0'));
  holdIds(holds, ['t150'], 0);
  assert.equal(holds.ids.size, HOLD_LIMIT, 'a ping for a held row grows nothing');
});
