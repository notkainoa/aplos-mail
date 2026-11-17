#!/usr/bin/env node
// Generates ui/generated/{tokens.css, motion.ts, contrast-pairs.json} from
// ui/tokens.json. Output is deterministic.
//
// Units (DESIGN 11.6, "everything is in rem"): tokens.json keeps px, the
// source of truth. A token whose group or own $extensions.aplos.rem is true has
// each px value written as rem here (px / 16, shortest decimal: 11px is
// 0.6875rem); `rem: false` keeps a token in px. So type sizes and line
// heights, spacing, controls, rows, layout sizes, icons and radii are rem, while
// hairlines, strokes, the focus ring, edges, bars, tracks, tracking, shadows
// and motion travel (moves in motion.ts) stay px. Values in ch, vh, em or %
// pass through unchanged.
//
// Type roles: --type-<role> is a font shorthand, --track-<role> its tracking,
// and a role with $extensions.aplos.tabular true also gets
// --num-<role>: tabular-nums for font-variant-numeric, which the shorthand
// would otherwise reset to normal.
//   node apps/desktop/scripts/design/build-tokens.mjs           write the files
//   node apps/desktop/scripts/design/build-tokens.mjs --check   exit 1 if any file on disk differs
// --tokens <path> and --out <dir> point at other copies (used by the tests).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as prettier from 'prettier';
import { fileURLToPath } from 'node:url';
import { toHex } from './color.mjs';
import { compileSpring } from './spring.mjs';
import {
  GENERATED_DIR,
  MODES,
  PAIR_MINIMUMS,
  TOKENS_PATH,
  aliasPath,
  declaredPairs,
  describeBg,
  flattenTokens,
  isAlias,
  lookup,
  pairId,
  pairModes,
  readJson,
  resolvePair,
} from './tokens-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SPRING_RUNTIME_PATH = join(here, 'spring-runtime.ts');
const HEADER_TEXT = 'Generated from tokens.json by scripts/design/build-tokens.mjs. Do not edit.';
const CSS_KEYWORD_FAMILIES = new Set([
  '-apple-system',
  'BlinkMacSystemFont',
  'system-ui',
  'ui-monospace',
  'ui-serif',
  'ui-sans-serif',
  'sans-serif',
  'serif',
  'monospace',
]);

// ---------- CSS values ----------

function cssRef(flat, ref) {
  const token = lookup(flat, ref);
  if (!token.css) {
    throw new Error(`${ref} has no CSS custom property`);
  }
  return `var(${token.css})`;
}

function cssColor(flat, value) {
  if (isAlias(value)) {
    return cssRef(flat, value);
  }
  if (typeof value === 'string') {
    return value;
  }
  const base = cssColor(flat, value.mix);
  const percent = isAlias(value.percent) ? cssRef(flat, value.percent) : `${value.percent}%`;
  // `solid: true` mixes into the `over` surface instead of transparent, so the
  // result is opaque and the same whatever it is painted on.
  const rest = value.solid ? cssColor(flat, value.over) : 'transparent';
  return `color-mix(in srgb, ${base} ${percent}, ${rest})`;
}

function cssPlain(flat, value) {
  return isAlias(value) ? cssRef(flat, value) : String(value);
}

const REM_BASE = 16;

// "11px" -> "0.6875rem". Anything that is not a plain px length is returned as is.
export function remFromPx(value) {
  const match = /^(-?\d*\.?\d+)px$/.exec(String(value));
  if (!match) {
    return String(value);
  }
  const n = Number(match[1]);
  return n === 0 ? '0' : `${Number((n / REM_BASE).toFixed(4))}rem`;
}

function cssDimension(flat, token, value) {
  if (isAlias(value)) {
    return cssRef(flat, value);
  }
  return token.rem ? remFromPx(value) : String(value);
}

function cssFamily(list) {
  return list.map(name => (CSS_KEYWORD_FAMILIES.has(name) ? name : `"${name}"`)).join(', ');
}

function cssShadow(flat, layers) {
  return layers
    .map(layer => {
      const parts = [layer.offsetX, layer.offsetY, layer.blur, layer.spread].map(v =>
        cssPlain(flat, v),
      );
      const inset = layer.inset ? 'inset ' : '';
      return `${inset}${parts.join(' ')} ${cssColor(flat, layer.color)}`;
    })
    .join(', ');
}

function cssBezier(points) {
  if (points.join(',') === '0,0,1,1') {
    return 'linear';
  }
  return `cubic-bezier(${points.join(', ')})`;
}

