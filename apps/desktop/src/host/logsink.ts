import {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LogRecord } from '@aplos/contract';
import type { LogSink } from '@aplos/engine/diag/log';

/**
 * The host log sink (plan 10 E0, ARCH 11; Phase 0 artifact F7): JSON lines in `~/Library/Logs/Aplos Mail/`, rotated at
 * 10 MB x 5 files, files 0600 in a 0700 directory. Lines arrive already redacted by the engine's Logger; the sink only
 * stores them. It never throws into the engine: a failing disk drops lines, counts them, and says so once it can write.
 */

export const LOG_FILE = 'aplos.log';
const LINE_MAX = 64 * 1024;

/** `<dataDir>/logs` when the caller runs isolated (`APLOS_DATA_DIR`, tests), else the macOS log folder. */
export function logDir(options: { dataDir?: string } = {}): string {
  return options.dataDir
    ? join(options.dataDir, 'logs')
    : join(homedir(), 'Library', 'Logs', 'Aplos Mail');
}

export interface LogSinkOptions {
  dir: string;
  /** Bytes per file before rotation; 10 MB. */
  maxBytes?: number;
  /** Files kept, the live one included: `aplos.log`, `aplos.log.1` … `aplos.log.4`. */
  files?: number;
  now?: () => number;
}

export interface LogSinkStats {
  lines: number;
  droppedLines: number;
  rotations: number;
}
export interface HostLogSink extends LogSink {
  stats(): LogSinkStats;
  close(): void;
}

export function createLogSink({
  dir,
  maxBytes = 10 * 1024 * 1024,
  files = 5,
  now = Date.now,
}: LogSinkOptions): HostLogSink {
  const stats: LogSinkStats = { lines: 0, droppedLines: 0, rotations: 0 };
  const path = (n: number) => join(dir, n ? `${LOG_FILE}.${n}` : LOG_FILE);
  let fd: number | undefined;
  let size = 0;
  /** Lines lost to the disk since the last line that reached it. */
  let unreported = 0;

  function open() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    // Files left by an older build or another tool keep their modes on rename, so fix every one, not just the live file.
    for (const name of readdirSync(dir))
      if (name === LOG_FILE || name.startsWith(`${LOG_FILE}.`)) chmodSync(join(dir, name), 0o600);
    fd = openSync(path(0), 'a', 0o600);
    fchmodSync(fd, 0o600);
    size = fstatSync(fd).size;
  }

  function drop() {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {
        // Already closed or gone: there is nothing left to flush, and the sink never throws.
      }
    fd = undefined;
  }

  function rotate() {
    drop();
    rmSync(path(files - 1), { force: true });
    for (let n = files - 2; n >= 0; n--)
      try {
        renameSync(path(n), path(n + 1));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    stats.rotations++;
    open();
  }

  function append(line: string) {
    const bytes = Buffer.byteLength(line);
    if (fd === undefined) open();
    if (size > 0 && size + bytes > maxBytes) rotate();
    writeSync(fd!, line);
    size += bytes;
  }

  function notice(why: 'disk' | 'oversize', lines: number) {
    const record: LogRecord = {
      t: now(),
      level: 'warn',
      event: 'log.lines_dropped',
      data: { lines, why },
    };
    append(`${JSON.stringify(record)}\n`);
  }

  return {
    write(record) {
      let line: string;
      try {
        line = `${JSON.stringify(record)}\n`;
      } catch {
        stats.droppedLines++;
        return;
      }
      try {
        if (unreported) {
          notice('disk', unreported);
          unreported = 0;
        }
        if (line.length > LINE_MAX) {
          stats.droppedLines++;
          notice('oversize', 1);
          return;
        }
        append(line);
        stats.lines++;
      } catch {
        stats.droppedLines++;
        unreported++;
        drop();
      }
    },
    stats: () => ({ ...stats }),
    close: drop,
  };
}
