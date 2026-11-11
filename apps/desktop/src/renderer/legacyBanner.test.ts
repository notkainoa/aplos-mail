// The legacy renderer's banner (legacyBanner.ts): present on a legacy boot, absent on every other. The boot itself needs
// Electron, so the wiring is read from main.tsx's source, the way tests/ui-onboard/review3.test.ts reads boot().
// Run: cd apps/desktop && npx tsx --test src/renderer/legacyBanner.test.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  LEGACY_BANNER_ID,
  LEGACY_BANNER_TEXT,
  mountLegacyBanner,
  type BannerDocument,
} from './legacyBanner';

interface FakeNode {
  id: string;
  textContent: string | null;
  attrs: Record<string, string>;
  setAttribute(name: string, value: string): void;
}

function fakeDocument() {
  const nodes: FakeNode[] = [];
  const head: FakeNode[] = [];
  const bodyAttrs: Record<string, string> = {};
  const make = (): FakeNode => ({
    id: '',
    textContent: null,
    attrs: {},
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
  });
  const doc: BannerDocument = {
    getElementById: id => [...head, ...nodes].find(node => node.id === id) ?? null,
    createElement: () => make(),
    head: { append: node => void head.push(node as FakeNode) },
    body: {
      prepend: node => void nodes.unshift(node as FakeNode),
      setAttribute: (name, value) => void (bodyAttrs[name] = value),
    },
  };
  return { doc, nodes, head, bodyAttrs };
}

test('the banner is one plain-English status line at the top of the page, added once', () => {
  const page = fakeDocument();
  assert.equal(mountLegacyBanner(page.doc), true);
  assert.equal(page.nodes.length, 1);
  const banner = page.nodes[0]!;
  assert.equal(banner.id, LEGACY_BANNER_ID);
  assert.equal(banner.attrs['role'], 'status');
  assert.equal(
    banner.textContent,
    'This is the old version of Aplos. Start the app with APLOS_ENGINE=real to see the new one.',
  );
  assert.equal(LEGACY_BANNER_TEXT, banner.textContent);
  assert.equal(page.head.length, 1, 'one style element');
  assert.equal(page.bodyAttrs['data-legacy-banner'], '');
  assert.equal(mountLegacyBanner(page.doc), false, 'a second call adds nothing');
  assert.equal(page.nodes.length, 1);
  assert.equal(page.head.length, 1);
});

test('the banner styles use the legacy tokens only: no colour of its own, no sparkle', () => {
  const page = fakeDocument();
  mountLegacyBanner(page.doc);
  const css = page.head[0]!.textContent ?? '';
  assert.doesNotMatch(css.replace(`#${LEGACY_BANNER_ID}`, ''), /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(css, /rgba?\(|hsl/);
  assert.doesNotMatch(`${css}${LEGACY_BANNER_TEXT}`, /[✨✦★☆⭐🪄]/u);
  assert.match(css, /background: var\(--raised\)/);
  assert.match(css, /\.app-shell/, 'the legacy shell gives up the banner height');
});

/** The text of `async function <name>(` up to the next top-level `async function`, `function` or `if (entry`. */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is in main.tsx`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n(?:async function|function|if \(entry|\/\*\*)/);
  return source.slice(start, start + 1 + (next < 0 ? rest.length : next));
}

test('only bootLegacy mounts the banner; the new roots (real engine or stand-in) never do', () => {
  const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
  assert.match(bodyOf(main, 'bootLegacy'), /mountLegacyBanner\(\)/);
  for (const name of ['boot', 'bootOnboarding', 'serveClose', 'serveNavigate', 'connectEngine'])
    assert.doesNotMatch(bodyOf(main, name), /mountLegacyBanner/, `${name} does not mount it`);
  assert.equal(main.match(/mountLegacyBanner\(/g)?.length, 1, 'one call site in all of main.tsx');
});
