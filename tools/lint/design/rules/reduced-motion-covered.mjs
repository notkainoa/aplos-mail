// DESIGN 4.8 "Reduced" column and 11 rule 5: the generated reduced-motion block
// neutralises every --dur-* token, so an animation is covered only when its
// duration is one of those tokens. The only loops allowed are breathe and status.

import { violation } from '../lib/context.mjs';
import { isAnimationProp, stripVendor } from '../lib/props.mjs';
import { parseValue, splitTopLevel, varName, walkNodes } from '../lib/value.mjs';

export const id = 'reduced-motion-covered';
export const description = 'Every animation duration is a var(--dur-*) token, every @keyframes is used by an animation in the same file (or marked as a WAAPI export in a comment), and only --dur-breathe and --dur-status may loop forever.';
export const appliesTo = ['css'];

const LOOP_TOKENS = new Set(['--dur-breathe', '--dur-status']);
const GLOBAL_WORDS = new Set(['none', 'inherit', 'initial', 'unset', 'revert']);

function durationVars(group) {
  const names = [];
  walkNodes(group, (node) => {
    if (node.type === 'fn' && node.name.toLowerCase() === 'var') {
      const name = varName(node);
      if (name.startsWith('--dur-')) names.push(name);
      return false;
    }
    return true;
  });
  return names;
}

function groupHasWord(group, word) {
  return group.some((node) => node.type === 'word' && node.text.toLowerCase() === word);
}

function isGlobalOnly(group) {
  return group.length === 1 && group[0].type === 'word' && GLOBAL_WORDS.has(group[0].text.toLowerCase());
}

function siblingDurationVars(decl) {
  const names = [];
  let sawDuration = false;
  decl.parent.each((node) => {
    if (node.type !== 'decl') return;
    const prop = stripVendor(node.prop.toLowerCase());
    if (prop !== 'animation' && prop !== 'animation-duration') return;
    sawDuration = true;
    for (const group of splitTopLevel(parseValue(node.value))) names.push(...durationVars(group));
  });
  return sawDuration ? names : null;
}

function checkAnimationDecl(decl, out) {
  const prop = stripVendor(decl.prop.toLowerCase());
  const at = decl.source.start;
  if (prop === 'animation' || prop === 'animation-duration') {
    for (const group of splitTopLevel(parseValue(decl.value))) {
      if (isGlobalOnly(group)) continue;
      const names = durationVars(group);
      if (names.length === 0) {
        out.push(violation(at.line, at.column, `${decl.prop} has no var(--dur-*) duration, so the reduced-motion block cannot neutralise it (DESIGN 4.8).`, decl));
      } else if (groupHasWord(group, 'infinite') && !names.every((name) => LOOP_TOKENS.has(name))) {
        out.push(violation(at.line, at.column, 'Only --dur-breathe and --dur-status may loop forever (DESIGN 4.8).', decl));
      }
    }
  }
  if (prop === 'animation-iteration-count' && /\binfinite\b/i.test(decl.value)) {
    const names = siblingDurationVars(decl);
    if (!names || names.length === 0 || !names.every((name) => LOOP_TOKENS.has(name))) {
      out.push(violation(at.line, at.column, 'animation-iteration-count: infinite needs --dur-breathe or --dur-status as its duration (DESIGN 4.8).', decl));
    }
  }
}

function referencedAnimationNames(root) {
  const names = new Set();
  root.walkDecls((decl) => {
    const prop = stripVendor(decl.prop.toLowerCase());
    if (prop !== 'animation' && prop !== 'animation-name') return;
    walkNodes(parseValue(decl.value), (node) => {
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

export function check(ctx) {
  const out = [];
  const { root } = ctx;
  root.walkDecls((decl) => {
    if (isAnimationProp(decl.prop) && decl.source) checkAnimationDecl(decl, out);
  });
  const referenced = referencedAnimationNames(root);
  root.walkAtRules(/keyframes$/i, (atRule) => {
    const name = atRule.params.trim().replace(/^["']|["']$/g, '');
    if (referenced.has(name) || isWaapiExport(atRule)) return;
    const at = atRule.source.start;
    out.push(violation(at.line, at.column, `@keyframes ${name} is not used by any animation in this file. Reference it, or mark it for WAAPI with a comment containing "waapi".`, atRule));
  });
  return out;
}

export default { id, description, appliesTo, check };
