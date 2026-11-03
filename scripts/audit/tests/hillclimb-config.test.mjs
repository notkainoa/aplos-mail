import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { loadConfig, resolveBrief, validateConfig } from '../hillclimb/config.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'hillclimb-config-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const good = {
  name: 'eslint-suppressions-main',
  allowedPaths: ['apps/desktop/src/main/**', 'eslint-suppressions.json'],
  gates: [{ name: 'lint', command: 'npm run lint', timeoutSec: 900 }],
  scorers: [{ name: 'suppressions', command: 'node scorer.mjs', weight: 1, noRegress: true }],
  attempt: { agent: 'swe-2', model: 'swe-2-high', brief: 'fix it', timeoutSec: 1800 },
  attemptsPerRound: 3,
  roundLimit: 3,
  stopAfterNoGain: 2,
  maxConcurrent: 3,
};

const bad = (patch, keyPart) =>
  assert.throws(() => validateConfig({ ...good, ...patch }), new RegExp(keyPart));

describe('validateConfig', () => {
  it('accepts the reference shape and fills defaults', () => {
    const config = validateConfig({ ...good });
    assert.equal(config.name, 'eslint-suppressions-main');
    assert.deepEqual(config.allowedTestPaths, []);
    assert.equal(config.scorers[0].weight, 1);
    assert.equal(config.scorers[0].noRegress, true);
    assert.equal(config.scorers[0].timeoutSec, 300); // scorer default
    assert.equal(config.attemptsPerRound, 3);
  });

  it('applies default loop counts when omitted', () => {
    const minimal = { ...good };
    delete minimal.attemptsPerRound;
    delete minimal.roundLimit;
    delete minimal.stopAfterNoGain;
    delete minimal.maxConcurrent;
    const config = validateConfig(minimal);
    assert.equal(config.attemptsPerRound, 4);
    assert.equal(config.roundLimit, 5);
    assert.equal(config.stopAfterNoGain, 2);
    assert.equal(config.maxConcurrent, 4);
  });

  it('rejects unknown keys at every level', () => {
    bad({ bogus: 1 }, 'bogus');
    assert.throws(
      () => validateConfig({ ...good, gates: [{ name: 'x', command: 'y', wat: 1 }] }),
      /gates\[0\].*wat/,
    );
    assert.throws(
      () =>
        validateConfig({
          ...good,
          scorers: [{ name: 'x', command: 'y', extra: 1 }],
        }),
      /scorers\[0\].*extra/,
    );
    assert.throws(
      () => validateConfig({ ...good, attempt: { agent: 'command', command: 'x', z: 1 } }),
      /attempt.*"z"/,
    );
  });

  it('rejects bad names', () => {
    bad({ name: 'Has Spaces' }, 'name');
    bad({ name: '' }, 'name');
    bad({ name: 42 }, 'name');
    bad({ name: 'a/b' }, 'name');
  });

  it('rejects missing or empty allowedPaths', () => {
    const noPaths = { ...good };
    delete noPaths.allowedPaths;
    assert.throws(() => validateConfig(noPaths), /allowedPaths/);
    bad({ allowedPaths: [] }, 'allowedPaths');
    bad({ allowedPaths: [''] }, 'allowedPaths');
    bad({ allowedPaths: [42] }, 'allowedPaths');
  });

  it('rejects malformed gates and scorers', () => {
    bad({ gates: 'npm test' }, 'gates');
    bad({ gates: [{ name: 'x' }] }, 'command');
    bad({ gates: [{ command: 'y' }] }, 'name');
    bad({ scorers: [] }, 'scorers');
    bad({ scorers: [{ name: 's', command: 'c', weight: 'a' }] }, 'weight');
    bad({ scorers: [{ name: 's', command: 'c', weight: 0 }] }, 'weight');
    bad({ scorers: [{ name: 's', command: 'c', weight: Number.NaN }] }, 'weight');
    bad({ scorers: [{ name: 's', command: 'c', noRegress: 'yes' }] }, 'noRegress');
    bad({ scorers: [{ name: 's', command: 'c', timeoutSec: -1 }] }, 'timeoutSec');
  });

  it('rejects malformed attempts', () => {
    bad({ attempt: { agent: 'gpt', brief: 'x' } }, 'agent');
    bad({ attempt: { agent: 'swe-2' } }, 'brief');
    bad({ attempt: { agent: 'command', brief: 'x' } }, 'attempt.command');
    bad(
      { attempt: { agent: 'swe-2', brief: 'x', command: 'echo hi' } },
      /attempt\.command is only allowed/,
    );
    bad({ attempt: { agent: 'swe-2', brief: 'x', timeoutSec: 0 } }, 'timeoutSec');
  });

  it('rejects bad loop counts', () => {
    bad({ attemptsPerRound: 0 }, 'attemptsPerRound');
    bad({ roundLimit: -2 }, 'roundLimit');
    bad({ stopAfterNoGain: 1.5 }, 'stopAfterNoGain');
    bad({ maxConcurrent: 'many' }, 'maxConcurrent');
  });

  it('accepts named allowDirectives and rejects unknown ones', () => {
    const config = validateConfig({ ...good, allowDirectives: ['ts-ignore', 'c8-ignore'] });
    assert.deepEqual(config.allowDirectives, ['ts-ignore', 'c8-ignore']);
    assert.equal(validateConfig({ ...good }).allowDirectives.length, 0);
    bad({ allowDirectives: 'ts-ignore' }, 'allowDirectives');
    bad({ allowDirectives: ['eslint'] }, 'unknown directive');
    bad({ allowDirectives: [42] }, 'allowDirectives');
  });

  it('accepts allowBinary globs and a maxAddedFileKB cap, defaulting safely', () => {
    const config = validateConfig({
      ...good,
      allowBinary: ['apps/desktop/assets/**'],
      maxAddedFileKB: 1024,
    });
    assert.deepEqual(config.allowBinary, ['apps/desktop/assets/**']);
    assert.equal(config.maxAddedFileKB, 1024);
    const plain = validateConfig({ ...good });
    assert.deepEqual(plain.allowBinary, []);
    assert.equal(plain.maxAddedFileKB, 512);
    bad({ allowBinary: 'src/**' }, 'allowBinary');
    bad({ allowBinary: [42] }, 'allowBinary');
    bad({ maxAddedFileKB: 0 }, 'maxAddedFileKB');
    bad({ maxAddedFileKB: -1 }, 'maxAddedFileKB');
    bad({ maxAddedFileKB: 'big' }, 'maxAddedFileKB');
  });

  it('accepts a lockWaitMin override and rejects bad values', () => {
    assert.equal(validateConfig({ ...good, lockWaitMin: 600 }).lockWaitMin, 600);
    assert.equal(validateConfig({ ...good }).lockWaitMin, 180);
    bad({ lockWaitMin: 0 }, 'lockWaitMin');
    bad({ lockWaitMin: -5 }, 'lockWaitMin');
    bad({ lockWaitMin: 'forever' }, 'lockWaitMin');
  });

  it('accepts a maxLogMB override in 1..500 and defaults to 50', () => {
    assert.equal(validateConfig({ ...good }).maxLogMB, 50);
    assert.equal(validateConfig({ ...good, maxLogMB: 1 }).maxLogMB, 1);
    assert.equal(validateConfig({ ...good, maxLogMB: 500 }).maxLogMB, 500);
    bad({ maxLogMB: 0 }, 'maxLogMB');
    bad({ maxLogMB: 501 }, 'maxLogMB');
    bad({ maxLogMB: -1 }, 'maxLogMB');
    bad({ maxLogMB: 1.5 }, 'maxLogMB');
    bad({ maxLogMB: '50' }, 'maxLogMB');
  });

  it('rejects non-object configs', () => {
    assert.throws(() => validateConfig(null), /object/);
    assert.throws(() => validateConfig([1, 2]), /object/);
    assert.throws(() => validateConfig('x'), /object/);
  });
});