function cssNumber(token, value) {
  return token.ext.unit ? `${value}${token.ext.unit}` : String(value);
}

function durationVar(token, phase) {
  return phase === 'base' ? token.css : `${token.css}-${phase}`;
}

function playVar(token) {
  return `--play-${token.key}`;
}

// Declarations a token contributes for a raw value (light, dark or more).
function declarations(flat, token, value, springCache) {
  switch (token.type) {
    case 'color':
      return [[token.css, cssColor(flat, value)]];
    case 'dimension':
      return [[token.css, cssDimension(flat, token, value)]];
    case 'string':
    case 'duration':
      return [[token.css, cssPlain(flat, value)]];
    case 'number':
      return [[token.css, cssNumber(token, value)]];
    case 'fontFamily':
      return [[token.css, cssFamily(value)]];
    case 'shadow':
      return [[token.css, cssShadow(flat, value)]];
    case 'cubicBezier':
      return [[token.css, cssBezier(value)]];
    case 'spring':
      return [[token.css, springCache.get(token.path).linear]];
    case 'typography':
      return typographyDeclarations(flat, token, value);
    case 'motion':
      return motionDeclarations(token, value);
    default:
      throw new Error(`No CSS for $type ${token.type} (${token.path})`);
  }
}

function typographyDeclarations(flat, token, value) {
  const role = token.key;
  const family = cssRef(flat, value.fontFamily);
  const unit = v => (token.rem ? remFromPx(v) : String(v));
  const size = `${unit(value.fontSize)}/${unit(value.lineHeight)}`;
  const out = [];
  if (token.ext.opsz !== undefined) {
    out.push([`--w-${role}`, String(value.fontWeight)]);
    out.push([token.css, `var(--w-${role}) ${size} ${family}`]);
  } else {
    out.push([token.css, `${value.fontWeight} ${size} ${family}`]);
  }
  out.push([`--track-${role}`, trackValue(flat, value.letterSpacing)]);
  if (token.ext.opsz !== undefined) {
    out.push([`--opsz-${role}`, String(token.ext.opsz)]);
  }
  // `tabular: true` (DESIGN 4.3: small is tabular) becomes --num-<role>. The
  // font shorthand resets font-variant-numeric, so a rule that writes
  // `font: var(--type-small)` pairs it with `font-variant-numeric: var(--num-small)`.
  if (token.ext.tabular) {
    out.push([`--num-${role}`, 'tabular-nums']);
  }
  return out;
}

// Each role's tracking plus the shared boost (tracking.boost), which base.css
// raises on non-Retina screens. Without a boost token the value is plain.
function trackValue(flat, letterSpacing) {
  const boost = flat.byPath.get('tracking.boost');
  return boost && boost.css ? `calc(${letterSpacing} + var(${boost.css}))` : String(letterSpacing);
}

function motionDeclarations(token, value) {
  const out = Object.entries(value.durations).map(([phase, d]) => [durationVar(token, phase), d]);
  if (value.reducedMode === 'static') {
    out.push([playVar(token), 'running']);
  }
  return out;
}

function darkDeclarations(flat, token) {
  if (token.dark === undefined) {
    return [];
  }
  if (token.type === 'typography') {
    return [[`--w-${token.key}`, String(token.dark.fontWeight)]];
  }
  return declarations(flat, token, token.dark);
}

function reducedDeclarations(token) {
  if (token.type === 'motion') {
    const value = token.value;
    const out = [];
    for (const [phase, d] of Object.entries(value.durations)) {
      const reduced = value.reduced[phase];
      if (reduced !== d) {
        out.push([durationVar(token, phase), reduced]);
      }
    }
    if (value.reducedMode === 'static') {
      out.push([playVar(token), 'paused']);
    }
    return out;
  }
  if (token.reduced === undefined || !token.css) {
    return [];
  }
  return [
    [token.css, token.type === 'number' ? cssNumber(token, token.reduced) : String(token.reduced)],
  ];
}

function block(selector, decls, indent = '') {
  const lines = decls.map(([name, value]) => `${indent}  ${name}: ${value};`);
  return `${indent}${selector} {\n${lines.join('\n')}\n${indent}}`;
}

