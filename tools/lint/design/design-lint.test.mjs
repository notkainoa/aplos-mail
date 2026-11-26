import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { alwaysExclude, exclude, repoRoot } from './config.mjs';
import { matchesAny } from './lib/glob.mjs';
import { lintFile, lintText } from './lib/lint.mjs';
import { parseValue } from './lib/value.mjs';
import { rules, ruleById } from './rules/index.mjs';
import { BANNED_PHRASES } from './rules/no-banned-string.mjs';
import eslintPlugin from './eslint-plugin.mjs';
import stylelintPlugins from './stylelint-plugin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const runScript = path.join(here, 'run.mjs');

const EXPECTED_RULES = [
  'no-raw-color',
  'no-decoration',
  'no-literal-motion',
  'no-layout-motion',
  'hover-no-layout',
  'no-literal-size',
  'no-static-will-change',
  'reduced-motion-covered',
  'no-banned-icon',
  'no-banned-string',
  'button-variant',
];

// The fewest distinct violations each bad fixture must plant. The fixtures may
// grow; they may not shrink without this table changing in review.
const MIN_PLANTED = {
  'no-raw-color': { css: 19, tsx: 24 },
  'no-decoration': { css: 24, tsx: 28 },
  'no-literal-motion': { css: 13, tsx: 26 },
  'no-layout-motion': { css: 26, tsx: 14 },
  'hover-no-layout': { css: 18, tsx: 6 },
  'no-literal-size': { css: 32, tsx: 20 },
  'no-static-will-change': { css: 4, tsx: 5 },
  'reduced-motion-covered': { css: 12, tsx: 7 },
  'no-banned-icon': { css: 8, tsx: 31 },
  'no-banned-string': { css: 3, tsx: 58 },
  'button-variant': { tsx: 14 },
};

function markerLines(file) {
  const lines = new Set();
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (line.includes('@expect')) lines.add(index + 1);
    });
  return lines;
}

function fixtureFiles(ruleId, stem) {
  return fs
    .readdirSync(path.join(fixtures, ruleId))
    .filter(name => name.startsWith(`${stem}.`))
    .map(name => path.join(fixtures, ruleId, name));
}

