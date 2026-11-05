import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  renameSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  promises as fsp,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BLOB_FILE_LIMITS,
  BlobFilesError,
  type BlobHeader,
  type BlobRefusal,
} from '@aplos/engine/ports';
import { openBlobFiles, type BlobFilesOptions, type BlobWriteStep } from '../../src/host/blobs';

const GB = 1024 * 1024 * 1024;
const ID = `b_${'a'.repeat(32)}`;
const ID2 = `b_${'b'.repeat(32)}`;
const plenty = async () => 100 * GB;

/** Gives every folder and file below `path` back to its owner (tests lock some), without following links. */
function unlock(path: string): void {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (!stats || stats.isSymbolicLink()) return;
  chmodSync(path, stats.isDirectory() ? 0o700 : 0o600);
  if (stats.isDirectory()) for (const name of readdirSync(path)) unlock(join(path, name));
}

/** A fresh folder for one test, removed after it (only ever this mkdtemp folder). */
function scratch(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'aplos-blobs-'));
  t.after(() => {
    if (!root.startsWith(join(tmpdir(), 'aplos-blobs-'))) return;
    unlock(root);
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function header(bytes: Uint8Array, extra: Partial<BlobHeader> = {}): BlobHeader {
  return {
    principal: 'app',
    kind: 'upload',
    mime: 'application/pdf',
    name: 'report.pdf',
    size: bytes.byteLength,
    createdAt: 1_700_000_000_000,
    ...extra,
  };
}

const bytesOf = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

function open(dir: string, extra: Partial<BlobFilesOptions> = {}) {
  return openBlobFiles({ dir, freeBytes: plenty, ...extra });
}

async function refusal(promise: Promise<unknown>): Promise<BlobRefusal> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof BlobFilesError, `a BlobFilesError, got ${String(error)}`);
    return error.reason;
  }
  assert.fail('expected a refusal');
}

const mode = (path: string) => statSync(path).mode & 0o777;

test('a blob round-trips: header and bytes back, fresh buffers, list, usage and an idempotent remove', async t => {
  const dir = join(scratch(t), 'blobs');
  const store = await open(dir);
  const bytes = bytesOf(5000, 3);
  await store.put(ID, header(bytes), bytes);

  const one = await store.get(ID);
  const two = await store.get(ID);
  assert.deepEqual(one?.header, header(bytes));
  assert.deepEqual(one?.bytes, bytes);
  assert.notEqual(one!.bytes.buffer, two!.bytes.buffer, 'a fresh buffer per call');
  assert.equal(one!.bytes.byteOffset, 0);
  assert.equal(
    one!.bytes.buffer.byteLength,
    5000,
    'the buffer is exactly the blob, safe to transfer',
  );
  // Moving one caller's buffer leaves the next read whole.
  structuredClone(one!.bytes, { transfer: [one!.bytes.buffer as ArrayBuffer] });
  assert.equal(one!.bytes.byteLength, 0);
  assert.deepEqual((await store.get(ID))?.bytes, bytes);

  const listed = await store.list();
  assert.deepEqual(
    listed.map(entry => [entry.id, entry.header]),
    [[ID, header(bytes)]],
  );
  assert.ok(listed[0].mtimeMs > 0);
  assert.ok((await store.usage()) > 5000);

  await store.remove(ID);
  await store.remove(ID);
  assert.equal(await store.get(ID), undefined);
  assert.equal(await store.usage(), 0);
  assert.deepEqual(await store.list(), []);
});

test('the folder is 0700, its temp folder 0700 and every blob file 0600, whatever the umask', async t => {
  const root = scratch(t);
  const dir = join(root, 'blobs');
  mkdirSync(dir, { mode: 0o755 });
  const previous = process.umask(0);
  t.after(() => void process.umask(previous));
  const store = await open(dir);
  const bytes = bytesOf(10);
  await store.put(ID, header(bytes), bytes);
  assert.equal(mode(dir), 0o700, 'an existing 0755 folder is tightened');
  assert.equal(mode(join(dir, '.tmp')), 0o700);
  assert.equal(mode(join(dir, `${ID}.blob`)), 0o600);
});

