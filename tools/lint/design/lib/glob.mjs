// A tiny glob matcher (**, *, ?, {a,b}) and directory walker, so the lint has
// no dependency beyond postcss and typescript.

import fs from 'node:fs';
import path from 'node:path';

export function globToRegExp(glob) {
  let source = '';
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (ch === '*') {
      source += '[^/]*';
    } else if (ch === '?') {
      source += '[^/]';
    } else if (ch === '{') {
      source += '(?:';
      braceDepth += 1;
    } else if (ch === '}' && braceDepth > 0) {
      source += ')';
      braceDepth -= 1;
    } else if (ch === ',' && braceDepth > 0) {
      source += '|';
    } else {
      source += ch.replace(/[\\^$+.()|[\]]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

export function matchesAny(relativePath, globs) {
  return globs.some(glob => globToRegExp(glob).test(relativePath));
}

const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'release']);

export function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

// The longest leading part of a glob with no wildcard, used as a walk root.
export function staticPrefix(glob) {
  const parts = glob.split('/');
  const fixed = [];
  for (const part of parts) {
    if (/[*?{]/.test(part)) break;
    fixed.push(part);
  }
  return fixed.join('/');
}
