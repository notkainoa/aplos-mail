// The Add account sheet: the shell's one-at-a-time sheet store and the dialog's states (server render, no DOM).
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AddAccountView, type AddAccountViewProps } from './AddAccountHost';
import { closeSheet, openAddAccount, openSheet, registerSheetCancel } from './index';
import { getSheet } from './store-sheet';
import { accountEntries } from './AccountMenu';
import { emptyText } from './states';

afterEach(() => {
  closeSheet();
});

const noop = () => {};
const base: AddAccountViewProps = {
  mode: 'choose',
  address: '',
  notice: null,
  failure: null,
  onEdit: noop,
  onSubmit: noop,
  onConnect: noop,
  onChooseGoogle: noop,
  onCancel: noop,
  onClear: noop,
  onClose: noop,
};
const html = (over: Partial<AddAccountViewProps>) =>
  renderToStaticMarkup(<AddAccountView {...base} {...over} />);

test('openAddAccount opens the addAccount sheet once, and closeSheet closes it', () => {
  openAddAccount();
  const first = getSheet();
  assert.equal(first?.name, 'addAccount');
  openAddAccount();
  assert.equal(getSheet(), first);
  closeSheet();
  assert.equal(getSheet(), null);
});

test('another sheet replaces the Add account sheet and cancels it', () => {
  const cancelled: string[] = [];
  const off = registerSheetCancel(sheet => cancelled.push(sheet.name));
  openAddAccount();
  openSheet('consent');
  off();
  assert.deepEqual(cancelled, ['addAccount']);
  assert.equal(getSheet()?.name, 'consent');
});

test('the choose state has the address field, the Google row and Cancel, and no filled button', () => {
  const out = html({});
  assert.match(out, /Add an account/);
  assert.match(out, /placeholder="name@example.com"/);
  assert.match(out, /Or choose a provider/);
  assert.match(out, />Cancel</);
  assert.doesNotMatch(out, /Continue with Google/);
});

test('a typed Google address offers Continue with Google as the one filled button', () => {
  const out = html({ mode: 'typed', address: 'alex@gmail.com' });
  assert.match(out, /Continue with Google/);
  assert.match(out, /Use a different address/);
  assert.match(out, /Found/);
  assert.equal((out.match(/data-variant="filled"/g) ?? []).length, 1);
});

test('waiting says so and offers Cancel; failed says why and offers Try again', () => {
  const waiting = html({ mode: 'waiting' });
  assert.match(waiting, /Waiting for Google in your browser…/);
  assert.match(waiting, />Cancel</);
  const failed = html({ mode: 'failed', failure: 'auth.denied', address: 'alex@gmail.com' });
  assert.match(failed, /Try again/);
  assert.match(failed, /role="alert"|ui-error-line/);
});

test('an unsupported address says so in words', () => {
  assert.match(html({ notice: 'unsupported' }), /Google accounts in this version/);
});

test('the switcher menu still ends with Add an account, and the empty copy is unchanged', () => {
  const entries = accountEntries([], noop);
  const last = entries.at(-1);
  assert.equal(last?.kind === 'item' ? last.label : undefined, 'Add an account');
  assert.equal(emptyText('later'), 'Nothing set aside for later.');
});
