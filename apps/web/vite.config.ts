import { defineConfig } from 'vite';
import { resolve } from 'node:path';
// Static pages (landing, privacy, terms, download). Each is its own HTML entry, so the build is plain files with no router or server.
export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: Number(process.env.APLOS_WEB_PORT) || 5273, strictPort: true },
  preview: {
    host: '127.0.0.1',
    port: Number(process.env.APLOS_WEB_PORT) || 5273,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        privacy: resolve(import.meta.dirname, 'privacy/index.html'),
        terms: resolve(import.meta.dirname, 'terms/index.html'),
        download: resolve(import.meta.dirname, 'download/index.html'),
      },
    },
  },
});