export function buildCss(flat, springCache) {
  const cssTokens = flat.tokens.filter(t => t.css);
  const light = [['color-scheme', 'light']];
  for (const token of cssTokens) {
    light.push(...declarations(flat, token, token.value, springCache));
  }
  const dark = [['color-scheme', 'dark']];
  for (const token of cssTokens) {
    dark.push(...darkDeclarations(flat, token));
  }
  const more = cssTokens
    .filter(t => t.more !== undefined)
    .flatMap(t => declarations(flat, t, t.more, springCache));
  const reduced = cssTokens.flatMap(t => reducedDeclarations(t));
  return (
    [
      `/* ${HEADER_TEXT}\n   Paper design tokens (plans/DESIGN.md section 4). Hooks: :root is light,\n   :root[data-theme="dark"] is night, Increase Contrast is prefers-contrast: more\n   or :root[data-contrast="more"], reduced motion is prefers-reduced-motion: reduce\n   or :root[data-motion="reduced"]. */`,
      block(':root', light),
      block(':root[data-theme="dark"]', dark),
      '/* Increase Contrast. The dark selector is repeated so these win over the night block. */',
      `@media (prefers-contrast: more) {\n${block(':root,\n  :root[data-theme="dark"]', more, '  ')}\n}`,
      block(':root[data-contrast="more"],\n:root[data-theme="dark"][data-contrast="more"]', more),
      '/* Reduced motion: durations take their reduced values, travel and scale go neutral,\n   static loops pause. CSS that uses these tokens is neutralised without extra rules. */',
      `@media (prefers-reduced-motion: reduce) {\n${block(':root', reduced, '  ')}\n}`,
      block(':root[data-motion="reduced"]', reduced),
      '/* Theme switch: set data-theme-switching on :root for one frame so the app changes at once. */',
      block(
        ':root[data-theme-switching] *,\n:root[data-theme-switching] *::before,\n:root[data-theme-switching] *::after',
        [['transition', 'none !important']],
      ),
    ].join('\n\n') + '\n'
  );
}

// ---------- motion.ts ----------

export function parseDuration(value) {
  const match = /^(-?\d*\.?\d+)(ms|s)$/.exec(String(value));
  if (!match) {
    throw new Error(`Not a duration: ${value}`);
  }
  const n = Number(match[1]);
  return match[2] === 's' ? Math.round(n * 1000) : n;
}

function parseLength(value) {
  const match = /^(-?\d*\.?\d+)(px|deg)$/.exec(String(value));
  if (!match) {
    throw new Error(`Not a px or deg length: ${value}`);
  }
  return Number(match[1]);
}

function msMap(durations) {
  return Object.fromEntries(Object.entries(durations).map(([k, v]) => [k, parseDuration(v)]));
}

function tsLiteral(value, indent = '') {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(v => tsLiteral(v)).join(', ')}]`;
  }
  const inner = indent + '  ';
  const tsKey = k => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
  const flatEntries = Object.values(value).every(v => v === null || typeof v !== 'object');
  if (flatEntries) {
    const inline = `{ ${Object.entries(value)
      .map(([k, v]) => `${tsKey(k)}: ${tsLiteral(v)}`)
      .join(', ')} }`;
    if (inline.length <= 72) {
      return inline;
    }
  }
  const entries = Object.entries(value).map(
    ([k, v]) => `${inner}${tsKey(k)}: ${tsLiteral(v, inner)},`,
  );
  return `{\n${entries.join('\n')}\n${indent}}`;
}

function curveInfo(flat, ref, springCache) {
  if (ref === null || ref === undefined) {
    return { curve: null, curveName: null };
  }
  const token = lookup(flat, ref);
  const css = token.type === 'spring' ? springCache.get(token.path).linear : cssBezier(token.value);
  return { curve: css, curveName: aliasPath(ref) };
}

// "same": rapid keeps the normal durations. "defer-until-hold": during a burst
// the motion waits for hold to end, then plays at its normal durations.
const RAPID_KEYWORDS = new Set(['same', 'defer-until-hold']);

function groupTokens(flat, group) {
  return flat.tokens.filter(t => t.group === group);
}

function camel(key) {
  return key.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function springRuntimeSource() {
  return readFileSync(SPRING_RUNTIME_PATH, 'utf8').trim();
}

export function buildMotionTs(flat, springCache) {
  const easings = {};
  for (const t of groupTokens(flat, 'ease')) {
    easings[t.key] = { css: cssBezier(t.value), points: t.value };
  }
  const springs = {};
  for (const t of groupTokens(flat, 'spring')) {
    springs[t.key] = springCache.get(t.path);
  }
  const motions = {};
  for (const t of groupTokens(flat, 'motion')) {
    const v = t.value;
    const durations = msMap(v.durations);
    const { curve, curveName } = curveInfo(flat, v.curve, springCache);
    const spec = {
      durations,
      rapid: RAPID_KEYWORDS.has(v.rapid) ? durations : msMap(v.rapid),
      deferWhenRapid: v.rapid === 'defer-until-hold',
      reduced: msMap(v.reduced),
      reducedMode: v.reducedMode,
      curve,
      curveName,
    };
    if (v.curveOut) {
      const out = curveInfo(flat, v.curveOut, springCache);
      spec.curveOut = out.curve;
      spec.curveOutName = out.curveName;
    }
    motions[t.key] = spec;
  }
  const moves = Object.fromEntries(
    groupTokens(flat, 'move').map(t => [camel(t.key), parseLength(t.value)]),
  );
  const scales = Object.fromEntries(groupTokens(flat, 'scale').map(t => [camel(t.key), t.value]));
  const breathe = Object.fromEntries(
    groupTokens(flat, 'breathe').map(t => [camel(t.key), t.value]),
  );
  const layers = Object.fromEntries(groupTokens(flat, 'layer').map(t => [camel(t.key), t.value]));
  const timingTokens = groupTokens(flat, 'timing');
  const timing = Object.fromEntries(
    timingTokens.map(t => [camel(t.key), t.type === 'number' ? t.value : parseDuration(t.value)]),
  );
  const timingReduced = Object.fromEntries(
    timingTokens
      .filter(t => t.reduced !== undefined)
      .map(t => [camel(t.key), parseDuration(t.reduced)]),
  );

  return `// ${HEADER_TEXT}
