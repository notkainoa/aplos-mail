import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RunnerError } from './errors';
import { applicationSupportDir } from './vault';

/**
 * The small state a phased probe leaves for its next phase (plan 20 5.4). Like the evidence file it is written from an
 * allowlist: a fixed set of key names, and values that are only a short lowercase hex string (a salted hash, a salt),
 * a decimal history cursor (`historyId`) or one of a few shape words. No Message-ID, address, id or text can be
 * stored, so the file is content-free even though it sits on the Mac outside the repository, mode 0600 in a 0700
 * folder.
 */

/** Key names a probe may keep. Add a name here on purpose when a probe needs one. */
export const STATE_KEYS: readonly string[] = [
  'salt',
  'tokenHash',
  'draftTokenHash',
  'afterCreateHash',
  'afterSaveHash',
  'draftIdHash',
  'afterCreateShape',
  'afterSaveShape',
  // gmail.archive-delta-cost: the Gmail history cursor its `mark` phase leaves for `measure`.
  'historyId',
];
/** The words a shape value may take. */
export const SHAPE_WORDS: readonly string[] = ['ours', 'gmail', 'other', 'absent'];
/** A salted hash is exactly 16 hex characters and a salt exactly 32: a 16-hex Gmail message id fits no other key. */
const HASH = /^[0-9a-f]{16}$/;
const SALT = /^[0-9a-f]{32}$/;
/** A Gmail history cursor is a decimal string: digits only, so no token or id can hide in it. */
const HISTORY_ID = /^\d{1,25}$/;

export interface ProbeState {
  /** What the earlier phase saved, or undefined when nothing (or nothing valid) is there. */
  load(): Promise<Record<string, string> | undefined>;
  /** Replaces the saved state. Throws, naming the field only, on a key or value that is not allowed. */
  save(values: Record<string, string>): Promise<void>;
}

const ID = /^[a-z][a-z0-9.-]{0,60}$/;

/** Each key has its own kind of value: `salt` 32 hex, a `...Hash` 16 hex, a `...Shape` one of the shape words, `historyId` digits. */
function allowedValue(key: string, value: string): boolean {
  if (key === 'salt') return SALT.test(value);
  if (key.endsWith('Hash')) return HASH.test(value);
  if (key.endsWith('Shape')) return SHAPE_WORDS.includes(value);
  if (key === 'historyId') return HISTORY_ID.test(value);
  return false;
}

function checked(values: unknown): Record<string, string> {
  if (typeof values !== 'object' || values === null || Array.isArray(values))
    throw new RunnerError('State rejected: not an object');
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!STATE_KEYS.includes(key))
      throw new RunnerError('State rejected: a key is not on the allowlist');
    if (typeof value !== 'string' || !allowedValue(key, value))
      throw new RunnerError(`State rejected: the value of ${key} is not allowed`);
    out[key] = value;
  }
  return out;
}

/** `~/Library/Application Support/Aplos Mail Review/live/state/`, outside the repository. */
export function defaultStateDir(): string {
  return applicationSupportDir('Aplos Mail Review', 'live', 'state');
}

export function createProbeState(dir: string, probeId: string): ProbeState {
  if (!ID.test(probeId)) throw new RunnerError('State rejected: probe id');
  const file = join(dir, `${probeId}.json`);
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        return undefined;
      }
      try {
        return checked(JSON.parse(text));
      } catch {
        return undefined;
      }
    },
    async save(values) {
      const body = checked(values);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      // `mkdir` leaves an existing folder as it is.
      await chmod(dir, 0o700);
      const temp = `${file}.tmp`;
      // Whatever sits at the temp name (a leftover, a planted symlink) is removed, and the file is created exclusively
      // (`wx`: O_EXCL, which does not follow a symlink), so this never writes through a link.
      await rm(temp, { force: true });
      await writeFile(temp, `${JSON.stringify(body)}\n`, { mode: 0o600, flag: 'wx' });
      await chmod(temp, 0o600);
      await rename(temp, file);
    },
  };
}
