// Reads tokens.json (W3C design-token format plus the $extensions.aplos
// conventions described in its root $description) and resolves values per
// mode. Shared by build-tokens.mjs and check-contrast.mjs.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compositeOver, parseHex, toRgb } from './color.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const DESKTOP_ROOT = resolve(here, '../..');
export const TOKENS_PATH = resolve(DESKTOP_ROOT, 'src/renderer/ui/tokens.json');
export const GENERATED_DIR = resolve(DESKTOP_ROOT, 'src/renderer/ui/generated');
export const REFERENCES_PATH = resolve(here, 'identity-references.json');

export const MODES = ['light', 'dark', 'light-more', 'dark-more'];
export const COLOR_USAGES = ['text', 'nontext', 'surface', 'decorative', 'shadow', 'overlay'];
export const PAIR_MINIMUMS = { text: 4.5, nontext: 3 };

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function aplosExt(node) {
  return (node && node.$extensions && node.$extensions.aplos) || {};
}

function isToken(node) {
  return node !== null && typeof node === 'object' && '$value' in node;
}

// Flattens the token tree into records in file order.
export function flattenTokens(tree) {
  const tokens = [];
  walk(tree, [], { type: undefined, prefix: '', reduced: undefined, rem: false }, tokens);
  const byPath = new Map(tokens.map(t => [t.path, t]));
  return { tokens, byPath, root: tree };
}

function walk(node, path, inherited, out) {
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('$') || child === null || typeof child !== 'object') {
      continue;
    }
    const childPath = [...path, key];
    const ext = aplosExt(child);
    if (isToken(child)) {
      out.push(makeToken(key, childPath, child, ext, inherited));
      continue;
    }
    walk(
      child,
      childPath,
      {
        type: child.$type ?? inherited.type,
        prefix: ext.cssPrefix ?? inherited.prefix,
        reduced: ext.reduced ?? inherited.reduced,
        rem: ext.rem ?? inherited.rem,
      },
      out,
    );
  }
}

function makeToken(key, path, node, ext, inherited) {
  const css = ext.css === false ? null : `--${ext.css ?? inherited.prefix + key}`;
  return {
    key,
    path: path.join('.'),
    group: path[0],
    type: node.$type ?? inherited.type,
    value: node.$value,
    description: node.$description,
    dark: ext.dark,
    more: ext.more,
    reduced: ext.reduced ?? inherited.reduced,
    // px values emitted in rem (DESIGN 11.6); see build-tokens.mjs remFromPx.
    rem: ext.rem ?? inherited.rem,
    usage: ext.usage,
    ext,
    css,
  };
}

export function isAlias(value) {
  return typeof value === 'string' && /^\{[^}]+\}$/.test(value);
}

export function aliasPath(value) {
  return value.slice(1, -1);
}

export function lookup(flat, ref) {
  const token = flat.byPath.get(aliasPath(ref));
  if (!token) {
    throw new Error(`Unknown token reference ${ref}`);
  }
  return token;
}

export function modeInfo(mode) {
  if (!MODES.includes(mode)) {
    throw new Error(`Unknown mode ${mode}`);
  }
  return { theme: mode.startsWith('dark') ? 'dark' : 'light', more: mode.endsWith('-more') };
}

// The raw $value a token takes in a mode: Increase Contrast first, then night.
export function valueIn(token, mode) {
  const { theme, more } = modeInfo(mode);
  if (more && token.more !== undefined) {
    return token.more;
  }
  if (theme === 'dark' && token.dark !== undefined) {
    return token.dark;
  }
  return token.value;
}

function resolveNumber(flat, value, mode) {
  if (typeof value === 'number') {
    return value;
  }
  if (isAlias(value)) {
    return resolveNumber(flat, valueIn(lookup(flat, value), mode), mode);
  }
  throw new Error(`Not a number: ${JSON.stringify(value)}`);
}

// A colour as a layer: { rgb, alpha }. Solid colours have alpha 1.
export function resolveColorValue(flat, value, mode) {
  if (isAlias(value)) {
    return resolveColorValue(flat, valueIn(lookup(flat, value), mode), mode);
  }
  if (value === 'transparent') {
    return { rgb: [0, 0, 0], alpha: 0 };
  }
  if (typeof value === 'string') {
    return { rgb: parseHex(value), alpha: 1 };
  }
  if (value && typeof value === 'object' && 'mix' in value) {
    const base = resolveColorValue(flat, value.mix, mode);
    const percent = resolveNumber(flat, value.percent, mode);
    const alpha = base.alpha * (percent / 100);
    if (value.solid) {
      // Mixed into its surface: opaque, so whatever lies under it does not matter.
      if (!value.over) {
        throw new Error(`A solid mix needs an over surface: ${JSON.stringify(value)}`);
      }
      return { rgb: compositeOver(base.rgb, alpha, solidColor(flat, value.over, mode)), alpha: 1 };
    }
    return { rgb: base.rgb, alpha, over: value.over };
  }
  throw new Error(`Not a colour: ${JSON.stringify(value)}`);
}

export function resolveColor(flat, ref, mode) {
  return resolveColorValue(flat, ref, mode);
}

// Paints a layer onto an opaque surface reference (or rgb), returning rgb.
export function flatten(flat, layer, surface, mode) {
  if (layer.alpha >= 1) {
    return layer.rgb;
  }
  const under = surface ?? layer.over;
  if (!under) {
    throw new Error('A translucent colour needs a surface to sit on');
  }
  const underRgb = Array.isArray(under) ? under : solidColor(flat, under, mode);
  return compositeOver(layer.rgb, layer.alpha, underRgb);
}

// A colour reference resolved to opaque rgb, compositing onto its declared
// surface if it is translucent.
export function solidColor(flat, ref, mode) {
  const layer = resolveColor(flat, ref, mode);
  return flatten(flat, layer, undefined, mode);
}

export function pairModes(pair) {
  return pair.modes ?? MODES;
}

function refName(flat, ref) {
  return lookup(flat, ref).css ?? aliasPath(ref);
}

export function describeBg(flat, bg) {
  if (typeof bg === 'string') {
    return refName(flat, bg);
  }
  const percent = isAlias(bg.percent) ? refName(flat, bg.percent) : `${bg.percent}%`;
  return `${refName(flat, bg.mix)} ${percent}`;
}

export function pairId(flat, pair) {
  if (pair.id) {
    return pair.id;
  }
  const parts = [refName(flat, pair.fg), 'on', describeBg(flat, pair.bg)];
  if (pair.over) {
    parts.push('over', refName(flat, pair.over));
  }
  return parts
    .join(' ')
    .replace(/--/g, '')
    .replace(/[^a-z0-9]+/gi, '-');
}

// Resolves one declared pair in one mode to composited colours.
export function resolvePair(flat, pair, mode) {
  const bgLayer = resolveColorValue(flat, pair.bg, mode);
  const bgRgb = flatten(
    flat,
    bgLayer,
    pair.over ? solidColor(flat, pair.over, mode) : undefined,
    mode,
  );
  const fgLayer = resolveColorValue(flat, pair.fg, mode);
  const fgRgb = flatten(flat, fgLayer, bgRgb, mode);
  return { fgRgb: toRgb(fgRgb), bgRgb: toRgb(bgRgb) };
}

export function declaredPairs(flat) {
  return aplosExt(flat.root).contrastPairs ?? [];
}

export function colorTokens(flat) {
  return flat.tokens.filter(t => t.type === 'color');
}
