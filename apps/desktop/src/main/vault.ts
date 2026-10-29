import * as nodeFs from 'node:fs/promises';
import { join } from 'node:path';

/** The few file calls the vault makes; tests inject faults through it. */
export interface VaultFs {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, options: { mode: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface VaultOptions {
  dataDir: string;
  encrypt?: (value: string) => Buffer;
  decrypt?: (value: Buffer) => string;
  file?: string;
  /** Default: `node:fs/promises`. */
  fs?: VaultFs;
}

/**
 * Account secrets (app passwords, API tokens, OAuth tokens) encrypted with the OS keychain key.
 * Each entry is encrypted on its own so one unreadable entry does not lock the others.
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

const UNAVAILABLE = 'Secure credential storage is unavailable. Connect using the desktop app.';
const UNREADABLE = 'Saved account credentials could not be read. Check the data directory.';
const LOCKED = 'Saved account credentials could not be unlocked. Check your macOS keychain.';
const UNENCRYPTABLE = 'Account credentials could not be encrypted. Check your macOS keychain.';
const UNSAVED = 'Account credentials could not be saved securely. Check the data directory.';

async function readSealed(fs: VaultFs, path: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(UNREADABLE);
  }
}

function unseal<T>(decrypt: (value: Buffer) => string, sealed: string): T {
  try {
    return JSON.parse(decrypt(Buffer.from(sealed, 'base64'))) as T;
  } catch {
    throw new Error(LOCKED);
  }
}

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

async function writeAtomically(fs: VaultFs, dataDir: string, path: string, text: string) {
  try {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(`${path}.tmp`, text, { mode: 0o600 });
    await fs.rename(`${path}.tmp`, path);
  } catch {
    throw new Error(UNSAVED);
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
 */
class SealedVault<T> implements Vault<T> {
  readonly secure: boolean;
  private readonly pending = new Map<string, Mutation<T>[]>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: VaultOptions,
    private readonly fs: VaultFs,
    private readonly path: string,
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
    if (!this.pending.has(id) && !this.committed.has(id)) return;
    await this.mutate({ id, value: undefined });
  }

  private mutate(mutation: Mutation<T>): Promise<void> {
    const { encrypt } = this.options;
    if (!encrypt) return Promise.reject(new Error(UNAVAILABLE));
    const waiting = this.pending.get(mutation.id) ?? [];
    waiting.push(mutation);
    this.pending.set(mutation.id, waiting);
    const operation = this.chain.then(() => this.persist(mutation, encrypt));
    this.chain = operation.catch(() => {});
    return operation;
  }

  private async persist(mutation: Mutation<T>, encrypt: (value: string) => Buffer): Promise<void> {
    try {
      const next = applied(this.committed, mutation, encrypt);
      await writeAtomically(this.fs, this.options.dataDir, this.path, serialize(next));
      this.committed = next;
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

export async function createVault<T>(options: VaultOptions): Promise<Vault<T>> {
  const fs = options.fs ?? nodeFs;
  const path = join(options.dataDir, options.file ?? 'credentials.enc.json');
  const committed = options.decrypt
    ? await load<T>(fs, path, options.decrypt)
    : new Map<string, Committed<T>>();
  return new SealedVault<T>(options, fs, path, committed);
}
