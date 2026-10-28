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
export const description =
  'Banned phrases (DESIGN 10 and 13) and exclamation marks in JSX text, JSX string props, copy-named object properties and CSS content.';
export const appliesTo = ['css', 'ts'];

export const BANNED_PHRASES = [
  'Swipe through them',
  'Hold to talk',
  'Hold Space to talk',
  'Tap to write',
  'Hide all',
  'Todo',
  'Todos',
  'Be here now',
  'Sent with',
  'Ask me anything',
  'magic',
  'AI-powered',
  'AI powered',
  'Copilot',
  'Ready when you are',
  'Waiting on you',
  'No reply yet',
  'All clear for now',
  'Making room for your mail',
  'Aplos needs a moment',
  "Couldn't summarize this email",
  'Your day beside your mail',
  'A comfortable place for your mail',
  'Make light work of your inbox',
  'A little less inbox',
  'Aplos is ready when your day begins',
  'Skypaper',
  'Airmail',
  'par avion',
];

function escapeRegExp(text) {
  return text.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&');
}

const PHRASE_PATTERNS = BANNED_PHRASES.map(phrase => ({
  phrase,
  pattern: new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegExp(phrase).replace(/ /g, '\\s+').replace(/'/g, "['\\u2019]")}(?![\\p{L}\\p{N}_])`,
    'iu',
  ),
}));

const ALONE_LABELS = /^\s*(smart|beta)\s*$/i;

// Object properties whose string values are copy: the last word of the key
// decides, so label, emptyLabel, confirm_label and aria-label all count while
// context and labelledBy do not.
const COPY_WORDS = new Set([
  'label',
  'title',
  'description',
  'placeholder',
  'hint',
  'tooltip',
  'message',
  'copy',
  'text',
  'subtitle',
  'caption',
  'heading',
  'headline',
  'summary',
  'blurb',
  'prompt',
]);

export function isCopyKey(key) {
  const words = key
    .split(/[-_.]+/)
    .flatMap(part => part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) || []);
  const last = words[words.length - 1];
  return Boolean(last) && COPY_WORDS.has(last.toLowerCase());
}

// DOM properties and calls that write copy the user sees.
const COPY_WRITES = new Set(['textContent', 'innerText', 'innerHTML', 'nodeValue', 'title', 'alt']);

// Helpers whose arguments are copy, so an exclamation mark there fails too.
const COPY_CALLS =
  /^(toast|notify|notice|announce|alert|confirm|prompt|group|titled|heading|say|speak|showToast|pushToast|addToast|setTitle|setMessage|setLabel|setStatus|success|error|warning|info)$/i;

// Calls that take identifiers, keys, selectors or log text, never copy.
const CODE_CALLS = new Set([
  'require',
  'import',
  'Symbol',
  'String',
  'Number',
  'Boolean',
  'parseInt',
  'parseFloat',
  'log',
  'warn',
  'debug',
  'trace',
  'getItem',
  'setItem',
  'removeItem',
  'querySelector',
  'querySelectorAll',
  'getElementById',
  'closest',
  'matches',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'createElement',
  'getAttribute',
  'hasAttribute',
  'removeAttribute',
  'includes',
  'startsWith',
  'endsWith',
  'indexOf',
  'lastIndexOf',
  'split',
  'replace',
  'replaceAll',
  'test',
  'match',
  'matchAll',
  'localeCompare',
  'join',
  'padStart',
  'padEnd',
  'charAt',
  'has',
  'get',
  'set',
  'add',
  'delete',
  'remove',
  'toggle',
  'contains',
  'invoke',
  'handle',
  'on',
  'off',
  'once',
  'emit',
  'send',
  'cx',
  'clsx',
  'classNames',
  'cn',
  'describe',
  'it',
  'expect',
  'assert',
  'equal',
  'format',
  'RegExp',
  'Error',
  'createContext',
  'useState',
  'useRef',
  'lazy',
  'memo',
  'forwardRef',
  'fetch',
  'open',
  'getComputedStyle',
  'setProperty',
  'getPropertyValue',
  'animate',
  'matchMedia',
  'toLocaleString',
]);

// JSX props that are always copy, even when the value is one lowercase word.
const COPY_PROPS = new Set([
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'title',
  'placeholder',
  'label',
  'alt',
  'description',
  'hint',
  'tooltip',
  'message',
  'text',
  'caption',
  'heading',
  'subtitle',
]);

