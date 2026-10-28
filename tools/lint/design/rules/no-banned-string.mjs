// DESIGN 2.3 check 6, 9 rule 8, 10 and 13: the phrases that echo Avec or an
// assistant's voice are banned in user-visible copy, and copy has no
// exclamation marks. Only copy positions are scanned, so identifiers and code
// strings are never flagged.

import ts from 'typescript';
import { nameOfProperty, positionOf, valueLeaves, visit } from '../lib/ast.mjs';
import { collectDecls } from '../lib/decls.mjs';
import { violation } from '../lib/context.mjs';
import { parseValue, walkNodes } from '../lib/value.mjs';

export const id = 'no-banned-string';
export const description = 'Banned phrases (DESIGN 10 and 13) and exclamation marks in JSX text, JSX string props, copy-named object properties and CSS content.';
export const appliesTo = ['css', 'ts'];

export const BANNED_PHRASES = [
  'Swipe through them', 'Hold to talk', 'Hold Space to talk', 'Tap to write', 'Hide all', 'Todo',
  'Todos', 'Be here now', 'Sent with', 'Ask me anything', 'magic', 'AI-powered', 'AI powered',
  'Copilot', 'Ready when you are', 'Waiting on you', 'No reply yet', 'All clear for now',
  'Making room for your mail', 'Aplos needs a moment', "Couldn't summarize this email",
  'Your day beside your mail', 'A comfortable place for your mail', 'Make light work of your inbox',
  'A little less inbox', 'Aplos is ready when your day begins', 'Skypaper', 'Airmail', 'par avion',
];

function escapeRegExp(text) {
  return text.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&');
}

const PHRASE_PATTERNS = BANNED_PHRASES.map((phrase) => ({
  phrase,
  pattern: new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegExp(phrase).replace(/ /g, '\\s+').replace(/'/g, "['\\u2019]")}(?![\\p{L}\\p{N}_])`,
    'iu',
  ),
}));

const ALONE_LABELS = /^\s*(smart|beta)\s*$/i;

// Object properties whose string values are copy.
const COPY_KEYS = new Set([
  'label', 'title', 'description', 'placeholder', 'ariaLabel', 'hint', 'tooltip', 'message',
  'copy', 'text', 'subtitle', 'caption', 'heading', 'aria-label', 'aria-description',
]);

// JSX props that are always copy, even when the value is one lowercase word.
const COPY_PROPS = new Set([
  'aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext',
  'title', 'placeholder', 'label', 'alt', 'description', 'hint', 'tooltip', 'message', 'text',
  'caption', 'heading', 'subtitle',
]);

// JSX props that carry identifiers, URLs or styling, never copy.
const CODE_PROPS = new Set([
  'className', 'class', 'id', 'key', 'ref', 'style', 'htmlFor', 'for', 'type', 'name', 'role',
  'href', 'src', 'srcSet', 'rel', 'target', 'to', 'variant', 'size', 'tone', 'kind', 'as', 'd',
  'points', 'fill', 'stroke', 'viewBox', 'xmlns', 'transform', 'tabIndex', 'autoComplete',
  'inputMode', 'pattern', 'accept', 'method', 'lang', 'dir', 'slot', 'value', 'icon', 'shortcut',
  'command', 'commandId', 'testId',
]);

function isCodeProp(name) {
  if (COPY_PROPS.has(name)) return false;
  if (CODE_PROPS.has(name)) return true;
  if (/^data-/.test(name) || /^on[A-Z]/.test(name)) return true;
  return /^aria-/.test(name);
}

function looksLikeCode(text) {
  const trimmed = text.trim();
  if (/^[a-z0-9_.:/#?=&%-]+$/.test(trimmed)) return true;
  return /^[a-z]+[A-Z]\w*$/.test(trimmed);
}

function copyProblems(text) {
  const normalised = text.replace(/\u2019/g, "'");
  const problems = [];
  for (const { phrase, pattern } of PHRASE_PATTERNS) {
    if (pattern.test(normalised)) problems.push(`banned phrase "${phrase}" (DESIGN 10)`);
  }
  if (ALONE_LABELS.test(normalised)) problems.push(`"${normalised.trim()}" alone as a label (DESIGN 9 rule 8)`);
  if (normalised.includes('!')) problems.push('an exclamation mark (DESIGN 10: no exclamation marks)');
  return problems;
}

function jsxAttributeLeaves(sf, attribute) {
  const initializer = attribute.initializer;
  if (!initializer) return [];
  if (ts.isStringLiteral(initializer)) return [{ text: initializer.text, node: initializer }];
  if (ts.isJsxExpression(initializer) && initializer.expression) return valueLeaves(initializer.expression, sf);
  return [];
}

function tsChecks(ctx, out) {
  const { sf } = ctx;
  const report = (node, problems, where) => {
    const at = positionOf(sf, node);
    for (const problem of problems) out.push(violation(at.line, at.column, `${where} contains ${problem}.`));
  };
  visit(sf, (node) => {
    if (ts.isJsxText(node)) {
      if (node.text.trim()) report(node, copyProblems(node.text), 'JSX text');
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText();
      if (isCodeProp(name)) return;
      for (const leaf of jsxAttributeLeaves(sf, node)) {
        if (!COPY_PROPS.has(name) && looksLikeCode(leaf.text)) continue;
        report(node, copyProblems(leaf.text), `Prop ${name}`);
      }
    } else if (ts.isJsxExpression(node) && node.expression && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      for (const leaf of valueLeaves(node.expression, sf)) report(node, copyProblems(leaf.text), 'JSX child');
    } else if (ts.isPropertyAssignment(node)) {
      const key = nameOfProperty(node.name);
      if (!key || !COPY_KEYS.has(key)) return;
      for (const leaf of valueLeaves(node.initializer, sf)) report(node, copyProblems(leaf.text), `Property ${key}`);
    }
  });
}

function cssChecks(ctx, out) {
  for (const decl of collectDecls(ctx)) {
    if (decl.prop !== 'content') continue;
    walkNodes(parseValue(decl.value), (node) => {
      if (node.type !== 'string') return true;
      for (const problem of copyProblems(node.text)) {
        out.push(violation(decl.line, decl.column, `CSS content contains ${problem}.`, decl.node));
      }
      return true;
    });
  }
}

export function check(ctx) {
  const out = [];
  if (ctx.kind === 'css') cssChecks(ctx, out);
  else tsChecks(ctx, out);
  return out;
}

export default { id, description, appliesTo, check };
