// Host message validation (lane card done criterion 3) against the engine reporter's message,
// `{token, h, w, bg, ready, marks}` (packages/mail-html/assets/reporter.js): spoofed source, origin and token, bad
// heights, bad colours, wrong shapes.
// Run: cd apps/desktop && npx tsx --test src/renderer/mailframe/protocol.test.ts

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  frameContentWidth,
  acceptReport,
  clampHeight,
  LIGHT_PAPER,
  parseBg,
  tokenOf,
  type ReportEvent,
  type ReportExpectation,
} from './protocol';

const frame = { name: 'the frame contentWindow' };
const other = { name: 'another window' };
const TOKEN = '0123456789abcdef0123456789abcdef';
const expect: ReportExpectation = { source: frame, origins: ['null'], token: TOKEN, width: 640 };
const paper = LIGHT_PAPER.toLowerCase();

function size(over: Record<string, unknown> = {}, event: Partial<ReportEvent> = {}): ReportEvent {
  return {
    source: frame,
    origin: 'null',
    data: {
      token: TOKEN,
      h: 812,
      w: 640,
      bg: 'rgb(244, 239, 230)',
      ready: true,
      marks: 0,
      plain: false,
      ...over,
    },
    ...event,
  };
}

describe('acceptReport', () => {
  test('plain: the seventh field is a boolean; an older reporter’s six fields mean not plain; anything else is refused', () => {
    assert.equal(acceptReport(size({ plain: true }), expect)?.plain, true);
    const { plain: _plain, ...six } = size().data as Record<string, unknown>;
    assert.equal(acceptReport(size({}, { data: six }), expect)?.plain, false);
    for (const plain of ['true', 1, null, {}, []])
      assert.equal(acceptReport(size({ plain }), expect), null, JSON.stringify(plain));
  });

  test("accepts the reporter's message from the frame", () => {
    assert.deepEqual(acceptReport(size(), expect), {
      height: 812,
      bg: '#f4efe6',
      ready: true,
      marks: 0,
      plain: false,
    });
    assert.deepEqual(acceptReport(size({ ready: false, marks: 3 }), expect), {
      height: 812,
      bg: '#f4efe6',
      ready: false,
      marks: 3,
      plain: false,
    });
  });

  test("the reporter's transparent body (no email background) reads as light paper", () => {
    assert.equal(acceptReport(size({ bg: 'rgba(0, 0, 0, 0)' }), expect)?.bg, paper);
  });

  test('rejects a spoofed source: another window, the parent, null', () => {
    assert.equal(acceptReport(size({}, { source: other }), expect), null);
    assert.equal(acceptReport(size({}, { source: globalThis }), expect), null);
    assert.equal(acceptReport(size({}, { source: null }), expect), null);
  });

  test('accepts nothing before the frame has a contentWindow', () => {
    assert.equal(acceptReport(size({}, { source: null }), { ...expect, source: null }), null);
  });

  test('rejects the wrong origin', () => {
    for (const origin of ['https://evil.test', 'file://', '', 'aplos-mail://m', 'NULL']) {
      assert.equal(acceptReport(size({}, { origin }), expect), null, origin);
    }
  });

  test('rejects a wrong, missing or non-string token, and any token when none is expected', () => {
    for (const token of [
      TOKEN.toUpperCase(),
      'tok_wrong',
      '',
      undefined,
      42,
      { toString: () => TOKEN },
    ]) {
      assert.equal(acceptReport(size({ token }), expect), null, String(token));
    }
    assert.equal(acceptReport(size({ token: '' }), { ...expect, token: '' }), null);
  });

  test('rejects h the reporter cannot send: NaN, Infinity, negative, over 1,000,000, strings, missing', () => {
    for (const h of [NaN, Infinity, -Infinity, -1, -0.5, 1e9, 1_000_001, '812', null, undefined]) {
      assert.equal(acceptReport(size({ h }), expect), null, String(h));
    }
  });

  test("clamps the reporter's range (0-1,000,000) into 1-200,000: a very long letter still shows", () => {
    assert.equal(acceptReport(size({ h: 0 }), expect)?.height, 1);
    assert.equal(acceptReport(size({ h: 200_001 }), expect)?.height, 200_000);
    assert.equal(acceptReport(size({ h: 1_000_000 }), expect)?.height, 200_000);
    assert.equal(clampHeight(0), 1);
    assert.equal(clampHeight(0.2), 1);
    assert.equal(clampHeight(811.2), 812);
    assert.equal(clampHeight(200_000), 200_000);
    assert.equal(clampHeight(5e6), 200_000);
    for (const h of [-1, NaN, Infinity, '1']) assert.equal(clampHeight(h), null, String(h));
  });

  test('rejects ready and marks of the wrong type or range, and a non-string bg', () => {
    for (const over of [
      { ready: 'true' },
      { ready: 1 },
      { ready: undefined },
      { marks: -1 },
      { marks: 1.5 },
      { marks: 100_001 },
      { marks: '3' },
      { marks: NaN },
      { bg: 7 },
      { bg: null },
    ]) {
      assert.equal(acceptReport(size(over), expect), null, JSON.stringify(over));
    }
  });

  test('rejects a report for another width (the out-of-process first-report pitfall)', () => {
    for (const w of [0, 43_000, 320, NaN, undefined, '640']) {
      assert.equal(acceptReport(size({ w }), expect), null, String(w));
    }
    assert.ok(acceptReport(size({ w: 640.6 }), expect));
  });

  test('the slot width is the frame content width: padding (the sheet inset) is not part of it', () => {
    const padded = (left: string, right: string) => ({ paddingLeft: left, paddingRight: right });
    // Light: no inset. Dark: 16 px a side on a 672 px client box, so the document lays out at 640.
    assert.equal(frameContentWidth({ clientWidth: 640 }, padded('0px', '0px')), 640);
    assert.equal(frameContentWidth({ clientWidth: 672 }, padded('16px', '16px')), 640);
    assert.equal(
      frameContentWidth({ clientWidth: 10 }, padded('16px', '16px')),
      0,
      'never negative',
    );
    assert.equal(
      frameContentWidth({ clientWidth: 640 }, padded('', 'auto')),
      640,
      'junk counts as 0',
    );
    for (const inset of ['0px', '16px']) {
      const width = frameContentWidth(
        { clientWidth: 640 + 2 * Number.parseFloat(inset) },
        padded(inset, inset),
      );
      const slot = { ...expect, width };
      assert.ok(
        acceptReport(size({ w: 640 }), slot),
        `a genuine report is accepted at inset ${inset}`,
      );
      assert.equal(
        acceptReport(size({ w: 672 }), slot),
        null,
        'the padded client width is not the content width',
      );
      assert.equal(acceptReport(size({ w: 320 }), slot), null, 'a wrong width is still rejected');
    }
  });

  test('a bg parse failure falls back to light paper, the report still counts', () => {
    for (const bg of [
      'red',
      'url(https://evil.test/x)',
      'rgb(300,0,0)',
      'rgba(0,0,0,0)',
      'rgb(1,2,3',
      'color(srgb 1 0 0)',
      'x'.repeat(64),
    ]) {
      const report = acceptReport(size({ bg }), expect);
      assert.equal(report?.bg, paper, String(bg));
    }
  });

  test('rejects arrays, non-objects, missing fields and the draft shapes with a `t` type', () => {
    const { marks: _marks, ...noMarks } = size().data as Record<string, unknown>;
    for (const data of [
      null,
      'size',
      [TOKEN],
      JSON.stringify(size().data),
      noMarks,
      { token: TOKEN },
      { ...(size().data as object), t: 'size' },
      { t: 'size', token: TOKEN, h: 812, w: 640, bg: '#fff', ready: true },
      { t: 'key', token: TOKEN, key: 'j' },
    ]) {
      assert.equal(acceptReport({ source: frame, origin: 'null', data }, expect), null);
    }
  });

  test('rejects prototype-pollution shapes: own __proto__, constructor or prototype keys, extra keys', () => {
    const own = `"token":"${TOKEN}","h":900,"w":640,"bg":"#000","ready":true`;
    const polluted = [
      JSON.parse(`{${own},"marks":0,"__proto__":{"x":1}}`),
      JSON.parse(`{${own},"__proto__":{"marks":0}}`),
      { ...(size().data as object), constructor: { prototype: { polluted: true } } },
      { ...(size().data as object), prototype: {} },
      { ...(size().data as object), extra: 1 },
    ];
    for (const data of polluted) {
      assert.equal(acceptReport({ source: frame, origin: 'null', data }, expect), null);
    }
    assert.equal(({} as { polluted?: unknown }).polluted, undefined);
  });

  test('reads own fields only: a polluted Object.prototype cannot fill in a missing one', () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.marks = 0;
    try {
      const data = { token: TOKEN, h: 900, w: 640, bg: '#000', ready: true };
      assert.equal(acceptReport({ source: frame, origin: 'null', data }, expect), null);
    } finally {
      delete proto.marks;
    }
  });

  test('rejects class instances and objects with a foreign prototype', () => {
    const base = size().data as object;
    const inherited = Object.assign(Object.create({ ready: true }) as object, base);
    class Report {
      token = TOKEN;
      h = 900;
      w = 640;
      bg = '#000';
      ready = true;
      marks = 0;
    }
    const getter = { ...(base as Record<string, unknown>) };
    Object.defineProperty(getter, 'h', { get: () => 900, enumerable: true });
    for (const data of [inherited, new Report(), getter]) {
      assert.equal(acceptReport({ source: frame, origin: 'null', data }, expect), null);
    }
  });
});

