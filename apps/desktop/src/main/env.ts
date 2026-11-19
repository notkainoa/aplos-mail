import { config } from 'dotenv';
import { join } from 'node:path';
// Development env files: the app's own .env first, then the monorepo root's. Existing variables always win.
export function loadDevEnv() {
  for (const dir of [process.cwd(), join(process.cwd(), '..', '..')])
    config({ path: join(dir, '.env'), quiet: true });
}