test('path traversal: a bad id is refused before any file is touched, by put, get and remove', async t => {
  const root = scratch(t);
  const dir = join(root, 'blobs');
  const steps: BlobWriteStep[] = [];
  // A VALID blob file one level above the folder: without the id check, get('../victim') would serve it.
  const maker = await open(join(root, 'maker'));
  const secret = bytesOf(9, 4);
  await maker.put(ID, header(secret), secret);
  const victim = readFileSync(join(root, 'maker', `${ID}.blob`));
  writeFileSync(join(root, 'victim.blob'), victim);
  rmSync(join(root, 'maker'), { recursive: true, force: true });
  const store = await open(dir, { step: step => void steps.push(step) });
  const bad = [
    '../victim',
    `../b_${'a'.repeat(32)}`,
    `b_${'A'.repeat(32)}`,
    `b_${'a'.repeat(31)}`,
    `b_${'a'.repeat(33)}`,
    `b_${'a'.repeat(32)}/`,
    `b_${'a'.repeat(32)}\n`,
    `b_${'a'.repeat(30)}..`,
    '/etc/passwd',
    '',
    'b_',
    `x_${'a'.repeat(32)}`,
  ];
  const bytes = bytesOf(4);
  for (const id of bad) {
    assert.equal(await refusal(store.put(id, header(bytes), bytes)), 'id', JSON.stringify(id));
    assert.equal(await store.get(id), undefined);
    await store.remove(id);
  }
  for (const id of [undefined, null, 42, {}, ['b_x']])
    assert.equal(await refusal(store.put(id as never, header(bytes), bytes)), 'id');
  assert.deepEqual(steps, [], 'no write ever started');
  assert.deepEqual(readdirSync(dir), ['.tmp']);
  assert.deepEqual(readdirSync(root).sort(), ['blobs', 'victim.blob']);
  assert.deepEqual(readFileSync(join(root, 'victim.blob')), victim);
});

test('a symlink planted as the blob folder or its temp folder is refused, and its target is left alone', async t => {
  const root = scratch(t);
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere);
  const dir = join(root, 'blobs');
  symlinkSync(elsewhere, dir);
  assert.equal(await refusal(open(dir)), 'io');
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing was created through the link');

  const dangling = join(root, 'dangling');
  symlinkSync(join(root, 'nowhere'), dangling);
  assert.equal(await refusal(open(dangling)), 'io');
  assert.equal(existsSync(join(root, 'nowhere')), false);

  const real = join(root, 'real');
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(elsewhere, join(real, '.tmp'));
  writeFileSync(join(elsewhere, 'precious'), 'x');
  assert.equal(await refusal(open(real)), 'io');
  assert.deepEqual(readdirSync(elsewhere), ['precious'], 'a linked temp folder is never emptied');

  const file = join(root, 'file');
  writeFileSync(file, 'not a folder');
  assert.equal(await refusal(open(file)), 'io');
});

test('a symlink planted as a blob file is never followed: get is undefined, put is refused, the scan drops the link only', async t => {
  const root = scratch(t);
  const dir = join(root, 'blobs');
  const store = await open(dir);
  const bytes = bytesOf(32, 9);
  await store.put(ID2, header(bytes), bytes);
  // A well-formed blob file outside the folder, linked in under another id.
  const outside = join(root, 'outside.blob');
  writeFileSync(outside, readFileSync(join(dir, `${ID2}.blob`)));
  symlinkSync(outside, join(dir, `${ID}.blob`));

  assert.equal(await store.get(ID), undefined);
  assert.equal(await refusal(store.put(ID, header(bytes), bytes)), 'exists');
  const listed = await store.list();
  assert.deepEqual(
    listed.map(entry => entry.id),
    [ID2],
  );
  assert.equal(existsSync(join(dir, `${ID}.blob`)), false, 'the link is gone');
  assert.ok(lstatSync(outside).isFile(), 'its target is untouched');
  assert.deepEqual(readFileSync(outside), readFileSync(join(dir, `${ID2}.blob`)));
});

test('a write that dies before the final name leaves nothing behind, and the id can be written again', async t => {
  const dir = join(scratch(t), 'blobs');
  let crash: BlobWriteStep | undefined = 'link';
  const store = await open(dir, {
    step: step => {
      if (step === crash) throw new Error('killed');
    },
  });
  const bytes = bytesOf(100);
  assert.equal(await refusal(store.put(ID, header(bytes), bytes)), 'io');
  assert.equal(existsSync(join(dir, `${ID}.blob`)), false);
  assert.deepEqual(readdirSync(join(dir, '.tmp')), []);
  assert.equal(await store.usage(), 0, 'the reservation was released');
  crash = 'fsync';
  assert.equal(await refusal(store.put(ID, header(bytes), bytes)), 'io');
  assert.deepEqual(readdirSync(join(dir, '.tmp')), []);
  crash = undefined;
  await store.put(ID, header(bytes), bytes);
  assert.deepEqual((await store.get(ID))?.bytes, bytes);
});