describe('parseBg', () => {
  test('reads rgb, rgba at full alpha and hex strictly', () => {
    assert.equal(parseBg('rgb(244, 239, 230)'), '#f4efe6');
    assert.equal(parseBg('rgb(244 239 230)'), '#f4efe6');
    assert.equal(parseBg('rgba(1, 2, 3, 1)'), '#010203');
    assert.equal(parseBg('#fff'), '#ffffff');
    assert.equal(parseBg('#F4EFE6'), '#f4efe6');
  });

  test('falls back for translucent, out-of-range, injected or overlong values', () => {
    for (const v of [
      'rgba(1,2,3,0.5)',
      'rgb(1.5,2,3)',
      'rgb(1,2,3);background:url(x)',
      '#ffff',
      'x'.repeat(100),
    ]) {
      assert.equal(parseBg(v), paper, v);
    }
  });
});

describe('tokenOf', () => {
  test("reads the token of the engine's document URL only (32 lowercase hex)", () => {
    assert.equal(tokenOf(`aplos-mail://m/${TOKEN}/`), TOKEN);
    assert.equal(tokenOf(`aplos-mail://m/${TOKEN}`), TOKEN);
    for (const url of [
      `aplos-mail://m/${TOKEN}/cid/1`,
      `aplos-mail://m/${TOKEN}/?x`,
      `aplos-mail://m/${TOKEN}/#x`,
      `aplos-mail://m/${TOKEN.toUpperCase()}/`,
      `aplos-mail://m/${TOKEN}0/`,
      `aplos-mail://x/${TOKEN}/`,
      `https://m/${TOKEN}/`,
      'aplos-mail://m/abcdEFGH1234_-xy',
      'aplos-mail://m/short',
    ]) {
      assert.equal(tokenOf(url), '', url);
    }
  });
});
