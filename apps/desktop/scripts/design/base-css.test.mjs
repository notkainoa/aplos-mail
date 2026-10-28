// Guards ui/base.css: the generator writes sizes as px/16 rem (DESIGN 11.6),
// which only holds while the root keeps the platform's 16px. A font or
// font-size on html or :root (e.g. `font: var(--type-base)`, which is 14px)
// would shrink every rem token by the same ratio while px tokens stay put.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

const BASE_CSS = fileURLToPath(new URL('../../src/renderer/ui/base.css', import.meta.url));
const ROOT_SELECTOR = /^(?:html|:root)(?![\w-])/i;
const ROOT_FONT = /^(?:font|font-size)$/i;

// Declarations that set the root font size, as "selector { prop }" strings.
export function rootFontDeclarations(css) {
  const found = [];
  postcss.parse(css).walkRules(rule => {
    const selectors = rule.selectors.map(s =>
      s
        .trim()
        .replace(/^:where\((.*)\)$/i, '$1')
        .trim(),
    );
    if (!selectors.some(s => ROOT_SELECTOR.test(s) && !/\s/.test(s))) {
      return;
    }
    rule.walkDecls(decl => {
      if (ROOT_FONT.test(decl.prop) && decl.value.trim() !== '100%') {
        found.push(`${rule.selector} { ${decl.prop} }`);
      }
    });
  });
  return found;
}

test('base.css leaves the root font size alone, so 1rem is 16px', () => {
  assert.deepEqual(rootFontDeclarations(readFileSync(BASE_CSS, 'utf8')), []);
});

test('base.css puts the base type on body', () => {
  const css = readFileSync(BASE_CSS, 'utf8');
  let found = false;
  postcss.parse(css).walkRules('body', rule => {
    rule.walkDecls('font', decl => {
      found ||= decl.value === 'var(--type-base)';
    });
  });
  assert.ok(found, 'body { font: var(--type-base) } is missing from base.css');
});

test('a root font or font-size is caught; 100% and descendants are not', () => {
  assert.deepEqual(rootFontDeclarations('html { font: var(--type-base); }'), ['html { font }']);
  assert.deepEqual(rootFontDeclarations(':root, body { font-size: 14px; }'), [
    ':root, body { font-size }',
  ]);
  assert.deepEqual(rootFontDeclarations(":root[data-theme='dark'] { font-size: 0.875rem; }"), [
    ":root[data-theme='dark'] { font-size }",
  ]);
  assert.deepEqual(rootFontDeclarations('html { font-size: 100%; color: red; }'), []);
  assert.deepEqual(
    rootFontDeclarations('html body { font: var(--type-base); } body { font: var(--type-base); }'),
    [],
  );
});

test('::selection sets only the opaque tint and ink, so fills cannot drop selected text under 4.5', () => {
  const decls = {};
  postcss.parse(readFileSync(BASE_CSS, 'utf8')).walkRules('::selection', rule => {
    rule.walkDecls(decl => {
      decls[decl.prop] = decl.value;
    });
  });
  assert.deepEqual(decls, { 'background-color': 'var(--selection)', color: 'var(--ink)' });
});

test('balance comes after pretty, so a display or heading line written as <p> balances', () => {
  const order = [];
  postcss.parse(readFileSync(BASE_CSS, 'utf8')).walkDecls('text-wrap', decl => {
    order.push([decl.value, decl.parent.selector]);
  });
  const balance = order.findIndex(([value]) => value === 'balance');
  const pretty = order.findIndex(([value]) => value === 'pretty');
  assert.ok(pretty >= 0 && balance > pretty, 'the balance rule must follow the pretty rule');
  const selector = order[balance][1].replaceAll("'", '"');
  for (const hook of [
    'h1',
    '.ui-display',
    '.ui-heading',
    '.ui-text[data-variant="display"]',
    '.ui-text[data-variant="heading"]',
  ]) {
    assert.ok(selector.includes(hook), `balance lacks ${hook}`);
  }
});
