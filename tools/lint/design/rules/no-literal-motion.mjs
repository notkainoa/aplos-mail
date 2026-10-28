// DESIGN 4.8: durations and easings come from tokens (var(--dur-*), var(--ease-*),
// var(--spring-*) in CSS, the motion.ts import in TS). 12.2 "No literal durations or easings".

import ts from 'typescript';
import {
  isLiteralExpression, nameOfProperty, positionOf, unwrap,
} from '../lib/ast.mjs';
import { collectDecls } from '../lib/decls.mjs';
import { violation } from '../lib/context.mjs';
import { isCustomProp, isMotionProp } from '../lib/props.mjs';
import { parseValue, walkNodes } from '../lib/value.mjs';
import {
  callbackWritesMotion, findAnimateCalls, findTimerCalls, keyframeKeys,
} from '../lib/waapi.mjs';

export const id = 'no-literal-motion';
export const description = 'No literal durations (ms, s) or easings (cubic-bezier(), steps(), linear(), ease keywords) in transition/animation values, custom properties, .animate() options or setTimeout-driven motion.';
export const appliesTo = ['css', 'ts'];

// A zero duration (0s, 0ms) is "no motion", not a timing value, so it is allowed.
const DURATION = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:ms|s)$/i;
const EASING_FUNCTIONS = new Set(['cubic-bezier', 'steps', 'linear']);
const EASING_KEYWORDS = new Set(['ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'step-start', 'step-end']);

function literalProblems(value, { keywords }) {
  const problems = [];
  walkNodes(parseValue(value), (node) => {
    if (node.type === 'word') {
      if (DURATION.test(node.text) && Number.parseFloat(node.text) !== 0) problems.push(`literal duration ${node.text}`);
      else if (keywords && EASING_KEYWORDS.has(node.text.toLowerCase())) problems.push(`literal easing ${node.text}`);
    } else if (node.type === 'fn' && EASING_FUNCTIONS.has(node.name.toLowerCase())) {
      problems.push(`literal easing ${node.name}()`);
      return false;
    }
    return true;
  });
  return problems;
}

function declChecks(ctx, out) {
  for (const decl of collectDecls(ctx)) {
    if (decl.numeric) continue;
    const custom = isCustomProp(decl.prop);
    if (!custom && !isMotionProp(decl.prop)) continue;
    const problems = literalProblems(decl.value, { keywords: !custom });
    for (const problem of problems) {
      const where = custom ? `custom property ${decl.prop}` : decl.prop;
      out.push(violation(decl.line, decl.column, `${problem} in ${where}. Use var(--dur-*) and var(--ease-*) or the motion.ts import (DESIGN 4.8).`, decl.node));
    }
  }
}

const TIMING_KEYS = new Set(['duration', 'delay', 'endDelay', 'easing']);

function animateChecks(sf, out) {
  for (const call of findAnimateCalls(sf)) {
    const optionArg = call.arguments[1] && unwrap(call.arguments[1]);
    if (optionArg && isLiteralExpression(optionArg)) {
      const at = positionOf(sf, optionArg);
      out.push(violation(at.line, at.column, '.animate() options are a literal. Use durations and easings from motion.ts.'));
    }
    if (optionArg && ts.isObjectLiteralExpression(optionArg)) {
      for (const property of optionArg.properties) {
        const key = nameOfProperty(property.name);
        if (!ts.isPropertyAssignment(property) || !TIMING_KEYS.has(key)) continue;
        if (isLiteralExpression(property.initializer)) {
          const at = positionOf(sf, property);
          out.push(violation(at.line, at.column, `.animate() ${key} is a literal. Import it from motion.ts (for example duration: dur.carry).`));
        }
      }
    }
    for (const { key, node } of keyframeKeys(sf, call.arguments[0])) {
      if (key === 'easing' && ts.isPropertyAssignment(node) && isLiteralExpression(node.initializer)) {
        const at = positionOf(sf, node);
        out.push(violation(at.line, at.column, 'Keyframe easing is a literal. Import it from motion.ts.'));
      }
    }
  }
}

function timerChecks(sf, out) {
  for (const call of findTimerCalls(sf)) {
    const delay = call.arguments[1];
    if (!delay || !isLiteralExpression(delay)) continue;
    if (!callbackWritesMotion(sf, call.arguments[0])) continue;
    const at = positionOf(sf, call);
    out.push(violation(at.line, at.column, 'Timer-driven motion with a literal delay. Animate with WAAPI and motion.ts durations, or a CSS transition on tokens.'));
  }
}

export function check(ctx) {
  const out = [];
  declChecks(ctx, out);
  if (ctx.kind === 'ts') {
    animateChecks(ctx.sf, out);
    timerChecks(ctx.sf, out);
  }
  return out;
}

export default { id, description, appliesTo, check };
