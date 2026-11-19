// A small CSS value tokenizer. It is not a full CSS parser: it only needs to
// split values into words, strings, operators and (nested) functions.

export const DYNAMIC = '';

const WORD_STOP = /[\s,/()"'*]/;

function readString(src, state) {
  const quote = src[state.i];
  let text = '';
  state.i += 1;
  while (state.i < src.length && src[state.i] !== quote) {
    if (src[state.i] === '\\' && state.i + 1 < src.length) {
      text += src[state.i + 1];
      state.i += 2;
      continue;
    }
    text += src[state.i];
    state.i += 1;
  }
  state.i += 1;
  return { type: 'string', text };
}

function readUnquotedUrl(src, state) {
  let j = state.i;
  while (j < src.length && /\s/.test(src[j])) j += 1;
  if (src[j] === '"' || src[j] === "'") return null;
  const end = src.indexOf(')', j);
  const stop = end === -1 ? src.length : end;
  state.i = end === -1 ? src.length : end + 1;
  return { type: 'string', text: src.slice(j, stop).trim() };
}

function groupByComma(nodes) {
  const groups = [[]];
  for (const node of nodes) {
    if (node.type === 'op' && node.text === ',') groups.push([]);
    else groups[groups.length - 1].push(node);
  }
  return groups;
}

function parseNodes(src, state, inFn) {
  const nodes = [];
  while (state.i < src.length) {
    const ch = src[state.i];
    if (/\s/.test(ch)) {
      state.i += 1;
    } else if (ch === ')') {
      if (inFn) return nodes;
      state.i += 1;
    } else if (ch === ',' || ch === '/' || ch === '*') {
      nodes.push({ type: 'op', text: ch });
      state.i += 1;
    } else if (ch === '"' || ch === "'") {
      nodes.push(readString(src, state));
    } else {
      const start = state.i;
      while (state.i < src.length && !WORD_STOP.test(src[state.i])) state.i += 1;
      const word = src.slice(start, state.i);
      if (src[state.i] === '(') {
        state.i += 1;
        nodes.push(readFunction(src, state, word, start));
      } else {
        nodes.push({ type: 'word', text: word });
      }
    }
  }
  return nodes;
}

function readFunction(src, state, name, start) {
  if (name.toLowerCase() === 'url') {
    const url = readUnquotedUrl(src, state);
    if (url) return { type: 'fn', name, args: [[url]], raw: src.slice(start, state.i) };
  }
  const inner = parseNodes(src, state, true);
  state.i += 1;
  return { type: 'fn', name, args: groupByComma(inner), raw: src.slice(start, state.i) };
}

export function parseValue(input) {
  return parseNodes(String(input), { i: 0 }, false);
}

export function splitTopLevel(nodes) {
  return groupByComma(nodes);
}

// Visits every node depth first. Returning false from visit skips a function's arguments.
export function walkNodes(nodes, visit) {
  for (const node of nodes) {
    const descend = visit(node);
    if (node.type === 'fn' && descend !== false) {
      for (const arg of node.args) walkNodes(arg, visit);
    }
  }
}

export function isDynamic(text) {
  return text.includes(DYNAMIC);
}

export function varName(fn) {
  const first = fn.args[0] && fn.args[0][0];
  return first && first.type === 'word' ? first.text : '';
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?([a-z%]*)$/i;

export function parseNumber(text) {
  const match = NUMBER.exec(text);
  if (!match) return null;
  return { value: Number.parseFloat(text), unit: match[1].toLowerCase() };
}
