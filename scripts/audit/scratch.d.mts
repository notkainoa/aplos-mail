// Type declarations for scratch.mjs so TypeScript tests can import it:
//   import { scratchDir, scratchDirFor } from '../../../scripts/audit/scratch.mjs';
// The test-context parameter is structural so it works with or without @types/node's
// node:test TestContext.
export declare const scratchRegistry: Map<string, true>;
export declare const scratchNamePattern: RegExp;
export declare const scratchMarkerName: string;
export declare function cleanupScratch(): void;
export declare function isRegisteredScratch(dir: string): boolean;
export declare function processStartKey(
  pid: number,
  readers?: {
    platform?: string;
    readFile?: (path: string) => string;
    ps?: (pid: number) => string;
  },
): string | null;
export declare function scratchDir(prefix?: string): string;
export declare function scratchDirFor(
  t: { after(fn: () => void | Promise<void>): void },
  prefix?: string,
): string;