test('at start, a crash’s temp files and every name that is not a readable blob are removed', async t => {
  const dir = join(scratch(t), 'blobs');
  const first = await open(dir);
  const good = bytesOf(64, 1);
  await first.put(ID, header(good), good);
  // What a crash or a stranger left: half-written temps, a truncated blob, a header that lies, foreign names.
  writeFileSync(join(dir, '.tmp', `${ID2}.1.x.part`), 'half');
  mkdirSync(join(dir, '.tmp', 'nested'));
  const whole = readFileSync(join(dir, `${ID}.blob`));
  writeFileSync(join(dir, `${ID2}.blob`), whole.subarray(0, whole.byteLength - 10));
  const ID3 = `b_${'c'.repeat(32)}`;
  writeFileSync(join(dir, `${ID3}.blob`), 'aplos-blob/1\n{"principal":"app"}\n');
  writeFileSync(join(dir, 'notes.txt'), 'x');
  writeFileSync(join(dir, `b_${'D'.repeat(32)}.blob`), 'x');
  mkdirSync(join(dir, 'sub'));
  // A planted folder with something in it is never deleted recursively: it is left alone.
  mkdirSync(join(dir, 'full'));
  writeFileSync(join(dir, 'full', 'keep'), 'x');

  const store = await open(dir);
  assert.deepEqual(readdirSync(join(dir, '.tmp')), [], 'the temp folder is emptied at open');
  assert.equal(await store.get(ID2), undefined, 'a truncated blob reads as gone');
  assert.equal(await store.get(ID3), undefined);
  const listed = await store.list();
  assert.deepEqual(
    listed.map(entry => entry.id),
    [ID],
  );
  assert.deepEqual(readdirSync(dir).sort(), ['.tmp', `${ID}.blob`, 'full']);
  assert.deepEqual(readdirSync(join(dir, 'full')), ['keep']);
  assert.deepEqual((await store.get(ID))?.bytes, good);
});

test('caps: 25 MB per blob, the folder cap, the free-disk floor, and a header that does not describe the bytes', async t => {
  const dir = join(scratch(t), 'blobs');
  const store = await open(dir);
  const over = new Uint8Array(BLOB_FILE_LIMITS.maxBytes + 1);
  assert.equal(await refusal(store.put(ID, header(over), over)), 'tooLarge');
  const exact = new Uint8Array(BLOB_FILE_LIMITS.maxBytes);
  await store.put(ID, header(exact), exact);
  assert.equal((await store.get(ID))?.bytes.byteLength, BLOB_FILE_LIMITS.maxBytes);
  await store.remove(ID);

  const small = bytesOf(10);
  assert.equal(await refusal(store.put(ID, header(small, { size: 11 }), small)), 'header');
  assert.equal(
    await refusal(store.put(ID, { ...header(small), kind: 'other' } as never, small)),
    'header',
  );
  assert.equal(
    await refusal(store.put(ID, header(small, { name: 'x'.repeat(256) }), small)),
    'header',
  );

  const capped = await open(join(scratch(t), 'blobs'), { limits: { folderBytes: 600 } });
  const half = bytesOf(300);
  await capped.put(ID, header(half), half);
  assert.equal(await refusal(capped.put(ID2, header(half), half)), 'folderFull');
  await capped.remove(ID);
  await capped.put(ID2, header(half), half);

  let free = GB + 1000;
  const disk = await open(join(scratch(t), 'blobs'), { freeBytes: async () => free });
  assert.equal(await refusal(disk.put(ID, header(bytesOf(1001)), bytesOf(1001))), 'diskFull');
  await disk.put(ID, header(bytesOf(10)), bytesOf(10));
  free = Number.NaN;
  assert.equal(await refusal(disk.put(ID2, header(small), small)), 'diskFull');
  const broken = await open(join(scratch(t), 'blobs'), {
    freeBytes: async () => {
      throw new Error('statfs failed');
    },
  });
  assert.equal(await refusal(broken.put(ID, header(small), small)), 'diskFull', 'fails closed');

  // A tighter header cap and a looser one: only the tighter applies.
  const tight = await open(join(scratch(t), 'blobs'), {
    limits: { maxHeaderBytes: 64, maxBytes: BLOB_FILE_LIMITS.maxBytes * 2 },
  });
  assert.equal(await refusal(tight.put(ID, header(small), small)), 'header');
  assert.equal(await refusal(tight.put(ID, header(over, { name: 'a' }), over)), 'tooLarge');
});

