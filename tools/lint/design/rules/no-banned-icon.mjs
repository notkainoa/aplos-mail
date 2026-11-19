// DESIGN 4.7 and 9 rule 8: AI has no glyph. No sparkle, wand, star, brain or
// robot icon, symbol name or glyph anywhere. "bookmark" is the bookmark icon.

import ts from 'typescript';
import { jsxTagName, lastSegment, nameOfProperty, positionOf, visit } from '../lib/ast.mjs';
import { collectDecls, forEachString } from '../lib/decls.mjs';
import { violation } from '../lib/context.mjs';
import { parseValue, walkNodes } from '../lib/value.mjs';

export const id = 'no-banned-icon';
export const description =
  'No sparkle, wand, star, brain or robot icon imports, SF Symbol names or glyphs (sparkle, wand.and.stars, star.fill, apple.intelligence, brain, the matching emoji) in code, JSX text or CSS content.';
export const appliesTo = ['css', 'ts'];

const EXACT_NAMES = new Set([
  'Sparkles',
  'Sparkle',
  'Wand',
  'Wand2',
  'WandSparkles',
  'Stars',
  'Star',
  'StarOff',
  'StarHalf',
  'Brain',
  'BrainCircuit',
  'BrainCog',
  'Bot',
  'BotMessageSquare',
  'BotOff',
]);
const BANNED_SUBSTRINGS = /sparkl|wand|brain|robot/i;
const BANNED_WORDS = /^(star|stars|starred|starry|starburst|bot|bots)$/;
const ICON_MODULE = /lucide|icon|symbol|phosphor|tabler|fontawesome|feather|remix/i;

const SYMBOL_NAMES = new Set([
  'sparkle',
  'sparkles',
  'wand',
  'wand2',
  'wand.and.stars',
  'wand.and.rays',
  'star',
  'stars',
  'star.fill',
  'apple.intelligence',
  'brain',
  'brain.head.profile',
  'bot',
  'robot',
]);
const SYMBOL_PREFIXES = [/^sparkle/i, /^wand\./i, /^star\./i, /^brain\./i];

const GLYPHS = [
  '✨',
  '⭐',
  '\u{1F31F}',
  '★',
  '☆',
  '\u{1FA84}',
  '\u{1F916}',
  '\u{1F9E0}',
  '✦',
  '✧',
  '✩',
  '✪',
  '⭑',
  '⭒',
  '\u{1F4AB}',
  '\u{1F320}',
];
const GLYPH_PATTERN = new RegExp(
  GLYPHS.map(g => g.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')).join('|'),
  'u',
);
const CSS_ESCAPES =
  /\\0*(2728|2b50|1f31f|2605|2606|1fa84|1f916|1f9e0|2726|2727|2729|272a|2b51|2b52|1f4ab|1f320)\b/i;
const ENTITIES =
  /&#(?:9733|9734|10024|11088|127775|129668|129302|129504);|&#x(?:2605|2606|2728|2b50|1f31f|1fa84|1f916|1f9e0);|&star;|&starf;/i;

export function isBannedIconName(name) {
  if (EXACT_NAMES.has(name)) return true;
  if (BANNED_SUBSTRINGS.test(name)) return true;
  const words = name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) || [];
  return words.some(word => BANNED_WORDS.test(word.toLowerCase()));
}

function wordsOf(name) {
  return name
    .split(/[-_.]+/)
    .flatMap(part => part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) || []);
}

// A name made of several words with no spaces (wand-sparkles, brain.head.profile,
// WandSparkles, star-off) is an icon or symbol name wherever it appears.
function isCompoundIconName(trimmed) {
  if (!/^[\w.-]+$/.test(trimmed)) return false;
  const words = wordsOf(trimmed);
  return words.length >= 2 && isBannedIconName(trimmed);
}

// iconPosition is true where the string is plainly an icon name: a prop or key
// named icon, symbol, glyph or systemImage, or the argument of an icon helper.
// A lone word such as "star" is only a banned name there.
export function isBannedSymbolName(text, { iconPosition = false } = {}) {
  const trimmed = text.trim();
  if (SYMBOL_PREFIXES.some(pattern => pattern.test(trimmed))) return true;
  if (isCompoundIconName(trimmed)) return true;
  if (!iconPosition) return false;
  return (
    SYMBOL_NAMES.has(trimmed.toLowerCase()) ||
    (/^[\w.-]+$/.test(trimmed) && isBannedIconName(trimmed))
  );
}

const ICON_KEY =
  /(?:^|[a-z])(?:icon|symbol|glyph|systemImage)$|^(?:icon|symbol|glyph|systemImage)/i;
const ICON_TAG = /(?:icon|symbol|glyph)$/i;
const ICON_CALL = /icon|symbol|glyph/i;

