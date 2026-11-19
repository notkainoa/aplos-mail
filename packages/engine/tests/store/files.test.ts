import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AttachmentFilesError,
  type AttachmentFilesOptions,
  type AttachmentRefusal,
  openAttachmentFiles,
} from '../../../../apps/desktop/src/host/files';

const GB = 1024 * 1024 * 1024;
const plenty = async () => 100 * GB;
const hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const GRAMMAR = /^[0-9a-f]{64}\/[0-9a-f]{64}_[0-9a-f]{64}$/;

/** Gives every folder and file below `path` back to its owner (tests lock some), without following links. */
function unlock(path: string): void {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (!stats || stats.isSymbolicLink()) return;
  chmodSync(path, stats.isDirectory() ? 0o700 : 0o600);
  if (stats.isDirectory()) for (const name of readdirSync(path)) unlock(join(path, name));
}

/** A fresh folder for one test, removed after it (only ever this mkdtemp folder). */
function scratch(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'aplos-files-'));
  t.after(() => {
    if (!root.startsWith(join(tmpdir(), 'aplos-files-'))) return;
    unlock(root);
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function open(dir: string, extra: Partial<AttachmentFilesOptions> = {}) {
  return openAttachmentFiles({ dir, freeBytes: plenty, ...extra });
}

async function refusal(promise: Promise<unknown>): Promise<AttachmentRefusal> {
  try {
    await promise;
  } catch (error) {
    assert.ok(
      error instanceof AttachmentFilesError,
      `an AttachmentFilesError, got ${String(error)}`,
    );
    return error.reason;
  }
  assert.fail('expected a refusal');
}

const bytesOf = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
const leaf = (dir: string, rel: string) => join(dir, '.noindex', ...rel.split('/'));

test('write returns a path in the one grammar, then read gives the bytes back', async t => {
  const dir = join(scratch(t), 'attachments');
  const files = await open(dir);
  const data = bytesOf(2_048, 3);
  const path = await files.write('acct-1', 'msg-1', 'part-1', data);
  assert.match(path, GRAMMAR);
  assert.equal(path, `${hex('acct-1')}/${hex('msg-1')}_${hex('part-1')}`);
  const back = await files.read(path);
  assert.deepEqual(back, data);
  // The file and its folders are private.
  assert.equal(lstatSync(leaf(dir, path)).mode & 0o777, 0o600);
  assert.equal(lstatSync(join(dir, '.noindex', hex('acct-1'))).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(dir, '.noindex')).mode & 0o777, 0o700);
  // A second read is a second buffer: a caller may detach the first.
  const again = await files.read(path);
  assert.notEqual(back, again);
  assert.deepEqual(again, data);
});

test('a re-fetch of the same part writes the same path and replaces the bytes whole', async t => {
  const dir = join(scratch(t), 'attachments');
  const files = await open(dir);
  const first = await files.write('a', 'm', 'p', bytesOf(10, 1));
  const second = await files.write('a', 'm', 'p', bytesOf(10, 2));
  assert.equal(first, second);
  assert.deepEqual(await files.read(second), bytesOf(10, 2));
});

test('write rejects over-cap bytes and nonsense ids with reason codes', async t => {
  const dir = join(scratch(t), 'attachments');
  const files = await open(dir, { limits: { maxBytes: 8 } });
  assert.equal(await refusal(files.write('a', 'm', 'p', bytesOf(9))), 'tooLarge');
  await files.write('a', 'm', 'p', bytesOf(8));
  assert.equal(await refusal(files.write('', 'm', 'p', bytesOf(1))), 'path');
  assert.equal(await refusal(files.write('a', 'm', 'p'.repeat(9000), bytesOf(1))), 'path');
  assert.equal(await refusal(files.write('a', 'm', 'p', 'not bytes' as never)), 'tooLarge');
});

test('a disk under the floor refuses the write', async t => {
  const dir = join(scratch(t), 'attachments');
  const files = await open(dir, { freeBytes: async () => GB + 5 });
  assert.equal(await refusal(files.write('a', 'm', 'p', bytesOf(6))), 'diskFull');
  await files.write('a', 'm', 'p', bytesOf(4)); // GB + 5 - 4 still clears the floor
  // A NaN from a broken statfs fails closed.
  const broken = await open(dir, { freeBytes: async () => NaN });
  assert.equal(await refusal(broken.write('a', 'm', 'q', bytesOf(1))), 'diskFull');
  // A tighter floor is honoured, a looser one never lowers the real cap.
  const tighter = await open(dir, {
    freeBytes: async () => GB + 5,
    limits: { freeDiskFloor: GB + 4 },
  });
  assert.equal(await refusal(tighter.write('a', 'm', 'p', bytesOf(2))), 'diskFull');
  const looser = await open(dir, {
    freeBytes: async () => 10,
    limits: { freeDiskFloor: 4 },
  });
  // The real floor (1 GB) still applies: a looser option cannot lower it.
  assert.equal(await refusal(looser.write('a', 'm', 'p', bytesOf(2))), 'diskFull');
});

test('read answers undefined for missing and unsafe entries, never wrong bytes', async t => {
  const dir = join(scratch(t), 'attachments');
  const files = await open(dir);
  assert.equal(await files.read(`${hex('a')}/${hex('m')}_${hex('p')}`), undefined);
  const path = await files.write('a', 'm', 'p', bytesOf(16, 5));
  const target = leaf(dir, path);
  // A second hard link is not served, and serving resumes once it is gone.
  const extra = join(dir, '.noindex', 'extra-link');
  linkSync(target, extra);
  assert.equal(await files.read(path), undefined);
  unlinkSync(extra);
  assert.deepEqual(await files.read(path), bytesOf(16, 5));
  // A link where the file was is never followed.
  unlinkSync(target);
  symlinkSync('/etc/hosts', target);
  assert.equal(await files.read(path), undefined);
  // A file swapped for a FIFO between the lstat and the open is not served, and the open
  // itself returns at once (the 10 s test timeout is what pins the non-blocking flag).
  unlinkSync(target);
  await files.write('a', 'm', 'p', bytesOf(16, 5));
  const swapped = await openAttachmentFiles({
    dir,
    freeBytes: plenty,
    peek: async () => {
      rmSync(target, { force: true });
      execFileSync('mkfifo', [target]);
    },
  });
  assert.equal(await swapped.read(path), undefined);
});

// The defence compares the opened file's inode with the one the lstat saw. APFS never reuses an inode
// number, so a swapped-in file always differs there. Linux file systems hand the freed inode straight to
// the next file, so the swap below reuses it and the check cannot see it; Aplos ships on macOS only.
const apfsOnly = { skip: process.platform !== 'darwin' && 'relies on APFS never reusing inodes' };

test('a file swapped in between the lstat and the open is not served', apfsOnly, async t => {
  const dir = join(scratch(t), 'attachments');
  const files = await open(dir);
  const path = await files.write('a', 'm', 'p', bytesOf(16, 5));
  const target = leaf(dir, path);
  const swapped = await openAttachmentFiles({
    dir,
    freeBytes: plenty,
    peek: async () => {
      rmSync(target, { force: true });
      writeFileSync(target, bytesOf(16, 9), { mode: 0o600 });
    },
  });
  assert.equal(await swapped.read(path), undefined);
  assert.deepEqual(await files.read(path), bytesOf(16, 9));
});

test('read and remove never leave the folder, however the path is shaped', async t => {
  const dir = join(scratch(t), 'attachments');
  const files = await open(dir);
  // A readable file that a `..` path would reach without the grammar check.
  const victim = join(dir, 'victim');
  writeFileSync(victim, bytesOf(4, 1));
  assert.equal(await files.read('../victim'), undefined);
  assert.equal(await files.read('/etc/hosts'), undefined);
  assert.equal(await files.read(''), undefined);
  assert.equal(await files.read(hex('x') + hex('x')), undefined); // flat name, no leaf part
  await files.remove('../victim');
  await files.remove('/etc/hosts');
  assert.equal(existsSync(victim), true, 'remove must not unlink outside the grammar');
  // A planted flat file with a hex name is still not a valid two-level path.
  const flat = hex('flat');
  writeFileSync(join(dir, '.noindex', flat), bytesOf(4, 2));
  assert.equal(await files.read(flat), undefined);
});

test('remove is idempotent, deletes the file but keeps the emptied account folder', async t => {
  const dir = join(scratch(t), 'attachments');
  const files = await open(dir);
  const path = await files.write('a', 'm', 'p', bytesOf(8));
  const other = await files.write('a', 'm', 'p2', bytesOf(8));
  await files.remove(path);
  assert.equal(existsSync(leaf(dir, path)), false);
  assert.equal(existsSync(join(dir, '.noindex', hex('a'))), true, 'still holds p2');
  await files.remove(other);
  // Emptied account folders stay: rmdir-ing one could fail a concurrent write's rename with
  // ENOENT. Keeping it costs nothing and the next write re-validates it.
  assert.equal(existsSync(join(dir, '.noindex', hex('a'))), true, 'emptied, kept');
  await files.remove(other); // idempotent
  await files.remove(`${hex('zz')}/${hex('zz')}_${hex('zz')}`); // missing is fine
});

test('a folder swapped in at a path is left alone, not emptied', async t => {
  const dir = join(scratch(t), 'attachments');
  const files = await open(dir);
  const path = await files.write('a', 'm', 'p', bytesOf(8));
  rmSync(leaf(dir, path), { force: true });
  mkdirSync(leaf(dir, path));
  writeFileSync(join(leaf(dir, path), 'inside'), bytesOf(4));
  await files.remove(path);
  assert.equal(existsSync(join(leaf(dir, path), 'inside')), true);
});

test('usage counts the regular files under .noindex only', async t => {
  const dir = join(scratch(t), 'attachments');
  const files = await open(dir);
  assert.equal(await files.usage(), 0);
  await files.write('a', 'm', 'p', bytesOf(100));
  await files.write('a', 'm', 'q', bytesOf(50));
  await files.write('b', 'm', 'p', bytesOf(25));
  writeFileSync(join(dir, '.noindex', 'foreign'), bytesOf(10)); // not an account dir: skipped
  assert.equal(await files.usage(), 175);
  await files.remove(await files.write('a', 'm', 'r', bytesOf(5)));
  assert.equal(await files.usage(), 175);
});

test('open clears a half-done write left in .tmp, keeps finished files', async t => {
  const dir = join(scratch(t), 'attachments');
  const first = await open(dir);
  const path = await first.write('a', 'm', 'p', bytesOf(64, 4));
  writeFileSync(join(dir, '.noindex', '.tmp', 'stale.part'), bytesOf(3));
  const second = await open(dir);
  assert.equal(readdirSync(join(dir, '.noindex', '.tmp')).length, 0);
  assert.deepEqual(await second.read(path), bytesOf(64, 4));
});

test('a write that fails mid-way leaves no temp file and no half-written target', async t => {
  const dir = join(scratch(t), 'attachments');
  const files = await open(dir, {
    step: step => {
      if (step === 'rename') throw new Error('crash before rename');
    },
  });
  assert.equal(await refusal(files.write('a', 'm', 'p', bytesOf(8))), 'io');
  assert.equal(readdirSync(join(dir, '.noindex', '.tmp')).length, 0);
  assert.equal(await files.read(`${hex('a')}/${hex('m')}_${hex('p')}`), undefined);
});

test('the folders must be real, ours and not links, at open and per call', async t => {
  const dir = join(scratch(t), 'attachments');
  // A link where the tree belongs is refused at open.
  const linked = join(scratch(t), 'attachments');
  mkdirSync(join(linked, 'real'), { recursive: true });
  symlinkSync(join(linked, 'real'), join(linked, '.noindex'));
  assert.equal(await refusal(open(linked)), 'io');
  // Swapping the folder for a link after open: reads do not follow it.
  const files = await open(dir);
  const path = await files.write('a', 'm', 'p', bytesOf(8));
  renameSync(join(dir, '.noindex'), join(dir, '.noindex-away'));
  symlinkSync(join(dir, '.noindex-away'), join(dir, '.noindex'));
  assert.equal(await files.read(path), undefined, 'a swapped-in link is not followed');
  assert.equal(await refusal(files.write('a', 'm', 'q', bytesOf(8))), 'io');
  assert.equal(await refusal(files.usage()), 'io');
});

test('a write into an account folder that stopped being a folder is refused', async t => {
  const dir = join(scratch(t), 'attachments');
  const files = await open(dir);
  const sub = join(dir, '.noindex', hex('a'));
  await files.write('a', 'm', 'p', bytesOf(8));
  rmSync(sub, { recursive: true, force: true });
  writeFileSync(sub, bytesOf(1)); // a file where the folder was
  assert.equal(await refusal(files.write('a', 'm', 'q', bytesOf(8))), 'io');
});

test('a zero-byte attachment round-trips', async t => {
  const dir = join(scratch(t), 'attachments');
  const files = await open(dir);
  const path = await files.write('a', 'm', 'p', new Uint8Array(0));
  const back = await files.read(path);
  assert.ok(back instanceof Uint8Array);
  assert.equal(back.byteLength, 0);
});

test('the returned path never names a sender-chosen string', async t => {
  const dir = join(scratch(t), 'attachments');
  const files = await open(dir);
  const path = await files.write('acct', '../../etc/passwd', 'report.pdf\0.jpg', bytesOf(4));
  assert.match(path, GRAMMAR);
  assert.equal(path.includes('passwd') || path.includes('.pdf') || path.includes('\0'), false);
});

test('an account folder swapped for a link keeps read and remove inside the tree', async t => {
  const dir = join(scratch(t), 'attachments');
  const files = await open(dir);
  const path = await files.write('acct', 'msg', 'part', bytesOf(16));
  const [acct] = path.split('/');
  const sub = leaf(dir, acct);
  // Swap the real account folder for a link into a folder holding a staged file with our leaf's name.
  const outside = join(scratch(t), 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, path.split('/')[1]), bytesOf(16, 9));
  rmSync(sub, { recursive: true });
  symlinkSync(outside, sub);
  assert.equal(await files.read(path), undefined, 'a link in the middle is not followed');
  await files.remove(path);
  assert.ok(existsSync(join(outside, path.split('/')[1])), 'nothing outside is deleted');
});

