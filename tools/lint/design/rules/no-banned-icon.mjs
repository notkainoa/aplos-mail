// DESIGN 4.7 and 9 rule 8: AI has no glyph. No sparkle, wand, star, brain or
// robot icon, symbol name or glyph anywhere. "bookmark" is the bookmark icon.

import ts from 'typescript';
import { jsxTagName, lastSegment, positionOf, visit } from '../lib/ast.mjs';
import { collectDecls, forEachString } from '../lib/decls.mjs';
import { violation } from '../lib/context.mjs';
import { parseValue, walkNodes } from '../lib/value.mjs';

export const id = 'no-banned-icon';
export const description = 'No sparkle, wand, star, brain or robot icon imports, SF Symbol names or glyphs (sparkle, wand.and.stars, star.fill, apple.intelligence, brain, the matching emoji) in code, JSX text or CSS content.';
export const appliesTo = ['css', 'ts'];

const EXACT_NAMES = new Set([
  'Sparkles', 'Sparkle', 'Wand', 'Wand2', 'WandSparkles', 'Stars', 'Star', 'StarOff', 'StarHalf',
  'Brain', 'BrainCircuit', 'BrainCog', 'Bot', 'BotMessageSquare', 'BotOff',
]);
const BANNED_SUBSTRINGS = /sparkl|wand|brain|robot/i;
const BANNED_WORDS = /^(star|stars|starred|starry|starburst|bot|bots)$/;
const ICON_MODULE = /lucide|icon|symbol|phosphor|tabler|fontawesome|feather|remix/i;

const SYMBOL_NAMES = new Set([
  'sparkle', 'sparkles', 'wand', 'wand2', 'wand.and.stars', 'wand.and.rays', 'star', 'stars',
  'star.fill', 'apple.intelligence', 'brain', 'brain.head.profile', 'bot', 'robot',
]);
const SYMBOL_PREFIXES = [/^sparkle/i, /^wand\./i, /^star\./i, /^brain\./i];

const GLYPHS = [
  '✨', '⭐', '\u{1F31F}', '★', '☆', '\u{1FA84}', '\u{1F916}', '\u{1F9E0}',
  '✦', '✧', '✩', '✪', '⭑', '⭒', '\u{1F4AB}', '\u{1F320}',
];
const GLYPH_PATTERN = new RegExp(GLYPHS.map((g) => g.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')).join('|'), 'u');
const CSS_ESCAPES = /\\0*(2728|2b50|1f31f|2605|2606|1fa84|1f916|1f9e0|2726|2727|2729|272a|2b51|2b52|1f4ab|1f320)\b/i;
const ENTITIES = /&#(?:9733|9734|10024|11088|127775|129668|129302|129504);|&#x(?:2605|2606|2728|2b50|1f31f|1fa84|1f916|1f9e0);|&star;|&starf;/i;

export function isBannedIconName(name) {
  if (EXACT_NAMES.has(name)) return true;
  if (BANNED_SUBSTRINGS.test(name)) return true;
  const words = name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) || [];
  return words.some((word) => BANNED_WORDS.test(word.toLowerCase()));
}

export function isBannedSymbolName(text) {
  const trimmed = text.trim();
  if (SYMBOL_NAMES.has(trimmed.toLowerCase())) return true;
  return SYMBOL_PREFIXES.some((pattern) => pattern.test(trimmed));
}

function hasBannedGlyph(text) {
  return GLYPH_PATTERN.test(text) || ENTITIES.test(text);
}

function namespaceImports(sf) {
  const names = new Set();
  visit(sf, (node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const clause = node.importClause;
    if (!clause || !ICON_MODULE.test(node.moduleSpecifier.text)) return;
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.add(clause.namedBindings.name.text);
  });
  return names;
}

function importChecks(sf, out) {
  visit(sf, (node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const specifier = node.moduleSpecifier.text;
    if (!ICON_MODULE.test(specifier)) return;
    const clause = node.importClause;
    if (!clause) return;
    const report = (target, name) => {
      const at = positionOf(sf, target);
      out.push(violation(at.line, at.column, `Icon "${name}" from ${specifier} is banned. AI has no glyph and bookmarks use the bookmark icon (DESIGN 4.7).`));
    };
    if (clause.name && isBannedIconName(clause.name.text)) report(clause.name, clause.name.text);
    const lastPart = specifier.split('/').pop() || '';
    const pathWords = lastPart.split(/[-_.]/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
    if (isBannedIconName(pathWords)) report(node.moduleSpecifier, lastPart);
    const bindings = clause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    for (const element of bindings.elements) {
      const imported = (element.propertyName || element.name).text;
      if (isBannedIconName(imported)) report(element, imported);
    }
  });
}

function usageChecks(sf, out) {
  const namespaces = namespaceImports(sf);
  visit(sf, (node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const name = lastSegment(jsxTagName(node));
      if (/^[A-Z]/.test(name) && isBannedIconName(name)) {
        const at = positionOf(sf, node);
        out.push(violation(at.line, at.column, `<${jsxTagName(node)}> is a banned icon component (DESIGN 4.7).`));
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && namespaces.has(node.expression.text)) {
      if (isBannedIconName(node.name.text)) {
        const at = positionOf(sf, node);
        out.push(violation(at.line, at.column, `Icon "${node.name.text}" is banned (DESIGN 4.7).`));
      }
    }
    if (ts.isJsxText(node) && hasBannedGlyph(node.text)) {
      const at = positionOf(sf, node);
      out.push(violation(at.line, at.column, 'A star, sparkle, wand, brain or robot glyph in JSX text is banned (DESIGN 4.7).'));
    }
  });
}

function tsChecks(ctx, out) {
  importChecks(ctx.sf, out);
  usageChecks(ctx.sf, out);
  forEachString(ctx, ({ text, line, column }) => {
    if (isBannedSymbolName(text)) {
      out.push(violation(line, column, `Symbol name "${text.trim()}" is banned. Suggestions wear their action's icon (DESIGN 4.7 and 9).`));
    }
    if (hasBannedGlyph(text)) {
      out.push(violation(line, column, 'A star, sparkle, wand, brain or robot glyph is banned (DESIGN 4.7).'));
    }
  });
}

function cssChecks(ctx, out) {
  for (const decl of collectDecls(ctx)) {
    let bad = hasBannedGlyph(decl.value) || CSS_ESCAPES.test(decl.value);
    if (!bad) {
      walkNodes(parseValue(decl.value), (node) => {
        if (node.type === 'string' && isBannedSymbolName(node.text)) bad = true;
        return true;
      });
    }
    if (bad) {
      out.push(violation(decl.line, decl.column, `${decl.prop} carries a banned star, sparkle, wand, brain or robot glyph (DESIGN 4.7).`, decl.node));
    }
  }
}

export function check(ctx) {
  const out = [];
  if (ctx.kind === 'css') cssChecks(ctx, out);
  else tsChecks(ctx, out);
  return out;
}

export default { id, description, appliesTo, check };
