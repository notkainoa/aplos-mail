import { build } from 'esbuild';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { bannerOptions, syntaxOptions } from './build-options.mjs';
import { checkReleaseOAuth, oauthDefines } from './oauth-defines.mjs';
if (process.env.APLOS_RELEASE_BUILD === '1') {
  try {
    for (const warning of checkReleaseOAuth(process.env)) console.warn(`build-main: ${warning}`);
  } catch (error) {
    console.error(`build-main: ${error.message}`);
    process.exit(1);
  }
}
// Test mode (APLOS_TEST=1, main/test-mode.ts) is compiled out of release builds, so a distributed app ignores it.
const define = {
  ...oauthDefines(process.env),
  __APLOS_TEST_MODE__: JSON.stringify(process.env.APLOS_RELEASE_BUILD !== '1'),
};
// Bundle the workspace packages (`@aplos/*`, TypeScript source that is not in the packaged node_modules);
// every third-party package stays external and ships from app.asar's node_modules.
const thirdPartyExternal = {
  name: 'third-party-external',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, args =>
      args.path.startsWith('@aplos/') ? undefined : { path: args.path, external: true },
    );
  },
};
await mkdir('dist/main', { recursive: true });
await build({
  entryPoints: ['src/main/electron.ts'],
  outfile: 'dist/main/electron.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  plugins: [thirdPartyExternal],
  sourcemap: false,
  define,
  ...syntaxOptions(process.env),
  ...bannerOptions(process.env),
});
await build({
  entryPoints: ['src/main/engine-process.ts'],
  outfile: 'dist/main/engine.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  plugins: [thirdPartyExternal],
  sourcemap: false,
  define,
  ...syntaxOptions(process.env),
  ...bannerOptions(process.env),
});
await build({
  entryPoints: ['src/main/preload.ts'],
  outfile: 'dist/main/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
  ...syntaxOptions(process.env),
  ...bannerOptions(process.env),
});
await copyFile('assets/icon.png', 'dist/main/icon.png');
for (const name of ['trayTemplate.png', 'trayTemplate@2x.png'])
  await copyFile(`assets/${name}`, `dist/main/${name}`);

// Universal (arm64 + x86_64) so both release architectures get a working helper.
if (process.platform === 'darwin') {
  await mkdir('dist/bin', { recursive: true });
  const slices = ['arm64', 'x86_64'].map(arch => {
    const out = `dist/bin/aplos-symbols-${arch}`;
    execFileSync(
      'swiftc',
      ['-O', '-target', `${arch}-apple-macos13`, 'native/symbols.swift', '-o', out],
      { stdio: 'inherit' },
    );
    return out;
  });
  execFileSync('lipo', ['-create', ...slices, '-output', 'dist/bin/aplos-symbols'], {
    stdio: 'inherit',
  });
  await Promise.all(slices.map(file => rm(file)));
}