test('a reopened store counts the blobs already there against the folder cap', async t => {
  const dir = join(scratch(t), 'blobs');
  const first = await open(dir);
  const bytes = bytesOf(400);
  await first.put(ID, header(bytes), bytes);
  const usage = await first.usage();
  const again = await open(dir, { limits: { folderBytes: 800 } });
  assert.equal(await again.usage(), usage);
  assert.equal(await refusal(again.put(ID2, header(bytes), bytes)), 'folderFull');
});

test('a file over the size cap on disk reads as gone', async t => {
  const dir = join(scratch(t), 'blobs');
  const store = await open(dir);
  const bytes = bytesOf(2000);
  await store.put(ID, header(bytes), bytes);
  const tight = await open(dir, { limits: { maxBytes: 1000 } });
  assert.equal(await tight.get(ID), undefined);
});

test('two puts of the same id at once: one wins whole, the other is refused, nothing is mixed', async t => {
  const dir = join(scratch(t), 'blobs');
  const store = await open(dir);
  // A second store on the same folder (a second engine), opened before either write: only the final link can refuse it.
  const other = await open(dir);
  const a = bytesOf(4096, 1);
  const b = bytesOf(4096, 2);
  const results = await Promise.allSettled([
    store.put(ID, header(a), a),
    store.put(ID, header(b), b),
  ]);
  assert.deepEqual(
    results.map(r => r.status),
    ['fulfilled', 'rejected'],
  );
  assert.equal(((results[1] as PromiseRejectedResult).reason as BlobFilesError).reason, 'exists');
  assert.deepEqual((await store.get(ID))?.bytes, a);
  assert.equal(await refusal(other.put(ID, header(b), b)), 'exists');
  assert.deepEqual((await store.get(ID))?.bytes, a);
  assert.deepEqual(readdirSync(join(dir, '.tmp')), []);
});

test('a write syncs the file before it gets its final name, and the folder after', async t => {
  const steps: string[] = [];
  const dir = join(scratch(t), 'blobs');
  const store = await open(dir, { step: step => void steps.push(step) });
  // Every real fsync, seen on the FileHandle prototype the store's handles share.
  const probe = await fsp.open(dir, 'r');
  const proto = Object.getPrototypeOf(probe) as { sync(): Promise<void> };
  await probe.close();
  const sync = proto.sync;
  proto.sync = function (this: unknown) {
    steps.push('sync()');
    return sync.call(this);
  };
  t.after(() => void (proto.sync = sync));
  await store.put(ID, header(bytesOf(3)), bytesOf(3));
  assert.deepEqual(steps, [
    'open',
    'write',
    'fsync',
    'sync()',
    'link',
    'unlinkTemp',
    'fsyncDir',
    'sync()',
  ]);
});

test('no refusal names a path', async t => {
  const dir = join(scratch(t), 'blobs');
  const store = await open(dir, {
    step: step => {
      if (step === 'link') throw new Error(`EACCES ${dir}`);
    },
  });
  try {
    await store.put(ID, header(bytesOf(1)), bytesOf(1));
    assert.fail('expected a refusal');
  } catch (error) {
    assert.ok(error instanceof BlobFilesError);
    assert.equal(String(error.message).includes(dir), false);
    assert.equal(String(error.stack).includes(dir), false);
  }
});

test(
  'a FIFO named like a blob never blocks: open, list and get return, and the scan drops it',
  { timeout: 5000 },
  async t => {
    const dir = join(scratch(t), 'blobs');
    mkdirSync(dir, { mode: 0o700 });
    execFileSync('mkfifo', [join(dir, `${ID}.blob`)]);
    const store = await open(dir);
    assert.equal(existsSync(join(dir, `${ID}.blob`)), false, 'a FIFO is positively no blob');
    execFileSync('mkfifo', [join(dir, `${ID2}.blob`)]);
    assert.equal(await store.get(ID2), undefined);
    assert.deepEqual(await store.list(), []);
  },
);