// JSX props that carry identifiers, URLs or styling, never copy.
const CODE_PROPS = new Set([
  'className',
  'class',
  'id',
  'key',
  'ref',
  'style',
  'htmlFor',
  'for',
  'type',
  'name',
  'role',
  'href',
  'src',
  'srcSet',
  'rel',
  'target',
  'to',
  'variant',
  'size',
  'tone',
  'kind',
  'as',
  'd',
  'points',
  'fill',
  'stroke',
  'viewBox',
  'xmlns',
  'transform',
  'tabIndex',
  'autoComplete',
  'inputMode',
  'pattern',
  'accept',
  'method',
  'lang',
  'dir',
  'slot',
  'value',
  'icon',
  'shortcut',
  'command',
  'commandId',
  'testId',
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

function calleeName(call) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return '';
}

function isConsoleCall(call) {
  return /^console\./.test(call.expression.getText());
}

function copyProblems(text) {
  const normalised = text.replace(/\u2019/g, "'");
  const problems = [];
  for (const { phrase, pattern } of PHRASE_PATTERNS) {
    if (pattern.test(normalised)) problems.push(`banned phrase "${phrase}" (DESIGN 10)`);
  }
  if (ALONE_LABELS.test(normalised))
    problems.push(`"${normalised.trim()}" alone as a label (DESIGN 9 rule 8)`);
  if (normalised.includes('!'))
    problems.push('an exclamation mark (DESIGN 10: no exclamation marks)');
  return problems;
}

function jsxAttributeLeaves(sf, attribute) {
  const initializer = attribute.initializer;
  if (!initializer) return [];
  if (ts.isStringLiteral(initializer)) return [{ text: initializer.text, node: initializer }];
  if (ts.isJsxExpression(initializer) && initializer.expression)
    return valueLeaves(initializer.expression, sf);
  return [];
}

function tsChecks(ctx, out) {
  const { sf } = ctx;
  const report = (node, problems, where) => {
    const at = positionOf(sf, node);
    for (const problem of problems)
      out.push(violation(at.line, at.column, `${where} contains ${problem}.`));
  };
  visit(sf, node => {
    if (ts.isJsxText(node)) {
      if (node.text.trim()) report(node, copyProblems(node.text), 'JSX text');
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText();
      if (isCodeProp(name)) return;
      for (const leaf of jsxAttributeLeaves(sf, node)) {
        if (!COPY_PROPS.has(name) && looksLikeCode(leaf.text)) continue;
        report(node, copyProblems(leaf.text), `Prop ${name}`);
      }
    } else if (
      ts.isJsxExpression(node) &&
      node.expression &&
      node.parent &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      for (const leaf of valueLeaves(node.expression, sf))
        report(node, copyProblems(leaf.text), 'JSX child');
    } else if (ts.isPropertyAssignment(node)) {
      const key = nameOfProperty(node.name);
      if (!key || !isCopyKey(key)) return;
      for (const leaf of valueLeaves(node.initializer, sf))
        report(node, copyProblems(leaf.text), `Property ${key}`);
    } else if (ts.isCallExpression(node)) {
      callChecks(sf, node, report);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      assignmentChecks(sf, node, report);
    }
  });
}

function setAttributeCopy(call) {
  if (calleeName(call) !== 'setAttribute' || call.arguments.length < 2) return false;
  const first = call.arguments[0];
  return ts.isStringLiteral(first) && (isCopyKey(first.text) || COPY_WRITES.has(first.text));
}

// Copy handed to a helper: toast('...'), window.confirm('...'), group('...', rows).
// Every string argument is read unless it looks like code. Phrases fail in any
// call that is not a known code call; an exclamation mark fails in copy helpers
// and in strings that read as a sentence.
function callChecks(sf, call, report) {
  const name = calleeName(call);
  if (isConsoleCall(call) || (CODE_CALLS.has(name) && !setAttributeCopy(call))) return;
  const helper = COPY_CALLS.test(name) || setAttributeCopy(call);
  const args = setAttributeCopy(call) ? call.arguments.slice(1) : call.arguments;
  for (const argument of args) {
    for (const leaf of valueLeaves(argument, sf)) {
      if (!helper && looksLikeCode(leaf.text)) continue;
      const sentence = /[A-Za-z].*\s.*!|[A-Za-z].*!\s/.test(leaf.text);
      const problems = copyProblems(leaf.text).filter(
        problem => helper || sentence || !problem.includes('exclamation'),
      );
      report(leaf.node, problems, `Argument of ${name || 'a call'}()`);
    }
  }
}

function assignmentChecks(sf, assignment, report) {
  const left = assignment.left;
  const name = ts.isPropertyAccessExpression(left) ? left.name.text : '';
  if (!name || !(COPY_WRITES.has(name) || isCopyKey(name))) return;
  for (const leaf of valueLeaves(assignment.right, sf))
    report(leaf.node, copyProblems(leaf.text), `Assignment to ${name}`);
}

function cssChecks(ctx, out) {
  for (const decl of collectDecls(ctx)) {
    if (decl.prop !== 'content') continue;
    walkNodes(parseValue(decl.value), node => {
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
