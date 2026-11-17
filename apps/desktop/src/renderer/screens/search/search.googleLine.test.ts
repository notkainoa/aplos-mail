/**
 * The line about Google after it answers with nothing new, and where it sits: "Nothing on Google either. Try fewer
 * words." only fits when nothing matched locally; under real results it reads "No more results on Google". With no
 * local results the line is the empty state's own detail, not a stray line at the pane's foot.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/search/search.googleLine.test.ts'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchPage } from './SearchPage';
import { initialSearch, searchPage, type LocalResults, type SearchState } from './search.model';
import { scopeLabel } from '../../shell/AccountMenu';
import { demoWorld } from '../calendar/CalendarStates';

const NOW = 1_000;
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
  onClear: noop,
};

const answered = (field: string, localIds: string[]): SearchState => ({
  ...initialSearch,
  field,
  remote: { phase: 'done', key: `all|${field}`, runId: 'r1', localIds },
});
const LIVE = (ids: string[]): LocalResults => ({ status: 'live', ids, total: ids.length });

function draw(state: SearchState, local: LocalResults): string {
  const model = searchPage(state, local, NOW);
  return renderToStaticMarkup(
    createElement(SearchPage, {
      model,
      localRows: [],
      remoteRows: [],
      density: 'comfortable',
      scopeLabel: 'All accounts',
      handlers: HANDLERS,
    }),
  );
}

test('Google had nothing new, with local results: no "either", no "fewer words"', () => {
  const model = searchPage(answered('invoice', ['t-1']), LIVE(['t-1']), NOW);
  assert.deepEqual(model.remoteLine, { kind: 'none', text: 'No more results on Google' });
});

test('Google had nothing and nothing matched locally: the original sentence stands', () => {
  const model = searchPage(answered('invoice', []), LIVE([]), NOW);
  assert.equal(model.noMatch, 'No mail matches “invoice”');
  assert.deepEqual(model.remoteLine, {
    kind: 'none',
    text: 'Nothing on Google either. Try fewer words.',
  });
});

test('no local results: the Google line is the empty state’s detail, not a separate line below it', () => {
  const markup = draw(answered('invoice', []), LIVE([]));
  assert.match(markup, /ui-empty-line__detail[^>]*>Nothing on Google either\. Try fewer words\./);
  assert.equal(markup.split('Nothing on Google either').length - 1, 1, 'said once');
  assert.ok(!markup.includes('search-screen__remote'), 'no stray line outside the empty state');
});

test('the scope label is the account picker’s own label for the same scope', () => {
  const accounts = demoWorld.accounts;
  assert.equal(scopeLabel(accounts, undefined).label, 'All accounts');
  const one = accounts[0];
  assert.equal(scopeLabel(accounts, one.id).label, one.address);
  assert.notEqual(scopeLabel(accounts, one.id).label, one.name);
});