test('a blob that cannot be read right now is never deleted, and reads as unavailable', async t => {
  const dir = join(scratch(t), 'blobs');
  const store = await open(dir);
  const bytes = bytesOf(50);
  await store.put(ID, header(bytes), bytes);
  const path = join(dir, `${ID}.blob`);
  chmodSync(path, 0o000);
  assert.deepEqual(await store.list(), []);
  assert.ok(existsSync(path), 'list() left it alone');
  assert.equal(await store.get(ID), undefined);
  const reopened = await open(dir);
  assert.ok(existsSync(path), 'a restart left it alone');
  assert.ok((await reopened.usage()) > 50, 'and still counts it against the folder cap');
  chmodSync(path, 0o600);
  assert.deepEqual((await reopened.get(ID))?.bytes, bytes, 'readable again later, whole');
});

test('a blob folder swapped for a link after start: nothing in the target is read, written or deleted', async t => {
  const root = scratch(t);
  const dir = join(root, 'blobs');
  const store = await open(dir);
  const bytes = bytesOf(20);
  await store.put(ID, header(bytes), bytes);
  const target = join(root, 'target');
  mkdirSync(target);
  writeFileSync(join(target, 'precious.txt'), 'x');
  writeFileSync(join(target, `${ID2}.blob`), 'not a blob');
  // Even a target that looks like a blob folder (with its own .tmp) is never written to.
  mkdirSync(join(target, '.tmp'));
  renameSync(dir, join(root, 'moved'));
  symlinkSync(target, dir);
  assert.equal(await refusal(store.list()), 'io');
  assert.equal(await refusal(store.put(ID2, header(bytes), bytes)), 'io');
  assert.equal(await refusal(store.remove(ID2)), 'io');
  assert.equal(await store.get(ID2), undefined);
  assert.deepEqual(readdirSync(target).sort(), ['.tmp', `${ID2}.blob`, 'precious.txt']);
  assert.deepEqual(readdirSync(join(target, '.tmp')), []);
  assert.equal(readFileSync(join(target, `${ID2}.blob`), 'utf8'), 'not a blob');
});

test('a failure inside list() leaves as a reason code, never a path; an undeletable stranger is skipped', async t => {
  const dir = join(scratch(t), 'blobs');
  const store = await open(dir);
  const locked = join(dir, 'junk', 'locked');
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, 'x'), 'x');
  chmodSync(locked, 0o500);
  const bytes = bytesOf(5);
  await store.put(ID, header(bytes), bytes);
  const listed = await store.list();
  assert.deepEqual(
    listed.map(entry => entry.id),
    [ID],
  );
  chmodSync(dir, 0o000);
  try {
    await store.list();
    assert.fail('expected a refusal');
  } catch (error) {
    chmodSync(dir, 0o700);
    assert.ok(error instanceof BlobFilesError);
    assert.equal(error.reason, 'io');
    assert.equal(`${error.message} ${error.stack}`.includes(dir), false);
  }
});

test('a blob with a second hard link (a backup tool’s) is not served, but never deleted and still counted', async t => {
  const root = scratch(t);
  const dir = join(root, 'blobs');
  const store = await open(dir);
  const bytes = bytesOf(8);
  await store.put(ID, header(bytes), bytes);
  const usage = await store.usage();
  linkSync(join(dir, `${ID}.blob`), join(root, 'second'));
  assert.equal(await store.get(ID), undefined);
  assert.deepEqual(await store.list(), []);
  assert.ok(existsSync(join(dir, `${ID}.blob`)), 'list() left it alone');
  assert.equal(await store.usage(), usage);
  const reopened = await open(dir);
  assert.ok(existsSync(join(dir, `${ID}.blob`)), 'a restart left it alone');
  assert.equal(await reopened.usage(), usage);
  rmSync(join(root, 'second'));
  assert.deepEqual((await reopened.get(ID))?.bytes, bytes, 'served again once it has one link');
});

