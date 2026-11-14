import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apcaLc, deltaE2000 } from './color.mjs';
import { pairsDocument } from './build-tokens.mjs';
import { evaluatePairs } from './check-contrast.mjs';
import {
  GENERATED_DIR,
  REFERENCES_PATH,
  TOKENS_PATH,
  flattenTokens,
  readJson,
} from './tokens-lib.mjs';

const SCRIPT = fileURLToPath(new URL('./check-contrast.mjs', import.meta.url));

function runCheck(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

function withTemp(name, data, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'aplos-contrast-'));
  try {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(data));
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BUILD = fileURLToPath(new URL('./build-tokens.mjs', import.meta.url));

// Writes edited tokens to a temp folder, regenerates the pairs there (so the
// stale-file check passes) and runs the contrast check against both.
function checkEdited(edit) {
  const tokens = readJson(TOKENS_PATH);
  edit(tokens);
  const dir = mkdtempSync(join(tmpdir(), 'aplos-contrast-'));
  try {
    const path = join(dir, 'tokens.json');
    writeFileSync(path, JSON.stringify(tokens));
    const built = spawnSync(process.execPath, [BUILD, '--tokens', path, '--out', dir], {
      encoding: 'utf8',
    });
    assert.equal(built.status, 0, built.stderr);
    return runCheck(['--contrast', '--tokens', path, '--pairs', join(dir, 'contrast-pairs.json')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function pairs(tokens) {
  return tokens.$extensions.aplos.contrastPairs;
}

const results = evaluatePairs(pairsDocument(flattenTokens(readJson(TOKENS_PATH))));

function ratio(id, mode) {
  const row = results.find(r => r.id === id && r.mode === mode);
  assert.ok(row, `no pair ${id} in ${mode}`);
  return row.ratio;
}

// DESIGN 4.1's computed-contrast table: [pair id, light, dark].
const DESIGN_TABLE = [
  ['ink-on-canvas', 16.67, 14.75],
  ['ink-on-shell', 15.3, 15.76],
  ['ink-on-paper', 16.67, 13.8],
  ['ink-on-raised', 15.43, 13.47],
  ['ink-on-sunken', 14.51, 16.25],
  ['ink-2-on-canvas', 9.15, 10.1],
  ['ink-2-on-shell', 8.4, 10.79],
  ['ink-2-on-raised', 8.47, 9.22],
  ['dim-on-canvas', 5.76, 6.41],
  ['dim-on-shell', 5.28, 6.85],
  ['dim-on-paper', 5.76, 6.0],
  ['dim-on-raised', 5.33, 5.86],
  ['dim-on-sunken', 5.01, 7.07],
  ['dim-on-accent-wash-over-canvas', 5.07, 5.19],
  ['dim-on-puck-over-canvas', 5.12, 5.23],
  ['dim-on-puck-over-shell', 4.71, 5.7],
  ['dim-on-hover-over-canvas', 5.33, 5.68],
  ['dim-on-today-tint-over-canvas', 5.41, 5.4],
  ['faint-on-canvas', 3.12, 3.61],
  ['accent-on-canvas', 7.84, 7.61],
  ['accent-on-shell', 7.19, 8.13],
  ['accent-ink-on-accent', 7.84, 8.3],
  ['fill-ink-on-hill', 6.13, 8.21],
  ['fill-ink-on-dusk', 7.31, 7.88],
  ['fill-ink-on-stamp', 5.52, 7.47],
  ['fill-ink-on-hill-70-over-paper', null, 4.85],
  ['fill-ink-on-dusk-70-over-paper', null, 4.7],
  ['fill-ink-on-accent-70-over-paper', null, 4.91],
  ['stamp-ink-on-stamp-tint-over-canvas', 6.63, 6.48],
  ['control-edge-on-canvas', 3.07, 3.41],
  // Dark control-edge on paper: DESIGN prints 3.19, which is the edge composited
  // over the pane but measured against paper. Composited over paper it is 3.37.
  ['control-edge-on-paper', 3.07, 3.37],
  ['line-strong-on-canvas', 1.33, 1.38],
  // Weakest event fill: stamp in light, sand in dark.
  ['ink-on-tag-stamp-event-fill-over-canvas', 13.86, null],
  ['ink-2-on-tag-stamp-event-fill-over-canvas', 7.61, null],
  ['dim-on-tag-stamp-event-fill-over-canvas', 4.79, null],
  ['ink-on-tag-sand-event-fill-over-canvas', null, 10.03],
  ['ink-2-on-tag-sand-event-fill-over-canvas', null, 6.87],
];

test("DESIGN 4.1's printed ratios are reproduced within 0.02", () => {
  for (const [id, light, dark] of DESIGN_TABLE) {
    if (light !== null) {
      assert.ok(
        Math.abs(ratio(id, 'light') - light) <= 0.02,
        `${id} light ${ratio(id, 'light').toFixed(3)} vs ${light}`,
      );
    }
    if (dark !== null) {
      assert.ok(
        Math.abs(ratio(id, 'dark') - dark) <= 0.02,
        `${id} dark ${ratio(id, 'dark').toFixed(3)} vs ${dark}`,
      );
    }
  }
});

test('dim on the weakest dark event fill stays undeclared because it is under 4.5', () => {
  assert.ok(!results.some(r => r.id.startsWith('dim-on-tag-') && r.mode.startsWith('dark')));
});

test('the field ring is an accepted exception at rest and passes 3:1 under Increase Contrast', () => {
  for (const mode of ['light', 'dark']) {
    const row = results.find(r => r.id === 'line-strong-on-canvas' && r.mode === mode);
    assert.equal(row.status, 'exception');
  }
  for (const mode of ['light-more', 'dark-more']) {
    const row = results.find(r => r.id === 'line-strong-on-canvas' && r.mode === mode);
    assert.equal(row.status, 'pass');
    assert.ok(row.ratio >= 3);
  }
});

test('ΔE00 matches de2000.py within 0.05', () => {
  // Values printed by python3 de2000.py's de2000() for the same inputs.
  assert.ok(Math.abs(deltaE2000('#0b5394', '#0050ff') - 13.840971) < 0.05);
  assert.ok(Math.abs(deltaE2000('#86b86a', '#03ce4c') - 11.560366) < 0.05);
  assert.ok(Math.abs(deltaE2000('#0b5394', '#1c42b1') - 8.914) < 0.05);
});

test('APCA matches its published reference values', () => {
  assert.ok(Math.abs(apcaLc('#888888', '#ffffff') - 63.056) < 0.01);
  assert.ok(Math.abs(apcaLc('#ffffff', '#000000') - -107.885) < 0.01);
});

test('the real tokens pass every check', () => {
  const result = runCheck([]);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /Accepted exception: line-strong-on-canvas in light/);
});

test('a colour changed in tokens.json is re-checked even if contrast-pairs.json is stale', () => {
  const tokens = readJson(TOKENS_PATH);
  tokens.color.dim.$value = '#c0c0c0';
  withTemp('tokens.json', tokens, path => {
    const result = runCheck([
      '--contrast',
      '--tokens',
      path,
      '--pairs',
      join(GENERATED_DIR, 'contrast-pairs.json'),
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL dim-on-canvas in light/);
    assert.match(result.stdout, /contrast-pairs\.json is stale/);
  });
});

test('a pair minimum below 4.5 or 3 fails', () => {
  const result = checkEdited(tokens => {
    tokens.color['stamp-ink'].$extensions.aplos.dark = '#ff9090';
    for (const pair of pairs(tokens).filter(p => p.fg === '{color.stamp-ink}')) {
      pair.min = 1.5;
    }
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /declared min 1\.5 is below the 4\.5 required for text/);
});

test('an exception that is not on the allow-list fails', () => {
  const result = checkEdited(tokens => {
    tokens.color['stamp-ink'].$value = '#ff9090';
    for (const pair of pairs(tokens).filter(p => p.fg === '{color.stamp-ink}')) {
      pair.exception = { decision: 'none', reason: 'test' };
    }
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /exception is not on the allow-list/);
});

test('the field ring exception has a floor', () => {
  const result = checkEdited(tokens => {
    tokens.color['line-strong'].$value.percent = 2;
    tokens.color['line-strong'].$extensions.aplos.dark.percent = 2;
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /FAIL line-strong-on-canvas in light: 1\.0\d is below the 1\.3 floor/,
  );
});

test('coverage is per mode: a text token paired only in light fails', () => {
  const result = checkEdited(tokens => {
    tokens.color.quiet = {
      $value: '#5f6268',
      $description: 'test',
      $extensions: { aplos: { dark: '#202020', usage: ['text'] } },
    };
    pairs(tokens).push({
      fg: '{color.quiet}',
      bg: '{color.canvas}',
      kind: 'text',
      modes: ['light'],
      usage: 'test',
    });
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /color\.quiet: used as text but is the foreground of no text pair in dark, light-more, dark-more/,
  );
});

test('a colour literal outside a colour token fails', () => {
  const result = checkEdited(tokens => {
    tokens.color.brand = { $type: 'string', $value: '#ffff80', $description: 'test' };
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /color\.brand: \$type string holds a colour literal/);
});

test('a surface colour that backs no pair needs a reason', () => {
  const result = checkEdited(tokens => {
    tokens.color.pale = {
      $value: '#c8c8c8',
      $description: 'test',
      $extensions: { aplos: { usage: ['surface'] } },
    };
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /color\.pale: surface colour is the background of no pair/);
});

test('a colour token without a declared pair fails coverage', () => {
  const tokens = readJson(TOKENS_PATH);
  tokens.color['link-visited'] = {
    $value: '#5a3d8a',
    $description: 'test',
    $extensions: { aplos: { usage: ['text'] } },
  };
  withTemp('tokens.json', tokens, path => {
    const result = runCheck(['--contrast', '--tokens', path]);
    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /color\.link-visited: used as text but is the foreground of no text pair/,
    );
  });
});

test('a colour token with no usage fails coverage', () => {
  const tokens = readJson(TOKENS_PATH);
  tokens.color.mystery = { $value: '#336699' };
  withTemp('tokens.json', tokens, path => {
    const result = runCheck(['--contrast', '--tokens', path]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /color\.mystery: no \$extensions\.aplos\.usage/);
  });
});

test('an accent too close to Avec fails the identity check', () => {
  const tokens = readJson(TOKENS_PATH);
  tokens.color.accent.$value = '#0a4fe0';
  withTemp('tokens.json', tokens, path => {
    const result = runCheck(['--identity', '--tokens', path]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL identity: --accent light/);
  });
});

// A copy of the references with Mimestream's system green moved into the gate
// and, optionally, an exception for the dark hill against it. The real list has
// no exceptions; this keeps the exception machinery exercised.
function refsWithGatedGreen(exception) {
  const refs = readJson(REFERENCES_PATH);
  const green = refs.advisoryReferences.find(r => r.hex === '#64ca56');
  refs.references.push(green);
  refs.advisoryReferences = refs.advisoryReferences.filter(r => r !== green);
  refs.exceptions = exception ? [exception] : [];
  return refs;
}

const HILL_EXCEPTION = {
  token: '{color.hill}',
  mode: 'dark',
  reference: '#64ca56',
  status: 'test fixture',
  decision: 'test decision',
  reviewBy: '2026-11-24',
  reason: 'test',
};

test("the gate is DESIGN 12.4's list: Avec's four plus the audited brand and link blues", () => {
  const refs = readJson(REFERENCES_PATH);
  const gated = refs.references.map(r => r.hex);
  for (const avec of ['#0050ff', '#07aa04', '#03ce4c', '#36b7ff']) {
    assert.ok(gated.includes(avec), `${avec} must be gated`);
  }
  const brands = [
    'Spark',
    'Missive',
    'Mimestream link',
    'Airmail',
    'Shortwave',
    'Canary',
    'Apple system blue',
  ];
  for (const r of refs.references.filter(ref => !ref.name.startsWith('Avec'))) {
    assert.ok(
      brands.some(b => r.name.startsWith(b)),
      `${r.name} is not on DESIGN 12.4's list`,
    );
    assert.match(r.source, /audit section 4/, `${r.name} must come from the audit's section 4`);
  }
  assert.ok(refs.references.some(r => r.name === 'Missive brand-dark'));
  for (const advisory of ['#64ca56', '#2b8e3f', '#ea2e1a']) {
    assert.ok(!gated.includes(advisory), `${advisory} must be advisory`);
    assert.ok(refs.advisoryReferences.some(r => r.hex === advisory));
  }
  assert.deepEqual(refs.exceptions, []);
});

test('an advisory colour under 8.5 is printed but never fails', () => {
  const result = runCheck(['--identity']);
  assert.equal(result.status, 0, result.stdout);
  assert.match(
    result.stdout,
    /--hill dark\s+#86b86a\s+nearest 7\.72 Mimestream system green #64ca56 \(under 8\.5\)/,
  );
  assert.doesNotMatch(result.stdout, /FAIL/);
  assert.match(result.stdout, /0 accepted exception, 0 fail/);
});

test('a colour moved into the gate fails without an exception', () => {
  withTemp('refs.json', refsWithGatedGreen(), path => {
    const result = runCheck(['--identity', '--refs', path, '--today', '2026-10-27']);
    assert.equal(result.status, 1);
    const fails = result.stdout.split('\n').filter(line => line.startsWith('FAIL identity'));
    assert.deepEqual(fails, [
      'FAIL identity: --hill dark #86b86a is 7.72 from Mimestream system green #64ca56',
    ]);
  });
});

test('a current identity exception is accepted', () => {
  withTemp('refs.json', refsWithGatedGreen(HILL_EXCEPTION), path => {
    const result = runCheck(['--identity', '--refs', path, '--today', '2026-10-27']);
    assert.equal(result.status, 0, result.stdout);
    assert.match(
      result.stdout,
      /Accepted exception \(test fixture\): --hill dark 7\.72 from Mimestream system green/,
    );
  });
});

test('an identity exception past its review date, or without a decision, fails', () => {
  withTemp('refs.json', refsWithGatedGreen(HILL_EXCEPTION), path => {
    const expired = runCheck(['--identity', '--refs', path, '--today', '2099-01-01']);
    assert.equal(expired.status, 1);
    assert.match(
      expired.stdout,
      /identity exception \{color\.hill\} dark vs #64ca56 expired on 2026-11-24/,
    );
  });
  const { decision, ...undecided } = HILL_EXCEPTION;
  assert.ok(decision);
  withTemp('refs.json', refsWithGatedGreen(undecided), path => {
    const result = runCheck(['--identity', '--refs', path, '--today', '2026-10-27']);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /has no decision reference/);
  });
});

test('an exception no gated distance needs is stale and fails', () => {
  const refs = readJson(REFERENCES_PATH);
  refs.exceptions = [HILL_EXCEPTION];
  withTemp('refs.json', refs, path => {
    const result = runCheck(['--identity', '--refs', path, '--today', '2026-10-27']);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /identity exception \{color\.hill\} dark vs #64ca56 is not needed/);
  });
});

test('the selection tint is solid: ink on it reads the same over the pane, an accent fill or a stamp fill', async () => {
  const { resolvePair } = await import('./tokens-lib.mjs');
  const flat = flattenTokens(readJson(TOKENS_PATH));
  for (const mode of ['light', 'dark', 'light-more', 'dark-more']) {
    const bgs = [
      '{color.canvas}',
      '{color.accent}',
      '{color.stamp}',
      '{color.hill}',
      '{color.sunken}',
    ].map(
      over =>
        resolvePair(flat, { fg: '{color.ink}', bg: '{color.selection}', over, kind: 'text' }, mode)
          .bgRgb,
    );
    for (const bg of bgs) {
      assert.deepEqual(
        bg,
        bgs[0],
        `${mode}: the selection must not let the surface under it show through`,
      );
    }
  }
  const css = (await import('./build-tokens.mjs')).generate()['tokens.css'];
  assert.match(css, /--selection: color-mix\(in srgb, var\(--accent\) 18%, var\(--canvas\)\);/);
});
