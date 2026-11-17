/**
 * The Search page's pure logic (DESIGN §7.9; plan 30 U7 acceptance 7): operator parsing (`from:`, `to:`, `in:` —
 * including `in:done` — `is:`, `has:`, `before:`, `after:`), the `>` palette handoff, and the remote rule: typing
 * never calls Google; Return calls it exactly once per query.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/search/*.test.ts*'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProgressFrame } from '../../data';
import type { PushedToast } from '../../shell';
import { getOpenThreadContext } from '../../shell/store-thread';
import {
  absorbTokens,
  currentSearch,
  formatSearch,
  normaliseDate,
  parseSearch,
  toSearchQuery,
} from './parse';
import { actOnRow, openResult, type ActDeps } from './searchActions';
import { SearchPage } from './SearchPage';
import { specKey } from '../../data/optimistic';
import {
  BUSY_DELAY_MS,
  clearField,
  currentQuery,
  highlightTerms,
  initialSearch,
  PAUSE_GRACE_MS,
  remoteFrame,
  remoteRejected,
  remoteStarted,
  removeToken,
  resultRow,
  beyondSubject,
  snippetAround,
  snippetFit,
  withoutGreeting,
  returnReady,
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
  scope: 'all',
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

test('Esc in the field clears the text and the tokens at once', () => {
  const state = typing(initialSearch, 'from:jordan invoice');
  assert.equal(state.tokens.length, 1);
  assert.equal(state.field, 'invoice');
  const step = clearField(state);
  assert.equal(step.state.field, '');
  assert.deepEqual(step.state.tokens, []);
  assert.deepEqual(step.effects, []);
  // Tokens alone clear too: the field is "already empty" only with none of either left.
  const pillOnly = clearField({ ...initialSearch, tokens: [{ operator: 'in', value: 'done' }] });
  assert.deepEqual(pillOnly.state.tokens, []);
});

test('Esc on an already empty field clears nothing, so the next Esc can go back', () => {
  const step = clearField(initialSearch);
  assert.equal(step.state, initialSearch);
  assert.deepEqual(step.effects, []);
});

test('clearing the field leaves a running remote search where it is, keyed to its query', () => {
  let state = submit({ ...initialSearch, field: 'hi' }, CTX()).state;
  state = remoteStarted(state, 'all|hi', 'run-1');
  const cleared = clearField(state).state;
  assert.equal(cleared.remote.phase, 'running');
  // Retyping the same query finds the remote state again rather than asking twice.
  const model = searchPage({ ...cleared, field: 'hi' }, LOCAL([]), 1_000 + BUSY_DELAY_MS);
  assert.equal(model.remoteLine?.kind, 'busy');
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
  state = remoteStarted(state, 'all|hi', 'run-1');
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
  state = remoteRejected(state, 'all|hi', { type: 'paused', message: 'x', resumeAt: 12_000 });
  assert.equal(state.remote.phase, 'paused');
  state = submit({ ...initialSearch, field: 'hi' }, CTX()).state;
  state = remoteRejected(state, 'all|hi', { type: 'needsReauth', message: 'x' });
  assert.equal(state.remote.phase, 'failed');
  const model = searchPage(state, { status: 'live', ids: [], total: 0 }, 1_000);
  assert.equal(model.remoteLine?.kind, 'failed');
});

test('a failed start may be retried; a paused one may not until it resumes', () => {
  let failed = submit({ ...initialSearch, field: 'hi' }, CTX()).state;
  failed = remoteRejected(failed, 'all|hi', { type: 'internal', message: 'x' });
  assert.deepEqual(
    submit(failed, CTX()).effects.map(e => e.kind),
    ['remote'],
  );
  let paused = submit({ ...initialSearch, field: 'hi' }, CTX()).state;
  paused = remoteRejected(paused, 'all|hi', { type: 'paused', message: 'x', resumeAt: 12_000 });
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
  assert.equal(miss.noMatch, 'No mail matches “dentist”');
  assert.equal(miss.noMatchOffer, true);
  assert.equal(miss.remoteLine, null);
});

test('the same query under another account scope is a different remote search', () => {
  let state = submit(
    { ...initialSearch, field: 'invoice' },
    CTX({ scope: 'acct-1', localIds: ['a'] }),
  ).state;
  state = remoteStarted(state, 'acct-1|invoice', 'r1');
  state = remoteFrame(state, {
    frame: 'progress',
    runId: 'r1',
    source: 'search',
    kind: 'done',
  } as ProgressFrame);
  // The scope switched: Return asks again, and the old window's ids no longer split local from remote.
  const asked = submit(state, CTX({ scope: 'acct-2', localIds: ['x', 'y'] }));
  assert.deepEqual(
    asked.effects.map(e => e.kind),
    ['remote'],
  );
  const other = searchPage(asked.state, LOCAL(['x', 'y']), 1_000, true, 'acct-2');
  assert.deepEqual(other.remoteIds, []);
  assert.deepEqual(other.localIds, ['x', 'y']);
  // …while the finished scope still reports "asked" and keeps its own local/remote split.
  assert.deepEqual(submit(state, CTX({ scope: 'acct-1' })).effects, []);
  const first = searchPage(state, LOCAL(['a', 'b']), 1_000, true, 'acct-1');
  assert.deepEqual(first.localIds, ['a']);
  assert.deepEqual(first.remoteIds, ['b']);
  // A late answer for the old scope's key settles nothing in the new pending remote.
  assert.equal(remoteStarted(asked.state, 'acct-1|invoice', 'r2').remote.phase, 'starting');
});

test('remote hits join under "From Google"; ids that were already local stay put', () => {
  let state = submit({ ...initialSearch, field: 'hi' }, CTX({ localIds: ['a'] })).state;
  state = remoteStarted(state, 'all|hi', 'r1');
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

test('a failed local window draws the error line, not "No mail matches"', () => {
  const model = searchPage(
    { ...initialSearch, field: 'dentist' },
    { status: 'failed', ids: [], total: 0, error: { type: 'internal' } },
    1_000,
  );
  assert.equal(model.localFailed, true);
  assert.equal(model.noMatch, null);
  assert.equal(model.announce, '');
});

test('the polite region counts the results once the window settles', () => {
  const state = { ...initialSearch, field: 'invoice' };
  assert.equal(searchPage(state, LOCAL(['a', 'b']), 1_000).announce, '2 results in your mail.');
  assert.equal(searchPage(state, LOCAL(['a']), 1_000).announce, '1 result in your mail.');
  assert.equal(searchPage(state, LOCAL([]), 1_000).announce, 'No results.');
  // Opening and failed say nothing here: the field's own states and the error line speak instead.
  assert.equal(searchPage(state, { status: 'opening', ids: [], total: 0 }, 1_000).announce, '');
});

test('the page renders the announce sentence in a hidden live region', () => {
  const model = searchPage({ ...initialSearch, field: 'invoice' }, LOCAL(['a']), 1_000);
  const markup = renderToStaticMarkup(
    createElement(SearchPage, {
      model,
      localRows: [],
      remoteRows: [],
      density: 'comfortable',
      scopeLabel: 'All accounts',
      handlers: {
        onChange: () => undefined,
        onRemoveToken: () => undefined,
        onSubmit: () => undefined,
        onClear: () => undefined,
        onRetryResults: () => undefined,
        onLeaveToList: () => undefined,
        onSelectRow: () => undefined,
        onOpenRow: () => undefined,
        onRowAction: () => undefined,
      },
    }),
  );
  assert.match(markup, /ui-sr-only[^>]*role="status"|role="status"[^>]*ui-sr-only/);
  assert.ok(markup.includes('1 result in your mail.'));
});

test('a pause without a resume time blocks only a grace, then Return retries', () => {
  let state = submit({ ...initialSearch, field: 'hi' }, CTX({ now: 1_000 })).state;
  state = remoteRejected(state, 'all|hi', { type: 'paused', message: 'x' }, 1_000);
  assert.equal(state.remote.phase, 'paused');
  // Inside the grace Return asks nothing; past it Return asks again.
  assert.deepEqual(submit(state, CTX({ now: 1_000 + PAUSE_GRACE_MS - 1 })).effects, []);
  assert.deepEqual(
    submit(state, CTX({ now: 1_000 + PAUSE_GRACE_MS })).effects.map(e => e.kind),
    ['remote'],
  );
  // A pause with no timestamp (a state built before the stamp existed) is retryable, never stuck.
  const unstamped: SearchState = {
    ...initialSearch,
    field: 'hi',
    remote: { phase: 'paused', key: 'hi' },
  };
  assert.deepEqual(
    submit(unstamped, CTX()).effects.map(e => e.kind),
    ['remote'],
  );
});

test('a row write toasts with its own Undo and drops the toast when refused', async () => {
  const pushed: PushedToast[] = [];
  const dismissed: string[] = [];
  let refuse!: (error: unknown) => void;
  const deps: ActDeps = {
    act: () => ({
      opId: 'op-1',
      receipt: new Promise((_resolve, reject) => {
        refuse = reject;
      }),
    }),
    push: toast => {
      pushed.push(toast);
      return toast.id;
    },
    dismiss: id => {
      dismissed.push(id);
    },
  };
  actOnRow(deps, 't1', { type: 'done' }, { kind: 'done', message: 'Done' });
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].id, 'op-1');
  assert.equal(pushed[0].undoable, true);
  assert.deepEqual(
    pushed[0].actions?.map(a => a.id),
    ['undo'],
  );
  assert.equal(typeof pushed[0].onAction, 'function');
  refuse(new Error('refused'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(dismissed, ['op-1']);
});

test('openResult hands the reader the visible result ids for J and K', () => {
  openResult({ label: 'Search' }, 't2', ['t1', 't2', 't3']);
  const ctx = getOpenThreadContext();
  assert.deepEqual(ctx.listIds, ['t1', 't2', 't3']);
  assert.equal(typeof ctx.from === 'object' && ctx.from?.label, 'Search');
});

test('the local window follows the query as you type', () => {
  // `SearchScreen` opens `{ kind: 'search', query }` per typed query and `specKey` is the window key, so two
  // different queries must key two different windows for local results to update (the specKey collision this
  // used to hit). `currentQuery` builds the same `SearchQuery` the screen passes to `useView`.
  const spec = (state: SearchState) =>
    ({ kind: 'search', query: currentQuery(state).query }) as const;
  const one = spec(typing(initialSearch, 'one'));
  const two = spec(typing(initialSearch, 'two'));
  assert.notEqual(specKey(one), specKey(two));
  // Key order and object identity are irrelevant: the same query reuses the one window.
  assert.equal(specKey({ query: one.query, kind: 'search' }), specKey(one));
  // A token is part of the query, so `in:done` plus a word differs from the word alone.
  const bare = spec(typing(initialSearch, 'invoice'));
  const filtered = spec(typing(initialSearch, 'in:done invoice'));
  assert.notEqual(specKey(bare), specKey(filtered));
  const first = searchPage({ ...initialSearch, field: 'one' }, LOCAL(['a']), 1_000);
  const second = searchPage({ ...initialSearch, field: 'two' }, LOCAL(['b']), 1_000);
  assert.deepEqual(first.localIds, ['a']);
  assert.deepEqual(second.localIds, ['b']);
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

test('a snippet whose match sits far in starts a few words before it, one leading ellipsis', () => {
  const text =
    'The printer queue was cleared overnight, and the invoice reminder went out before nine';
  assert.equal(snippetAround(text, ['invoice']), '…and the invoice reminder went out before nine');
  assert.equal(snippetAround(text, ['printer']), text, 'a match near the start is left alone');
  assert.equal(snippetAround(text, ['nothing']), text, 'no match, no cut');
});

test('a snippet that starts by repeating the subject shows what follows it, or nothing', () => {
  const subject = 'Saturday in the community garden';
  assert.equal(
    beyondSubject('Saturday in the community garden this week needs hands.', subject),
    'this week needs hands.',
  );
  assert.equal(beyondSubject('Saturday in the community garden', subject), undefined);
  assert.equal(
    beyondSubject('Bring gloves for the garden.', subject),
    'Bring gloves for the garden.',
  );
  assert.equal(beyondSubject('anything', ''), 'anything', 'no subject, nothing to repeat');
});

test('a snippet is cut after a whole word, keeps its match, and short text is left alone', () => {
  const text = '…can close out the project. The two layout directions are ready';
  assert.equal(snippetFit(text, ['project'], 25), '…can close out the project…');
  assert.equal(
    snippetFit('Our project review is Friday at ten', ['project'], 25),
    'Our project review is…',
  );
  assert.equal(snippetFit('A short line', ['line']), 'A short line');
  const long = 'Replacement parts arrive in the supercalifragilisticexpialidocious crate';
  assert.ok(
    snippetFit(long, ['supercalifragilisticexpialidocious']).includes(
      'supercalifragilisticexpialidocious',
    ),
  );
});

test('a result keeps its whole subject and windows only the snippet, past a leading greeting', () => {
  const subject = 'Quarterly invoice reminder for the studio printer lease';
  const row = resultRow(
    {
      id: 't1',
      fromName: 'Maya',
      subject,
      snippet:
        'Hi Alex, the printer queue was cleared overnight, and the invoice went out before nine',
      unread: false,
      lastDate: 0,
      hasAttachments: false,
      workflow: { status: 'new', bookmarked: false, hiddenFromHome: false },
      accountId: 'a1',
    },
    toSearchQuery([], 'invoice'),
    false,
  );
  assert.equal(row.primary, subject);
  assert.ok(row.secondary?.startsWith('…') || row.secondary?.startsWith('the printer'));
  assert.ok(!row.secondary?.includes('Hi Alex'));
  assert.equal(withoutGreeting('Hello, world'), 'world');
  assert.equal(withoutGreeting('Hi,'), 'Hi,', 'a bare greeting is left alone');
});

test('a saved cursor lands once its row is there, or once the local window has settled (never on a local neighbour early)', () => {
  const local = ['l1', 'l2'];
  assert.equal(returnReady('g1', local, 'opening'), false, 'the window is still opening');
  assert.equal(returnReady('g1', local, 'live'), true, 'settled without it: the row is gone');
  assert.equal(returnReady('g1', [...local, 'g1'], 'opening'), true, 'its row has arrived');
  assert.equal(returnReady('l1', local, 'live'), true);
  assert.equal(returnReady(undefined, [], 'live'), true);
  assert.equal(returnReady('g1', [], 'failed'), true, 'a failed window will not bring it');
});
