// Builds the release artifacts (DMG + ZIP, arm64 + x64, latest-mac.yml) with electron-builder.
// Signs and notarizes only when the credentials exist; otherwise makes an ad-hoc signed build.
// Usage: node scripts/release-build.mjs [--publish never|always] [extra electron-builder args]
// Run `APLOS_RELEASE_BUILD=1 npm run build` first (the npm scripts release:build / release:publish do);
// a bundle built without it is refused.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Only a bundle built with APLOS_RELEASE_BUILD=1 carries the release define, and with it the ADR 40-6
// debug guard and the release-only renderer rules (src/main/security.ts). Packaging a dev bundle as a
// release would ship a debuggable app with the release identity, so refuse it.
for (const bundle of ['electron.cjs', 'engine.cjs']) {
  let source = '';
  try {
    source = readFileSync(new URL(`../dist/main/${bundle}`, import.meta.url), 'utf8');
  } catch {
    // Missing: reported below like a non-release bundle.
  }
  if (!/\bvar releaseBuild = true;/.test(source)) {
    console.error(
      `release-build: dist/main/${bundle} is missing or was not built with APLOS_RELEASE_BUILD=1; run npm run release:build (or APLOS_RELEASE_BUILD=1 npm run build) first.`,
    );
    process.exit(1);
  }
}

const env = { ...process.env };
// GitHub Actions passes missing secrets as empty strings; electron-builder should see them as absent.
const signingVars = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_NAME',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
];
for (const name of signingVars) if (!env[name]?.trim()) delete env[name];

const args = process.argv.slice(2);
if (!args.includes('--publish')) args.push('--publish', 'never');
const extra = [];
const signed = Boolean(env.CSC_LINK || env.CSC_NAME);
const notaryVars = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
const notary = notaryVars.filter(name => env[name]);

if (!signed) {
  // No Developer ID: never pick up a random identity from this Mac's keychain. Ad-hoc signing keeps the
  // bundle seal valid (an unsealed arm64 app is reported as "damaged" after download); it is not trusted
  // by Gatekeeper and the in-app updater stays off for it.
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  delete env.CSC_KEY_PASSWORD;
  extra.push('-c.mac.identity=-', '-c.mac.notarize=false');
  console.log('release-build: no CSC_LINK/CSC_NAME, building ad-hoc signed and not notarized.');
} else if (notary.length === 0) {
  extra.push('-c.mac.notarize=false');
  console.log(
    'release-build: signing with the Developer ID certificate; APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID not set, so not notarizing.',
  );
} else if (notary.length < notaryVars.length) {
  console.error(
    `release-build: notarization needs all of ${notaryVars.join(', ')}; missing ${notaryVars.filter(name => !env[name]).join(', ')}.`,
  );
  process.exit(1);
} else console.log('release-build: signing and notarizing.');

const cli = createRequire(import.meta.url).resolve('electron-builder/cli.js');
const result = spawnSync(process.execPath, [cli, '--mac', ...args, ...extra], {
  stdio: 'inherit',
  env,
});
process.exit(result.status ?? 1);
