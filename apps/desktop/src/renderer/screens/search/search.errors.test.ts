/**
 * One failure, one line (bug #322): the Search page stacked the generic "Couldn’t load this list." over the
 * failure's own sentence — two `role="alert"` banners for one failure. Every failure kind the model
 * distinguishes (needsReauth, offline, unavailable, rate limit, an unnamed window error, a partial list under a
 * remote problem, and no-match which is not a failure) gets exactly one presentation: a named reason shows only
 * its own line; only an unnamed window failure gets the generic list line with Try again.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/search/*.test.ts'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchPage } from './SearchPage';
import { toSearchQuery } from './parse';
import {
  initialSearch,
  remoteRejected,
  resultRow,
  searchPage,
  submit,
  type LocalResults,
  type RemoteContext,
  type ResultRow,
  type SearchPageModel,
  type SearchState,
} from './search.model';

const CTX = (over: Partial<RemoteContext> = {}): RemoteContext => ({
  now: 1_000,
  supported: true,
  localIds: [],
  scope: 'all',
  ...over,
});

const LOCAL = (ids: string[], over: Partial<LocalResults> = {}): LocalResults => ({
  status: 'live',
  ids,
  total: ids.length,
  ...over,
});

const FAILED_LOCAL = (over: Partial<LocalResults> = {}): LocalResults => ({
  status: 'failed',
  ids: [],
  total: 0,
  ...over,
});

/** The remote state after a refused Return: the key `remoteKey` gives a scoped query. */
const refused = (reason: 'offline' | 'needsReauth' | 'unavailable' | 'error'): SearchState => ({
  ...initialSearch,
  field: 'invoice',
  remote: { phase: 'failed', key: 'all|invoice', reason },
});

const noop = () => undefined;
const HANDLERS = {
  onChange: noop,
  onRemoveToken: noop,
  onSubmit: noop,
  onRetryResults: noop,
  onLeaveToList: noop,
  onSelectRow: noop,
  onOpenRow: noop,
  onRowAction: noop,
};

function render(
  model: SearchPageModel,
  over: { localRows?: ResultRow[]; remoteRows?: ResultRow[] } = {},
): string {
  return renderToStaticMarkup(
    createElement(SearchPage, {
      model,
      localRows: over.localRows ?? [],
      remoteRows: over.remoteRows ?? [],
      density: 'comfortable',
      showAccountDot: false,
      scopeLabel: 'All accounts',
      handlers: HANDLERS,
    }),
  );
}

const alerts = (markup: string): number => markup.match(/role="alert"/g)?.length ?? 0;
const errorLines = (markup: string): number => markup.match(/class="ui-error-line"/g)?.length ?? 0;

const ROW = resultRow(
  {
    id: 't-1',
    fromName: 'Jordan Park',
    subject: 'Invoice 0412 · October illustrations',
    snippet: 'The October illustrations are finished.',
    unread: false,
    lastDate: 0,
    hasAttachments: false,
    workflow: { status: 'new', bookmarked: false, hiddenFromHome: false },
    accountId: 'a1',
  },
  toSearchQuery([], 'invoice'),
  false,
);

test('needsReauth: a refused Return and a failed window share one line, not two banners', () => {
  // The packaged sweep's case: Return's remote search and the search window both report needsReauth.
  let state = submit({ ...initialSearch, field: 'invoice' }, CTX()).state;
  state = remoteRejected(state, 'all|invoice', { type: 'needsReauth', message: 'x' });
  const model = searchPage(state, FAILED_LOCAL({ error: { type: 'needsReauth' } }), 1_000);
  assert.equal(model.localFailed, true);
  assert.equal(model.listFailed, false);
  assert.equal(model.remoteLine?.kind, 'failed');
  const markup = render(model);
  assert.equal(errorLines(markup), 1);
  assert.equal(alerts(markup), 1);
  assert.ok(markup.includes('Google needs you to sign in again before it can search.'));
  assert.ok(!markup.includes('Couldn’t load this list.'));
});

test('a window that failed naming a reason shows only that reason, never the generic line', () => {
  // The window's own error names the failure: no generic line, and no offer to ask Google what it just refused.
  const model = searchPage(
    { ...initialSearch, field: 'invoice' },
    FAILED_LOCAL({ error: { type: 'needsReauth' } }),
    1_000,
  );
  assert.equal(model.listFailed, false);
  assert.equal(model.remoteLine?.kind, 'failed');
  const markup = render(model);
  assert.equal(errorLines(markup), 1);
  assert.equal(alerts(markup), 1);
  assert.ok(markup.includes('Google needs you to sign in again before it can search.'));
  assert.ok(!markup.includes('Couldn’t load this list.'));
  assert.ok(!markup.includes('Search all mail on Google'));
});

