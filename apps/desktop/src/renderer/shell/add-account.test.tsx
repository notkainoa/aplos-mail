// The Add account sheet: the shell's one-at-a-time sheet store and the dialog's states (server render, no DOM).
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AddAccountView, type AddAccountViewProps } from './AddAccountHost';
import { closeSheet, openAddAccount, openSheet, registerSheetCancel, useAddAccount } from './index';
import { FOCUS_IDS, addAccountFocusId } from './add-account-controller';
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
  assert.match(out, /Add account/);
  assert.match(out, /placeholder="name@example.com"/);
  assert.doesNotMatch(out, /Or choose a provider/, 'one provider row needs no label');
  assert.match(out, /Google/);
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

const liveRegions = (out: string) => (out.match(/role="(?:status|alert)"/g) ?? []).length;

test('waiting says so, offers Cancel and has exactly one live region', () => {
  const waiting = html({ mode: 'waiting' });
  assert.match(waiting, /Waiting for Google in your browser…/);
  assert.match(waiting, />Cancel</);
  assert.equal(liveRegions(waiting), 1);
});

test('failed says why in one status line, keeps the field valid and offers Try again', () => {
  const failed = html({ mode: 'failed', failure: 'auth.denied', address: 'alex@gmail.com' });
  assert.match(failed, /Try again/);
  assert.equal(liveRegions(failed), 1);
  assert.match(failed, /<div id="add-account-line" role="status"><div class="ui-error-line"/);
  assert.match(failed, /Google sign-in was declined/);
  assert.doesNotMatch(failed, /aria-invalid/);
  assert.doesNotMatch(failed, /ui-text-field-error/);
  assert.doesNotMatch(failed, /auth\.denied/);
});

test('a notice is one calm ink-2 status line under a valid field, and none without a notice', () => {
  const noticed = html({ notice: 'unsupported' });
  assert.equal(liveRegions(noticed), 1);
  assert.match(noticed, /<div id="add-account-line" role="status"><p class="ui-text"/);
  assert.match(noticed, /data-tone="ink-2"/);
  assert.doesNotMatch(noticed, /aria-invalid/);
  assert.equal(liveRegions(html({ notice: 'unchecked' })), 1);
  assert.equal(liveRegions(html({})), 0);
});

test('only an invalid address flags the field, through the field’s own single status', () => {
  const invalid = html({ notice: 'invalid' });
  assert.equal(liveRegions(invalid), 1);
  assert.match(invalid, /aria-invalid="true"/);
  assert.match(invalid, /aria-describedby="onb-address-error"/);
  assert.match(invalid, /<p id="onb-address-error"[^>]*role="status"/);
  assert.doesNotMatch(invalid, /add-account-line/);
});

test('each mode names its own primary control, and the markup has it', () => {
  assert.equal(addAccountFocusId('choose'), 'onb-address');
  assert.equal(addAccountFocusId('discovering'), 'onb-address');
  assert.equal(addAccountFocusId('typed'), FOCUS_IDS.continue);
  assert.equal(addAccountFocusId('waiting'), FOCUS_IDS.cancel);
  assert.equal(addAccountFocusId('failed'), FOCUS_IDS.retry);
  assert.equal(addAccountFocusId('connected'), undefined);
  const ids = [FOCUS_IDS.continue, FOCUS_IDS.cancel, FOCUS_IDS.retry];
  assert.equal(new Set(ids).size, 3);
  const modes = ['choose', 'typed', 'waiting', 'failed'] as const;
  for (const mode of modes) {
    const id = addAccountFocusId(mode);
    assert.match(html({ mode, address: 'a@b.co' }), new RegExp(`id="${id}"`), mode);
  }
});

test('a connected flow draws nothing, so the choose body never flashes before the sheet closes', () => {
  assert.equal(html({ mode: 'connected' }), '');
});

test('useAddAccount follows the open sheet', () => {
  const Probe = () => <i>{String(useAddAccount())}</i>;
  assert.match(renderToStaticMarkup(<Probe />), />false</);
  openAddAccount();
  assert.match(renderToStaticMarkup(<Probe />), />true</);
});

test('an unsupported address says so in words', () => {
  assert.match(html({ notice: 'unsupported' }), /Google accounts in this version/);
});

test('the switcher menu still ends with Add an account, and the empty copy is unchanged', () => {
  const entries = accountEntries([], noop);
  const last = entries.at(-1);
  assert.equal(last?.kind === 'item' ? last.label : undefined, 'Add account');
  assert.equal(emptyText('later'), 'Nothing set aside for later');
});