test('an over-cap file planted on disk is not served', async t => {
  const dir = join(scratch(t), 'attachments');
  const files = await open(dir);
  const path = await files.write('acct', 'msg', 'part', bytesOf(4));
  writeFileSync(leaf(dir, path), bytesOf(26 * 1024 * 1024));
  assert.equal(await files.read(path), undefined);
});

test('two stores on one folder write without their temp names colliding', async t => {
  const dir = join(scratch(t), 'attachments');
  const one = await open(dir);
  const two = await open(dir);
  const [a, b] = await Promise.all([
    one.write('acct', 'msg', 'p1', bytesOf(8, 1)),
    two.write('acct', 'msg', 'p2', bytesOf(8, 2)),
  ]);
  assert.equal((await one.read(a))?.byteLength, 8);
  assert.equal((await two.read(b))?.byteLength, 8);
});

test('a failure after the rename still reports the write done', async t => {
  const dir = join(scratch(t), 'attachments');
  const files = await open(dir, {
    step: async label => {
      if (label === 'fsyncDir') throw new Error('boom');
    },
  });
  const path = await files.write('acct', 'msg', 'part', bytesOf(6));
  assert.match(path, GRAMMAR);
  assert.deepEqual(await files.read(path), bytesOf(6), 'the renamed file is the truth');
});

