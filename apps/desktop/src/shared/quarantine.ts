// Marks a file Aplos wrote as "downloaded from the internet" (com.apple.quarantine), as Mail.app does for a saved
// attachment: Gatekeeper then asks before a downloaded program runs, and Office opens a document in Protected View.
// No Electron import, so node:test runs it with a fake `run`.

import { execFile } from 'node:child_process';

/** The attribute's value: flags 0083 (downloaded, user-approved quarantine), the time in hex seconds, the agent name. */
export function quarantineValue(nowMs: number): string {
  return `0083;${Math.floor(nowMs / 1000).toString(16)};Aplos Mail;`;
}

/** How the xattr tool is run: an argument array, never a shell string, so a file name cannot become a command. */
export type RunTool = (file: string, args: readonly string[]) => Promise<void>;

const XATTR = '/usr/bin/xattr';

const runXattr: RunTool = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: 5_000 }, error => (error ? reject(error) : resolve()));
  });

/** Marks `file`. A no-op off macOS (there is no such attribute); rejects when the tool fails. */
export async function markQuarantined(
  file: string,
  options: { now?: () => number; platform?: string; run?: RunTool } = {},
): Promise<void> {
  if ((options.platform ?? process.platform) !== 'darwin') return;
  const value = quarantineValue((options.now ?? Date.now)());
  await (options.run ?? runXattr)(XATTR, ['-w', 'com.apple.quarantine', value, file]);
}