test('removes that land while a scan runs stay removed', async t => {
  const dir = join(scratch(t), 'blobs');
  const ids = Array.from({ length: 30 }, (_, i) => `b_${i.toString(16).padStart(32, '0')}`);
  let calls = 0;
  const holder: { store?: Awaited<ReturnType<typeof open>> } = {};
  const store = await open(dir, {
    peek: async () => {
      // Two thirds into the scan, every blob is removed, the ones it already saw included.
      if (++calls === 20 && holder.store) for (const id of ids) await holder.store.remove(id);
    },
  });
  for (const id of ids) await store.put(id, header(bytesOf(10)), bytesOf(10));
  calls = 0;
  holder.store = store;
  await store.list();
  assert.equal(await store.usage(), 0);
  await store.put(ids[0], header(bytesOf(10)), bytesOf(10));
});

test(
  'a blob swapped for a FIFO between lstat and open never blocks a read',
  { timeout: 5000 },
  async t => {
    const dir = join(scratch(t), 'blobs');
    let swap = false;
    const store = await open(dir, {
      peek: async () => {
        if (!swap) return;
        swap = false;
        rmSync(join(dir, `${ID}.blob`));
        execFileSync('mkfifo', [join(dir, `${ID}.blob`)]);
      },
    });
    const bytes = bytesOf(4);
    await store.put(ID, header(bytes), bytes);
    swap = true;
    assert.equal(await store.get(ID), undefined);
    assert.ok(lstatSync(join(dir, `${ID}.blob`)).isFIFO(), 'a read never deletes');
  },
);

test('a put while list() runs is counted against the folder cap', async t => {
  const dir = join(scratch(t), 'blobs');
  const store = await open(dir, { limits: { folderBytes: 1000 } });
  const bytes = bytesOf(400);
  await store.put(ID, header(bytes), bytes);
  const listing = store.list();
  assert.equal(await refusal(store.put(ID2, header(bytes), bytes)), 'folderFull');
  await listing;
  assert.equal(await refusal(store.put(ID2, header(bytes), bytes)), 'folderFull');
  const ID3 = `b_${'c'.repeat(32)}`;
  await store.remove(ID);
  const racing = store.list();
  await store.put(ID3, header(bytes), bytes);
  await racing;
  assert.equal(
    await refusal(store.put(ID2, header(bytes), bytes)),
    'folderFull',
    'a put that finished mid-scan stays counted',
  );
});

/** A store whose 20th read during a `list()` runs `during` (the scan is then half way through 40 blobs). */
async function midScanStore(dir: string, during: () => Promise<void>, extra = {}) {
  let reads = 0;
  let armed = false;
  const store = await open(dir, {
    ...extra,
    peek: async () => {
      if (armed && ++reads === 20) await during();
    },
  });
  return {
    store,
    async list() {
      armed = true;
      reads = 0;
      try {
        return await store.list();
      } finally {
        armed = false;
      }
    },
  };
}

test('while a scan runs, the blobs already there stay counted and a put that finishes is kept', async t => {
  const dir = join(scratch(t), 'blobs');
  const seed = await open(dir);
  for (let i = 0; i < 40; i++) {
    const id = `b_${i.toString(16).padStart(32, '0')}`;
    await seed.put(id, header(bytesOf(40)), bytesOf(40));
  }
  const existing = await seed.usage();
  const small = bytesOf(100);
  // Room for the new file only if the 40 old ones were forgotten.
  let refused: BlobRefusal | undefined;
  const capped = await midScanStore(
    dir,
    async () => void (refused = await refusal(capped.store.put(ID, header(small), small))),
    { limits: { folderBytes: existing + 100 } },
  );
  await capped.list();
  assert.equal(refused, 'folderFull');

  const roomy = await midScanStore(dir, () => roomy.store.put(ID, header(small), small));
  await roomy.list();
  assert.ok(
    (await roomy.store.usage()) > existing + 100,
    'the put that finished mid-scan is still counted',
  );
});

test('a scan while a write is between its link and its temp unlink leaves the new blob alone', async t => {
  const dir = join(scratch(t), 'blobs');
  let midway: Promise<unknown> | undefined;
  const holder: { store?: Awaited<ReturnType<typeof open>> } = {};
  const store = await open(dir, {
    step: async step => {
      // The file has two links right now (its final name and the temp): a scan must not judge it.
      if (step === 'unlinkTemp') await (midway = holder.store!.list());
    },
  });
  holder.store = store;
  const bytes = bytesOf(12);
  await store.put(ID, header(bytes), bytes);
  assert.deepEqual(await midway, []);
  assert.deepEqual((await store.get(ID))?.bytes, bytes);
  assert.deepEqual(
    (await store.list()).map(entry => entry.id),
    [ID],
  );
});

