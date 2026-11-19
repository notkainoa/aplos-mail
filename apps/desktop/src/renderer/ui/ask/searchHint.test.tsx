import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SearchFieldProps } from '../props';
import { SearchField } from './SearchField';

const noop = () => undefined;

function field(value: string, tokens: SearchFieldProps['tokens'] = []) {
  return renderToStaticMarkup(
    <SearchField
      value={value}
      onChange={noop}
      tokens={tokens}
      onRemoveToken={noop}
      onSubmit={noop}
      scopeLabel="All accounts"
      resultsId="results"
      onLeaveToList={noop}
    />,
  );
}

test('SearchField: the operators stay one click away while text is typed and no operator is a token yet', () => {
  for (const value of ['', 'garden']) {
    const markup = field(value);
    assert.match(markup, /aria-label="Search operators"/, `value "${value}"`);
    assert.match(markup, />Narrow with</);
  }
});

test('SearchField: a token replaces the hint', () => {
  const markup = field('garden', [{ operator: 'from', value: 'jordan' }]);
  assert.doesNotMatch(markup, /Narrow with/);
});
