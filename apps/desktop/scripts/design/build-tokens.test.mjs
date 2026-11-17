import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as prettier from 'prettier';
import { generate, generateFormatted, remFromPx } from './build-tokens.mjs';
import { springLinear } from './spring.mjs';
import { GENERATED_DIR } from './tokens-lib.mjs';

const SCRIPT = fileURLToPath(new URL('./build-tokens.mjs', import.meta.url));
const HEADER = 'Generated from tokens.json by scripts/design/build-tokens.mjs. Do not edit.';

function runBuild(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

function rootBlock(css) {
  return css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
}

test('generation is deterministic and the committed files are current', () => {
  const first = generate();
  const second = generate();
  assert.deepEqual(first, second);
  const result = runBuild(['--check']);
  assert.equal(result.status, 0, result.stderr);
});

test('--check names a hand-edited generated file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aplos-tokens-'));
  try {
    cpSync(GENERATED_DIR, dir, { recursive: true });
    assert.equal(runBuild(['--check', '--out', dir]).status, 0);
    const cssPath = join(dir, 'tokens.css');
    writeFileSync(
      cssPath,
      readFileSync(cssPath, 'utf8').replace('--accent: #0b5394;', '--accent: #0050ff;'),
    );
    const result = runBuild(['--check', '--out', dir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /tokens\.css/);
    assert.doesNotMatch(result.stderr, /motion\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--check fails on a hand-made file in generated/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aplos-tokens-'));
  try {
    cpSync(GENERATED_DIR, dir, { recursive: true });
    writeFileSync(join(dir, 'extra.css'), ':root { --x: red; }\n');
    const result = runBuild(['--check', '--out', dir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /extra\.css \(not generated; remove it\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every generated file starts with the do-not-edit header', () => {
  const outputs = generate();
  assert.ok(outputs['tokens.css'].startsWith(`/* ${HEADER}`));
  assert.ok(outputs['motion.ts'].startsWith(`// ${HEADER}`));
  assert.equal(JSON.parse(outputs['contrast-pairs.json']).$comment, HEADER);
});

test('--font-mono is defined (baseline defect 9) and mockup leftovers are not carried over', () => {
  const css = generate()['tokens.css'];
  assert.match(rootBlock(css), /--font-mono: ui-monospace, "SF Mono", "Menlo", monospace;/);
  for (const leftover of [
    '--app-icon',
    '--icon-sky',
    '--dur-send',
    '--os-',
    '--avatar',
    '--page-top',
    '--float-bg',
    '--float-filter',
    '--elev-paper',
    '--radius-window',
  ]) {
    assert.ok(!css.includes(`${leftover}`), `${leftover} should not be generated`);
  }
});

test('Increase Contrast and reduced motion work through both hooks', () => {
  const css = generate()['tokens.css'];
  const more = [
    '--line: var(--control-edge);',
    '--line-strong: var(--control-edge);',
    '--faint: var(--dim);',
    '--focus-width: 3px;',
  ];
  const media = css.slice(
    css.indexOf('@media (prefers-contrast: more)'),
    css.indexOf(':root[data-contrast="more"],\n'),
  );
  const attr = css.slice(
    css.indexOf(':root[data-contrast="more"],\n'),
    css.indexOf('/* Reduced motion'),
  );
  for (const decl of more) {
    assert.ok(media.includes(decl), `media block lacks ${decl}`);
    assert.ok(attr.includes(decl), `attribute block lacks ${decl}`);
  }
  assert.match(
    media,
    /:root\[data-theme="dark"\]/,
    'contrast overrides must also beat the night block',
  );
  const reduced = css.slice(css.indexOf(':root[data-motion="reduced"] {'));
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  for (const decl of [
    '--move-carry: 0px;',
    '--move-flight-rotate: 0deg;',
    '--scale-lift: 1;',
    '--press-scale: 1;',
    '--dur-slide: 0ms;',
    '--dur-flight: 120ms;',
    '--play-status: paused;',
    '--breathe-hi: 0.85;',
    '--dur-toast-fade: 120ms;',
  ]) {
    assert.ok(reduced.includes(decl), `reduced block lacks ${decl}`);
  }
  assert.match(css, /:root\[data-theme-switching\] \*[\s\S]*transition: none !important;/);
});

test('generated motion.ts loads and matches the solver', async () => {
  const motion = await import(pathToFileURL(join(GENERATED_DIR, 'motion.ts')).href);
  assert.equal(motion.springs.slide.linear, springLinear({ stiffness: 600, damping: 42, mass: 1 }));
  assert.equal(motion.motionMs('carry', 'base'), 120);
  assert.equal(motion.motionMs('carry', 'base', { rapid: true }), 60);
  assert.equal(motion.motionMs('carry', 'base', { rapid: true, reduced: true }), 80);
  assert.equal(motion.motionMs('press', 'up'), 140);
  assert.equal(motion.motions['undo-send'].durations.base, 8000);
  assert.equal(motion.easings.out.css, 'cubic-bezier(0.16, 1, 0.3, 1)');
  assert.equal(motion.timingReduced.toastFade, 120);
});

test('arrive is deferred during rapid triage; nothing else is', async () => {
  const motion = await import(pathToFileURL(join(GENERATED_DIR, 'motion.ts')).href);
  assert.equal(motion.motionDeferred('arrive', { rapid: true }), true);
  assert.equal(motion.motionDeferred('arrive', { rapid: true, reduced: true }), true);
  assert.equal(motion.motionDeferred('arrive'), false);
  const deferred = Object.keys(motion.motions).filter(name =>
    motion.motionDeferred(name, { rapid: true }),
  );
  assert.deepEqual(deferred, ['arrive']);
});

test('sizes are emitted in rem (DESIGN 11.6) while hairlines, rings, edges, tracking and shadows stay px', () => {
  assert.equal(remFromPx('11px'), '0.6875rem');
  assert.equal(remFromPx('999px'), '62.4375rem');
  assert.equal(remFromPx('0px'), '0');
  assert.equal(remFromPx('16vh'), '16vh');
  const root = rootBlock(generate()['tokens.css']);
  for (const decl of [
    '--type-caption: 500 0.71875rem/1rem var(--font-sans);',
    '--type-summary: var(--w-summary) 1.3125rem/1.9375rem var(--font-serif);',
    '--space-1: 0.25rem;',
    '--space-half: 0.125rem;',
    '--control-md: 2rem;',
    '--kbd: 1.125rem;',
    '--row: 2.5rem;',
    '--focus-letter: 11.25rem;',
    '--sidebar-w: 14.5rem;',
    '--icon: 1rem;',
    '--radius-md: 0.5rem;',
    '--gutter: var(--space-8);',
    '--palette-top: 16vh;',
    '--measure-read: 64ch;',
    '--hairline: 0.75px;',
    '--icon-stroke: 1.5px;',
    '--focus-width: 2px;',
    '--focus-gap: 2px;',
    '--commit-edge: 3px;',
    '--select-bar: 2px;',
    '--thread-rail: 2px;',
    '--track: 2px;',
    '--seg-h: 3px;',
    '--move-carry: 28px;',
    '--track-title: calc(-0.16px + var(--track-boost));',
    '--track-boost: 0em;',
    '--track-boost-lowres: 0.005em;',
  ]) {
    assert.ok(root.includes(decl), `root lacks ${decl}`);
  }
  assert.match(root, /--elev-card: 0px 0px 0px var\(--hairline\)/);
  const sizeLines = root
    .split('\n')
    .filter(line =>
      /^\s+--(space|control|radius|row|focus-letter|icon|sidebar|list|reader|composer|dock|palette-w|settings|toast|sender|menu|switch|kbd)/.test(
        line,
      ),
    )
    .filter(line => !line.includes('--icon-stroke'));
  assert.ok(sizeLines.length > 40);
  for (const line of sizeLines) {
    assert.doesNotMatch(line, /\dpx/, `${line.trim()} should be in rem`);
  }
});

test('the serif stack lists the metric-matched fallback faces before the system serifs', () => {
  assert.match(
    rootBlock(generate()['tokens.css']),
    /--font-serif: "Newsreader", "Newsreader Fallback New York", "Newsreader Fallback Georgia", "New York", "Georgia", serif;/,
  );
});

test('z-index layers are emitted in CSS and motion.ts, increasing from sticky to tooltip', async () => {
  const order = ['sticky', 'dock', 'menu', 'toast', 'dialog', 'palette', 'tooltip'];
  const root = rootBlock(generate()['tokens.css']);
  const css = order.map(name => Number(new RegExp(`--z-${name}: (\\d+);`).exec(root)?.[1]));
  const motion = await import(pathToFileURL(join(GENERATED_DIR, 'motion.ts')).href);
  assert.deepEqual(Object.keys(motion.layers), order);
  assert.deepEqual(Object.values(motion.layers), css);
  for (let i = 1; i < css.length; i += 1) {
    assert.ok(
      Number.isInteger(css[i]) && css[i] > css[i - 1],
      `${order[i]} must sit above ${order[i - 1]}`,
    );
  }
});

test('every generated file is Prettier-formatted and stays deterministic', async () => {
  const first = await generateFormatted();
  const second = await generateFormatted();
  assert.deepEqual(first, second);
  for (const [name, text] of Object.entries(first)) {
    const filepath = join(GENERATED_DIR, name);
    const options = await prettier.resolveConfig(filepath);
    assert.equal(
      await prettier.format(text, { ...options, filepath }),
      text,
      `${name} is not Prettier-formatted`,
    );
  }
});

test('a tabular type role emits --num-<role>; other roles do not', () => {
  const root = rootBlock(generate()['tokens.css']);
  assert.ok(root.includes('--num-small: tabular-nums;'), 'root lacks --num-small: tabular-nums');
  const tabular = [...root.matchAll(/^\s+(--num-[a-z-]+):/gm)].map(m => m[1]);
  assert.deepEqual(tabular, ['--num-small']);
});
