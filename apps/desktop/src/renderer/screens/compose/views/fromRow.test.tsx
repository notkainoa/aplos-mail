/**
 * The From row: hidden with one account, a menu button with two or more (a reply and a forward too, owner 2026-11-16),
 * and an account that needs to sign in again is listed but cannot be chosen. Run:
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

function html(accounts: readonly Account[]): string {
  return renderToStaticMarkup(
    createElement(FromRow, { accounts, accountId: 'a1', onChange: () => undefined }),
  );
}

test('one account: no From row at all', () => {
  assert.equal(html([A]), '');
});

test('two accounts: the current address is a menu button, for a reply as much as a new message', () => {
  const out = html([A, B]);
  assert.match(out, /<button[^>]*aria-haspopup="menu"/);
  assert.match(out, /alex@studio\.example/);
});

test('a missing current account falls back to its id, never a blank label', () => {
  const out = renderToStaticMarkup(
    createElement(FromRow, {
      accounts: [A, B],
      accountId: 'gone',
      onChange: () => undefined,
    }),
  );
  assert.match(out, />gone</);
});
