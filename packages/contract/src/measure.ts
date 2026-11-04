/**
 * How many bytes a message costs on the wire (lane eng-contract, contract-4): what the structured clone of a
 * MessagePort really carries, measured without recursion and with a hard bound, so hostile input can neither hang nor
 * exhaust the process that measures it. Platform-neutral: no Node module, no zod (preload bundles it into a sandbox).
 */
/** UTF-8 length without allocating the encoded string. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** At most this many values are visited to measure one message; a message with more counts as infinite. */
export const MAX_MEASURED_NODES = 1_000_000;

/**
 * The same bound for what a WINDOW sends: a legitimate call has hundreds of values, and a million empty objects
 * (3 MB on the wire) took about 0.5 s to measure, enough for a hostile renderer to stall an engine that serves every window.
 */
export const MAX_WINDOW_NODES = 100_000;

/** JSON leaves these out of an object and writes `null` for them in an array. */
const dropped = (value: unknown) =>
  value === undefined || typeof value === 'function' || typeof value === 'symbol';

/**
 * The JSON text length of a value with no children, or undefined for a container or binary. A boxed String, Number
 * or Boolean counts as its value (JSON writes it so; the structured clone carries just the value). Throws on a BigInt,
 * boxed or not, which cannot be measured.
 */
function leafBytes(value: unknown, inArray: boolean): number | undefined {
  if (value === null) return 4;
  if (dropped(value)) return inArray ? 4 : 0;
  if (typeof value === 'string') return utf8Length(JSON.stringify(value));
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value).length;
  if (typeof value === 'bigint' || value instanceof BigInt)
    throw new TypeError('A BigInt cannot be measured.');
  if (value instanceof String || value instanceof Number || value instanceof Boolean)
    return leafBytes(value.valueOf(), inArray);
  if (value instanceof Date) return JSON.stringify(value).length;
  return undefined;
}

/**
 * The bytes binary carries: a one-character placeholder plus its WHOLE underlying buffer (a view's clone copies all of
 * it, not just the view's slice), each buffer once however many views share it. Undefined for anything else.
 */
function binaryBytes(value: unknown, counted: Set<object>): number | undefined {
  const buffer =
    value instanceof ArrayBuffer ? value : ArrayBuffer.isView(value) ? value.buffer : undefined;
  if (!buffer) return undefined;
  if (counted.has(buffer)) return 1;
  counted.add(buffer);
  return 1 + buffer.byteLength;
}

type Child = { value: unknown; inArray: boolean };

/** A container's own text (brackets, commas, keys) and the children the structured clone carries in it. */
type Contents = { bytes: number; children: Child[] };

const listText = (count: number) => 2 + Math.max(count - 1, 0);

/** True for a canonical array index ("0", "17"), which JSON writes as a slot rather than a key. */
const isIndex = (key: string) => /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1;

/**
 * Up to `room` own enumerable string keys of `object` that `keep` accepts, or undefined as soon as there are more:
 * the loop stops there, so a huge object never has all its keys listed at once.
 */
function ownKeys(object: object, room: number, keep: (key: string) => boolean) {
  const keys: string[] = [];
  for (const key in object) {
    if (!Object.hasOwn(object, key) || !keep(key)) continue;
    if (keys.length >= room) return undefined;
    keys.push(key);
  }
  return keys;
}

/**
 * Each key JSON would write, with its value: the key's text, a colon and a comma, and the value as a child. A key longer
 * than the bytes still allowed is refused (undefined) before it is stringified, so a huge key costs nothing.
 */
function keyedContents(
  object: Record<string, unknown>,
  keys: string[],
  into: Contents,
  bytesLeft: number,
) {
  let left = bytesLeft;
  for (const key of keys) {
    if (dropped(object[key])) continue;
    if (key.length > left) return undefined;
    const bytes = utf8Length(JSON.stringify(key)) + 2;
    left -= bytes;
    into.bytes += bytes;
    into.children.push({ value: object[key], inArray: false });
  }
  return into;
}

/** A list-shaped value's slots, or undefined when it has more than `room`. */
function listContents(list: ArrayLike<unknown>, room: number): Contents | undefined {
  if (list.length > room) return undefined;
  const children: Child[] = [];
  for (let i = 0; i < list.length; i++) children.push({ value: list[i], inArray: true });
  return { bytes: listText(list.length), children };
}

/**
 * An array's slots plus any named own property (JSON drops those; the structured clone copies them). Only the slots
 * that exist are listed and visited, by key, so a sparse array costs what it holds: a hole is JSON's `null` (4 bytes,
 * counted from the length) with no entry, and `a[99_990] = 0` is one entry, not 100,000. A length past the
 * room left (or `MAX_MEASURED_NODES`) is refused before any key is read.
 */
function arrayContents(list: unknown[], room: number, bytesLeft: number): Contents | undefined {
  // The room is checked on the length first: a longer array is refused before any key is built (`for...in` builds every index key of a dense array).
  if (list.length > Math.min(room, MAX_MEASURED_NODES)) return undefined;
  const keys = ownKeys(list, room, () => true);
  if (!keys) return undefined;
  const slots = keys.filter(isIndex);
  const holes = list.length - slots.length;
  const children = slots.map(key => ({ value: list[Number(key)], inArray: true }));
  const contents: Contents = { bytes: listText(list.length) + 4 * holes, children };
  const named = keys.filter(key => !isIndex(key));
  return keyedContents(list as unknown as Record<string, unknown>, named, contents, bytesLeft);
}

