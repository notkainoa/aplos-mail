import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { killGroup, onShutdown } from './lifecycle';

// Used by lifecycle.test.ts only: a "scorer" holding a detached child (like the vite server) and a
// cleanup that leaves a marker, waiting to be signalled. argv: marker file.

const marker = process.argv[2] as string;
const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
onShutdown(() => void killGroup(child.pid));
onShutdown(() => writeFileSync(marker, 'cleaned'));
process.stdout.write(`${child.pid}\n`);
setInterval(() => undefined, 1000);
