// Home's row layout is the one it had before UI council 2, with the council's keyboard cursor kept (owner review of #548).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const screens = readFileSync(new URL('../screens.css', import.meta.url), 'utf8');
const list = readFileSync(new URL('../../ui/list/list.css', import.meta.url), 'utf8');
const rule = (css: string, selector: string) =>
  css.match(new RegExp(`^${selector.replace(/[.[\]()*+?^$|]/g, '\\$&')} \\{[^}]*\\}`, 'm'))?.[0] ??
  '';

test('Home keeps its earlier edges: 16 px lead, the Home sender column, labels 12 px in, 20 px card inset', () => {
  const home = ".aplos-list-column[data-screen='home']";
  assert.match(rule(screens, `${home} .ui-list-row`), /var\(--space-4\) minmax/);
  assert.match(
    rule(list, ".ui-list-row[data-layout='home']"),
    /--ui-sender-w: var\(--sender-w-home\)/,
  );
  assert.match(rule(screens, `${home} .ui-section-header`), /padding: 0 var\(--space-3\)/);
  assert.match(rule(screens, `${home} .ui-focus-letter`), /padding-right: var\(--space-5\)/);
});

test('the keyboard cursor still holds the rows below: the card takes a row’s place and its meta line keeps its height', () => {
  assert.match(rule(list, '.ui-list-row + .ui-focus-slot'), /margin-top: var\(--space-1\)/);
  assert.match(rule(list, '.ui-focus-letter__meta'), /min-height: var\(--control-xs\)/);
});

test('no list reserves a chip slot: the due chip sits inline before the subject again', () => {
  assert.doesNotMatch(list, /--ui-due-slot|\.ui-list-row__due/);
});
