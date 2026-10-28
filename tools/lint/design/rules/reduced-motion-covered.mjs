// DESIGN 4.8 "Reduced" column and 11 rule 5: the generated reduced-motion block
// neutralises every --dur-* token, so an animation is covered only when its
// duration is one of those tokens. The only loops allowed are breathe and status.
// In CSS and in TS (style objects, strings, el.animate options) alike.

import ts from 'typescript';
import {
  nameOfProperty,
  positionOf,
  resolveIdentifier,
  unwrap,
  numericValue,
  isNumericLiteralLike,
} from '../lib/ast.mjs';
import { collectDecls } from '../lib/decls.mjs';
import { violation } from '../lib/context.mjs';
import { isAnimationProp, stripVendor } from '../lib/props.mjs';
import { parseNumber, parseValue, splitTopLevel, varName, walkNodes } from '../lib/value.mjs';
import { findAnimateCalls, optionsObject } from '../lib/waapi.mjs';

export const id = 'reduced-motion-covered';
export const description =
  'Every animation duration is a var(--dur-*) token, every @keyframes is used by an animation in the same file (or marked as a WAAPI export in a comment), and only --dur-breathe and --dur-status may loop (infinite, or ten or more iterations).';
export const appliesTo = ['css', 'ts'];

const LOOP_TOKENS = new Set(['--dur-breathe', '--dur-status']);
const GLOBAL_WORDS = new Set(['none', 'inherit', 'initial', 'unset', 'revert']);
const LOOP_ITERATIONS = 10;

function durationVars(group) {
  const names = [];
  walkNodes(group, node => {
    if (node.type === 'fn' && node.name.toLowerCase() === 'var') {
      const name = varName(node);
      if (name.startsWith('--dur-')) names.push(name);
      return false;
    }
    return true;
  });
  return names;
}

// infinite, or a bare number of iterations big enough to be a loop.
function isLooping(group) {
  return group.some(node => {
    if (node.type !== 'word') return false;
    if (node.text.toLowerCase() === 'infinite') return true;
    const number = parseNumber(node.text);
    return Boolean(number) && number.unit === '' && number.value >= LOOP_ITERATIONS;
  });
}

function isGlobalOnly(group) {
  return (
    group.length === 1 && group[0].type === 'word' && GLOBAL_WORDS.has(group[0].text.toLowerCase())
  );
}

function siblingDurationVars(decl) {
  const names = [];
  let sawDuration = false;
  decl.parent.each(node => {
    if (node.type !== 'decl') return;
    const prop = stripVendor(node.prop.toLowerCase());
    if (prop !== 'animation' && prop !== 'animation-duration') return;
    sawDuration = true;
    for (const group of splitTopLevel(parseValue(node.value))) names.push(...durationVars(group));
  });
  return sawDuration ? names : null;
}

// siblings() returns the duration tokens declared beside an iteration count, or
// null when the declaration has no sibling duration.
function checkAnimationDecl({ prop: rawProp, value, line, column, node, siblings }, out) {
  const prop = stripVendor(rawProp.toLowerCase());
  if (prop === 'animation' || prop === 'animation-duration') {
    for (const group of splitTopLevel(parseValue(value))) {
      if (group.length === 0 || isGlobalOnly(group)) continue;
      const names = durationVars(group);
      if (names.length === 0) {
        out.push(
          violation(
            line,
            column,
            `${rawProp} has no var(--dur-*) duration, so the reduced-motion block cannot neutralise it (DESIGN 4.8).`,
            node,
          ),
        );
      } else if (isLooping(group) && !names.every(name => LOOP_TOKENS.has(name))) {
        out.push(
          violation(
            line,
            column,
            'Only --dur-breathe and --dur-status may loop (DESIGN 4.8).',
            node,
          ),
        );
      }
    }
  }
  if (prop === 'animation-iteration-count') {
    const looping = splitTopLevel(parseValue(value)).some(group => isLooping(group));
    if (!looping) return;
    const names = siblings();
    if (!names || names.length === 0 || !names.every(name => LOOP_TOKENS.has(name))) {
      out.push(
        violation(
          line,
          column,
          'animation-iteration-count of infinite or ten and over needs --dur-breathe or --dur-status as its duration (DESIGN 4.8).',
          node,
        ),
      );
    }
  }
}