function runCli(args) {
  const result = spawnSync(process.execPath, [runScript, ...args], {
    encoding: 'utf8',
    cwd: repoRoot,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function violationsOf(ruleId, text, file = 'snippet.tsx') {
  return lintText({ path: file, text, rules: [ruleById(ruleId)] });
}

test('the eleven rules exist, are unique and follow the module contract', () => {
  assert.deepEqual(rules.map(rule => rule.id).sort(), [...EXPECTED_RULES].sort());
  for (const rule of rules) {
    assert.equal(typeof rule.check, 'function', rule.id);
    assert.ok(rule.description.length > 20, rule.id);
    assert.ok(
      rule.appliesTo.length > 0 && rule.appliesTo.every(kind => kind === 'css' || kind === 'ts'),
      rule.id,
    );
    assert.ok(fs.existsSync(path.join(here, 'rules', `${rule.id}.mjs`)), rule.id);
  }
});

for (const ruleId of EXPECTED_RULES) {
  test(`${ruleId}: the bad fixtures report exactly the planted lines`, () => {
    const rule = ruleById(ruleId);
    const bad = fixtureFiles(ruleId, 'bad');
    assert.ok(bad.length > 0, 'a bad fixture exists');
    for (const file of bad) {
      const ext = path.extname(file).slice(1);
      const planted = markerLines(file);
      assert.ok(
        planted.size >= MIN_PLANTED[ruleId][ext],
        `${path.basename(file)} plants at least ${MIN_PLANTED[ruleId][ext]} violations, found ${planted.size}`,
      );
      const reports = lintFile(file, [rule]);
      const reported = new Set(reports.map(report => report.line));
      assert.deepEqual(
        [...reported].sort((a, b) => a - b),
        [...planted].sort((a, b) => a - b),
        path.basename(file),
      );
      assert.ok(reports.length >= planted.size);
    }
  });

  test(`${ruleId}: the good fixtures are clean`, () => {
    const rule = ruleById(ruleId);
    const good = fixtureFiles(ruleId, 'good');
    assert.ok(good.length > 0, 'a good fixture exists');
    for (const file of good) assert.deepEqual(lintFile(file, [rule]), [], path.basename(file));
  });

  test(`${ruleId}: a fixture exists for every kind the rule applies to`, () => {
    const rule = ruleById(ruleId);
    const names = fs.readdirSync(path.join(fixtures, ruleId));
    if (rule.appliesTo.includes('css'))
      assert.ok(names.includes('bad.css') && names.includes('good.css'));
    if (rule.appliesTo.includes('ts'))
      assert.ok(names.includes('bad.tsx') && names.includes('good.tsx'));
  });
}

test('run.mjs exits 1 on the bad fixtures and prints file:line:col rule-id message', () => {
  const bad = EXPECTED_RULES.flatMap(ruleId => fixtureFiles(ruleId, 'bad'));
  const { status, stdout } = runCli(['--no-ignore', ...bad]);
  assert.equal(status, 1);
  const lines = stdout.split('\n').filter(line => /^.+:\d+:\d+ \S+ .+/.test(line));
  assert.ok(lines.length >= 300, `found ${lines.length} report lines`);
  for (const ruleId of EXPECTED_RULES) {
    assert.ok(
      lines.some(line => line.includes(` ${ruleId} `)),
      `${ruleId} appears in the CLI output`,
    );
  }
  const single = runCli([
    '--no-ignore',
    '--rule',
    'button-variant',
    path.join(fixtures, 'button-variant', 'bad.tsx'),
  ]);
  assert.equal(single.status, 1);
  assert.match(
    single.stdout.split('\n')[0],
    /^.+bad\.tsx:\d+:\d+ button-variant Button variant "pill"/,
  );
});

test('run.mjs exits 0 on the whole good set with every rule on', () => {
  const good = EXPECTED_RULES.flatMap(ruleId => fixtureFiles(ruleId, 'good'));
  assert.ok(good.length >= 17);
  const { status, stdout } = runCli(['--no-ignore', ...good]);
  assert.equal(status, 0, stdout);
});

test('run.mjs --json prints an array and --rule filters', () => {
  const file = path.join(fixtures, 'no-raw-color', 'bad.css');
  const all = JSON.parse(runCli(['--no-ignore', '--json', file]).stdout);
  const only = JSON.parse(runCli(['--no-ignore', '--json', '--rule', 'no-raw-color', file]).stdout);
  assert.ok(only.length >= 19);
  assert.ok(
    only.every(
      item => item.rule === 'no-raw-color' && item.line > 0 && item.column > 0 && item.message,
    ),
  );
  assert.ok(all.length >= only.length);
  assert.equal(runCli(['--rule', 'no-such-rule', file]).status, 2);
});

test("the default scope over today's tree passes, and the exempt files are exempt", () => {
  const { status, stdout } = runCli([]);
  assert.equal(status, 0, stdout);
  const exempt = [
    'apps/desktop/src/renderer/ui/tokens.json',
    'apps/desktop/src/renderer/ui/generated/tokens.css',
    'apps/desktop/src/renderer/ui/generated/motion.ts',
    'apps/desktop/src/renderer/ui/generated/contrast-pairs.json',
    'tools/lint/design/fixtures/no-raw-color/bad.css',
  ];
  for (const file of exempt) assert.ok(matchesAny(file, alwaysExclude), file);
  const covered = [
    'apps/desktop/src/renderer/home/Home.tsx',
    'apps/desktop/src/renderer/ui/Button.css',
    'apps/desktop/src/renderer/commands/types.ts',
    'apps/desktop/src/renderer/home/fixtures/mail.tsx',
    'apps/desktop/src/renderer/ui/tokens.css',
    'apps/desktop/src/renderer/ui/motion.ts',
  ];
  for (const file of covered) assert.ok(!matchesAny(file, exclude), file);
});

test('evasions from plan 30 WP1.3 are caught', () => {
  const cases = [
    ['no-raw-color', 'export const c = `${prefix} #0b5394`;'],
    ['no-raw-color', "export const m = 'color-mix(in srgb, #0b5394 8%, transparent)';"],
    ['no-raw-color', "export const n = 'color-mix(in srgb, red 20%, var(--paper))';"],
    ['no-raw-color', "export const s = <i style={{ color: 'rgb(' + r + ',0,0)' }} />;"],
    ['no-literal-motion', "export const s = <i style={{ transition: 'all 120ms' }} />;"],
    ['no-layout-motion', "export const s = <i style={{ transition: 'all 120ms' }} />;"],
    ['no-literal-size', "export const s = <i style={{ padding: '0 7px' }} />;"],
    ['no-literal-motion', "export const s = <i style={{ '--x': '120ms' }} />;"],
    ['no-literal-motion', 'setTimeout(() => { el.style.opacity = "0"; }, 250);'],
    [
      'no-literal-motion',
      'setTimeout(() => { el.classList.add("leaving"); el.classList.add("animate-out"); }, 250);',
    ],
    ['no-literal-size', "const pad = '0 7px'; export const s = <i style={{ padding: pad }} />;"],
    [
      'no-literal-motion',
      "const t = 'opacity 200ms'; export const s = <i style={{ transition: t }} />;",
    ],
    ['no-banned-string', "const label = 'Hide all'; export const s = <button>{label}</button>;"],
    ['button-variant', "const v = 'ghost'; export const s = <Button variant={v} />;"],
    ['no-raw-color', "export const c = '#0b' + '5394';"],
    ['no-raw-color', 'export const s = <path fill="red" />;'],
    ['no-raw-color', "const theme = { color: 'red' }; export const s = <div style={theme} />;"],
    ['no-literal-size', 'const n = 7; export const s = <div style={{ margin: `${n}px` }} />;'],
    ['no-literal-size', 'const box = { padding: 7 }; export const s = <div style={box} />;'],
    ['no-literal-motion', 'const opts = { duration: 240 }; el.animate(kf, opts);'],
    ['no-literal-motion', 'const D = 240; el.animate(kf, { duration: D });'],
    ['no-literal-motion', "export const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';"],
    ['no-decoration', "export const s = { transform: 'rotate3d(0, 1, 0, 14deg)' };"],
    ['no-banned-icon', 'export const s = <DynamicIcon name="wand-sparkles" />;'],
    ['no-banned-icon', "import { Sparkles as Ai } from './glyphs'; export const s = <Ai />;"],
    ['no-banned-string', "declare const toast: any; toast('All clear for now!');"],
    ['no-banned-string', "export const g = group('No reply yet', rows);"],
    ['no-banned-string', "export const s = { emptyLabel: 'Ready when you are' };"],
    ['reduced-motion-covered', 'el.animate(kf, { duration: dur.quick, iterations: Infinity });'],
    [
      'hover-no-layout',
      'export const s = <div onMouseEnter={() => setHovered(true)}>{hovered && <kbd>E</kbd>}</div>;',
    ],
    [
      'button-variant',
      'import { Button as Btn } from \'./ui\'; export const s = <Btn variant="pill" />;',
    ],
  ];
  for (const [ruleId, text] of cases) {
    assert.ok(violationsOf(ruleId, text).length >= 1, `${ruleId}: ${text}`);
  }
  assert.ok(
    violationsOf('no-literal-motion', '.a { --x: 120ms; transition: opacity var(--x); }', 'a.css')
      .length >= 1,
  );
  assert.ok(violationsOf('no-literal-size', '.a { padding: 0 7px; }', 'a.css').length >= 1);
});

test('legitimate code is not flagged', () => {
  const cases = [
    ['no-literal-motion', 'setTimeout(() => { el.focus(); }, 250);'],
    ['no-literal-motion', 'setTimeout(() => { el.style.opacity = "0"; }, dur.carry);'],
    [
      'no-banned-string',
      'export const route = { id: \'todo\', kind: \'airmail\' }; export const s = <div className="todo" data-kind="smart" />;',
    ],
    ['no-banned-string', 'export const s = <p>Back from Later</p>;'],
    ['no-raw-color', "export const s = 'Issue #12 and rgb values'; export const a = '#main';"],
    [
      'no-banned-icon',
      "import { Bookmark, Restart } from 'lucide-react'; export const s = <Bookmark />;",
    ],
    ['no-literal-size', 'export const layout = { top: 40, height: 120, gap: 8 };'],
    ['button-variant', 'export const s = <Button variant={busy ? "filled" : "text"} />;'],
    ['no-banned-icon', 'export const s = <span data-state="star" />;'],
    ['no-banned-icon', "import { useStarred } from './hooks';"],
    [
      'no-raw-color',
      "export const issue = 'Fixes #123'; export const a = location.hash === '#add';",
    ],
    [
      'no-banned-string',
      "export const n = () => { console.log('Done!'); return list.includes('todo'); };",
    ],
    [
      'no-literal-motion',
      "import { ease } from './ui/generated/motion'; el.animate(kf, { duration: dur.carry, easing: ease.carry });",
    ],
  ];
  for (const [ruleId, text] of cases) {
    assert.deepEqual(violationsOf(ruleId, text), [], `${ruleId}: ${text}`);
  }
});

test('every banned phrase, class name and reference hex fails when planted in a new component', () => {
  for (const phrase of BANNED_PHRASES) {
    const text = `export const A = () => <p>${phrase}</p>;`;
    assert.ok(violationsOf('no-banned-string', text).length >= 1, phrase);
    const upper = `export const A = () => <p aria-label="${phrase.toUpperCase()}" />;`;
    assert.ok(violationsOf('no-banned-string', upper).length >= 1, `${phrase} upper-case`);
  }
  const classes = [
    'post-edge',
    'airmail',
    'skyscene',
    'sky-scene',
    'dock-pill',
    'deck',
    'has-next',
    'low-line',
    'reader-dock',
  ];
  for (const name of classes) {
    assert.ok(
      violationsOf('no-decoration', `export const A = () => <div className="pane ${name}" />;`)
        .length >= 1,
      name,
    );
    assert.ok(
      violationsOf('no-decoration', `.${name} { color: var(--ink); }`, 'a.css').length >= 1,
      `${name} css`,
    );
  }
  const hexes = ['#0050ff', '#07aa04', '#03ce4c', '#e5e4e1', '#0682fe', '#0a9c0a'];
  for (const hex of hexes) {
    assert.ok(violationsOf('no-raw-color', `export const c = '${hex}';`).length >= 1, hex);
    assert.ok(
      violationsOf('no-raw-color', `.a { color: ${hex}; }`, 'a.css').length >= 1,
      `${hex} css`,
    );
  }
  assert.ok(
    violationsOf('no-decoration', 'export const t = "perspective(1400px) rotateY(14deg)";')
      .length >= 1,
  );
});

test('banned icon names are matched by word, so Restart and Start stay legal', () => {
  const banned = [
    'Sparkles',
    'Wand2',
    'WandSparkles',
    'Stars',
    'StarOff',
    'BrainCircuit',
    'BotMessageSquare',
    'RobotIcon',
    'StarIcon',
    'Sparkle',
  ];
  for (const name of banned) {
    const text = `import { ${name} } from 'lucide-react'; export const A = () => <${name} />;`;
    assert.ok(violationsOf('no-banned-icon', text).length >= 2, name);
  }
  const allowed = ['Restart', 'StartIcon', 'Bookmark', 'Both', 'Clock'];
  for (const name of allowed) {
    assert.deepEqual(
      violationsOf('no-banned-icon', `import { ${name} } from 'lucide-react';`),
      [],
      name,
    );
  }
});

test('the value tokenizer splits nested functions and keeps var fallbacks', () => {
  const nodes = parseValue(
    '0 0 0 var(--a, calc(1px + 2px)) color-mix(in srgb, var(--ink) 8%, transparent), url(x.png)',
  );
  const names = nodes.filter(node => node.type === 'fn').map(node => node.name);
  assert.deepEqual(names, ['var', 'color-mix', 'url']);
  const variable = nodes.find(node => node.type === 'fn' && node.name === 'var');
  assert.equal(variable.args.length, 2);
});

test('the ESLint adapter reports core violations at core locations', () => {
  assert.ok(eslintPlugin.rules['no-raw-color'] && eslintPlugin.rules['button-variant']);
  assert.ok(eslintPlugin.rules['reduced-motion-covered'], 'loops are checked in TS too');
  const reports = [];
  const context = {
    filename: 'x.tsx',
    sourceCode: { text: "export const c = '#fff';\n" },
    report: item => reports.push(item),
  };
  eslintPlugin.rules['no-raw-color'].create(context).Program();
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].loc, { line: 1, column: 17 });
  assert.equal(reports[0].messageId, 'violation');
  assert.ok(eslintPlugin.configs.all.rules['aplos-design/no-banned-string'] === 'error');
});

test('the stylelint adapter exposes one plugin per CSS rule and loads without stylelint', () => {
  const names = stylelintPlugins.map(plugin => plugin.ruleName).sort();
  const expected = rules
    .filter(rule => rule.appliesTo.includes('css'))
    .map(rule => `aplos-design/${rule.id}`)
    .sort();
  assert.deepEqual(names, expected);
  assert.ok(stylelintPlugins.every(plugin => typeof plugin.rule === 'function'));
  assert.ok(!names.includes('aplos-design/button-variant'));
});
