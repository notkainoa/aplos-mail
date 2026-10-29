import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** The few file calls the vault makes; tests inject faults through it. */
export interface VaultFs {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, options: { mode: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Optional: removes a temporary file after a failed write, or one a crash left behind. */
  unlink?(path: string): Promise<void>;
  /** Optional: creates the file, flushes it to the disk and closes it. Without it the vault uses `writeFile`. */
  writeFileSynced?(path: string, data: string, mode: number): Promise<void>;
  /** Optional: flushes a directory so a rename inside it survives a power loss. */
  syncDir?(path: string): Promise<void>;
  /** Optional: lists a directory, so every temporary file a crash left behind is found at load. */
  readdir?(path: string): Promise<string[]>;
}

export interface VaultOptions {
  dataDir: string;
  encrypt?: (value: string) => Buffer;
  decrypt?: (value: Buffer) => string;
  file?: string;
  /** Default: `node:fs/promises`, with every write flushed to the disk before it counts as saved. */
  fs?: VaultFs;
  /** How long one file call of a save may take before the save fails. Default: 15 s. */
  writeTimeoutMs?: number;
}

/**
 * Account secrets (app passwords, API tokens, OAuth tokens) encrypted with the OS keychain key.
 * Each entry is encrypted on its own, but a file holding any entry this keychain cannot open refuses to
 * load: a save rewrites the whole file, so it must never run over entries it could not read.
 */
export interface Vault<T> {
  readonly secure: boolean;
  get(id: string): T | undefined;
  set(id: string, value: T): Promise<void>;
  delete(id: string): Promise<void>;
}

/** An entry the file on disk holds: the value and its encrypted, base64 form. */
interface Committed<T> {
  value: T;
  sealed: string;
}

/** One `set` (a value) or `delete` (undefined) that has not reached the disk yet. */
interface Mutation<T> {
  id: string;
  value: T | undefined;
}

/** Where and how the vault file is written. */
interface Target {
  fs: VaultFs;
  path: string;
  timeoutMs: number;
}

/** `replaced`: the file was renamed into place but the write did not finish, so the disk may hold it. */
type Outcome = 'saved' | 'unsaved' | 'replaced';

const UNAVAILABLE = 'Secure credential storage is unavailable. Connect using the desktop app.';
const UNREADABLE = 'Saved account credentials could not be read. Check the data directory.';
const LOCKED = 'Saved account credentials could not be unlocked. Check your macOS keychain.';
const UNENCRYPTABLE = 'Account credentials could not be encrypted. Check your macOS keychain.';
const UNSAVED = 'Account credentials could not be saved securely. Check the data directory.';
const HALF_KEYCHAIN =
  'Secure credential storage can only partly open saved account credentials. Restart Aplos Mail.';
const WRITE_TIMEOUT_MS = 15_000;
// Writes of the committed entries a queued repair tries before it leaves the vault dirty for the next turn.
const REPAIR_ATTEMPTS = 3;
// A directory cannot be flushed on Windows and on some file systems; there the rename is as durable as it gets.
const UNSYNCABLE_DIR = new Set(['EISDIR', 'EINVAL', 'EPERM', 'ENOTSUP']);
// `<file>.tmp` (older versions) or `<file>.<uuid>.tmp`.
const TEMPORARY_SUFFIX = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.)?tmp$/;

