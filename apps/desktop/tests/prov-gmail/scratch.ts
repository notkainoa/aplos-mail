import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Scratch directories for the rigs. A test that forgets to close its rig must not leak a directory into /tmp (a full
// tmpfs stops every other test), so every directory is also removed when the test process exits.
const open = new Set<string>();
let hooked = false;

function sweep(): void {
  for (const dir of open) rmSync(dir, { recursive: true, force: true });
  open.clear();
}

export function scratchDir(prefix: string): string {
  if (!hooked) {
    hooked = true;
    process.once('exit', sweep);
  }
  const dir = mkdtempSync(join(tmpdir(), prefix));
  open.add(dir);
  return dir;
}

export function removeScratchDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  open.delete(dir);
}