test('a delete that fails keeps the blob counted', async t => {
  const dir = join(scratch(t), 'blobs');
  const store = await open(dir);
  const bytes = bytesOf(30);
  await store.put(ID, header(bytes), bytes);
  const before = await store.usage();
  chmodSync(dir, 0o500);
  assert.equal(await refusal(store.remove(ID)), 'io');
  chmodSync(dir, 0o700);
  assert.equal(await store.usage(), before);
  await store.remove(ID);
  assert.equal(await store.usage(), 0);
});

test('a buffer detached while it is written fails the put: nothing short is ever linked', async t => {
  const dir = join(scratch(t), 'blobs');
  const holder: { bytes?: Uint8Array } = {};
  const store = await open(dir, {
    step: step => {
      // The caller transfers its buffer away after `put` admitted it, before the bytes are written.
      if (step === 'write' && holder.bytes)
        structuredClone(holder.bytes.buffer, { transfer: [holder.bytes.buffer as ArrayBuffer] });
    },
  });
  const bytes = bytesOf(4096, 6);
  holder.bytes = bytes;
  assert.equal(await refusal(store.put(ID, header(bytes), bytes)), 'io');
  assert.equal(bytes.byteLength, 0, 'the buffer really was detached');
  assert.equal(existsSync(join(dir, `${ID}.blob`)), false);
  assert.deepEqual(readdirSync(join(dir, '.tmp')), []);
  assert.equal(await store.usage(), 0);
});

test('a temp folder swapped for a link after start: put refuses and writes nothing through it', async t => {
  const root = scratch(t);
  const dir = join(root, 'blobs');
  const store = await open(dir);
  const target = join(root, 'target');
  mkdirSync(target, { mode: 0o700 });
  renameSync(join(dir, '.tmp'), join(root, 'old-tmp'));
  symlinkSync(target, join(dir, '.tmp'));
  const bytes = bytesOf(10);
  assert.equal(await refusal(store.put(ID, header(bytes), bytes)), 'io');
  assert.deepEqual(readdirSync(target), []);
  assert.equal(existsSync(join(dir, `${ID}.blob`)), false);
  assert.equal(await refusal(open(dir)), 'io', 'and a restart refuses the folder');
  assert.deepEqual(readdirSync(target), []);
});

test('a blob of another format version or an unknown kind is kept and counted, never served or deleted', async t => {
  const dir = join(scratch(t), 'blobs');
  mkdirSync(dir, { mode: 0o700 });
  const newer = 'aplos-blob/2\n{"principal":"app","kind":"upload"}\nbytes';
  const head = { principal: 'app', kind: 'thumbnail', mime: 'image/png', size: 3, createdAt: 1 };
  const unknownKind = `aplos-blob/1\n${JSON.stringify(head)}\nabc`;
  writeFileSync(join(dir, `${ID}.blob`), newer);
  writeFileSync(join(dir, `${ID2}.blob`), unknownKind);
  const store = await open(dir);
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.get(ID), undefined);
  assert.equal(await store.get(ID2), undefined);
  assert.equal(readFileSync(join(dir, `${ID}.blob`), 'utf8'), newer);
  assert.equal(readFileSync(join(dir, `${ID2}.blob`), 'utf8'), unknownKind);
  assert.equal(await store.usage(), newer.length + unknownKind.length);
  // A v1 file that is simply corrupt is still deleted.
  const ID3 = `b_${'c'.repeat(32)}`;
  writeFileSync(join(dir, `${ID3}.blob`), 'aplos-blob/1\nnot json\n');
  await store.list();
  assert.equal(existsSync(join(dir, `${ID3}.blob`)), false);
});

test('a blob folder or temp folder opened up to group or others after start is refused', async t => {
  const dir = join(scratch(t), 'blobs');
  const store = await open(dir);
  const bytes = bytesOf(5);
  chmodSync(join(dir, '.tmp'), 0o755);
  assert.equal(await refusal(store.put(ID, header(bytes), bytes)), 'io');
  chmodSync(join(dir, '.tmp'), 0o700);
  chmodSync(dir, 0o750);
  assert.equal(await refusal(store.list()), 'io');
  chmodSync(dir, 0o700);
  await store.put(ID, header(bytes), bytes);
});
