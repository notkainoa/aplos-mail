import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('./surfaces.css', import.meta.url), 'utf8');

test('a tooltip next to an expanded button is hidden by a rule as specific as the one that shows it', () => {
  const show = 'html[data-real-pointer] .ui-part-tipwrap:hover > .ui-part-tip {';
  const hide =
    "html[data-real-pointer] .ui-part-tipwrap:hover > [aria-expanded='true'] + .ui-part-tip {";
  assert.ok(css.includes(show));
  assert.ok(css.includes(hide), 'same html[data-real-pointer] prefix, or the show rule wins');
  assert.ok(css.indexOf(hide) > css.indexOf(show), 'and it comes later');
});