// Paper motion tokens (plans/DESIGN.md section 4.8) and stacking layers.
// Durations are in ms, moves in px (flightRotate in deg): the runtime needs
// pixel travel even though CSS sizes are in rem. The spring solver below is
// inlined from scripts/design/spring-runtime.ts.

${springRuntimeSource()}

export type ReducedMode = "none" | "opacity" | "colour" | "static" | "same";

export interface Easing {
  readonly css: string;
  readonly points: readonly [number, number, number, number];
}

export interface SpringToken extends SpringParams {
  readonly dampingRatio: number;
  readonly settleMs: number;
  readonly linear: string;
}

export interface MotionSpec {
  readonly durations: Readonly<Record<string, number>>;
  readonly rapid: Readonly<Record<string, number>>;
  // During rapid triage the motion must not start until hold ends (arrive).
  readonly deferWhenRapid: boolean;
  readonly reduced: Readonly<Record<string, number>>;
  readonly reducedMode: ReducedMode;
  readonly curve: string | null;
  readonly curveName: string | null;
  readonly curveOut?: string;
  readonly curveOutName?: string;
}

export const easings = ${tsLiteral(easings)} as const satisfies Record<string, Easing>;

export type EasingName = keyof typeof easings;

export const springs = ${tsLiteral(springs)} as const satisfies Record<string, SpringToken>;

export type SpringName = keyof typeof springs;

export const motions = ${tsLiteral(motions)} as const satisfies Record<string, MotionSpec>;

export type MotionName = keyof typeof motions;

export type MotionPhase<N extends MotionName> = keyof (typeof motions)[N]["durations"] & string;

export const moves = ${tsLiteral(moves)} as const;

export const scales = ${tsLiteral(scales)} as const;

export const breathe = ${tsLiteral(breathe)} as const;

export const timing = ${tsLiteral(timing)} as const;

// Stacking layers (z-index), lowest to highest; the same values as the --z-* CSS
// variables. Use these only where a style is written from TS.
export const layers = ${tsLiteral(layers)} as const;

export type LayerName = keyof typeof layers;

// Timing values that change under reduced motion.
export const timingReduced = ${tsLiteral(timingReduced)} as const satisfies Partial<Record<keyof typeof timing, number>>;

export const themeHooks = {
  theme: "data-theme",
  contrast: "data-contrast",
  motion: "data-motion",
  switching: "data-theme-switching",
  contrastQuery: "(prefers-contrast: more)",
  reducedMotionQuery: "(prefers-reduced-motion: reduce)",
} as const;

export interface MotionContext {
  readonly rapid?: boolean;
  readonly reduced?: boolean;
}

// True when a motion must wait for hold to end instead of playing now.
export function motionDeferred(name: MotionName, context: MotionContext = {}): boolean {
  const spec: MotionSpec = motions[name];
  return Boolean(context.rapid) && spec.deferWhenRapid;
}

