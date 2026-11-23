// Run: npx tsx --tsconfig apps/desktop/tsconfig.json --test apps/desktop/src/renderer/spelling.test.ts
// The owner is American: user-visible renderer strings use US spelling. This reads string literals only, so
// identifiers, CSS classes and data attributes (accountColour, data-minimised) are left alone. It also reads plain
// JSX text between tags on one line (<b>Colour</b>); text that wraps over several lines is not scanned.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Stems, so every inflection is caught: organis(e|ed|ing|ation), recognis(e|ed|ing), colour(s|ed), cancell(ed|ing).
// Case-sensitive after the first letter, so a camelCase name like `cancelLabel` in a template is not a word.
const STEMS = [
  'colour',
  'minimis',
  'behaviour',
  'organis',
  'recognis',
  'favour',
  'honour',
  'cancell',
  'licence',
  'grey',
  'centre',
  'customis',
  'personalis',
  'normalis',
  'authoris',
  'summaris',
  'analyse',
  'programme',
  'dialogue',
  'catalogue',
];
const BRITISH = new RegExp(
  `\\b(?:${STEMS.map(stem => `[${stem[0]!.toUpperCase()}${stem[0]}]${stem.slice(1)}`).join('|')})[a-z]*\\b`,
);
const SKIP_DIRS = new Set(['generated', 'node_modules', 'mailframe']);
const root = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(path);
    const isSource = /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name);
    return isSource ? [path] : [];
  });
}

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** A literal reads as words when it has a space, or is one capitalized word or exactly one of the plain words. */
function readsAsCopy(literal: string): boolean {
  if (/\s/.test(literal)) return true;
  return /^[A-Z][a-z]+$/.test(literal) || /^(colours?|greys?)$/.test(literal);
}

/** Plain words between JSX tags on one line, such as `>Account colour<`. */
function jsxTexts(text: string): string[] {
  return [...text.matchAll(/>([A-Za-z][A-Za-z ,.'’-]*)</g)].map(m => m[1] ?? '');
}

function offenders(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(root)) {
    const text = withoutComments(readFileSync(file, 'utf8'));
    for (const literal of file.endsWith('.tsx') ? jsxTexts(text) : []) {
      const word = BRITISH.exec(literal)?.[0];
      if (word)
        found.push(`${file.slice(root.length)}: "${word}" in JSX text ${JSON.stringify(literal)}`);
    }
    for (const match of text.matchAll(
      /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g,
    )) {
      const literal = match[1] ?? match[2] ?? match[3] ?? '';
      const word = readsAsCopy(literal) ? BRITISH.exec(literal)?.[0] : undefined;
      if (word)
        found.push(
          `${file.slice(root.length)}: "${word}" in ${JSON.stringify(literal.slice(0, 60))}`,
        );
    }
  }
  return found;
}

test('user-visible renderer strings use US spelling', () => {
  assert.deepEqual(offenders(), []);
});

test('the pattern catches the British forms and passes the US ones', () => {
  assert.ok(BRITISH.test('Account colour'));
  assert.ok(!BRITISH.test('Account color'));
  assert.ok(BRITISH.test('Sign-in was cancelled.') && !BRITISH.test('Sign-in was canceled.'));
  for (const word of [
    'organising',
    'recognising',
    'customising',
    'personalising',
    'normalising',
    'authorising',
    'favour',
    'honour',
    'analyse',
    'programme',
    'dialogue',
    'catalogue',
  ]) {
    assert.ok(BRITISH.test(`the ${word} here`), word);
  }
  assert.deepEqual(jsxTexts('<b>Account colour</b><i>{x}</i>'), ['Account colour']);
});
