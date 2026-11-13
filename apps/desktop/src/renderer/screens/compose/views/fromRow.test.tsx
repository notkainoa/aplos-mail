/**
 * The From row: hidden with one account, a menu button with two or more for a new message, plain text for a reply or
 * forward, and an account that needs to sign in again is listed but cannot be chosen. Run:
 * `cd apps/desktop && npx tsx --test src/renderer/screens/compose/views/fromRow.test.tsx`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Account } from '../../../data';
import { FromRow } from './FromRow';

const account = (id: string, address: string, state = 'ok') =>
  ({ id, address, health: { status: { state } } }) as unknown as Account;

const A = account('a1', 'alex@studio.example');
const B = account('a2', 'alex@home.example');

function html(accounts: readonly Account[], canChange: boolean): string {
  return renderToStaticMarkup(
    createElement(FromRow, { accounts, accountId: 'a1', canChange, onChange: () => undefined }),
  );
}

test('one account: no From row at all', () => {
  assert.equal(html([A], true), '');
});

test('two accounts, a new message: the address is a menu button', () => {
  const out = html([A, B], true);
  assert.match(out, /<button[^>]*aria-haspopup="menu"/);
  assert.match(out, /alex@studio\.example/);
  assert.doesNotMatch(out, /aplos-from__address/);
});

test('a reply or forward shows the thread’s address as text, with no button', () => {
  const out = html([A, B], false);
  assert.match(out, /class="aplos-from__address">alex@studio\.example</);
  assert.doesNotMatch(out, /<button/);
});

test('a missing current account falls back to its id, never a blank label', () => {
  const out = renderToStaticMarkup(
    createElement(FromRow, {
      accounts: [A, B],
      accountId: 'gone',
      canChange: false,
      onChange: () => undefined,
    }),
  );
  assert.match(out, />gone</);
});
