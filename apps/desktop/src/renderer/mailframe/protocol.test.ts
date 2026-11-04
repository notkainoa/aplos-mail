// Host message validation (lane card done criterion 3): spoofed source, origin and token, bad heights, bad colours.
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
const TOKEN = 'tok_0123456789abcdef';
const expect: ReportExpectation = { source: frame, origins: ['null'], token: TOKEN, width: 640 };
const paper = LIGHT_PAPER.toLowerCase();

function size(over: Record<string, unknown> = {}, event: Partial<ReportEvent> = {}): ReportEvent {
  return {
    source: frame,
    origin: 'null',
    data: {
      t: 'size',
      token: TOKEN,
      h: 812,
      w: 640,
      bg: 'rgb(244, 239, 230)',
      ready: true,
      ...over,
    },
    ...event,
  };
}

describe('acceptReport', () => {
  test('accepts a well-formed size report from the frame', () => {
    assert.deepEqual(acceptReport(size(), expect), {
      type: 'size',
      height: 812,
      bg: '#f4efe6',
      ready: true,
    });
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
    for (const token of ['tok_wrong', '', undefined, 42, { toString: () => TOKEN }]) {
      assert.equal(acceptReport(size({ token }), expect), null, String(token));
    }
    assert.equal(acceptReport(size({ token: '' }), { ...expect, token: '' }), null);
  });

  test('rejects h of NaN, Infinity, negative, 1e9, strings and missing', () => {
    for (const h of [NaN, Infinity, -Infinity, -1, -0.5, 1e9, 200_001, '812', null, undefined]) {
      assert.equal(acceptReport(size({ h }), expect), null, String(h));
    }
  });

  test('clamps heights into 1-200,000', () => {
    assert.equal(clampHeight(0), 1);
    assert.equal(clampHeight(0.2), 1);
    assert.equal(clampHeight(811.2), 812);
    assert.equal(clampHeight(200_000), 200_000);
    assert.equal(clampHeight(200_000.5), null);
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
      7,
      null,
    ]) {
      const report = acceptReport(size({ bg }), expect);
      assert.equal(report?.type, 'size', String(bg));
      assert.equal(report?.type === 'size' && report.bg, paper, String(bg));
    }
  });

  test('rejects unknown types, arrays and non-objects', () => {
    for (const data of [null, 'size', [TOKEN], { t: 'navigate', token: TOKEN }, { t: 'size' }]) {
      assert.equal(acceptReport({ source: frame, origin: 'null', data }, expect), null);
    }
  });

  test('key reports pass only the non-destructive fallback keys', () => {
    const key = (k: string) =>
      acceptReport(
        { source: frame, origin: 'null', data: { t: 'key', token: TOKEN, key: k } },
        expect,
      );
    assert.deepEqual(key('j'), { type: 'key', key: 'j', shift: false, alt: false });
    assert.equal(key('Escape')?.type, 'key');
    for (const k of ['e', 'E', ' ', 'r', 'R', 'l', 'Enter', 'Delete', '#'])
      assert.equal(key(k), null, k);
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
  test('reads the token segment of an aplos-mail URL only', () => {
    assert.equal(tokenOf('aplos-mail://m/abcdEFGH1234_-xy'), 'abcdEFGH1234_-xy');
    assert.equal(tokenOf('aplos-mail://m/abcdEFGH1234/cid/1'), 'abcdEFGH1234');
    assert.equal(tokenOf('https://m/abcdEFGH1234'), '');
    assert.equal(tokenOf('aplos-mail://m/short'), '');
  });
});