describe('loadConfig', () => {
  it('reports the repo-relative path for the diff guard', () => {
    const dir = join(tmp, 'repo', 'scripts', 'audit', 'hillclimb', 'targets');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 't.json'), JSON.stringify(good));
    const { config, repoRelPath } = loadConfig(join(dir, 't.json'), join(tmp, 'repo'));
    assert.equal(config.name, 'eslint-suppressions-main');
    assert.equal(repoRelPath, 'scripts/audit/hillclimb/targets/t.json');
  });

  it('returns null repoRelPath for configs outside the repo', () => {
    const outside = join(tmp, 'outside.json');
    writeFileSync(outside, JSON.stringify(good));
    const { repoRelPath } = loadConfig(outside, join(tmp, 'repo'));
    assert.equal(repoRelPath, null);
  });
});

describe('resolveBrief', () => {
  it('passes inline text through', () => {
    assert.equal(resolveBrief('just do it', tmp), 'just do it');
  });

  it('reads .md files relative to the repo root', () => {
    writeFileSync(join(tmp, 'brief.md'), '# do the thing\n');
    assert.equal(resolveBrief('brief.md', tmp), '# do the thing\n');
  });

  it('rejects missing .md briefs and escapes', () => {
    assert.throws(() => resolveBrief('nope.md', tmp), /brief/);
    assert.throws(() => resolveBrief('../secret.md', tmp), /brief/);
  });
});
