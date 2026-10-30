import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeRoute, getRoute, getScreen, setRoute, setScreen } from './store-route';

test('the screen starts on home and keeps its snapshot for an equal label view', () => {
  assert.equal(getScreen(), 'home');
  setScreen({ label: 'Receipts' });
  const first = getScreen();
  setScreen({ label: 'Receipts' });
  assert.equal(getScreen(), first);
  setScreen('home');
});

test('openRoute records the section and row, opens Settings, and fires again for the same row', () => {
  setRoute('settings/mail#undoSeconds');
  const first = getRoute();
  assert.equal(first?.section, 'mail');
  assert.equal(first?.row, 'undoSeconds');
  assert.equal(getScreen(), 'settings');
  setRoute('settings/mail#undoSeconds');
  assert.notEqual(getRoute()?.seq, first?.seq);
});

test('a bare section has no row; consuming clears only the route it was given', () => {
  setRoute('settings/ai');
  const pending = getRoute();
  assert.equal(pending?.row, undefined);
  consumeRoute((pending?.seq ?? 0) - 1);
  assert.ok(getRoute());
  consumeRoute(pending?.seq ?? 0);
  assert.equal(getRoute(), null);
  setScreen('home');
});

test('a route that does not parse changes nothing', () => {
  setRoute('settings/mail#undoSeconds');
  const before = getRoute();
  setRoute('settings/nowhere' as never);
  assert.equal(getRoute(), before);
  consumeRoute(before?.seq ?? 0);
  setScreen('home');
});