async function writeFileSynced(path: string, data: string, mode: number): Promise<void> {
  // `wx`: a fresh file, never one that is already there (or a link planted in its place).
  const handle = await nodeFs.open(path, 'wx', mode);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function ignoreUnsyncable(error: unknown): undefined {
  if (UNSYNCABLE_DIR.has((error as NodeJS.ErrnoException).code ?? '')) return undefined;
  throw error;
}

async function syncDir(path: string): Promise<void> {
  const handle = await nodeFs.open(path, 'r').catch(ignoreUnsyncable);
  if (!handle) return;
  try {
    await handle.sync().catch(ignoreUnsyncable);
  } finally {
    await handle.close();
  }
}

/** Temporary files this process is still writing; a vault loading meanwhile must not remove them. */
const writing = new Set<string>();

/** A file call that did not settle in time; it may still settle (and take effect) later. */
class TimedOut extends Error {}

const nodeVaultFs: VaultFs = {
  mkdir: (path, options) => nodeFs.mkdir(path, options),
  readFile: (path, encoding) => nodeFs.readFile(path, encoding),
  writeFile: (path, data, options) => nodeFs.writeFile(path, data, options),
  rename: (from, to) => nodeFs.rename(from, to),
  unlink: path => nodeFs.unlink(path),
  readdir: path => nodeFs.readdir(path),
  writeFileSynced,
  syncDir,
};

/**
 * Settles like `call`, or rejects once `ms` pass so a hung file call cannot wedge the write queue. A call
 * that settles after that is reported to `late` (true when it succeeded) so its effect can be undone.
 */
function bounded<R>(
  call: () => Promise<R>,
  ms: number,
  late: (succeeded: boolean) => void = () => {},
): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new TimedOut('timed out'));
    }, ms);
    const settle = (succeeded: boolean, done: () => void) => {
      clearTimeout(timer);
      if (timedOut) late(succeeded);
      else done();
    };
    (async () => call())().then(
      value => settle(true, () => resolve(value)),
      (error: unknown) => settle(false, () => reject(error)),
    );
  });
}

async function removeQuietly(target: Target, path: string): Promise<void> {
  const { fs } = target;
  await bounded(async () => fs.unlink?.(path), target.timeoutMs).catch(() => {});
}

function isTemporaryOf(file: string, name: string): boolean {
  return name.startsWith(`${file}.`) && TEMPORARY_SUFFIX.test(name.slice(file.length + 1));
}

async function listTemporaries(fs: VaultFs, path: string): Promise<string[]> {
  const file = basename(path);
  const names = fs.readdir ? await fs.readdir(dirname(path)) : [`${file}.tmp`];
  return names.filter(name => isTemporaryOf(file, name)).map(name => join(dirname(path), name));
}

/**
 * Best effort: a crash mid-write can leave an encrypted temporary copy behind. Never the vault file itself, nor
 * a temporary file this process is still writing. Another process writing the same vault at that moment would
 * lose its write (it reports UNSAVED); the app's single-instance lock keeps a second process away.
 */
async function removeStaleTemporaries(target: Target): Promise<void> {
  if (!target.fs.unlink) return;
  const found = await bounded(
    () => listTemporaries(target.fs, target.path),
    target.timeoutMs,
  ).catch(() => []);
  const stale = found.filter(path => !writing.has(path));
  await Promise.all(stale.map(path => removeQuietly(target, path)));
}

function isSealedMap(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(entry => typeof entry === 'string');
}

async function readSealed(fs: VaultFs, path: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
    if (isSealedMap(parsed)) return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
  }
  throw new Error(UNREADABLE);
}

function unseal<T>(decrypt: (value: Buffer) => string, sealed: string): T {
  try {
    return JSON.parse(decrypt(Buffer.from(sealed, 'base64'))) as T;
  } catch {
    throw new Error(LOCKED);
  }
}

/** Every entry, or LOCKED when any one cannot be opened: the first save would otherwise drop it. */
async function load<T>(
  fs: VaultFs,
  path: string,
  decrypt: (value: Buffer) => string,
): Promise<Map<string, Committed<T>>> {
  const entries = new Map<string, Committed<T>>();
  for (const [id, sealed] of Object.entries(await readSealed(fs, path))) {
    entries.set(id, { value: unseal<T>(decrypt, sealed), sealed });
  }
  return entries;
}

