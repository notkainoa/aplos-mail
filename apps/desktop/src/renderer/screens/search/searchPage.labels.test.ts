/**
 * The Search page's section label (DESIGN §7.9): with nothing typed the rows are the newest mail, so the section reads
 * "Recent mail"; once a query is typed they are results, "In your mail".
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/search/searchPage.labels.test.ts'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initialSearch, resultRow, searchPage, type LocalResults } from './search.model';
import { toSearchQuery } from './parse';
import { SearchPage } from './SearchPage';

const THREAD = {
  id: 't1',
  fromName: 'Jordan',
  subject: 'Print run for November',
  snippet: 'The proof is attached',
  unread: false,
  lastDate: 0,
  hasAttachments: false,
  workflow: { status: 'new' as const, bookmarked: false, hiddenFromHome: false },
  accountId: 'a1',
};

const LOCAL: LocalResults = { status: 'live', ids: ['t1'], total: 1 };

const HANDLERS = {
  onChange: () => undefined,
  onRemoveToken: () => undefined,
  onSubmit: () => undefined,
  onClear: () => undefined,
  onRetryResults: () => undefined,
  onLeaveToList: () => undefined,
  onSelectRow: () => undefined,
  onOpenRow: () => undefined,
  onRowAction: () => undefined,
};

function emptyMarkup(local: LocalResults, field: string, offer = true): string {
  const model = searchPage({ ...initialSearch, field }, local, 1_000);
  return renderToStaticMarkup(
    createElement(SearchPage, {
      model: offer ? model : { ...model, noMatchOffer: false },
      localRows: [],
      remoteRows: [],
      density: 'comfortable',
      scopeLabel: 'All accounts',
      handlers: HANDLERS,
    }),
  );
}

function markupFor(field: string): string {
  const model = searchPage({ ...initialSearch, field }, LOCAL, 1_000);
  const row = resultRow(THREAD, toSearchQuery([], field), false);
  return renderToStaticMarkup(
    createElement(SearchPage, {
      model,
      localRows: [row],
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
}

test('an empty field labels the newest mail "Recent mail", never "In your mail"', () => {
  const markup = markupFor('');
  assert.ok(markup.includes('Recent mail'));
  assert.ok(!markup.includes('In your mail'));
});

test('a typed query labels the rows "In your mail"', () => {
  const markup = markupFor('print');
  assert.ok(markup.includes('In your mail'));
  assert.ok(!markup.includes('Recent mail'));
});

test('an empty result with the Google offer has that one action; without it, Clear search is the one', () => {
  const offered = emptyMarkup({ status: 'live', ids: [], total: 0 }, 'dentist');
  assert.ok(offered.includes('Search all mail on Google'), 'the offer is the action');
  assert.ok(!offered.includes('Clear search'), 'one action only (DESIGN 7.14)');
  const bare = emptyMarkup({ status: 'live', ids: [], total: 0 }, 'dentist', false);
  assert.ok(bare.includes('Clear search'));
  assert.ok(!bare.includes('Search all mail on Google'));
});
