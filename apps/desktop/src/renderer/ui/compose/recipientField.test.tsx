import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Recipient } from '../props';
import { RecipientField } from './index';

const noop = () => undefined;

function chipsFor(recipients: readonly Recipient[]): string {
  return renderToStaticMarkup(
    <RecipientField
      label="To"
      recipients={recipients}
      query=""
      onQueryChange={noop}
      onCommit={noop}
      onRemove={noop}
      listboxId="to-list"
    />,
  );
}

test('a chip shows the name and carries the real address in its title and accessible name', () => {
  const markup = chipsFor([{ id: 'j', name: 'Jordan Lee', address: 'jordan@example.com' }]);
  assert.match(markup, /title="Jordan Lee &lt;jordan@example\.com&gt;"/);
  assert.match(markup, /aria-label="Jordan Lee &lt;jordan@example\.com&gt;"/);
  assert.match(markup, /<span class="ui-recipient-field__name" dir="auto">Jordan Lee<\/span>/);
});

test('a name that looks like an address is never the visible label', () => {
  const markup = chipsFor([
    { id: 'a', name: 'boss@company.com', address: 'attacker@evil.example' },
  ]);
  assert.match(markup, /title="attacker@evil\.example"/);
  assert.match(markup, /aria-label="attacker@evil\.example"/);
  assert.match(
    markup,
    /<span class="ui-recipient-field__name" dir="auto">attacker@evil\.example<\/span>/,
  );
  assert.ok(!markup.includes('boss@company.com'), 'the fake name is not rendered anywhere');
});

test('a name with a fullwidth or small look-alike "@" is never the visible label either', () => {
  for (const name of ['boss＠company.com', 'boss﹫company.com']) {
    const markup = chipsFor([{ id: 'a', name, address: 'attacker@evil.example' }]);
    assert.match(markup, /aria-label="attacker@evil\.example"/);
    assert.ok(!markup.includes(name), `the look-alike name is not rendered: ${name}`);
  }
});