function referencedAnimationNames(root) {
  const names = new Set();
  root.walkDecls(decl => {
    const prop = stripVendor(decl.prop.toLowerCase());
    if (prop !== 'animation' && prop !== 'animation-name') return;
    walkNodes(parseValue(decl.value), node => {
      if (node.type === 'word' || node.type === 'string') names.add(node.text);
      return true;
    });
  });
  return names;
}

function isWaapiExport(atRule) {
  const previous = atRule.prev();
  return Boolean(previous) && previous.type === 'comment' && /waapi/i.test(previous.text);
}

function cssChecks(ctx, out) {
  const { root } = ctx;
  root.walkDecls(decl => {
    if (!isAnimationProp(decl.prop) || !decl.source) return;
    const at = decl.source.start;
    checkAnimationDecl(
      {
        prop: decl.prop,
        value: decl.value,
        line: at.line,
        column: at.column,
        node: decl,
        siblings: () => siblingDurationVars(decl),
      },
      out,
    );
  });
  const referenced = referencedAnimationNames(root);
  root.walkAtRules(/keyframes$/i, atRule => {
    const name = atRule.params.trim().replace(/^["']|["']$/g, '');
    if (referenced.has(name) || isWaapiExport(atRule)) return;
    const at = atRule.source.start;
    out.push(
      violation(
        at.line,
        at.column,
        `@keyframes ${name} is not used by any animation in this file. Reference it, or mark it for WAAPI with a comment containing "waapi".`,
        atRule,
      ),
    );
  });
}

// Duration tokens beside an animationIterationCount key in the same object.
function objectSiblingDurations(decl) {
  const object = decl.node && decl.node.parent;
  if (!object || !ts.isObjectLiteralExpression(object)) return null;
  const names = [];
  let sawDuration = false;
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = nameOfProperty(property.name);
    if (key !== 'animation' && key !== 'animationDuration' && key !== 'animation-duration')
      continue;
    sawDuration = true;
    const text = property.initializer.getText();
    for (const match of text.matchAll(/--dur-[\w-]+/g)) names.push(match[0]);
  }
  return sawDuration ? names : null;
}

function inlineSiblingDurations(decl) {
  const text = decl.node.getText();
  const names = [...text.matchAll(/--dur-[\w-]+/g)].map(match => match[0]);
  return names.length > 0 ? names : null;
}

function tsDeclChecks(ctx, out) {
  for (const decl of collectDecls(ctx)) {
    if (!isAnimationProp(decl.prop)) continue;
    let siblings = () => null;
    if (decl.origin === 'css-embedded') siblings = () => siblingDurationVars(decl.node);
    else if (decl.origin === 'object') siblings = () => objectSiblingDurations(decl);
    else if (decl.origin === 'inline') siblings = () => inlineSiblingDurations(decl);
    checkAnimationDecl({ ...decl, siblings }, out);
  }
}

function isInfinity(sf, expression) {
  const node = unwrap(resolveIdentifier(sf, expression));
  if (!node) return false;
  if (ts.isIdentifier(node)) return node.text === 'Infinity';
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'POSITIVE_INFINITY';
  return isNumericLiteralLike(node) && numericValue(node) >= LOOP_ITERATIONS;
}

const LOOP_DURATION = /\.(breathe|status)\b|\[\s*['"](breathe|status)['"]\s*\]/;

// el.animate(frames, { iterations: Infinity }) loops only with dur.breathe or dur.status.
function waapiLoopChecks(sf, out) {
  for (const call of findAnimateCalls(sf)) {
    const options = optionsObject(sf, call);
    if (!options) continue;
    const iterations = options.properties.find(
      p => ts.isPropertyAssignment(p) && nameOfProperty(p.name) === 'iterations',
    );
    if (!iterations || !isInfinity(sf, iterations.initializer)) continue;
    const duration = options.properties.find(
      p => ts.isPropertyAssignment(p) && nameOfProperty(p.name) === 'duration',
    );
    if (duration && LOOP_DURATION.test(duration.initializer.getText())) continue;
    const at = positionOf(sf, iterations);
    out.push(
      violation(at.line, at.column, 'Only dur.breathe and dur.status may loop (DESIGN 4.8).'),
    );
  }
}

export function check(ctx) {
  const out = [];
  if (ctx.kind === 'css') {
    cssChecks(ctx, out);
  } else {
    tsDeclChecks(ctx, out);
    waapiLoopChecks(ctx.sf, out);
  }
  return out;
}

export default { id, description, appliesTo, check };