function isIconPosition(node) {
  let current = node.parent;
  if (current && ts.isJsxExpression(current)) current = current.parent;
  if (current && ts.isJsxAttribute(current)) {
    const name = current.name.getText();
    if (ICON_KEY.test(name)) return true;
    if (name === 'name') {
      const tag = current.parent && current.parent.parent;
      return Boolean(tag) && ICON_TAG.test(lastSegment(jsxTagName(tag)));
    }
    return false;
  }
  if (current && ts.isPropertyAssignment(current))
    return ICON_KEY.test(nameOfProperty(current.name) || '');
  if (current && ts.isCallExpression(current)) {
    const callee = current.expression;
    const name = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ts.isIdentifier(callee)
        ? callee.text
        : '';
    return ICON_CALL.test(name);
  }
  return false;
}

function hasBannedGlyph(text) {
  return GLYPH_PATTERN.test(text) || ENTITIES.test(text);
}

function namespaceImports(sf) {
  const names = new Set();
  visit(sf, node => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const clause = node.importClause;
    if (!clause || !ICON_MODULE.test(node.moduleSpecifier.text)) return;
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
      names.add(clause.namedBindings.name.text);
  });
  return names;
}

function importChecks(sf, out) {
  visit(sf, node => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const specifier = node.moduleSpecifier.text;
    const iconModule = ICON_MODULE.test(specifier);
    const clause = node.importClause;
    if (!clause) return;
    // Outside icon libraries only the unmistakable names fail, so a hook such
    // as useStarred is left alone, while an aliased Sparkles never slips by.
    const banned = name =>
      iconModule ? isBannedIconName(name) : EXACT_NAMES.has(name) || BANNED_SUBSTRINGS.test(name);
    const report = (target, name) => {
      const at = positionOf(sf, target);
      out.push(
        violation(
          at.line,
          at.column,
          `Icon "${name}" from ${specifier} is banned. AI has no glyph and bookmarks use the bookmark icon (DESIGN 4.7).`,
        ),
      );
    };
    if (clause.name && banned(clause.name.text)) report(clause.name, clause.name.text);
    const lastPart = specifier.split('/').pop() || '';
    const pathWords = lastPart
      .split(/[-_.]/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');
    if (iconModule && isBannedIconName(pathWords)) report(node.moduleSpecifier, lastPart);
    const bindings = clause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    for (const element of bindings.elements) {
      const imported = (element.propertyName || element.name).text;
      if (banned(imported)) report(element, imported);
    }
  });
}

function usageChecks(sf, out) {
  const namespaces = namespaceImports(sf);
  visit(sf, node => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const name = lastSegment(jsxTagName(node));
      if (/^[A-Z]/.test(name) && isBannedIconName(name)) {
        const at = positionOf(sf, node);
        out.push(
          violation(
            at.line,
            at.column,
            `<${jsxTagName(node)}> is a banned icon component (DESIGN 4.7).`,
          ),
        );
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text)
    ) {
      if (isBannedIconName(node.name.text)) {
        const at = positionOf(sf, node);
        out.push(violation(at.line, at.column, `Icon "${node.name.text}" is banned (DESIGN 4.7).`));
      }
    }
    if (ts.isJsxText(node) && hasBannedGlyph(node.text)) {
      const at = positionOf(sf, node);
      out.push(
        violation(
          at.line,
          at.column,
          'A star, sparkle, wand, brain or robot glyph in JSX text is banned (DESIGN 4.7).',
        ),
      );
    }
  });
}

function tsChecks(ctx, out) {
  importChecks(ctx.sf, out);
  usageChecks(ctx.sf, out);
  forEachString(ctx, ({ text, node, line, column }) => {
    if (isBannedSymbolName(text, { iconPosition: isIconPosition(node) })) {
      out.push(
        violation(
          line,
          column,
          `Symbol name "${text.trim()}" is banned. Suggestions wear their action's icon (DESIGN 4.7 and 9).`,
        ),
      );
    }
    if (hasBannedGlyph(text)) {
      out.push(
        violation(
          line,
          column,
          'A star, sparkle, wand, brain or robot glyph is banned (DESIGN 4.7).',
        ),
      );
    }
  });
}

function cssChecks(ctx, out) {
  for (const decl of collectDecls(ctx)) {
    let bad = hasBannedGlyph(decl.value) || CSS_ESCAPES.test(decl.value);
    if (!bad) {
      walkNodes(parseValue(decl.value), node => {
        if (node.type === 'string' && isBannedSymbolName(node.text)) bad = true;
        return true;
      });
    }
    if (bad) {
      out.push(
        violation(
          decl.line,
          decl.column,
          `${decl.prop} carries a banned star, sparkle, wand, brain or robot glyph (DESIGN 4.7).`,
          decl.node,
        ),
      );
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