test('a window failure with no reason to name keeps the generic line and its Try again', () => {
  for (const error of [{ type: 'internal' as const, message: 'x' }, undefined, null]) {
    const model = searchPage(
      { ...initialSearch, field: 'invoice' },
      FAILED_LOCAL({ error }),
      1_000,
    );
    assert.equal(model.localFailed, true);
    assert.equal(model.listFailed, true);
    const markup = render(model);
    assert.equal(errorLines(markup), 1);
    assert.equal(alerts(markup), 1);
    assert.ok(markup.includes('Couldn’t load this list.'));
    assert.ok(markup.includes('Try again'));
  }
});

test('a remote refusal beside an unnamed window failure still draws one line', () => {
  let state = submit({ ...initialSearch, field: 'invoice' }, CTX()).state;
  state = remoteRejected(state, 'all|invoice', { type: 'internal', message: 'x' });
  const model = searchPage(state, FAILED_LOCAL({ error: { type: 'internal' } }), 1_000);
  assert.equal(model.remoteLine?.kind, 'failed');
  assert.equal(model.listFailed, false);
  const markup = render(model);
  assert.equal(errorLines(markup), 1);
  assert.equal(alerts(markup), 1);
  assert.ok(markup.includes('Google didn’t answer.'));
  assert.ok(!markup.includes('Couldn’t load this list.'));
});

test('every remote refusal reason draws its one sentence', () => {
  const cases = [
    ['offline', 'You’re offline. Your mail on this Mac is still searched.', true],
    ['needsReauth', 'Google needs you to sign in again before it can search.', false],
    ['unavailable', 'This account can’t search on Google.', false],
    ['error', 'Google didn’t answer.', true],
  ] as const;
  for (const [reason, text, tries] of cases) {
    const model = searchPage(refused(reason), LOCAL([]), 1_000);
    assert.equal(model.remoteLine?.kind, 'failed');
    const markup = render(model);
    assert.equal(errorLines(markup), 1, reason);
    assert.equal(alerts(markup), 1, reason);
    assert.ok(markup.includes(text), `${reason}: ${text}`);
    assert.equal(markup.includes('Try again'), tries, reason);
  }
});

test('a window stopped by a rate limit shows the pause line alone', () => {
  const model = searchPage(
    { ...initialSearch, field: 'invoice' },
    FAILED_LOCAL({ error: { type: 'paused', resumeAt: 61_000 } }),
    1_000,
  );
  assert.equal(model.remoteLine?.kind, 'paused');
  assert.equal(model.listFailed, false);
  const markup = render(model);
  assert.equal(errorLines(markup), 0);
  assert.equal(alerts(markup), 0);
  assert.ok(markup.includes('Google asked us to slow down. Search again at'));
  assert.ok(!markup.includes('Couldn’t load this list.'));
});

test('local results still render under a remote failure, with one notice', () => {
  const model = searchPage(refused('needsReauth'), LOCAL(['t-1']), 1_000);
  const markup = render(model, { localRows: [ROW] });
  assert.ok(markup.includes('role="listbox"'));
  assert.ok(markup.includes('search-row-t-1'));
  assert.equal(errorLines(markup), 1);
  assert.equal(alerts(markup), 1);
  assert.ok(markup.includes('Google needs you to sign in again before it can search.'));
});

test('a failed window that kept its rows shows them under one notice', () => {
  const model = searchPage(
    refused('needsReauth'),
    FAILED_LOCAL({ ids: ['t-1'], total: 1, error: { type: 'needsReauth' } }),
    1_000,
  );
  const markup = render(model, { localRows: [ROW] });
  assert.ok(markup.includes('role="listbox"'));
  assert.equal(errorLines(markup), 1);
  assert.equal(alerts(markup), 1);
  assert.ok(!markup.includes('Couldn’t load this list.'));
});

test('no mail matched is not a failure: the empty line carries the offer, no alert', () => {
  const model = searchPage({ ...initialSearch, field: 'dentist' }, LOCAL([]), 1_000);
  assert.equal(model.noMatch, 'No mail matches ‘dentist’');
  const markup = render(model);
  assert.equal(errorLines(markup), 0);
  assert.equal(alerts(markup), 0);
  assert.ok(markup.includes('No mail matches'));
});
