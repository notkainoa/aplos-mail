// The sealed frame's listener: a message that fails a cheap check costs no layout read, and nothing is read once the
// growth fence froze. The late-report refusal in the gap before React unmounts the slot is tested here too.
// Run: cd apps/desktop && npx tsx --test src/renderer/mailframe/reports.test.ts

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createFrameDeadline, type DeadlineClock } from './deadline';
import { MAX_GROWTHS } from './growth';
import { createMeasuredHandler } from './measured';
import { createReportListener } from './reports';
import type { FrameSource, MailFrameReady } from './types';

const TOKEN = '0123456789abcdef0123456789abcdef';

/** A frame whose layout reads are counted. */
function countingFrame() {
  const reads = { width: 0, style: 0 };
  const contentWindow = {};
  const frame = {
    contentWindow,
    get clientWidth() {
      reads.width++;
      return 600;
    },
  };
  const style = () => {
    reads.style++;
    return { paddingLeft: '0px', paddingRight: '0px' };
  };
  return { frame, contentWindow, reads, style };
}

function report(h: number, extra: Record<string, unknown> = {}) {
  return { token: TOKEN, h, w: 600, bg: 'rgb(255, 255, 255)', ready: true, marks: 0, ...extra };
}

function harness() {
  const f = countingFrame();
  const heights: number[] = [];
  const firsts: number[] = [];
  const listener = createReportListener({
    frame: () => f.frame,
    token: TOKEN,
    setHeight: h => heights.push(h),
    onFirst: r => firsts.push(r.height),
    style: f.style,
  });
  const send = (data: unknown, source: unknown = f.contentWindow, origin = 'null') =>
    listener({ source, origin, data });
  return { ...f, heights, firsts, send };
}

describe('sealed frame listener', () => {
  test('a message from the wrong source never reads layout', () => {
    const h = harness();
    h.send(report(100), {});
    h.send(report(100), null);
    assert.deepEqual(h.reads, { width: 0, style: 0 });
    assert.deepEqual(h.heights, []);
  });

  test('a wrong origin, token, shape or height never reads layout either', () => {
    const h = harness();
    h.send(report(100), h.contentWindow, 'http://evil.test');
    h.send(report(100, { token: 'f'.repeat(32) }));
    h.send({ token: TOKEN, h: 100 });
    h.send(report(Number.NaN));
    h.send(report(100, { marks: -1 }));
    assert.deepEqual(h.reads, { width: 0, style: 0 });
    assert.deepEqual(h.heights, []);
  });

  test('a valid report reads the width and is applied; a wrong width is still refused', () => {
    const h = harness();
    h.send(report(100, { w: 300 }));
    assert.deepEqual(h.heights, []);
    h.send(report(100));
    assert.deepEqual(h.heights, [100]);
    assert.deepEqual(h.firsts, [100]);
    assert.ok(h.reads.width > 0 && h.reads.style > 0);
  });

  test('once the fence froze, repeated reports do no layout reads and change nothing', () => {
    const h = harness();
    for (let i = 0; i <= MAX_GROWTHS; i++) h.send(report(100 + i * 10));
    const frozenAt = h.heights.length;
    const reads = { ...h.reads };
    for (let i = 0; i < 50; i++) h.send(report(5_000));
    h.send(report(5_000), {});
    assert.deepEqual(h.reads, reads);
    assert.equal(h.heights.length, frozenAt);
    assert.deepEqual(h.firsts, [100]);
  });
});

function fakeClock() {
  const timers: Array<() => void> = [];
  const clock: DeadlineClock = {
    setTimeout: run => timers.push(run),
    clearTimeout: () => {},
  };
  return { clock, fire: () => timers.splice(0).forEach(run => run()) };
}

describe('MailFrameView first report', () => {
  const source: FrameSource = { kind: 'url', key: 'm1', url: 'x', token: TOKEN, blocked: 0 };
  const ready: MailFrameReady = { height: 10, bg: '#ffffff', blocked: 0, trackers: 0 };

  function view() {
    const { clock, fire } = fakeClock();
    const expired: string[] = [];
    const deadline = createFrameDeadline(key => expired.push(key), 1_000, clock);
    const calls = { onReady: 0, shown: [] as string[] };
    const onMeasured = createMeasuredHandler({
      deadline,
      latest: () => ({ source, onReady: () => void calls.onReady++ }),
      shownKey: () => calls.shown.at(-1) ?? null,
      show: s => calls.shown.push(s.key),
    });
    deadline.watch(source.key);
    return { onMeasured, fire, deadline, calls, expired };
  }

  test('a report in time shows the letter and tells onReady once', () => {
    const v = view();
    v.onMeasured(source, ready);
    v.onMeasured(source, ready);
    assert.deepEqual(v.calls, { onReady: 1, shown: ['m1'] });
  });

  test('a report after the deadline, with the slot still mounted, is refused and the view stays failed', () => {
    const v = view();
    v.fire();
    assert.deepEqual(v.expired, ['m1']);
    v.onMeasured(source, ready);
    assert.deepEqual(v.calls, { onReady: 0, shown: [] });
    assert.equal(v.deadline.expired('m1'), true);
  });
});
