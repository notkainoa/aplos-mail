// File contexts: one object per file that rules read from. A context is either
// a CSS context (PostCSS root) or a TS context (TypeScript compiler API AST).

import path from 'node:path';
import postcss from 'postcss';
import ts from 'typescript';

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);

export function kindOfPath(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.css') return 'css';
  if (TS_EXTENSIONS.has(ext)) return 'ts';
  return null;
}

function scriptKindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return ts.ScriptKind.TS;
  return ts.ScriptKind.JSX;
}

export function createCssContext({ path: file = 'input.css', text, root }) {
  return {
    kind: 'css',
    path: file,
    text,
    get root() {
      if (!this._root) this._root = root || postcss.parse(text, { from: file });
      return this._root;
    },
  };
}

export function createTsContext({ path: file = 'input.tsx', text, sourceFile }) {
  return {
    kind: 'ts',
    path: file,
    text,
    get sf() {
      if (!this._sf) {
        this._sf =
          sourceFile ||
          ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
      }
      return this._sf;
    },
  };
}

export function createContext({ path: file, text, kind }) {
  const resolved = kind || kindOfPath(file);
  if (resolved === 'css') return createCssContext({ path: file, text });
  if (resolved === 'ts') return createTsContext({ path: file, text });
  throw new Error(`Unsupported file type: ${file}`);
}

export function violation(line, column, message, node) {
  const result = { line, column, message };
  if (node) Object.defineProperty(result, 'node', { value: node, enumerable: false });
  return result;
}
