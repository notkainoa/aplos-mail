// ui-ask: the Search page's operator parser and view model (DESIGN §7.9; plan 30 U7 acceptance 7).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  absorbTokens,
  formatSearch,
  normaliseDate,
  parseSearch,
  scanSearch,
  toSearchQuery,
  withToken,
  type SearchToken,
} from '../../src/renderer/screens/search/parse';
import {
  BUSY_DELAY_MS,
  currentQuery,
  initialSearch,
  remoteFrame,
  remoteRejected,
  remoteStarted,
  removeToken,
  searchPage,
  submit,
  typeField,
  type LocalResults,
  type SearchEffect,
  type SearchState,
} from '../../src/renderer/screens/search/search.model';
import type { ProgressFrame } from '../../src/renderer/data';
import type { SearchOperator } from '../../src/renderer/ui/props';

/** Deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rand: () => number, list: readonly T[]): T =>
  list[Math.floor(rand() * list.length)];

describe('ui-ask: search parser', () => {
  test('search operators become tokens – from:, to:, subject:, has:attachment, before:, after:, in: incl. in:done', () => {
    const parsed = parseSearch(
      'layout from:jordan to:mina@example.com subject:"design review" has:attachment before:2026/10/20 after:2026-09-01 in:Done',
    );
    assert.deepEqual(parsed.tokens, [
      { operator: 'from', value: 'jordan' },
      { operator: 'to', value: 'mina@example.com' },
      { operator: 'subject', value: 'design review' },
      { operator: 'has', value: 'attachment' },
      { operator: 'before', value: '2026-10-20' },
      { operator: 'after', value: '2026-09-01' },
      { operator: 'in', value: 'done' },
    ]);
    assert.equal(parsed.free, 'layout');
    assert.deepEqual(toSearchQuery(parsed.tokens, parsed.free), {
      text: 'layout',
      from: 'jordan',
      to: 'mina@example.com',
      subject: 'design review',
      hasAttachment: true,
      before: '2026-10-20',
      after: '2026-09-01',
      in: 'done',
    });
  });

  test('values an operator does not take stay free text', () => {
    const parsed = parseSearch(
      'before:soon has:pdf from: in:"" after:2026-02-30 http://example.com into:x',
    );
    assert.deepEqual(parsed.tokens, []);
    assert.equal(
      parsed.free,
      'before:soon has:pdf from: in:"" after:2026-02-30 http://example.com into:x',
    );
    assert.equal(normaliseDate('2028-02-29'), '2028-02-29');
    assert.equal(normaliseDate('2026-02-29'), null);
  });

  test('a label name keeps its case; a known place is lower-cased', () => {
    assert.deepEqual(parseSearch('in:"Hollow Creek" in:INBOX').tokens, [
      { operator: 'in', value: 'inbox' },
    ]);
    assert.deepEqual(parseSearch('in:"Hollow Creek"').tokens, [
      { operator: 'in', value: 'Hollow Creek' },
    ]);
  });

  test('one value per operator: the later token replaces the earlier', () => {
    assert.deepEqual(parseSearch('from:jordan from:mina').tokens, [
      { operator: 'from', value: 'mina' },
    ]);
  });

  test('quoted values keep spaces, escapes and non-Latin text', () => {
    const tokens: SearchToken[] = [
      { operator: 'from', value: 'Mina "M" Cho' },
      { operator: 'subject', value: 'ハイキング 計画' },
      { operator: 'to', value: 'back\\slash' },
    ];
    const text = formatSearch(tokens, 'résumé');
    assert.equal(
      text,
      'from:"Mina \\"M\\" Cho" subject:"ハイキング 計画" to:"back\\\\slash" résumé',
    );
    assert.deepEqual(parseSearch(text), { tokens, free: 'résumé' });
  });

  test('an unclosed quote runs to the end, so a value can be typed with spaces', () => {
    assert.deepEqual(parseSearch('subject:"design rev').tokens, [
      { operator: 'subject', value: 'design rev' },
    ]);
  });

  test('scan marks a term complete only when whitespace follows it', () => {
    const terms = scanSearch('from:jordan layout to:mina');
    assert.deepEqual(
      terms.map(t => (t.kind === 'op' ? `${t.operator}:${t.complete}` : `free:${t.text}`)),
      ['from:true', 'free:layout', 'to:false'],
    );
  });

  test('search parser round trip – format then parse gives the same tokens and words (500 fuzzed queries)', () => {
    const rand = prng(7);
    const words = [
      'layout',
      'invoice',
      'Jordan',
      'résumé',
      'ハイキング',
      'дизайн',
      'q3',
      'a-b',
      'x.y',
      'from',
      'in',
      '"quoted phrase"',
    ];
    const values: Record<SearchOperator, () => string> = {
      from: () => pick(rand, ['jordan', 'Mina Cho', 'drew@example.com', 'Ünal', 'a"b', '李雷']),
      to: () => pick(rand, ['mina', 'team@example.org', 'Sam Lee']),
      subject: () => pick(rand, ['design review', 'Q3', 'Re: "plans"', 'back\\up', 'まとめ']),
      has: () => 'attachment',
      before: () =>
        `20${10 + Math.floor(rand() * 20)}-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}`,
      after: () => pick(rand, ['2026-01-01', '2025-12-31']),
      in: () => pick(rand, ['done', 'later', 'inbox', 'Hollow Creek', 'Receipts']),
    };
    const ops = Object.keys(values) as SearchOperator[];
    for (let i = 0; i < 500; i += 1) {
      let tokens: SearchToken[] = [];
      const count = Math.floor(rand() * 5);
      for (let j = 0; j < count; j += 1) {
        const operator = pick(rand, ops);
        tokens = withToken(tokens, { operator, value: values[operator]() });
      }
      const free = Array.from({ length: Math.floor(rand() * 4) }, () => pick(rand, words)).join(
        ' ',
      );
      const text = formatSearch(tokens, free);
      assert.deepEqual(parseSearch(text), { tokens, free }, text);
    }
  });

  test('parse is idempotent on arbitrary text (500 fuzzed strings)', () => {
    const rand = prng(11);
    const pieces = [
      'from:',
      'to:',
      'in:',
      'has:',
      'before:',
      'subject:',
      '"',
      '\\',
      ' ',
      '  ',
      'x',
      'Jordan',
      'done',
      'attachment',
      '2026-10-01',
      ':',
      'é',
      '漢',
      '\t',
    ];
    for (let i = 0; i < 500; i += 1) {
      const text = Array.from({ length: 1 + Math.floor(rand() * 12) }, () =>
        pick(rand, pieces),
      ).join('');
      const once = parseSearch(text);
      const again = parseSearch(formatSearch(once.tokens, once.free));
      assert.deepEqual(again, once, JSON.stringify(text));
    }
  });

  test('a finished operator leaves the field for a pill; an unfinished one stays typed', () => {
    assert.deepEqual(absorbTokens('layout from:jordan ', []), {
      field: 'layout ',
      tokens: [{ operator: 'from', value: 'jordan' }],
    });
    assert.deepEqual(absorbTokens('from:jor', []), { field: 'from:jor', tokens: [] });
    assert.deepEqual(
      absorbTokens('has:attachment in:done ', [{ operator: 'from', value: 'jordan' }]),
      {
        field: '',
        tokens: [
          { operator: 'from', value: 'jordan' },
          { operator: 'has', value: 'attachment' },
          { operator: 'in', value: 'done' },
        ],
      },
    );
  });
});

const live = (ids: string[], total = ids.length): LocalResults => ({ status: 'live', ids, total });
const ctx = (localIds: string[] = [], extra: Partial<Parameters<typeof submit>[1]> = {}) => ({
  now: 1_000,
  supported: true,
  localIds,
  ...extra,
});

function type(state: SearchState, text: string): SearchState {
  return typeField(state, text).state;
}

function progress(runId: string, kind: ProgressFrame['kind'], reasonCode?: string): ProgressFrame {
  return {
    frame: 'progress',
    dbEpoch: 'e1',
    seq: 1,
    runId,
    source: 'search',
    kind,
    problem: reasonCode ? { reasonCode } : undefined,
  };
}

describe('ui-ask: search page model', () => {
  test('search local as you type – typing never asks Google', () => {
    let state = initialSearch;
    for (const text of [
      'l',
      'la',
      'lay',
      'layout',
      'layout from:jordan ',
      'layout from:jordan x',
    ]) {
      const stepped = typeField(state, text);
      assert.deepEqual(stepped.effects, []);
      state = stepped.state;
    }
    assert.equal(searchPage(state, live(['t1']), 0).remoteLine?.kind, 'offer');
  });

  test('typing never calls remote; Return calls it exactly once, including across a reset (U7 acc. 7, fuzzed)', () => {
    const rand = prng(42);
    for (let run = 0; run < 300; run += 1) {
      let state = initialSearch;
      // The oracle: Return asks iff there is a query and it is not the one Google was last asked.
      let lastAsked = null as string | null;
      let runSeq = 0;
      for (let i = 0; i < 40; i += 1) {
        const action = pick(rand, [
          'type',
          'type',
          'return',
          'return',
          'reset',
          'remove',
          'frame',
          'render',
        ]);
        let effects: readonly SearchEffect[] = [];
        if (action === 'type') {
          const stepped = typeField(
            state,
            pick(rand, ['', 'a', 'layout', 'layout ', 'from:jordan ', 'invoice', 'x']),
          );
          effects = stepped.effects;
          state = stepped.state;
        } else if (action === 'remove') {
          const stepped = removeToken(state, 0);
          effects = stepped.effects;
          state = stepped.state;
        } else if (action === 'reset' || action === 'render') {
          // A window reset or any re-render reads the page from the same state: there is no step, so no call.
          searchPage(
            state,
            { status: action === 'reset' ? 'reset' : 'live', ids: [], total: 0 },
            2_000,
          );
        } else if (action === 'frame' && 'runId' in state.remote && state.remote.runId) {
          state = remoteFrame(state, progress(state.remote.runId, 'done'));
        } else if (action === 'return') {
          const { key, empty } = currentQuery(state);
          const expected: number = !empty && key !== lastAsked ? 1 : 0;
          const stepped = submit(state, ctx());
          effects = stepped.effects;
          state = stepped.state;
          assert.equal(
            effects.filter(e => e.kind === 'remote').length,
            expected,
            `Return on "${key}"`,
          );
          if (expected) lastAsked = key;
          for (const e of effects) {
            if (e.kind !== 'remote') continue;
            runSeq += 1;
            state = remoteStarted(state, e.key, `run-${runSeq}`);
          }
        }
        if (action !== 'return')
          assert.ok(
            effects.every(e => e.kind !== 'remote'),
            `${action} asked Google`,
          );
      }
    }
  });

  test('search remote exactly once – a second Return with the same text calls nothing; a new query calls again', () => {
    let state = type(initialSearch, 'layout');
    const first = submit(state, ctx(['t1']));
    assert.equal(first.effects.length, 1);
    state = remoteStarted(
      first.state,
      first.effects[0].kind === 'remote' ? first.effects[0].key : '',
      'r1',
    );
    assert.equal(submit(state, ctx(['t1'])).effects.length, 0);
    state = remoteFrame(state, progress('r1', 'done'));
    assert.equal(submit(state, ctx(['t1'])).effects.length, 0);
    // Typing the same query back after changing it is still the same query: Google already answered it.
    state = type(type(state, 'layouts'), 'layout');
    assert.equal(submit(state, ctx(['t1'])).effects.length, 0);
    state = type(state, 'invoice');
    assert.equal(submit(state, ctx()).effects.length, 1);
  });

  test('a failed remote search may be retried with Return; a refused one is not', () => {
    let state = type(initialSearch, 'layout');
    const first = submit(state, ctx());
    state = remoteRejected(first.state, (first.effects[0] as { key: string }).key, {
      type: 'providerError',
      message: 'x',
    });
    assert.equal(searchPage(state, live([]), 5_000).remoteLine?.kind, 'failed');
    assert.equal(submit(state, ctx()).effects.length, 1);
    const again = submit(state, ctx());
    const reauth = remoteRejected(again.state, (again.effects[0] as { key: string }).key, {
      type: 'needsReauth',
      message: 'x',
    });
    assert.equal(submit(reauth, ctx()).effects.length, 0);
  });

  test('search remote paused – Return while paused shows the pause line with the resume time and asks nothing', () => {
    const resumeAt = new Date(2026, 9, 29, 14, 14).getTime();
    const state = type(initialSearch, 'dentist');
    const stepped = submit(state, ctx([], { pausedUntil: resumeAt, now: resumeAt - 60_000 }));
    assert.deepEqual(stepped.effects, []);
    const page = searchPage(stepped.state, live([]), resumeAt - 60_000);
    assert.equal(page.remoteLine?.kind, 'paused');
    assert.equal(page.remoteLine?.text, 'Google asked us to slow down. Search again at 2:14 PM.');
  });

  test('search remote merge – "From Google" lists only threads that joined the window after Return', () => {
    let state = type(initialSearch, 'layout');
    const stepped = submit(state, ctx(['t1', 't2']));
    state = remoteStarted(stepped.state, (stepped.effects[0] as { key: string }).key, 'r1');
    let page = searchPage(state, live(['t1', 't2']), 1_000 + BUSY_DELAY_MS - 1);
    assert.equal(page.remoteLine, null, 'no busy line under 150 ms');
    page = searchPage(state, live(['t1', 't2']), 1_000 + BUSY_DELAY_MS);
    assert.deepEqual(page.remoteLine, { kind: 'busy', text: 'Searching Google…' });
    state = remoteFrame(state, progress('r1', 'done'));
    page = searchPage(state, live(['g1', 't1', 'g2', 't2'], 4), 3_000);
    assert.deepEqual(page.localIds, ['t1', 't2']);
    assert.deepEqual(page.remoteIds, ['g1', 'g2']);
    assert.equal(page.localCount, 2);
    assert.equal(page.remoteLine, null);
    page = searchPage(state, live(['t1', 't2']), 3_000);
    assert.equal(page.remoteLine?.text, 'Nothing on Google either. Try fewer words.');
  });

  test('search no match – "No mail matches ‘dentist’." with the Google offer on the line itself', () => {
    const page = searchPage(type(initialSearch, 'dentist'), live([], 0), 0);
    assert.equal(page.noMatch, 'No mail matches ‘dentist’.');
    assert.equal(page.remoteLine, null, 'the offer rides on the no-match line');
    assert.equal(page.announce, 'No results.');
    assert.equal(
      searchPage(type(initialSearch, 'layout'), live(['a', 'b', 'c', 'd']), 0).announce,
      '4 results in your mail.',
    );
  });

  test('nothing to search: no offer, no no-match, no announcement', () => {
    const page = searchPage(initialSearch, live([], 0), 0);
    assert.equal(page.empty, true);
    assert.equal(page.noMatch, null);
    assert.equal(page.remoteLine, null);
    assert.equal(submit(initialSearch, ctx()).effects.length, 0);
  });

  test('search to palette – ">" first opens the palette with the rest; the field keeps its text', () => {
    const state = type(initialSearch, 'layout');
    const stepped = typeField(state, '>later');
    assert.deepEqual(stepped.effects, [{ kind: 'openPalette', query: 'later' }]);
    assert.equal(stepped.state.field, 'layout');
  });

  test('removing a pill changes the query and never asks Google', () => {
    let state = type(initialSearch, 'from:jordan has:attachment ');
    assert.equal(state.tokens.length, 2);
    const stepped = removeToken(state, 0);
    assert.deepEqual(stepped.effects, []);
    state = stepped.state;
    assert.deepEqual(state.tokens, [{ operator: 'has', value: 'attachment' }]);
  });
});
