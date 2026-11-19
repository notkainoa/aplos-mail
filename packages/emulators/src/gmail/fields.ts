import type { Shape } from './schema';

/**
 * Google's `fields=` partial-response parameter. Supported: comma lists, `a/b` paths,
 * `a(b,c)` sub-selections, `a/b(c)` and `*`. A name the response type does not have is a 400
 * (`invalidFieldIn`); a name the type has but this value lacks simply drops out.
 */
interface FieldNode {
  /** True when the whole value at this point is selected. */
  all: boolean;
  children: Map<string, FieldNode>;
}

const newNode = (): FieldNode => ({ all: false, children: new Map() });

function childOf(node: FieldNode, name: string): FieldNode {
  let child = node.children.get(name);
  if (!child) {
    child = newNode();
    node.children.set(name, child);
  }
  return child;
}

export function parseFieldsMask(mask: string): FieldNode {
  const root = newNode();
  let pos = 0;

  // list := item (',' item)*
  const parseList = (into: FieldNode): void => {
    for (;;) {
      parseItem(into);
      if (mask[pos] === ',') {
        pos++;
        continue;
      }
      return;
    }
  };

  // item := name ('/' name)* ('(' list ')')?
  const parseItem = (into: FieldNode): void => {
    let current = into;
    for (;;) {
      const start = pos;
      while (pos < mask.length && !'/,()'.includes(mask[pos])) pos++;
      const name = mask.slice(start, pos).trim();
      if (name) current = childOf(current, name);
      if (mask[pos] === '/') {
        pos++;
        continue;
      }
      break;
    }
    if (mask[pos] === '(') {
      pos++;
      parseList(current);
      if (mask[pos] === ')') pos++;
    } else if (current !== into) {
      current.all = true;
    }
  };

  parseList(root);
  return root;
}

/**
 * The first field in `mask` that `shape` does not have, or undefined when the mask is valid.
 * Selecting inside a scalar (`id/x`) is invalid too. `*` matches any field.
 */
export function invalidFieldIn(mask: string, shape: Shape): string | undefined {
  if (!mask.trim()) return undefined;
  const check = (node: FieldNode, at: Shape): string | undefined => {
    for (const [name, child] of node.children) {
      if (name === '*') continue;
      const inner = at[name];
      if (inner === undefined) return name;
      if (child.children.size === 0) continue;
      if (inner === true) return [...child.children.keys()][0];
      const deeper = check(child, inner);
      if (deeper) return deeper;
    }
    return undefined;
  };
  return check(parseFieldsMask(mask), shape);
}

function apply(value: unknown, node: FieldNode): unknown {
  if (node.all) return value;
  if (Array.isArray(value)) return value.map(item => apply(item, node));
  if (value === null || typeof value !== 'object') return value;
  const wildcard = node.children.get('*');
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const selected = node.children.get(key) ?? wildcard;
    if (selected) out[key] = apply(child, selected);
  }
  return out;
}

/** Returns a copy of `value` that keeps only what `mask` selects. */
export function applyFieldsMask(value: unknown, mask: string): unknown {
  if (!mask.trim()) return value;
  return apply(value, parseFieldsMask(mask));
}