/** A plain object's contents: every own enumerable key JSON would write, with its value. */
function objectContents(
  object: Record<string, unknown>,
  room: number,
  bytesLeft: number,
): Contents | undefined {
  const keys = ownKeys(object, room, () => true);
  if (!keys) return undefined;
  const contents = keyedContents(object, keys, { bytes: 0, children: [] }, bytesLeft);
  if (!contents) return undefined;
  // `{` and `}` with one comma fewer than keys (keyedContents counted one per key).
  contents.bytes += contents.children.length ? 1 : 2;
  return contents;
}

/** A Map as `[[k,v],...]`: per entry two brackets and a comma, plus the list's own text. */
function mapContents(map: Map<unknown, unknown>, room: number): Contents | undefined {
  if (map.size * 2 > room) return undefined;
  const children: Child[] = [];
  for (const [key, item] of map)
    children.push({ value: key, inArray: true }, { value: item, inArray: true });
  return { bytes: listText(map.size) + 3 * map.size, children };
}

/**
 * What the structured clone carries in a container, measured as JSON would write it. A Map counts as `[[k,v],...]`
 * and a Set as `[...]` (JSON alone writes both as `{}`), a RegExp as `[source, flags]`, an Error as its name, message,
 * stack and cause. Undefined when it has more than `room` children.
 */
function contents(value: object, room: number, bytesLeft: number): Contents | undefined {
  if (value instanceof Map) return mapContents(value, room);
  if (value instanceof Set) return value.size > room ? undefined : listContents([...value], room);
  if (value instanceof RegExp) return listContents([value.source, value.flags], room);
  if (value instanceof Error)
    return listContents([value.name, value.message, value.stack, value.cause], room);
  if (Array.isArray(value)) return arrayContents(value, room, bytesLeft);
  return objectContents(value as Record<string, unknown>, room, bytesLeft);
}

type Visit = Child | { leave: object };

/**
 * A free lower bound of what a string (boxed or not) measures: its UTF-8 bytes are at least its UTF-16 length. A string
 * longer than the room left is refused before it is copied or scanned.
 */
function lowerBound(value: unknown): number {
  const text = value instanceof String ? value.valueOf() : value;
  return typeof text === 'string' ? text.length : 0;
}

/**
 * Walks `root` with an explicit stack (no recursion, so no stack overflow) and stops as soon as the total passes
 * `limit`, the total WITHOUT binary payloads passes `textLimit`, or more than `maxNodes` values (default
 * `MAX_MEASURED_NODES`) were seen. Each object and each binary buffer counts once, like the structured clone copies a
 * shared one once; a later reference counts one byte. A cycle counts as infinite (no JSON-shaped message has one).
 */
function measure(root: unknown, limit: number, maxNodes: number, textLimit: number): number {
  const counted = new Set<object>();
  const ancestors = new Set<object>();
  const stack: Visit[] = [{ value: root, inArray: false }];
  let total = 0;
  let binary = 0;
  let nodes = 1;
  while (stack.length) {
    const visit = stack.pop()!;
    if ('leave' in visit) {
      ancestors.delete(visit.leave);
      continue;
    }
    if (total + lowerBound(visit.value) > limit) return Number.POSITIVE_INFINITY;
    if (total - binary + lowerBound(visit.value) > textLimit) return Number.POSITIVE_INFINITY;
    const text = leafBytes(visit.value, visit.inArray);
    const bytes = text ?? binaryBytes(visit.value, counted);
    const object = visit.value as object;
    if (bytes !== undefined) {
      total += bytes;
      if (text === undefined) binary += bytes - 1;
    } else if (ancestors.has(object)) return Number.POSITIVE_INFINITY;
    else if (counted.has(object)) total += 1;
    else {
      const left = Math.min(limit - total, textLimit - (total - binary));
      const inner = contents(object, maxNodes - nodes, left);
      if (!inner) return Number.POSITIVE_INFINITY;
      counted.add(object);
      ancestors.add(object);
      nodes += inner.children.length;
      total += inner.bytes;
      stack.push({ leave: object });
      for (let i = inner.children.length - 1; i >= 0; i--) stack.push(inner.children[i]);
    }
    if (total > limit || total - binary > textLimit) return Number.POSITIVE_INFINITY;
  }
  return total;
}

/**
 * About what a message costs on the wire: its JSON text in UTF-8 plus every binary payload's bytes, measured on what
 * the structured clone really carries (a Map's and a Set's entries, a Buffer's bytes; never a `toJSON` view). Anything
 * that cannot be measured (a cycle, a BigInt, more than `MAX_MEASURED_NODES` values) or that passes `limit` counts as
 * infinite, so it never leaves. `textLimit` (default `limit`) caps everything except binary payloads, so an upload
 * route's big allowance is for its bytes and never for text. Never throws, never recurses.
 */
export function messageBytes(
  value: unknown,
  limit = Number.POSITIVE_INFINITY,
  maxNodes = MAX_MEASURED_NODES,
  textLimit = limit,
): number {
  try {
    return measure(value, limit, maxNodes, textLimit);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
