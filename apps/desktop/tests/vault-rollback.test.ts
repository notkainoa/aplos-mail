import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault, type VaultFs } from '../src/main/vault';

// A keychain that cannot encrypt the value `{"v":2}`, so saving it fails while any other value saves.
const crypto = {
  encrypt: (text: string) => {
    if (text.includes('"v":2')) throw new Error('keychain locked');
    return Buffer.from(text, 'utf8');
  },
  decrypt: (data: Buffer) => data.toString('utf8'),
};

async function withVault(run: (vault: Awaited<ReturnType<typeof open>>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-vault-'));
  try {
    await run(await open(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const open = (dir: string) => createVault<{ v: number }>({ dataDir: dir, ...crypto });

test('a failed save rolls back to the previous value', async () => {
  await withVault(async vault => {
    await vault.set('a', { v: 1 });
    await assert.rejects(vault.set('a', { v: 2 }));
    assert.deepEqual(vault.get('a'), { v: 1 });
    await assert.rejects(vault.set('b', { v: 2 }));
    assert.equal(vault.get('b'), undefined);
  });
});

test('a failed save does not overwrite a value that was saved after it', async () => {
  await withVault(async vault => {
    await vault.set('a', { v: 1 });
    const failing = vault.set('a', { v: 2 });
    const later = vault.set('a', { v: 3 });
    await assert.rejects(failing);
    await later;
    assert.deepEqual(vault.get('a'), { v: 3 });
  });
});

/** The real file system, except the next `failWrites` writes of the temporary file fail. */
function flakyFs() {
  const plan = { failWrites: 0 };
  const fs: VaultFs = {
    mkdir: (path, options) => nodeFs.mkdir(path, options),
    readFile: (path, encoding) => nodeFs.readFile(path, encoding),
    rename: (from, to) => nodeFs.rename(from, to),
    writeFile: async (path, data, options) => {
      if (plan.failWrites > 0) {
        plan.failWrites -= 1;
        throw new Error('disk full');
      }
      await nodeFs.writeFile(path, data, options);
    },
  };
  return { fs, plan };
}

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-vault-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const unsaved = { message: /could not be saved securely/ };

test('a failed save of the same string as a later successful one does not roll memory back', async () => {
  await withDir(async dir => {
    const { fs, plan } = flakyFs();
    const vault = await createVault<string>({ dataDir: dir, ...crypto, fs });
    await vault.set('a', 'old');
    plan.failWrites = 1;
    const failing = vault.set('a', 'new');
    const later = vault.set('a', 'new');
    await assert.rejects(failing, unsaved);
    await later;
    assert.equal(vault.get('a'), 'new');
    const reloaded = await createVault<string>({ dataDir: dir, ...crypto });
    assert.equal(reloaded.get('a'), 'new');
  });
});

test('a failed save never reaches the disk through another entry’s queued save', async () => {
  await withDir(async dir => {
    const { fs, plan } = flakyFs();
    const vault = await createVault<{ v: number }>({ dataDir: dir, ...crypto, fs });
    await vault.set('a', { v: 1 });
    plan.failWrites = 1;
    const failing = vault.set('a', { v: 9 });
    const queued = vault.set('b', { v: 3 });
    await assert.rejects(failing, unsaved);
    await queued;
    assert.deepEqual(vault.get('a'), { v: 1 });
    const reloaded = await open(dir);
    assert.deepEqual(reloaded.get('a'), { v: 1 });
    assert.deepEqual(reloaded.get('b'), { v: 3 });
  });
});

test('a failed delete rolls back', async () => {
  await withDir(async dir => {
    const { fs, plan } = flakyFs();
    const vault = await createVault<{ v: number }>({ dataDir: dir, ...crypto, fs });
    await vault.set('a', { v: 1 });
    plan.failWrites = 1;
    await assert.rejects(vault.delete('a'), unsaved);
    assert.deepEqual(vault.get('a'), { v: 1 });
    assert.deepEqual((await open(dir)).get('a'), { v: 1 });
  });
});

test('a delete queued behind a failing delete still deletes', async () => {
  await withDir(async dir => {
    const { fs, plan } = flakyFs();
    const vault = await createVault<{ v: number }>({ dataDir: dir, ...crypto, fs });
    await vault.set('a', { v: 1 });
    plan.failWrites = 1;
    const failing = vault.delete('a');
    const later = vault.delete('a');
    await assert.rejects(failing, unsaved);
    await later;
    assert.equal(vault.get('a'), undefined);
    assert.equal((await open(dir)).get('a'), undefined);
  });
});

test('a real write failure keeps the saved value in memory and on disk', async () => {
  await withDir(async dir => {
    const blocked = { on: false };
    const fs = realFs({
      writeFileSynced: async (path, data, mode) => {
        if (blocked.on) await nodeFs.mkdir(path);
        await syncedWrite(path, data, mode);
      },
    });
    const vault = await createVault<{ v: number }>({ dataDir: dir, ...crypto, fs });
    await vault.set('a', { v: 1 });
    // A directory where the temporary file goes: the write fails with EEXIST, even for root.
    blocked.on = true;
    await assert.rejects(vault.set('a', { v: 5 }), unsaved);
    assert.deepEqual(vault.get('a'), { v: 1 });
    assert.deepEqual((await open(dir)).get('a'), { v: 1 });
    blocked.on = false;
    await vault.set('a', { v: 6 });
    assert.deepEqual((await open(dir)).get('a'), { v: 6 });
  });
});

test('a real rename failure keeps the saved value, and the next save writes it again', async () => {
  await withDir(async dir => {
    const vault = await open(dir);
    await vault.set('a', { v: 1 });
    // A directory in place of the vault file: renaming the temporary file onto it fails.
    const file = join(dir, 'credentials.enc.json');
    await rm(file);
    await nodeFs.mkdir(join(file, 'blocker'), { recursive: true });
    await assert.rejects(vault.set('a', { v: 5 }), unsaved);
    assert.deepEqual(vault.get('a'), { v: 1 });
    assert.deepEqual(
      await temporaries(dir),
      [],
      'no encrypted copy of the failed value is left behind',
    );
    await rm(file, { recursive: true });
    await vault.set('b', { v: 3 });
    const reloaded = await open(dir);
    assert.deepEqual(reloaded.get('a'), { v: 1 });
    assert.deepEqual(reloaded.get('b'), { v: 3 });
  });
});

test('a vault file that is valid JSON but not a map of sealed entries is unreadable, not a crash', async () => {
  for (const body of ['null', '[]', '"x"', '{"a": 1}']) {
    await withDir(async dir => {
      await nodeFs.mkdir(dir, { recursive: true });
      await nodeFs.writeFile(join(dir, 'credentials.enc.json'), body);
      await assert.rejects(open(dir), /could not be read/, body);
    });
  }
});

/** What the default file system does: a fresh file, written, flushed and closed. */
async function syncedWrite(path: string, data: string, mode: number) {
  const handle = await nodeFs.open(path, 'wx', mode);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The real file system with every optional call, except the ones `overrides` replaces. */
function realFs(overrides: Partial<VaultFs> = {}): VaultFs {
  return {
    mkdir: (path, options) => nodeFs.mkdir(path, options),
    readFile: (path, encoding) => nodeFs.readFile(path, encoding),
    writeFile: (path, data, options) => nodeFs.writeFile(path, data, options),
    rename: (from, to) => nodeFs.rename(from, to),
    unlink: path => nodeFs.unlink(path),
    readdir: path => nodeFs.readdir(path),
    writeFileSynced: syncedWrite,
    syncDir: async () => {},
    ...overrides,
  };
}

async function temporaries(dir: string): Promise<string[]> {
  return (await nodeFs.readdir(dir)).filter(name => name.endsWith('.tmp'));
}

/** A promise the test releases by hand: stands in for a file call that hangs. */
function gate() {
  let release = () => {};
  const opened = new Promise<void>(resolve => {
    release = resolve;
  });
  return { opened, release };
}

async function eventually(check: () => Promise<boolean>, message: string) {
  for (let tries = 0; tries < 200; tries++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

const vaultFile = (dir: string) => join(dir, 'credentials.enc.json');

test('a save flushes the temporary file before the rename and the directory after it', async () => {
  await withDir(async dir => {
    const calls: string[] = [];
    const fs = realFs({
      writeFileSynced: async (path, data, mode) => {
        await syncedWrite(path, data, mode);
        calls.push(`write+sync ${path.startsWith(`${vaultFile(dir)}.`) && path.endsWith('.tmp')}`);
      },
      rename: async (from, to) => {
        await nodeFs.rename(from, to);
        calls.push(`rename ${to === vaultFile(dir)}`);
      },
      syncDir: async path => {
        calls.push(`sync dir ${path === dir}`);
      },
    });
    const vault = await createVault<{ v: number }>({ dataDir: dir, ...crypto, fs });
    await vault.set('a', { v: 1 });
    assert.deepEqual(calls, ['write+sync true', 'rename true', 'sync dir true']);
  });
});

test('the default file system flushes the new file before the rename and the directory after', async () => {
  await withDir(async dir => {
    const vault = await open(dir);
    await vault.set('a', { v: 1 });
    const probe = await nodeFs.open(vaultFile(dir), 'r');
    const handles = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const original = handles.sync;
    const seen: unknown[] = [];
    handles.sync = function (this: unknown) {
      seen.push(JSON.parse(readFileSync(vaultFile(dir), 'utf8')).a);
      return original.call(this);
    };
    try {
      await vault.set('a', { v: 3 });
    } finally {
      handles.sync = original;
    }
    const sealed = (v: number) => Buffer.from(JSON.stringify({ v })).toString('base64');
    assert.deepEqual(
      seen,
      [sealed(1), sealed(3)],
      'file flush sees the old file, directory flush the new one',
    );
  });
});

test('a failed flush is a failed save: memory and disk keep the old value', async () => {
  await withDir(async dir => {
    const plan = { fail: false };
    const fs = realFs({
      writeFileSynced: async (path, data, mode) => {
        if (!plan.fail) return syncedWrite(path, data, mode);
        await nodeFs.writeFile(path, data, { mode });
        throw Object.assign(new Error('fsync'), { code: 'EIO' });
      },
    });
    const vault = await createVault<{ v: number }>({ dataDir: dir, ...crypto, fs });
    await vault.set('a', { v: 1 });
    plan.fail = true;
    await assert.rejects(vault.set('a', { v: 4 }), unsaved);
    assert.deepEqual(vault.get('a'), { v: 1 });
    assert.deepEqual((await open(dir)).get('a'), { v: 1 });
    assert.deepEqual(await temporaries(dir), []);
  });
});

test('a failed directory flush rolls back and puts the committed entries back on disk', async () => {
  await withDir(async dir => {
    const plan = { fail: false };
    const fs = realFs({
      syncDir: async () => {
        if (plan.fail) throw Object.assign(new Error('fsync'), { code: 'EIO' });
      },
    });
    const vault = await createVault<{ v: number }>({ dataDir: dir, ...crypto, fs });
    await vault.set('a', { v: 1 });
    plan.fail = true;
    await assert.rejects(vault.set('a', { v: 4 }), unsaved);
    plan.fail = false;
    assert.deepEqual(vault.get('a'), { v: 1 });
    await eventually(
      async () => (await open(dir)).get('a')?.v === 1,
      'the failed value does not stay on disk',
    );
  });
});

test('stale temporary files are removed at load and the vault file is untouched', async () => {
  await withDir(async dir => {
    await (await open(dir)).set('a', { v: 1 });
    const before = await nodeFs.readFile(vaultFile(dir));
    const stale = [
      'credentials.enc.json.tmp',
      'credentials.enc.json.0b9c3f1e-6d2a-4c47-9a51-3f0e8d7c6b5a.tmp',
    ];
    const kept = [
      'credentials.enc.json.bak',
      'imap-credentials.enc.json.tmp',
      'credentials.enc.json.x.tmp',
    ];
    for (const name of [...stale, ...kept]) await nodeFs.writeFile(join(dir, name), 'leftover');
    const vault = await open(dir);
    assert.deepEqual(vault.get('a'), { v: 1 });
    assert.deepEqual(await nodeFs.readFile(vaultFile(dir)), before);
    for (const name of stale) await assert.rejects(nodeFs.stat(join(dir, name)), name);
    for (const name of kept) await nodeFs.stat(join(dir, name));
  });
});

test('a temporary file that cannot be removed does not stop the vault from loading', async () => {
  await withDir(async dir => {
    await (await open(dir)).set('a', { v: 1 });
    await nodeFs.mkdir(join(dir, 'credentials.enc.json.tmp', 'blocker'), { recursive: true });
    assert.deepEqual((await open(dir)).get('a'), { v: 1 });
  });
});

test(
  'a hung write times out, the next save succeeds and the straggler never reaches the disk',
  { timeout: 10_000 },
  async () => {
    await withDir(async dir => {
      const hang = gate();
      const plan = { hang: false };
      const fs = realFs({
        writeFileSynced: async (path, data, mode) => {
          if (!plan.hang) return syncedWrite(path, data, mode);
          plan.hang = false;
          await hang.opened;
          await syncedWrite(path, data, mode);
        },
      });
      const vault = await createVault<{ v: number }>({
        dataDir: dir,
        ...crypto,
        fs,
        writeTimeoutMs: 50,
      });
      await vault.set('a', { v: 1 });
      plan.hang = true;
      await assert.rejects(vault.set('a', { v: 7 }), unsaved);
      assert.deepEqual(vault.get('a'), { v: 1 });
      await vault.set('b', { v: 3 });
      hang.release();
      await eventually(
        async () => (await temporaries(dir)).length === 0,
        'the straggler’s file is removed',
      );
      const reloaded = await open(dir);
      assert.deepEqual(reloaded.get('a'), { v: 1 });
      assert.deepEqual(reloaded.get('b'), { v: 3 });
    });
  },
);

test(
  'a hung rename that lands after a later save does not clobber it',
  { timeout: 10_000 },
  async () => {
    await withDir(async dir => {
      const hang = gate();
      const plan = { hang: false };
      const fs = realFs({
        rename: async (from, to) => {
          if (!plan.hang) return nodeFs.rename(from, to);
          plan.hang = false;
          // The kernel already holds the source; the call returns (and replaces the file) only later.
          const held = `${from}.held`;
          await nodeFs.link(from, held);
          await hang.opened;
          await nodeFs.rename(held, to);
        },
      });
      const vault = await createVault<{ v: number }>({
        dataDir: dir,
        ...crypto,
        fs,
        writeTimeoutMs: 50,
      });
      await vault.set('a', { v: 1 });
      plan.hang = true;
      await assert.rejects(vault.set('a', { v: 7 }), unsaved);
      await vault.set('b', { v: 3 });
      hang.release();
      await eventually(async () => {
        const reloaded = await open(dir);
        return reloaded.get('a')?.v === 1 && reloaded.get('b')?.v === 3;
      }, 'the late rename is repaired with the committed entries');
      assert.deepEqual(await temporaries(dir), []);
      await vault.set('c', { v: 5 });
      assert.deepEqual((await open(dir)).get('c'), { v: 5 });
    });
  },
);

test('half a keychain refuses to start instead of saving over entries it cannot read', async () => {
  await withDir(async dir => {
    await (await open(dir)).set('a', { v: 1 });
    const before = await nodeFs.readFile(vaultFile(dir));
    const locked = /credential storage is unavailable/;
    await assert.rejects(createVault({ dataDir: dir, encrypt: crypto.encrypt }), locked);
    await assert.rejects(createVault({ dataDir: dir, decrypt: crypto.decrypt }), locked);
    assert.deepEqual(await nodeFs.readFile(vaultFile(dir)), before);
  });
});

test('a vault file with entries this keychain cannot open refuses to start and is never overwritten', async () => {
  await withDir(async dir => {
    await (await open(dir)).set('a', { v: 1 });
    const raw = JSON.parse(await nodeFs.readFile(vaultFile(dir), 'utf8'));
    raw.other = Buffer.from('sealed by another key').toString('base64');
    await nodeFs.writeFile(vaultFile(dir), JSON.stringify(raw));
    const before = await nodeFs.readFile(vaultFile(dir));
    await assert.rejects(open(dir), /could not be unlocked/);
    const otherKey = {
      encrypt: crypto.encrypt,
      decrypt: () => {
        throw new Error('wrong key');
      },
    };
    await assert.rejects(createVault({ dataDir: dir, ...otherKey }), /could not be unlocked/);
    assert.deepEqual(await nodeFs.readFile(vaultFile(dir)), before);
  });
});