// The duration of one phase of a named motion. Reduced wins over rapid. For a
// motion with deferWhenRapid, check motionDeferred() first.
export function motionMs<N extends MotionName>(name: N, phase: MotionPhase<N>, context: MotionContext = {}): number {
  const spec: MotionSpec = motions[name];
  if (context.reduced) {
    return spec.reduced[phase];
  }
  if (context.rapid) {
    return spec.rapid[phase];
  }
  return spec.durations[phase];
}
`;
}

// ---------- contrast-pairs.json ----------

function round6(rgb) {
  return rgb.map(c => Math.round(c * 1e6) / 1e6);
}

function cssName(flat, ref) {
  return ref ? lookup(flat, ref).css : undefined;
}

export function pairsDocument(flat) {
  const pairs = [];
  const seen = new Set();
  for (const pair of declaredPairs(flat)) {
    for (const mode of pairModes(pair)) {
      const id = pairId(flat, pair);
      if (seen.has(`${id} ${mode}`)) {
        throw new Error(`Contrast pair ${id} is declared twice for ${mode}; give one an "id"`);
      }
      seen.add(`${id} ${mode}`);
      const { fgRgb, bgRgb } = resolvePair(flat, pair, mode);
      const entry = {
        id,
        mode,
        fg: cssName(flat, pair.fg),
        bg: describeBg(flat, pair.bg),
        over: cssName(flat, pair.over),
        kind: pair.kind,
        min: pair.min ?? PAIR_MINIMUMS[pair.kind],
        usage: pair.usage,
        fgHex: toHex(fgRgb),
        bgHex: toHex(bgRgb),
        fgRgb: round6(fgRgb),
        bgRgb: round6(bgRgb),
      };
      if (pair.exception) {
        entry.exception = pair.exception;
      }
      pairs.push(entry);
    }
  }
  return { $comment: HEADER_TEXT, modes: MODES, pairs };
}

export function buildPairs(flat) {
  const json = JSON.stringify(pairsDocument(flat), null, 2).replace(
    /\[\s+([^[\]{}]*?)\s+\]/g,
    (_, inner) => `[${inner.split(/,\s+/).join(', ')}]`,
  );
  return `${json}\n`;
}

// ---------- driver ----------

function compileSprings(flat) {
  const cache = new Map();
  for (const token of flat.tokens.filter(t => t.type === 'spring')) {
    cache.set(token.path, compileSpring(token.value));
  }
  return cache;
}

export function generate(tokensPath = TOKENS_PATH) {
  const flat = flattenTokens(readJson(tokensPath));
  const springCache = compileSprings(flat);
  return {
    'tokens.css': buildCss(flat, springCache),
    'motion.ts': buildMotionTs(flat, springCache),
    'contrast-pairs.json': buildPairs(flat),
  };
}

// Format every output with the repository's Prettier config. Options come from
// the committed file's path, not the write target, so --out copies format the
// same way as generated/.
export async function formatOutputs(outputs) {
  const formatted = {};
  for (const [name, content] of Object.entries(outputs)) {
    const filepath = join(GENERATED_DIR, name);
    const options = await prettier.resolveConfig(filepath);
    formatted[name] = await prettier.format(content, { ...options, filepath });
  }
  return formatted;
}

export async function generateFormatted(tokensPath = TOKENS_PATH) {
  return formatOutputs(generate(tokensPath));
}

// Generated files that differ from disk, plus any file in the output folder
// the generator does not make (generated/ is exempt from the raw-colour lint,
// so nothing hand-made may live there).
export function diffOutputs(outputs, outDir) {
  const changed = Object.entries(outputs)
    .filter(([name, content]) => {
      const path = join(outDir, name);
      return !existsSync(path) || readFileSync(path, 'utf8') !== content;
    })
    .map(([name]) => name);
  const stray = existsSync(outDir) ? readdirSync(outDir).filter(name => !(name in outputs)) : [];
  return [...changed, ...stray.map(name => `${name} (not generated; remove it)`)];
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args) {
  const tokensPath = resolve(argValue(args, '--tokens') ?? TOKENS_PATH);
  const outDir = resolve(argValue(args, '--out') ?? GENERATED_DIR);
  const outputs = await generateFormatted(tokensPath);
  if (args.includes('--check')) {
    const stale = diffOutputs(outputs, outDir);
    if (stale.length > 0) {
      console.error(`Generated files differ from tokens.json: ${stale.join(', ')}`);
      console.error(
        'Run node apps/desktop/scripts/design/build-tokens.mjs and do not edit generated files by hand.',
      );
      process.exit(1);
    }
    console.log(`Generated files match tokens.json (${Object.keys(outputs).join(', ')}).`);
    return;
  }
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(outputs)) {
    writeFileSync(join(outDir, name), content);
  }
  console.log(`Wrote ${Object.keys(outputs).join(', ')} to ${outDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error);
    process.exit(1);
  });
}
