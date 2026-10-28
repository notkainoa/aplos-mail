// Runs rules over text. This is the only place that knows how to turn a rule's
// check() into reportable violations, so the CLI and the tests share it.

import fs from 'node:fs';
import { createContext, kindOfPath } from './context.mjs';
import { rules as allRules } from '../rules/index.mjs';

export function lintText({ path: file, text, rules = allRules, kind }) {
  const resolved = kind || kindOfPath(file);
  if (!resolved) return [];
  let ctx;
  try {
    ctx = createContext({ path: file, text, kind: resolved });
    if (resolved === 'css') void ctx.root;
    else void ctx.sf;
  } catch (error) {
    return [
      {
        rule: 'parse-error',
        line: error.line || 1,
        column: error.column || 1,
        message: `Could not parse: ${error.reason || error.message}`,
      },
    ];
  }
  const found = [];
  for (const rule of rules) {
    if (!rule.appliesTo.includes(resolved)) continue;
    for (const item of rule.check(ctx)) {
      found.push({ rule: rule.id, line: item.line, column: item.column, message: item.message });
    }
  }
  return found.sort(
    (a, b) => a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule),
  );
}

export function lintFile(file, rules) {
  return lintText({ path: file, text: fs.readFileSync(file, 'utf8'), rules });
}
