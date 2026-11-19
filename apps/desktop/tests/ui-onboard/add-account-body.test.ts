// The shell's Add account dialog (`shell/AddAccountHost`) draws the onboarding lane's `AccountsBody` inside its
// own `Dialog` frame instead of a second copy of the connect content: the body's markup sits verbatim inside the
// dialog for every state, the dialog's announcements are unchanged (one live region, `add-account-line`, the
// field's own error for a refused address), and the shell file no longer defines its own address block.
// Run: cd apps/desktop && npx tsx --test tests/ui-onboard/add-account-body.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountsBody, type AccountsBodyProps } from '../../src/renderer/onboarding/steps/Accounts';
import { AddAccountView, type AddAccountViewProps } from '../../src/renderer/shell/AddAccountHost';

const noop = () => {};

const view = (over: Partial<AddAccountViewProps> = {}) =>
  renderToStaticMarkup(
    createElement(AddAccountView, {
      mode: 'choose',
      address: 'jordan.lee@example.com',
      notice: null,
      failure: null,
      onEdit: noop,
      onSubmit: noop,
      onConnect: noop,
      onChooseGoogle: noop,
      onCancel: noop,
      onClear: noop,
      onClose: noop,
      ...over,
    }),
  );

const body = (over: Partial<AccountsBodyProps> = {}) =>
  renderToStaticMarkup(
    createElement(AccountsBody, {
      mode: 'choose',
      address: 'jordan.lee@example.com',
      notice: null,
      failure: null,
      accounts: [],
      onEdit: noop,
      onSubmit: noop,
      onChooseGoogle: noop,
      liveLineId: 'add-account-line',
      ...over,
    }),
  );

const liveRegions = (html: string) => (html.match(/role="(?:status|alert)"/g) ?? []).length;

describe('AddAccountView contains the exact AccountsBody markup in every connect state', () => {
  test('choose, discovering, typed and failed draw the body verbatim; connected draws nothing', () => {
    for (const state of [
      { mode: 'choose' as const },
      { mode: 'choose' as const, notice: 'unsupported' as const },
      { mode: 'discovering' as const },
      { mode: 'typed' as const },
      { mode: 'failed' as const, failure: 'auth.denied' },
    ]) {
      assert.ok(view(state).includes(body(state)), `mode ${state.mode} ${state.notice ?? ''}`);
    }
    assert.equal(view({ mode: 'connected' }), '');
  });

  test("waiting draws the body's track under the dialog's own wait line", () => {
    const html = view({ mode: 'waiting' });
    assert.ok(html.includes(body({ mode: 'waiting' })));
    assert.match(
      html,
      /<p class="aplos-add-account__wait" role="status">Waiting for Google in your browser…<\/p>/,
    );
  });
});

describe("the dialog keeps its announcements on the body's own structure", () => {
  test('a notice or failed connect is the one live region inside the field block, with the line id', () => {
    const noticed = view({ notice: 'unsupported' });
    assert.match(noticed, /<div class="onb-field-block">/);
    assert.equal(liveRegions(noticed), 1);
    assert.match(noticed, /<div id="add-account-line" role="status"><p class="ui-text"/);
    const failed = view({ mode: 'failed', failure: 'auth.denied' });
    assert.match(failed, /<div class="onb-field-block">/);
    assert.equal(liveRegions(failed), 1);
    assert.match(failed, /<div id="add-account-line" role="status"><div class="ui-error-line"/);
  });

  test("a refused address is the field's own error, still exactly one live region", () => {
    const invalid = view({ notice: 'invalid' });
    assert.match(invalid, /<div class="onb-field-block">/);
    assert.equal(liveRegions(invalid), 1);
    assert.match(invalid, /aria-invalid="true"/);
    assert.match(invalid, /<p id="onb-address-error"[^>]*role="status"/);
    assert.doesNotMatch(invalid, /add-account-line/);
  });

  test("the provider rows carry the lane's ids, not a dialog copy", () => {
    assert.ok(view().includes('id="onb-provider-google"'));
    assert.ok(view({ mode: 'typed' }).includes('id="onb-found-google"'));
    assert.doesNotMatch(view(), /add-account-google|add-account-found-google/);
  });
});

describe('AddAccountHost no longer defines its own copy of the connect content', () => {
  const source = readFileSync(
    new URL('../../src/renderer/shell/AddAccountHost.tsx', import.meta.url),
    'utf8',
  );

  test('it imports AccountsBody from the onboarding lane', () => {
    assert.match(source, /import \{ AccountsBody \} from '\.\.\/onboarding\/steps\/Accounts';/);
  });

  test('it has no address block, under-line or field of its own', () => {
    assert.doesNotMatch(source, /AddressBlock|UnderLine|underOf|useDescribedBy/);
    assert.doesNotMatch(source, /<TextField|<ChoiceRow|<ErrorLine|<ProgressSegments/);
    assert.doesNotMatch(source, /add-account-google|add-account-found-google/);
  });
});
