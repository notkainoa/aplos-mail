import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault, flushVault, type VaultFs } from '../src/main/vault';

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

/**
 * What the default file system does (a fresh file, written and closed) minus the flush to the disk: a real
 * flush can outlast HUNG_MS while other test files run, which would fail a save that should succeed.
 */
async function syncedWrite(path: string, data: string, mode: number) {
  const handle = await nodeFs.open(path, 'wx', mode);
  try {
    await handle.writeFile(data, 'utf8');
  } finally {
    await handle.close();
  }
}

/** The write timeout of tests that hang a file call on purpose. */
const HUNG_MS = 250;

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
        writeTimeoutMs: HUNG_MS,
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
        writeTimeoutMs: HUNG_MS,
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
      // The abandoned write removes its temp file after the repair, so wait for it instead of asserting at once.
      await eventually(
        async () => (await temporaries(dir)).length === 0,
        'the late rename leaves no temp file behind',
      );
      await vault.set('c', { v: 5 });
      assert.deepEqual((await open(dir)).get('c'), { v: 5 });
    });
  },
);

test('half a keychain refuses to start instead of saving over entries it cannot read', async () => {
  await withDir(async dir => {
    await (await open(dir)).set('a', { v: 1 });
    const before = await nodeFs.readFile(vaultFile(dir));
    const locked = /can only partly open saved account credentials/;
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

/**
 * The real file system, except the next `dirs` directory flushes fail, each failure making the next
 * `writesAfter` file writes (the repair's) fail, and the next `writes` file writes fail.
 */
function failingFs(
  plan: { dirs: number; writes: number; writesAfter?: number },
  overrides: Partial<VaultFs> = {},
) {
  const eio = () => Object.assign(new Error('I/O error'), { code: 'EIO' });
  return realFs({
    syncDir: async () => {
      if (plan.dirs <= 0) return;
      plan.dirs -= 1;
      plan.writes += plan.writesAfter ?? 0;
      throw eio();
    },
    writeFileSynced: async (path, data, mode) => {
      if (plan.writes <= 0) return syncedWrite(path, data, mode);
      plan.writes -= 1;
      throw eio();
    },
    ...overrides,
  });
}

const onDisk = async (dir: string) => {
  const reloaded = await open(dir);
  return { a: reloaded.get('a')?.v, b: reloaded.get('b')?.v, c: reloaded.get('c')?.v };
};

test('a repair that fails is retried until the committed entries are back on disk', async () => {
  await withDir(async dir => {
    const plan = { dirs: 0, writes: 0, writesAfter: 0 };
    const vault = await createVault<{ v: number }>({
      dataDir: dir,
      ...crypto,
      fs: failingFs(plan),
    });
    await vault.set('a', { v: 1 });
    Object.assign(plan, { dirs: 1, writesAfter: 2 });
    await assert.rejects(vault.set('a', { v: 4 }), unsaved);
    await eventually(
      async () => (await onDisk(dir)).a === 1,
      'the third repair attempt restores a=1',
    );
    assert.equal(plan.writes, 0, 'two repair attempts failed first');
  });
});

test('a repair that keeps failing is retried by the next save, even one that cannot be written', async () => {
  await withDir(async dir => {
    const plan = { dirs: 0, writes: 0, writesAfter: 0 };
    const vault = await createVault<{ v: number }>({
      dataDir: dir,
      ...crypto,
      fs: failingFs(plan),
    });
    await vault.set('a', { v: 1 });
    Object.assign(plan, { dirs: 1, writesAfter: 3 });
    await assert.rejects(vault.set('a', { v: 4 }), unsaved);
    await eventually(async () => plan.writes === 0, 'every repair attempt ran');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(
      await onDisk(dir),
      { a: 4, b: undefined, c: undefined },
      'the gap: until the next save',
    );
    assert.deepEqual(vault.get('a'), { v: 1 });
    await assert.rejects(vault.set('c', { v: 2 }), /could not be encrypted/);
    assert.deepEqual(await onDisk(dir), { a: 1, b: undefined, c: undefined });
    await vault.set('b', { v: 3 });
    assert.deepEqual(await onDisk(dir), { a: 1, b: 3, c: undefined });
  });
});

test(
  'a late rename of an older snapshot whose repair fails is repaired by the next delete',
  { timeout: 10_000 },
  async () => {
    await withDir(async dir => {
      const hang = gate();
      const plan = { dirs: 0, writes: 0, hang: false };
      // Set once the vault has the late rename's result. The file is replaced before that: a check of the
      // disk alone could run while the vault does not know yet, and the delete below would find nothing to repair.
      let landed = false;
      const fs = failingFs(plan, {
        rename: async (from, to) => {
          if (!plan.hang) return nodeFs.rename(from, to);
          plan.hang = false;
          const held = `${from}.held`;
          await nodeFs.link(from, held);
          await hang.opened;
          // The repair after this landing fails every time.
          plan.writes = 3;
          await nodeFs.rename(held, to);
          setImmediate(() => (landed = true));
        },
      });
      const vault = await createVault<{ v: number }>({
        dataDir: dir,
        ...crypto,
        fs,
        writeTimeoutMs: HUNG_MS,
      });
      await vault.set('a', { v: 1 });
      plan.hang = true;
      await assert.rejects(vault.set('a', { v: 7 }), unsaved);
      await vault.set('b', { v: 3 });
      hang.release();
      await eventually(async () => landed && plan.writes === 0, 'every repair attempt ran');
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(
        await onDisk(dir),
        { a: 7, b: undefined, c: undefined },
        'the acknowledged b is lost for now',
      );
      await vault.delete('nope');
      assert.deepEqual(await onDisk(dir), { a: 1, b: 3, c: undefined });
      await flushVault(vault);
      assert.deepEqual(await temporaries(dir), []);
    });
  },
);

test('a vault loading in this process never removes a temporary file another vault is still writing', async () => {
  await withDir(async dir => {
    const hang = gate();
    const written = gate();
    const plan = { hang: false };
    const fs = realFs({
      writeFileSynced: async (path, data, mode) => {
        await syncedWrite(path, data, mode);
        if (!plan.hang) return;
        plan.hang = false;
        written.release();
        await hang.opened;
      },
    });
    // However short the grace period, it starts only once a call has timed out.
    const options = { dataDir: dir, ...crypto, fs, writeTimeoutMs: 5_000, abandonedGraceMs: 0 };
    const vault = await createVault<{ v: number }>(options);
    await vault.set('a', { v: 1 });
    plan.hang = true;
    const saving = vault.set('a', { v: 5 });
    await written.opened;
    await new Promise(resolve => setTimeout(resolve, 50));
    await open(dir);
    hang.release();
    await saving;
    assert.deepEqual((await open(dir)).get('a'), { v: 5 });
  });
});

/** A file call held by the test: `reached` opens when the call starts, `release` lets it go on. */
function hold() {
  const reached = gate();
  const released = gate();
  const done = gate();
  return { reached, released, done };
}

/**
 * The real file system, except renames and directory flushes the test queued a `hold` for: such a rename takes
 * its source at once but replaces the vault file only once released (it then opens `done`).
 */
function heldFs() {
  const renames: ReturnType<typeof hold>[] = [];
  const dirSyncs: ReturnType<typeof hold>[] = [];
  const fs = realFs({
    rename: async (from, to) => {
      const held = renames.shift();
      if (!held) return nodeFs.rename(from, to);
      const copy = `${from}.held`;
      await nodeFs.link(from, copy);
      held.reached.release();
      await held.released.opened;
      await nodeFs.rename(copy, to);
      held.done.release();
    },
    syncDir: async () => {
      const held = dirSyncs.shift();
      if (!held) return;
      held.reached.release();
      await held.released.opened;
      held.done.release();
    },
  });
  const holdRename = () => {
    const held = hold();
    renames.push(held);
    return held;
  };
  const holdDirSync = () => {
    const held = hold();
    dirSyncs.push(held);
    return held;
  };
  return { fs, holdRename, holdDirSync };
}

async function heldVault(dir: string) {
  const held = heldFs();
  const vault = await createVault<{ v: number }>({
    dataDir: dir,
    ...crypto,
    fs: held.fs,
    writeTimeoutMs: HUNG_MS,
  });
  await vault.set('a', { v: 1 });
  return { vault, ...held };
}

test(
  'a late rename that lands while a later save flushes the directory is still repaired',
  { timeout: 10_000 },
  async () => {
    await withDir(async dir => {
      const { vault, holdRename, holdDirSync } = await heldVault(dir);
      const late = holdRename();
      await assert.rejects(vault.set('a', { v: 7 }), unsaved);
      const flushing = holdDirSync();
      const saving = vault.set('b', { v: 3 });
      await flushing.reached.opened;
      // b is renamed into place; now the failed a=7 lands over it.
      late.released.release();
      await late.done.opened;
      flushing.released.release();
      await saving;
      await flushVault(vault);
      assert.deepEqual(await onDisk(dir), { a: 1, b: 3, c: undefined });
      assert.deepEqual(vault.get('a'), { v: 1 });
      assert.deepEqual(vault.get('b'), { v: 3 });
    });
  },
);

test(
  'a late rename that lands while a repair flushes the directory is repaired again',
  { timeout: 10_000 },
  async () => {
    await withDir(async dir => {
      const { vault, holdRename, holdDirSync } = await heldVault(dir);
      const first = holdRename();
      await assert.rejects(vault.set('a', { v: 7 }), unsaved);
      const second = holdRename();
      await assert.rejects(vault.set('a', { v: 8 }), unsaved);
      await vault.set('b', { v: 3 });
      const repairing = holdDirSync();
      first.released.release();
      // The repair of a=7 renames the committed entries into place; now a=8 lands over them.
      await repairing.reached.opened;
      second.released.release();
      await second.done.opened;
      repairing.released.release();
      await flushVault(vault);
      assert.deepEqual(await onDisk(dir), { a: 1, b: 3, c: undefined });
      assert.deepEqual(vault.get('a'), { v: 1 });
      await vault.set('c', { v: 5 });
      assert.deepEqual(await onDisk(dir), { a: 1, b: 3, c: 5 });
    });
  },
);

test('a hung read fails the load instead of hanging it', { timeout: 10_000 }, async () => {
  await withDir(async dir => {
    const fs = realFs({ readFile: () => new Promise<string>(() => {}) });
    const loading = createVault({ dataDir: dir, ...crypto, fs, writeTimeoutMs: HUNG_MS });
    await assert.rejects(loading, /could not be read/);
  });
});

const exists = (path: string) =>
  nodeFs.stat(path).then(
    () => true,
    () => false,
  );

/** Ref'd timers only: an unref'd one does not show up, since it does not keep the process alive. */
const liveTimers = () => process.getActiveResourcesInfo().filter(kind => kind === 'Timeout').length;

/**
 * A vault whose next save hangs for good once the vault has given it up, leaving a temporary file behind:
 * `write` creates the file only after the timeout (and after the vault's own cleanup) and then never settles;
 * `rename` never settles and the vault's own removal of the file fails.
 */
async function hungVault(dir: string, step: 'write' | 'rename', abandonedGraceMs: number) {
  const seen = { temporary: '', hang: false, unlinkFails: false };
  const fs = realFs({
    writeFileSynced: async (path, data, mode) => {
      seen.temporary = path;
      if (!seen.hang || step !== 'write') return syncedWrite(path, data, mode);
      await new Promise(resolve => setTimeout(resolve, HUNG_MS * 2));
      await syncedWrite(path, data, mode);
      await new Promise(() => {});
    },
    rename: async (from, to) => {
      if (!seen.hang || step !== 'rename') return nodeFs.rename(from, to);
      seen.unlinkFails = true;
      await new Promise(() => {});
    },
    unlink: async path => {
      if (!seen.unlinkFails) return nodeFs.unlink(path);
      seen.unlinkFails = false;
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    },
  });
  const vault = await createVault<{ v: number }>({
    dataDir: dir,
    ...crypto,
    fs,
    writeTimeoutMs: HUNG_MS,
    abandonedGraceMs,
  });
  await vault.set('a', { v: 1 });
  seen.hang = true;
  return { vault, seen };
}

for (const step of ['write', 'rename'] as const) {
  test(
    `the temporary file of a ${step} that never settles is kept while the grace period runs`,
    { timeout: 10_000 },
    async () => {
      await withDir(async dir => {
        // A grace far longer than any load makes this independent of how fast the machine is.
        const { vault, seen } = await hungVault(dir, step, 120_000);
        const timersBefore = liveTimers();
        await assert.rejects(vault.set('a', { v: 7 }), unsaved);
        await eventually(() => exists(seen.temporary), 'the hung call leaves its file behind');
        assert.equal(liveTimers(), timersBefore, 'the grace timer does not keep the process alive');
        await open(dir);
        assert.ok(await exists(seen.temporary), 'kept while the hung call may still finish');
        assert.deepEqual(vault.get('a'), { v: 1 });
      });
    },
  );

  test(
    `the temporary file of a ${step} that never settles is removed by a load after its grace period`,
    { timeout: 10_000 },
    async () => {
      await withDir(async dir => {
        // A short grace expires on its own: nothing here depends on loading inside the window.
        const { vault, seen } = await hungVault(dir, step, 50);
        await assert.rejects(vault.set('a', { v: 7 }), unsaved);
        await eventually(() => exists(seen.temporary), 'the hung call leaves its file behind');
        await eventually(async () => {
          await open(dir);
          return !(await exists(seen.temporary));
        }, 'a load after the grace period removes the stale temporary file');
        assert.deepEqual(vault.get('a'), { v: 1 });
        assert.deepEqual((await open(dir)).get('a'), { v: 1 });
      });
    },
  );
}

test(
  'a write gives its temporary name up when it settles, on time or late, not after the grace period',
  { timeout: 10_000 },
  async () => {
    await withDir(async dir => {
      const hang = gate();
      const seen = { temporary: '', hang: false, unlinked: 0 };
      const fs = realFs({
        writeFileSynced: async (path, data, mode) => {
          await syncedWrite(path, data, mode);
          seen.temporary = path;
          if (seen.hang) await hang.opened;
        },
        // Counts the vault's own removals of the temporary file once each has settled.
        unlink: async path => {
          try {
            await nodeFs.unlink(path);
          } finally {
            if (path === seen.temporary) seen.unlinked += 1;
          }
        },
      });
      const options = { dataDir: dir, ...crypto, fs, writeTimeoutMs: HUNG_MS };
      const vault = await createVault<{ v: number }>({ ...options, abandonedGraceMs: 60_000 });
      const leftoverIsRemoved = async () => {
        await nodeFs.writeFile(seen.temporary, 'leftover');
        await open(dir);
        return !(await exists(seen.temporary));
      };
      await vault.set('a', { v: 1 });
      assert.ok(await leftoverIsRemoved(), 'a saved write released its name at once');
      seen.hang = true;
      await assert.rejects(vault.set('a', { v: 7 }), unsaved);
      assert.equal(seen.unlinked, 1, 'the timeout removed the file');
      assert.equal(await leftoverIsRemoved(), false, 'the abandoned write still holds its name');
      hang.release();
      // The straggler removes its file again, then releases the name; wait for both before the next leftover.
      await eventually(async () => seen.unlinked === 2, 'the late write is removed');
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(await leftoverIsRemoved(), 'the late write released its name on settle');
    });
  },
);
