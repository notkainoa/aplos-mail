import test from 'node:test';
import assert from 'node:assert/strict';
import { accountColor } from './status-map';

test('an account with no colour tag gets the colour its position has in Settings → Accounts', () => {
  assert.equal(accountColor({ colorTag: 'ember' }, 0), 'ember');
  assert.equal(accountColor({ colorTag: undefined }, 0), 'sky');
  assert.equal(accountColor({ colorTag: undefined }, 1), 'hill');
  assert.equal(accountColor({ colorTag: 'not-a-tag' }, 7), 'hill');
  assert.equal(accountColor({ colorTag: undefined }), 'sky', 'no position: sky');
});
