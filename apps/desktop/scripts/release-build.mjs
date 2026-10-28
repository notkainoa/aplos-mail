// Builds the release artifacts (DMG + ZIP, arm64 + x64, latest-mac.yml) with electron-builder.
// Signs and notarizes only when the credentials exist; otherwise makes an ad-hoc signed build.
// Usage: node scripts/release-build.mjs [--publish never|always] [extra electron-builder args]
// Run `npm run build` first (the npm scripts release:build / release:publish do).
// After a successful build every .app it produced goes through scripts/verify-hardening.mjs (plan 40 Q2
// item 7): `--expect release` for a Developer ID build, `--expect adhoc` for an ad-hoc one. Any FAIL row
// makes this script exit 1, so a signed build that is not notarized, or whose fuses or entitlements
// drifted, never ends in a green run.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

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
  // An ad-hoc signature has no Team ID, so it takes the source-build entitlements (same as npm run package).
  extra.push(
    '-c.mac.identity=-',
    '-c.mac.notarize=false',
    '-c.mac.entitlements=build/entitlements.adhoc.plist',
    '-c.mac.entitlementsInherit=build/entitlements.adhoc.plist',
  );
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
const startedAt = Date.now();
const result = spawnSync(process.execPath, [cli, '--mac', ...args, ...extra], {
  stdio: 'inherit',
  env,
});
if (result.status !== 0) process.exit(result.status ?? 1);

// The .app bundles this run wrote (release/mac/ for x64, release/mac-arm64/ for arm64); older ones are ignored.
const output = join(here, '..', 'release');
const apps = readdirSync(output, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name.startsWith('mac'))
  .map(entry => join(output, entry.name, 'Aplos Mail.app'))
  .filter(app => {
    const info = join(app, 'Contents', 'Info.plist');
    return existsSync(info) && statSync(info).mtimeMs >= startedAt - 1000;
  });
if (!apps.length) {
  console.error(`release-build: found no freshly built Aplos Mail.app under ${output} to verify.`);
  process.exit(1);
}
const expect = signed ? 'release' : 'adhoc';
let failed = false;
for (const app of apps) {
  console.log(`release-build: verify-hardening --expect ${expect} ${app}`);
  const verify = spawnSync(
    process.execPath,
    [join(here, 'verify-hardening.mjs'), app, '--expect', expect],
    { stdio: 'inherit' },
  );
  if (verify.status !== 0) failed = true;
}
if (failed) {
  console.error(
    'release-build: verify-hardening failed (see the FAIL rows above); this build is not a release candidate.',
  );
  process.exit(1);
}
