// Saving and opening an attachment on the owner's disk, with the I/O handed in so node:test drives every branch with fakes.
// The destination of a save is whatever the save dialog returns and nothing a caller sends; an open writes a private temp
// file, marks it quarantined, and hands it to the OS only when its name and its first bytes agree on a safe type.

import { extensionOf } from './desktop-v1';
import { sniffMatches, SNIFFED_EXTENSIONS } from './file-sniff';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const TEMP_PREFIX = 'aplos-attachment-';
const NOT_OPENABLE = 'Save this attachment to inspect it before opening.';

export interface FileIo {
  /** The save dialog, seeded with a file name only. */
  chooseSavePath(defaultName: string): Promise<{ canceled: boolean; filePath?: string }>;
  writeFile(path: string, data: Uint8Array, options?: { mode: number }): Promise<void>;
  /** A fresh private directory (mode 0700) under the system temp folder; its path. */
  makeTempDir(prefix: string): Promise<string>;
  join(...parts: string[]): string;
  /** Hands a file to its app; resolves to the OS's error text, or '' when it opened. */
  openPath(path: string): Promise<string>;
  /** Marks a file quarantined (`shared/quarantine.ts`); rejects when it cannot. */
  quarantine(path: string): Promise<void>;
  /** Removes a directory and what is in it (the temp folder of a file that was not opened). */
  removeDir(path: string): Promise<void>;
  /** Test mode launches no other app. */
  testMode: boolean;
}

/** The save dialog, then the bytes to the path the OWNER chose in it. A save the OS cannot quarantine still saves. */
export async function saveAttachment(io: FileIo, name: string, data: Uint8Array) {
  if (data.length > MAX_FILE_BYTES) throw new Error('Attachment exceeds 25 MB.');
  const chosen = await io.chooseSavePath(name);
  if (chosen.canceled || !chosen.filePath) return { canceled: true as const };
  await io.writeFile(chosen.filePath, data);
  // A volume with no extended attributes must not fail a save the owner asked for; the file is still where they put it.
  await io.quarantine(chosen.filePath).catch(() => undefined);
  return { canceled: false as const, path: chosen.filePath };
}

/** Whether `name` and `data` may be opened in another app: a safe extension whose bytes look like that type. */
export function isOpenable(name: string, data: Uint8Array): boolean {
  const extension = extensionOf(name);
  return SNIFFED_EXTENSIONS.has(extension) && sniffMatches(extension, data);
}

/** Writes the bytes to a private temp file, quarantines it, and opens it. Refuses before any write when it is not safe. */
export async function openAttachment(io: FileIo, name: string, data: Uint8Array) {
  if (data.length > MAX_FILE_BYTES) throw new Error('Attachment exceeds 25 MB.');
  if (!isOpenable(name, data)) throw new Error(NOT_OPENABLE);
  if (io.testMode) return true; // no other app is launched in test mode
  const directory = await io.makeTempDir(TEMP_PREFIX);
  const file = io.join(directory, name);
  await io.writeFile(file, data, { mode: 0o600 });
  // Fail closed: a file that cannot be marked as downloaded is not handed to an app.
  await io.quarantine(file).catch(async () => {
    // Nothing unmarked stays on disk.
    await io.removeDir(directory).catch(() => undefined);
    throw new Error("Aplos couldn't open that file. Save it and open it from there.");
  });
  // The OS's own sentence names paths; the page is told the plain one.
  if (await io.openPath(file))
    throw new Error("Aplos couldn't open that file. Save it and open it from there.");
  return true;
}

/** Start-up sweep: temp folders an earlier session left behind (an opened attachment is never deleted while its app has it). */
export async function sweepTemp(io: {
  tempEntries(): Promise<string[]>;
  removeTemp(entry: string): Promise<void>;
}): Promise<number> {
  let removed = 0;
  for (const entry of await io.tempEntries().catch(() => [] as string[])) {
    if (!entry.startsWith(TEMP_PREFIX)) continue;
    await io.removeTemp(entry).then(
      () => void (removed += 1),
      () => undefined,
    );
  }
  return removed;
}