function seal(encrypt: (value: string) => Buffer, value: unknown): string {
  try {
    return encrypt(JSON.stringify(value)).toString('base64');
  } catch {
    throw new Error(UNENCRYPTABLE);
  }
}

/** The committed entries with one mutation applied; encrypts only the mutated value. */
function applied<T>(
  committed: ReadonlyMap<string, Committed<T>>,
  mutation: Mutation<T>,
  encrypt: (value: string) => Buffer,
): Map<string, Committed<T>> {
  const next = new Map(committed);
  if (mutation.value === undefined) next.delete(mutation.id);
  else next.set(mutation.id, { value: mutation.value, sealed: seal(encrypt, mutation.value) });
  return next;
}

function writeNew(fs: VaultFs, path: string, text: string): Promise<void> {
  if (fs.writeFileSynced) return fs.writeFileSynced(path, text, 0o600);
  return fs.writeFile(path, text, { mode: 0o600 });
}

/**
 * Writes `text` to a temporary file of its own, flushed to the disk, renames it over the vault file and
 * flushes the directory, so a power loss leaves either the old file or the new one, never a truncated one.
 * Each call is bounded; a rename that times out and then lands anyway is reported to `onLateRename`, since it
 * puts this (failed) text on the disk after whatever was written since.
 */
async function writeAtomically(
  target: Target,
  text: string,
  onLateRename: () => void,
): Promise<Outcome> {
  const { fs, path, timeoutMs } = target;
  const dir = dirname(path);
  // A name of its own, so a write that timed out but is still running never mixes with the next one.
  const temporary = `${path}.${randomUUID()}.tmp`;
  // A failed write must not leave an encrypted copy of a value that was reported as unsaved.
  const discard = () => removeQuietly(target, temporary);
  const forget = () => writing.delete(temporary);
  const abandon = () => void discard().finally(forget);
  writing.add(temporary);
  let renamed = false;
  try {
    await bounded(() => fs.mkdir(dir, { recursive: true, mode: 0o700 }), timeoutMs, forget);
    await bounded(() => writeNew(fs, temporary, text), timeoutMs, abandon);
    await bounded(
      () => fs.rename(temporary, path),
      timeoutMs,
      landed => {
        if (landed) onLateRename();
        abandon();
      },
    );
    renamed = true;
    forget();
    await bounded(async () => fs.syncDir?.(dir), timeoutMs);
    return 'saved';
  } catch (error) {
    if (renamed) return 'replaced';
    await discard();
    // A call that timed out may still create the file; its late handler removes it and forgets the name.
    if (!(error instanceof TimedOut)) forget();
    return 'unsaved';
  }
}

function serialize<T>(entries: ReadonlyMap<string, Committed<T>>): string {
  return JSON.stringify(Object.fromEntries([...entries].map(([id, entry]) => [id, entry.sealed])));
}

/**
 * `committed` is exactly what the file holds. A mutation waits in `pending` until its write, serialized on `chain`,
 * succeeds (it joins `committed`) or fails (it is dropped). Each write is the committed entries plus that one mutation,
 * so a failed value never reaches the disk through another entry's write. `get` answers the latest mutation still
 * waiting, so dropping a failed one falls back to whatever came before or after it, never undoing a later write.
 * A failed write that may still have put its file in place marks the vault `dirty` (the disk may differ from
 * `committed`) and queues a repair: the committed entries written again, up to REPAIR_ATTEMPTS times. While still
 * dirty, the next set, delete or `flushVault` tries again before anything else; any successful write clears it.
 */
class SealedVault<T> implements Vault<T> {
  readonly secure: boolean;
  private readonly pending = new Map<string, Mutation<T>[]>();
  private chain: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(
    private readonly options: VaultOptions,
    private readonly target: Target,
    private committed: Map<string, Committed<T>>,
  ) {
    this.secure = Boolean(options.encrypt && options.decrypt);
  }

