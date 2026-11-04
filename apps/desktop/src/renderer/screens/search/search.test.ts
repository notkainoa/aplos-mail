/**
 * The Search page's pure logic (DESIGN §7.9; plan 30 U7 acceptance 7): operator parsing (`from:`, `to:`, `in:` —
 * including `in:done` — `is:`, `has:`, `before:`, `after:`), the `>` palette handoff, and the remote rule: typing
 * never calls Google; Return calls it exactly once per query.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/search/*.test.ts*'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProgressFrame } from '../../data';
import {
  absorbTokens,
  currentSearch,
  formatSearch,
  normaliseDate,
  parseSearch,
  toSearchQuery,
} from './parse';
import {
  highlightTerms,
  initialSearch,
  remoteFrame,
  remoteRejected,
  remoteStarted,
  removeToken,
  resultRow,
  searchPage,
  submit,
  typeField,
  type LocalResults,
  type RemoteContext,
  type SearchState,
} from './search.model';

const CTX = (over: Partial<RemoteContext> = {}): RemoteContext => ({
  now: 1_000,
  supported: true,
  localIds: [],
  ...over,
});

const typing = (state: SearchState, text: string): SearchState => {
  const step = typeField(state, text);
  assert.deepEqual(step.effects, []);
  return step.state;
};

test('operators parse into structured fields, including in:done', () => {
  const parsed = parseSearch(
    'from:Jordan to:me subject:"Q4 review" has:attachment before:2026-10-01 after:2026-09-01 in:done is:unread hello world',
  );
  const query = toSearchQuery(parsed.tokens, parsed.free);
  assert.equal(query.from, 'Jordan');
  assert.equal(query.to, 'me');
  assert.equal(query.subject, 'Q4 review');
  assert.equal(query.hasAttachment, true);
  assert.equal(query.before, '2026-10-01');
  assert.equal(query.after, '2026-09-01');
  assert.equal(query.in, 'done');
  assert.deepEqual(query.is, ['unread']);
  assert.equal(query.text, 'hello world');
});

test('is: takes only a known flag; a bad value stays free text', () => {
  const good = parseSearch('is:flagged');
  assert.equal(good.tokens.length, 1);
  const bad = parseSearch('is:done');
  assert.equal(bad.tokens.length, 0);
  assert.equal(bad.free, 'is:done');
  const several = toSearchQuery(parseSearch('is:unread is:bookmarked').tokens, '');
  assert.deepEqual(several.is, ['unread', 'bookmarked']);
});

test('in: lower-cases a known place and keeps a label name as typed', () => {
  assert.equal(parseSearch('in:DONE').tokens[0].value, 'done');
  assert.equal(parseSearch('in:"Receipts 2026"').tokens[0].value, 'Receipts 2026');
});

test('dates must be real; before:soon and 2026-02-30 are free text', () => {
  assert.equal(normaliseDate('2026-02-30'), null);
  assert.equal(normaliseDate('2026/2/3'), '2026-02-03');
  const parsed = parseSearch('before:soon');
  assert.equal(parsed.tokens.length, 0);
  assert.equal(parsed.free, 'before:soon');
});

test('a finished operator becomes a pill; an unfinished one stays text', () => {
  const absorbed = absorbTokens('from:jordan invoice', []);
  assert.deepEqual(absorbed.tokens, [{ operator: 'from', value: 'jordan' }]);
  assert.equal(absorbed.field, 'invoice');
  const done = absorbTokens('from:jordan ', []);
  assert.deepEqual(done.tokens, [{ operator: 'from', value: 'jordan' }]);
  assert.equal(done.field, '');
  const kept = absorbTokens('invoice from:jo', []);
  assert.deepEqual(kept.tokens, []);
  assert.equal(kept.field, 'invoice from:jo');
});

test('a later token of the same operator replaces the earlier one', () => {
  assert.deepEqual(parseSearch('from:jordan from:mina').tokens, [
    { operator: 'from', value: 'mina' },
  ]);
  const { tokens } = currentSearch('from:mina', [{ operator: 'from', value: 'jordan' }]);
  assert.deepEqual(tokens, [{ operator: 'from', value: 'mina' }]);
});

test('the canonical query text round-trips', () => {
  const parsed = parseSearch('from:Jordan  in:done  "two words"');
  assert.equal(formatSearch(parsed.tokens, parsed.free), 'from:Jordan in:done "two words"');
});

test('> opens the palette with the rest as its query; the field keeps its text', () => {
  const step = typeField({ ...initialSearch, field: 'inv' }, '>trash');
  assert.deepEqual(step.effects, [{ kind: 'openPalette', query: 'trash' }]);
  assert.equal(step.state.field, 'inv');
});

test('typing never asks Google; Return asks exactly once per query', () => {
  let state = typing(initialSearch, 'inv');
  state = typing(state, 'invoice');
  const step = submit(state, CTX());
  assert.deepEqual(
    step.effects.map(e => e.kind),
    ['remote'],
  );
  state = step.state;
  // A second Return with the same query asks nothing.
  assert.deepEqual(submit(state, CTX()).effects, []);
  // Typing still asks nothing, then Return on the new query asks once more.
  state = typing(state, ' number');
  assert.deepEqual(
    submit(state, CTX()).effects.map(e => e.kind),
    ['remote'],
  );
  // Removing a token never asks, either.
  assert.deepEqual(removeToken(state, 0).effects, []);
});

test('an empty query or an unsupported account asks nothing', () => {
  assert.deepEqual(submit(initialSearch, CTX()).effects, []);
  assert.deepEqual(
    submit({ ...initialSearch, field: 'hi' }, CTX({ supported: false })).effects,
    [],
  );
});

test('a paused account shows the pause line and asks nothing', () => {
  const step = submit({ ...initialSearch, field: 'hi' }, CTX({ now: 5, pausedUntil: 9_000 }));
  assert.deepEqual(step.effects, []);
  assert.equal(step.state.remote.phase, 'paused');
  const model = searchPage(step.state, { status: 'live', ids: [], total: 0 }, 5);
  assert.equal(model.remoteLine?.kind, 'paused');
});

test('the run id arrives, done settles it, and a second Return still asks nothing', () => {
  let state = submit({ ...initialSearch, field: 'hi' }, CTX()).state;
  state = remoteStarted(state, 'hi', 'run-1');
  assert.equal(state.remote.phase, 'running');
  state = remoteFrame(state, {
    frame: 'progress',
    runId: 'run-1',
    source: 'search',
    kind: 'done',
  } as ProgressFrame);
  assert.equal(state.remote.phase, 'done');
  assert.deepEqual(submit(state, CTX()).effects, []);
});

test('a refused start maps to the page line, never the provider text', () => {
  let state = submit({ ...initialSearch, field: 'hi' }, CTX()).state;
  state = remoteRejected(state, 'hi', { type: 'paused', message: 'x', resumeAt: 12_000 });
  assert.equal(state.remote.phase, 'paused');
  state = submit({ ...initialSearch, field: 'hi' }, CTX()).state;
  state = remoteRejected(state, 'hi', { type: 'needsReauth', message: 'x' });
  assert.equal(state.remote.phase, 'failed');
  const model = searchPage(state, { status: 'live', ids: [], total: 0 }, 1_000);
  assert.equal(model.remoteLine?.kind, 'failed');
});

test('a failed start may be retried; a paused one may not until it resumes', () => {
  let failed = submit({ ...initialSearch, field: 'hi' }, CTX()).state;
  failed = remoteRejected(failed, 'hi', { type: 'internal', message: 'x' });
  assert.deepEqual(
    submit(failed, CTX()).effects.map(e => e.kind),
    ['remote'],
  );
  let paused = submit({ ...initialSearch, field: 'hi' }, CTX()).state;
  paused = remoteRejected(paused, 'hi', { type: 'paused', message: 'x', resumeAt: 12_000 });
  assert.deepEqual(submit(paused, CTX({ now: 1_000 })).effects, []);
  assert.deepEqual(
    submit(paused, CTX({ now: 13_000 })).effects.map(e => e.kind),
    ['remote'],
  );
});

const LOCAL = (ids: string[], over: Partial<LocalResults> = {}): LocalResults => ({
  status: 'live',
  ids,
  total: ids.length,
  ...over,
});

test('the offer row sits under local results; a no-match carries the offer itself', () => {
  const state = { ...initialSearch, field: 'dentist' };
  const hit = searchPage(state, LOCAL(['t1']), 1_000);
  assert.equal(hit.remoteLine?.kind, 'offer');
  assert.equal(hit.noMatch, null);
  const miss = searchPage(state, LOCAL([]), 1_000);
  assert.equal(miss.noMatch, 'No mail matches ‘dentist’.');
  assert.equal(miss.noMatchOffer, true);
  assert.equal(miss.remoteLine, null);
});

test('remote hits join under "From Google"; ids that were already local stay put', () => {
  let state = submit({ ...initialSearch, field: 'hi' }, CTX({ localIds: ['a'] })).state;
  state = remoteStarted(state, 'hi', 'r1');
  state = remoteFrame(state, {
    frame: 'progress',
    runId: 'r1',
    source: 'search',
    kind: 'done',
  } as ProgressFrame);
  const model = searchPage(state, LOCAL(['a', 'b']), 1_000);
  assert.deepEqual(model.localIds, ['a']);
  assert.deepEqual(model.remoteIds, ['b']);
});

test('free terms bold in subjects and snippets; quoted phrases stay whole', () => {
  const query = toSearchQuery([], 'two "exact words"');
  assert.deepEqual(highlightTerms(query), ['two', 'exact words']);
  const row = resultRow(
    {
      id: 't1',
      fromName: 'Jordan',
      subject: 'Two exact words',
      snippet: 'see inside',
      unread: true,
      lastDate: 0,
      hasAttachments: true,
      workflow: { status: 'new', bookmarked: true, hiddenFromHome: false },
      accountId: 'a1',
    },
    query,
    true,
  );
  assert.equal(row.remote, true);
  assert.equal(row.marks.attachment, true);
  assert.equal(row.marks.bookmarked, true);
});
