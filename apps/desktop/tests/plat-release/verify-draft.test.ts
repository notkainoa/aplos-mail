import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
// @ts-expect-error plain ESM script without types
import { verifyDirectory, expectedAssets } from '../../scripts/verify-draft.mjs';

const VERSION = '9.8.7';
type Result = { ok: boolean; message: string; info?: boolean };
const names = (arch: string, ext: string) => `Aplos-Mail-${VERSION}-${arch}.${ext}`;
/** Random bytes that end the way a real disk image does: a 512-byte trailer starting with `koly`. */
const fakeDmg = (size: number) =>
  Buffer.concat([randomBytes(size), Buffer.from('koly'), Buffer.alloc(508)]);
const fakeBlockmap = () =>
  gzipSync(
    JSON.stringify({
      version: '2',
      files: [{ name: 'file', offset: 0, checksums: [], sizes: [] }],
    }),
  );

/** An honest release: random bytes for each file, a matching latest-mac.yml, zip blockmaps only. */
async function makeDraft(mutate?: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'verify-draft-test-'));
  const sums: Record<string, { sha512: string; size: number }> = {};
  for (const arch of ['arm64', 'x64'])
    for (const ext of ['dmg', 'zip']) {
      const bytes =
        ext === 'dmg' ? fakeDmg(2048 + arch.length) : randomBytes(2048 + arch.length * ext.length);
      await writeFile(join(dir, names(arch, ext)), bytes);
      sums[names(arch, ext)] = {
        sha512: createHash('sha512').update(bytes).digest('base64'),
        size: bytes.length,
      };
    }
  for (const arch of ['arm64', 'x64'])
    await writeFile(join(dir, names(arch, 'zip') + '.blockmap'), fakeBlockmap());
  const z = [names('x64', 'zip'), names('arm64', 'zip')];
  const yml =
    `version: ${VERSION}\nfiles:\n` +
    z
      .map(f => `  - url: ${f}\n    sha512: ${sums[f].sha512}\n    size: ${sums[f].size}\n`)
      .join('') +
    `path: ${z[0]}\nsha512: ${sums[z[0]].sha512}\nreleaseDate: '2026-10-27T00:00:00.000Z'\n`;
  await writeFile(join(dir, 'latest-mac.yml'), yml);
  await mutate?.(dir);
  return dir;
}
const failures = (r: Result[]) => r.filter(x => !x.ok).map(x => x.message);
async function run(mutate?: (dir: string) => Promise<void>, version = VERSION) {
  const dir = await makeDraft(mutate);
  try {
    return failures(await verifyDirectory(dir, version));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('expected set comes from the config: no DMG blockmaps because writeUpdateInfo is false', () => {
  const want = expectedAssets(VERSION);
  assert.deepEqual(want.dmgs.sort(), [names('arm64', 'dmg'), names('x64', 'dmg')]);
  assert.deepEqual(want.blockmaps.sort(), [
    names('arm64', 'zip') + '.blockmap',
    names('x64', 'zip') + '.blockmap',
  ]);
});

test('an honest set passes', async () => {
  assert.deepEqual(await run(), []);
});

test('a tampered sha512 fails', async () => {
  const f = await run(async dir => {
    const p = join(dir, 'latest-mac.yml');
    const text = await readFile(p, 'utf8');
    await writeFile(
      p,
      text.replace(/sha512: (\S{4})/, (_m, a) => 'sha512: ' + (a === 'AAAA' ? 'BBBB' : 'AAAA')),
    );
  });
  assert.ok(
    f.some(m => m.includes('sha512 mismatch')),
    f.join('\n'),
  );
});

test('a changed file on disk fails sha512 and size', async () => {
  const f = await run(dir => writeFile(join(dir, names('arm64', 'zip')), randomBytes(100)));
  assert.ok(f.some(m => m.includes('sha512 mismatch')));
  assert.ok(f.some(m => m.includes('size mismatch')));
});

test('a wrong version fails', async () => {
  const f = await run(undefined, '9.8.8');
  assert.ok(
    f.some(m => m.includes('version is 9.8.7, expected 9.8.8')),
    f.join('\n'),
  );
});

test('a missing blockmap fails', async () => {
  const f = await run(dir => rm(join(dir, names('x64', 'zip') + '.blockmap')));
  assert.ok(
    f.some(m => m === 'missing ' + names('x64', 'zip') + '.blockmap'),
    f.join('\n'),
  );
});

test('an extra unlisted file fails', async () => {
  const f = await run(dir => writeFile(join(dir, 'notes.txt'), 'hi'));
  assert.ok(
    f.some(m => m.includes('unexpected file notes.txt')),
    f.join('\n'),
  );
});

test('a file listed in the YAML but missing fails', async () => {
  const f = await run(dir => rm(join(dir, names('arm64', 'zip'))));
  assert.ok(
    f.some(m => m.includes('lists ' + names('arm64', 'zip') + ' but the file is missing')),
    f.join('\n'),
  );
});

test('a zip that the YAML does not list fails', async () => {
  const f = await run(async dir => {
    const p = join(dir, 'latest-mac.yml');
    const lines = (await readFile(p, 'utf8')).split('\n');
    const at = lines.findIndex(l => l.includes('url: ' + names('arm64', 'zip')));
    lines.splice(at, 3);
    await writeFile(p, lines.join('\n'));
  });
  assert.ok(
    f.some(m => m.includes('does not list it')),
    f.join('\n'),
  );
});

test('a missing latest-mac.yml fails', async () => {
  const f = await run(dir => rm(join(dir, 'latest-mac.yml')));
  assert.ok(f.some(m => m === 'missing latest-mac.yml'));
});

const swapYaml = (edit: (text: string) => string) => async (dir: string) => {
  const p = join(dir, 'latest-mac.yml');
  await writeFile(p, edit(await readFile(p, 'utf8')));
};

test('a ZIP listed twice fails even when the first entry is the wrong one (the updater uses the first)', async () => {
  const f = await run(
    swapYaml(text => {
      const arm = names('arm64', 'zip');
      const real = text.match(
        new RegExp(`  - url: ${arm.replace(/\./g, '\\.')}\n    sha512: (\\S+)\n    size: (\\d+)\n`),
      )!;
      const evil = `  - url: ${arm}\n    sha512: ${createHash('sha512').update('evil').digest('base64')}\n    size: ${real[2]}\n`;
      return text.replace('files:\n', 'files:\n' + evil);
    }),
  );
  assert.ok(
    f.some(m => m.includes('more than once')),
    f.join('\n'),
  );
  assert.ok(
    f.some(m => m.includes('sha512 mismatch ' + names('arm64', 'zip'))),
    f.join('\n'),
  );
});

test('an identical duplicate entry also fails', async () => {
  const f = await run(
    swapYaml(text => {
      const entry = text.match(/ {2}- url: [^\n]+\n {4}sha512: [^\n]+\n {4}size: \d+\n/)![0];
      return text.replace('files:\n', 'files:\n' + entry);
    }),
  );
  assert.ok(
    f.some(m => m.includes('more than once')),
    f.join('\n'),
  );
});

test('an empty DMG fails', async () => {
  const f = await run(dir => writeFile(join(dir, names('arm64', 'dmg')), ''));
  assert.ok(
    f.some(m => m === names('arm64', 'dmg') + ' is empty'),
    f.join('\n'),
  );
});

test('a DMG without the disk image trailer fails', async () => {
  const f = await run(async dir => {
    const file = join(dir, names('x64', 'dmg'));
    await writeFile(file, randomBytes((await readFile(file)).length));
  });
  assert.ok(
    f.some(m => m.includes('koly')),
    f.join('\n'),
  );
});

test('a DMG far smaller than its zip fails', async () => {
  const f = await run(dir => writeFile(join(dir, names('arm64', 'dmg')), fakeDmg(1)));
  assert.ok(
    f.some(m => m.includes('expected between')),
    f.join('\n'),
  );
});

test('two identical DMGs fail (arch swap by copy)', async () => {
  const f = await run(async dir => {
    const bytes = await readFile(join(dir, names('arm64', 'dmg')));
    await writeFile(join(dir, names('x64', 'dmg')), bytes);
  });
  assert.ok(
    f.some(m => m.includes('byte-identical')),
    f.join('\n'),
  );
});

test('an empty blockmap fails', async () => {
  const f = await run(dir => writeFile(join(dir, names('arm64', 'zip') + '.blockmap'), ''));
  assert.ok(
    f.some(m => m.includes('blockmap') && m.includes('not gzip')),
    f.join('\n'),
  );
});

test('a gzip blockmap that is not blockmap JSON fails', async () => {
  const f = await run(async dir => {
    await writeFile(join(dir, names('arm64', 'zip') + '.blockmap'), gzipSync('not json'));
    await writeFile(join(dir, names('x64', 'zip') + '.blockmap'), gzipSync('{"version":"2"}'));
  });
  assert.ok(
    f.some(m => m.includes(names('arm64', 'zip') + '.blockmap does not decompress')),
    f.join('\n'),
  );
  assert.ok(
    f.some(m => m.includes(names('x64', 'zip') + '.blockmap has no files')),
    f.join('\n'),
  );
});

test('DMG blockmaps are expected if the config writes update info', async () => {
  const build = {
    artifactName: 'Aplos-Mail-${version}-${arch}.${ext}',
    mac: {
      target: [
        { target: 'dmg', arch: ['arm64'] },
        { target: 'zip', arch: ['arm64'] },
      ],
    },
    dmg: { writeUpdateInfo: true },
  };
  const want = expectedAssets(VERSION, build);
  assert.deepEqual(want.blockmaps.sort(), [
    names('arm64', 'dmg') + '.blockmap',
    names('arm64', 'zip') + '.blockmap',
  ]);
});
