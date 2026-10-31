import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT } from './helpers';
import { fact, read, world } from './drafts.ports.kit';

/**
 * The sender of a draft that came from another device (BINDING 3): the copy's sender is compared with the one the draft
 * goes out under (its `from`, else the account's own address `owner@mail.example`). The account's own address is the
 * absence of an explicit `from`.
 */

const ID = `${ACCOUNT}:rd-phone`;
const ALIAS = { address: 'alias@mail.example', name: 'Alias' };

const phoneDraft = (w: Parameters<typeof fact>[0], n: number, f: Parameters<typeof fact>[3]) =>
  fact(w, 'rd-phone', `pm-${n}`, {
    html: `<p>${n}</p>`,
    internetId: `<p${n}@phone.example>`,
    ...f,
  });

test('sender: a phone draft from an alias keeps it, and a display-name change of the same address is taken', () =>
  world(async w => {
    phoneDraft(w, 1, { from: ALIAS });
    assert.deepEqual(read(w, ID).from, ALIAS);
    phoneDraft(w, 2, { from: { address: 'ALIAS@mail.example', name: 'Alias B' } });
    const d = read(w, ID);
    assert.equal(d.html, '<p>2</p>', 'the edit arrived');
    assert.equal(d.from?.address, 'alias@mail.example', 'the same sender');
    assert.equal(d.from?.name, 'Alias B', 'with the new display name');
  }));

test('sender: a copy with no display name keeps ours', () =>
  world(async w => {
    phoneDraft(w, 1, { from: ALIAS });
    phoneDraft(w, 2, { from: { address: 'alias@mail.example' } });
    assert.deepEqual(read(w, ID).from, ALIAS);
  }));

test('sender: the phone switching back to the account address leaves no explicit sender', () =>
  world(async w => {
    phoneDraft(w, 1, { from: ALIAS });
    phoneDraft(w, 2, { from: { address: 'owner@mail.example', name: 'Owner' } });
    assert.equal(read(w, ID).from, undefined, 'it goes out from the account address again');
  }));

test('sender: the phone switching to another alias is taken', () =>
  world(async w => {
    phoneDraft(w, 1, { from: ALIAS });
    phoneDraft(w, 2, { from: { address: 'other@mail.example', name: 'Other' } });
    assert.equal(read(w, ID).from?.address, 'other@mail.example');
  }));

test('sender: a draft from the account address stays without an explicit sender through edits, any case and name', () =>
  world(async w => {
    phoneDraft(w, 1, {});
    phoneDraft(w, 2, { from: { address: 'OWNER@mail.example', name: 'Whoever' } });
    assert.equal(read(w, ID).from, undefined);
  }));
