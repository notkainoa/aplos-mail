import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// The gallery is served from the repo root so it can import apps/desktop sources directly.
const repoRoot = resolve(import.meta.dirname, '..', '..');
const packages = resolve(repoRoot, 'packages') + '/';

export default defineConfig({
  root: repoRoot,
  base: '/',
  cacheDir: resolve(repoRoot, 'node_modules/.vite-visual'),
  resolve: { alias: [{ find: /^@aplos\/(engine|contract)\//, replacement: `${packages}$1/src/` }] },
  server: { host: '127.0.0.1', fs: { allow: [repoRoot] }, watch: null },
  logLevel: 'warn',
});