  get(id: string): T | undefined {
    const waiting = this.pending.get(id);
    if (waiting?.length) return waiting[waiting.length - 1].value;
    return this.committed.get(id)?.value;
  }

  set(id: string, value: T): Promise<void> {
    return this.mutate({ id, value });
  }

  async delete(id: string): Promise<void> {
    // A waiting mutation may still fail, so a delete behind one is written even when `get` already answers undefined.
    if (this.pending.has(id) || this.committed.has(id))
      return this.mutate({ id, value: undefined });
    if (this.dirty) await this.flush();
  }

  /** Waits for every queued write, then retries the repair if the disk may still differ from `committed`. */
  flush(): Promise<void> {
    return this.enqueue(() => this.restore(REPAIR_ATTEMPTS));
  }

  private mutate(mutation: Mutation<T>): Promise<void> {
    const { encrypt } = this.options;
    if (!encrypt) return Promise.reject(new Error(UNAVAILABLE));
    const waiting = this.pending.get(mutation.id) ?? [];
    waiting.push(mutation);
    this.pending.set(mutation.id, waiting);
    return this.enqueue(() => this.persist(mutation, encrypt));
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const operation = this.chain.then(task);
    this.chain = operation.catch(() => {});
    return operation;
  }

  private write(text: string): Promise<Outcome> {
    return writeAtomically(this.target, text, () => this.repair());
  }

  /** A failed write landed anyway: the disk may differ from `committed` until a write of it succeeds. */
  private repair(): void {
    this.dirty = true;
    void this.flush();
  }

  /** Writes exactly the committed entries, up to `attempts` times, while the disk may differ from them. */
  private async restore(attempts: number): Promise<void> {
    for (let attempt = 0; attempt < attempts && this.dirty; attempt++) {
      if ((await this.write(serialize(this.committed))) === 'saved') this.dirty = false;
    }
  }

  private async persist(mutation: Mutation<T>, encrypt: (value: string) => Buffer): Promise<void> {
    try {
      // One more try at a repair that failed, so the disk is right even when this mutation cannot be written.
      await this.restore(1);
      const next = applied(this.committed, mutation, encrypt);
      const outcome = await this.write(serialize(next));
      if (outcome === 'saved') {
        this.committed = next;
        this.dirty = false;
        return;
      }
      if (outcome === 'replaced') this.repair();
      throw new Error(UNSAVED);
    } finally {
      this.settle(mutation);
    }
  }

  private settle(mutation: Mutation<T>): void {
    const waiting = this.pending.get(mutation.id);
    if (!waiting) return;
    waiting.splice(waiting.indexOf(mutation), 1);
    if (!waiting.length) this.pending.delete(mutation.id);
  }
}

/** `setTimeout` fires at once for 0, NaN, negative or over-2^31 delays, which would fail every save. */
function writeTimeout(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return WRITE_TIMEOUT_MS;
  return Math.min(ms, 2 ** 31 - 1);
}

/** For tests and shutdown: waits for queued writes and retries a repair the vault still owes the disk. */
export async function flushVault<T>(vault: Vault<T>): Promise<void> {
  if (vault instanceof SealedVault) await vault.flush();
}

export async function createVault<T>(options: VaultOptions): Promise<Vault<T>> {
  // With only one half of the keychain the vault would start empty and its first save would drop every entry.
  if (Boolean(options.encrypt) !== Boolean(options.decrypt)) throw new Error(HALF_KEYCHAIN);
  const target: Target = {
    fs: options.fs ?? nodeVaultFs,
    path: join(options.dataDir, options.file ?? 'credentials.enc.json'),
    timeoutMs: writeTimeout(options.writeTimeoutMs),
  };
  if (!options.decrypt) return new SealedVault<T>(options, target, new Map());
  await removeStaleTemporaries(target);
  return new SealedVault<T>(
    options,
    target,
    await load<T>(target.fs, target.path, options.decrypt),
  );
}
