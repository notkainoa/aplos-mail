import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
// Development ports can move (APLOS_VITE_PORT / APLOS_API_PORT) so several checkouts preview side by side; the CSP follows them.
const vitePort = Number(process.env.APLOS_VITE_PORT) || 5173,
  apiPort = Number(process.env.VITE_APLOS_API_PORT || process.env.APLOS_API_PORT) || 4317;
// The workspace packages are TypeScript source; the alias matches the tsconfig paths.
const packages = fileURLToPath(new URL('../../packages/', import.meta.url));

/**
 * The renderer's Content-Security-Policy (plan 40 Q2.5, stage 1). index.html carries the dev
 * policy; `vite serve` moves its ports and `vite build` swaps in the production policy.
 *
 * - script-src: production has no 'unsafe-inline'. The build emits only external module scripts
 *   (modulePreload polyfill off; Electron's Chromium preloads modules natively), and the build
 *   step below fails if an inline script ever appears. Dev keeps 'unsafe-inline' for Vite's and
 *   React's dev-time injected scripts.
 * - style-src keeps 'unsafe-inline': React renders `style={...}` props as style attributes
 *   (layout sizes, motion, colours), and a CSP can only allow those with 'unsafe-inline'.
 * - img-src keeps https: until stage 2, when eng-html's aplos-mail: frames replace it.
 * - connect-src: the packaged app talks to the engine over IPC, so no loopback origin; only the
 *   browser preview (dev) fetches the API on 127.0.0.1.
 * - frame-ancestors cannot be set here: browsers ignore it (and report-uri, sandbox) in a <meta>
 *   CSP. The renderer is a top-level file:// window nothing else frames; stage 2 serves it from
 *   aplos-app:// with the policy as a real header, which can carry frame-ancestors 'none'.
 */
export function rendererCsp(mode: 'production' | { vitePort: number; apiPort: number }): string {
  const dev = mode !== 'production';
  const loopback = dev
    ? ` http://127.0.0.1:${mode.vitePort} ws://127.0.0.1:${mode.vitePort} http://127.0.0.1:${mode.apiPort}`
    : '';
  return [
    "default-src 'self'",
    dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob:",
    `connect-src 'self'${loopback}`,
    "font-src 'self' data:",
    ...(dev ? [] : ["object-src 'none'", "base-uri 'none'", "form-action 'none'"]),
  ].join('; ');
}

const cspMeta = /(<meta http-equiv="Content-Security-Policy" content=")[^"]*(")/;
function setCsp(html: string, policy: string): string {
  // A missing meta would ship the renderer with no policy at all, so the build stops instead.
  if (!cspMeta.test(html)) throw new Error('index.html has no Content-Security-Policy meta tag.');
  return html.replace(cspMeta, `$1${policy}$2`);
}
/** Inline <script> bodies (a script element without a src attribute). */
export function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attributes]) => !/\ssrc\s*=/i.test(attributes))
    .map(([tag]) => tag);
}
function csp(): Plugin[] {
  return [
    {
      name: 'aplos-csp-dev',
      apply: 'serve',
      transformIndexHtml: html => setCsp(html, rendererCsp({ vitePort, apiPort })),
    },
    {
      name: 'aplos-csp-production',
      apply: 'build',
      // 'post' runs after Vite has injected its own tags, so the check sees the final HTML.
      transformIndexHtml: {
        order: 'post',
        handler(html) {
          const inline = inlineScripts(html);
          if (inline.length)
            throw new Error(
              `The production CSP forbids inline scripts, but index.html has ${inline.length}: ${inline[0].slice(0, 120)}`,
            );
          return setCsp(html, rendererCsp('production'));
        },
      },
    },
  ];
}

export default defineConfig({
  base: './',
  resolve: { alias: [{ find: /^@aplos\/(engine|contract)\//, replacement: `${packages}$1/src/` }] },
  server: {
    host: '127.0.0.1',
    port: vitePort,
    strictPort: true,
    watch: { ignored: ['**/release/**', '**/dist/**', '**/artifacts/**'] },
  },
  build: { outDir: 'dist/renderer', modulePreload: { polyfill: false } },
  plugins: [csp()],
});