test('open clears only .part files from .tmp, nothing else', async t => {
  const dir = join(scratch(t), 'attachments');
  const tmp = join(dir, '.noindex', '.tmp');
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, 'abandoned.part'), bytesOf(4));
  writeFileSync(join(tmp, 'keep.me'), bytesOf(4));
  const files = await open(dir);
  assert.equal(existsSync(join(tmp, 'abandoned.part')), false);
  assert.equal(existsSync(join(tmp, 'keep.me')), true, 'not ours: left alone');
  assert.match(await files.write('a', 'b', 'c', bytesOf(2)), GRAMMAR);
});

test('a .tmp swapped for an outside link makes write refuse io and leaves the outside empty', async t => {
  const dir = join(scratch(t), 'attachments');
  const files = await open(dir);
  const outside = join(scratch(t), 'outside-tmp');
  mkdirSync(outside);
  const tmp = join(dir, '.noindex', '.tmp');
  rmSync(tmp, { recursive: true });
  symlinkSync(outside, tmp);
  assert.equal(await refusal(files.write('acct', 'msg', 'part', bytesOf(8))), 'io');
  assert.equal(readdirSync(outside).length, 0, 'no temp escaped into the outside folder');
});

test('an id that is not well-formed Unicode is refused as a path error', async t => {
  const dir = join(scratch(t), 'attachments');
  const files = await open(dir);
  const lone = 'a\ud800';
  assert.equal(await refusal(files.write(lone, 'm', 'p', bytesOf(1))), 'path');
  assert.equal(await refusal(files.write('a', lone, 'p', bytesOf(1))), 'path');
  assert.equal(await refusal(files.write('a', 'm', lone, bytesOf(1))), 'path');
});
