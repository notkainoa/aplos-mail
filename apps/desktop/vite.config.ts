import { defineConfig, type Plugin } from 'vite';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Development ports can move (APLOS_VITE_PORT / APLOS_API_PORT) so several checkouts preview side by side; the CSP follows them.
const vitePort = Number(process.env.APLOS_VITE_PORT) || 5173,
  apiPort = Number(process.env.VITE_APLOS_API_PORT || process.env.APLOS_API_PORT) || 4317;
// The workspace packages are TypeScript source; the alias matches the tsconfig paths.
const packages = fileURLToPath(new URL('../../packages/', import.meta.url));

/**
 * What Help & about says about this build: the short git commit ("dev" when git is unavailable) and the channel suffix
 * ("revamp" until a release build, which sets APLOS_RELEASE_BUILD=1 and shows the plain version).
 */
export function buildInfo(env: NodeJS.ProcessEnv): { commit: string; channel: string } {
  const channel = env.APLOS_BUILD_CHANNEL ?? (env.APLOS_RELEASE_BUILD === '1' ? '' : 'revamp');
  try {
    const out = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { commit: out.trim() || 'dev', channel };
  } catch {
    return { commit: 'dev', channel };
  }
}

/**
 * The renderer's Content-Security-Policy (plan 40 Q2.5, stage 1). index.html carries the dev
 * policy; `vite serve` moves its ports and `vite build` swaps in the production policy.
 *
 * - script-src: production has no 'unsafe-inline'. The build emits only external module scripts
 *   (modulePreload polyfill off; Electron's Chromium preloads modules natively), and the build
 *   step below fails if an inline script ever appears. Dev keeps 'unsafe-inline' for Vite's and
 *   React's dev-time injected scripts. No script-src-elem, script-src-attr or worker-src: each
 *   overrides script-src for its own targets, and script-src-attr 'unsafe-inline' would let
 *   onerror= handlers in mail HTML (Reader's dangerouslySetInnerHTML) run. The test pins the
 *   whole production policy, so any added directive or source has to be argued there.
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
    // The sealed mail frame (`aplos-mail://m/<token>/`, ARCH 9.3): without this the page's `default-src 'self'` would
    // block the frame. Script inside it runs under its own header policy, in an opaque origin (no allow-same-origin).
    'frame-src aplos-mail:',
    ...(dev ? [] : ["object-src 'none'", "base-uri 'none'", "form-action 'none'"]),
  ].join('; ');
}

/**
 * Finds the one CSP <meta> that will govern the page and returns where it is and its policy, or
 * throws. A meta CSP only counts in <head>, and only for elements parsed after it, so the meta must
 * be the first thing in <head> apart from other <meta> tags. Exactly one may exist anywhere in the
 * text, and none inside a comment: otherwise a commented-out or second copy could be the one the
 * build rewrites (or checks) while the browser obeys another, or none at all.
 */
export function cspMeta(html: string): { start: number; end: number; policy: string } {
  for (const [comment] of html.matchAll(/<!--[\s\S]*?(?:-->|$)/g))
    if (/content-security-policy/i.test(comment))
      throw new Error('index.html has Content-Security-Policy text inside an HTML comment.');
  const mentions = html.match(/content-security-policy/gi)?.length ?? 0;
  if (mentions !== 1)
    throw new Error(
      `index.html must have exactly one Content-Security-Policy meta; found ${mentions}.`,
    );
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"\s*\/?>/.exec(html);
  if (!meta)
    throw new Error(
      'index.html\'s CSP must be written <meta http-equiv="Content-Security-Policy" content="...">.',
    );
  const before = html.slice(0, meta.index);
  if (
    !/^\s*(?:<!doctype html>\s*)?(?:<html\b[^>]*>\s*)?<head\b[^>]*>\s*(?:<meta\b[^>]*>\s*)*$/i.test(
      before,
    )
  )
    throw new Error(
      "index.html's CSP meta must sit in <head>, preceded only by other <meta> tags, so it governs every script and stylesheet.",
    );
  return { start: meta.index, end: meta.index + meta[0].length, policy: meta[1] };
}
function setCsp(html: string, policy: string): string {
  const { start, end } = cspMeta(html);
  return `${html.slice(0, start)}<meta http-equiv="Content-Security-Policy" content="${policy}">${html.slice(end)}`;
}
/** Inline <script> bodies (a script element without a src attribute). */
export function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attributes]) => !/\ssrc\s*=/i.test(attributes))
    .map(([tag]) => tag);
}
/** The production build's final HTML step: refuse inline script or a misplaced meta, then set the policy. */
export function productionHtml(html: string): string {
  const inline = inlineScripts(html);
  if (inline.length)
    throw new Error(
      `The production CSP forbids inline scripts, but index.html has ${inline.length}: ${inline[0].slice(0, 120)}`,
    );
  return setCsp(html, rendererCsp('production'));
}
function csp(): Plugin[] {
  return [
    {
      name: 'aplos-csp-dev',
      apply: 'serve',
      // 'pre' checks index.html as written, before Vite prepends its dev client script to <head>.
      transformIndexHtml: {
        order: 'pre',
        handler: html => setCsp(html, rendererCsp({ vitePort, apiPort })),
      },
    },
    {
      name: 'aplos-csp-production',
      apply: 'build',
      // 'post' runs after Vite has injected its own tags, so the check sees the final HTML.
      transformIndexHtml: {
        order: 'post',
        handler: productionHtml,
      },
    },
  ];
}

export default defineConfig({
  base: './',
  define: { __APLOS_BUILD__: JSON.stringify(buildInfo(process.env)) },
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
