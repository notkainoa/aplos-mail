// Run: npx tsx --tsconfig apps/desktop/tsconfig.json --test apps/desktop/src/renderer/ui/accountLabel.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountLabel } from './accountLabel';

test('the label is the address even when display names look alike', () => {
  const a = { name: 'Kainoa Newton', address: 'kainoa@example.com' };
  const b = { name: 'Kainoa', address: 'kainoa.work@example.org' };
  assert.equal(accountLabel(a), 'kainoa@example.com');
  assert.equal(accountLabel(b), 'kainoa.work@example.org');
  assert.notEqual(accountLabel(a), accountLabel(b));
});

test('an account with no address falls back to its name', () => {
  assert.equal(accountLabel({ name: 'Demo', address: '' }), 'Demo');
  assert.equal(accountLabel({ address: ' a@example.com ' }), 'a@example.com');
});
