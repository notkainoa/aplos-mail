// Builds the release artifacts (DMG + ZIP, arm64 + x64, latest-mac.yml) with electron-builder.
// Signs and notarizes only when the credentials exist; otherwise makes an ad-hoc signed build.
// Usage: node scripts/release-build.mjs [--publish never|always] [--expect release|adhoc] [--upload-only]
//        [extra electron-builder args]
// Run `npm run build` first (the npm scripts release:build / release:publish do).
// After a successful build every .app it produced goes through scripts/verify-hardening.mjs (plan 40 Q2
// item 7): `--expect release` for a Developer ID build, `--expect adhoc` for an ad-hoc one (`--expect`
// forces one; the Release workflow forces release). A release expectation also runs the debug-guard launches
// (`--launch-checks=guard`). Any FAIL row makes this script exit 1, so a signed build that is not notarized,
// or whose fuses, entitlements or debug guard drifted, never ends in a green run.
// electron-builder itself never uploads (`--publish never`): with `--publish always` this script uploads the
// DMGs, ZIPs, blockmaps and latest-mac.yml to the draft release only after verification passed.
// `--upload-only` skips the build and the verification and only uploads this version's artifacts; the
// Release workflow runs it as its own step after its verification step, so a failed check uploads nothing.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

// This script's own flags; everything else goes to electron-builder.
const args = [];
let publish = 'never',
  forcedExpect,
  uploadOnly = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--publish' || arg === '-p') publish = argv[++i];
  else if (arg.startsWith('--publish=')) publish = arg.slice('--publish='.length);
  else if (arg === '--expect') forcedExpect = argv[++i];
  else if (arg.startsWith('--expect=')) forcedExpect = arg.slice('--expect='.length);
  else if (arg === '--upload-only') uploadOnly = true;
  else args.push(arg);
}
if (!['never', 'always'].includes(publish)) {
  console.error(`release-build: --publish must be never or always, not ${publish}.`);
  process.exit(2);
}
if (forcedExpect !== undefined && !['release', 'adhoc'].includes(forcedExpect)) {
  console.error(`release-build: --expect must be release or adhoc, not ${forcedExpect}.`);
  process.exit(2);
}
const desktop = join(here, '..');
const output = join(desktop, 'release');

if (uploadOnly) {
  if (publish !== 'always') {
    console.error('release-build: --upload-only needs --publish always.');
    process.exit(2);
  }
  await upload();
  process.exit(0);
}

const extra = ['--publish', 'never'];
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
const expect = forcedExpect ?? (signed ? 'release' : 'adhoc');
// The debug-guard launches exit before any window when the guard works; an ad-hoc build skips them so an
// agent's local build never starts the app.
const verifyArgs = ['--expect', expect, ...(expect === 'release' ? ['--launch-checks=guard'] : [])];
let failed = false;
for (const app of apps) {
  console.log(`release-build: verify-hardening ${verifyArgs.join(' ')} ${app}`);
  const verify = spawnSync(
    process.execPath,
    [join(here, 'verify-hardening.mjs'), app, ...verifyArgs],
    { stdio: 'inherit' },
  );
  if (verify.status !== 0) failed = true;
}
if (failed) {
  console.error(
    'release-build: verify-hardening failed (see the FAIL rows above); this build is not a release candidate and nothing was uploaded.',
  );
  process.exit(1);
}
if (publish === 'always') await upload();

/** Uploads this version's artifacts to the draft release with electron-builder's publisher (build.publish). */
async function upload() {
  const { version } = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
  const files = [];
  const missing = [];
  for (const arch of ['arm64', 'x64'])
    for (const ext of ['dmg', 'zip']) {
      const file = join(output, `Aplos-Mail-${version}-${arch}.${ext}`);
      if (!existsSync(file)) missing.push(file);
      else files.push(file, ...[`${file}.blockmap`].filter(existsSync));
    }
  const feed = join(output, 'latest-mac.yml');
  if (!existsSync(feed)) missing.push(feed);
  else if (
    !new RegExp(`^version: ${version.replaceAll('.', '\\.')}$`, 'm').test(
      readFileSync(feed, 'utf8'),
    )
  )
    missing.push(`${feed} for version ${version}`);
  else files.push(feed);
  if (missing.length) {
    console.error(`release-build: not uploading; missing ${missing.join(', ')}.`);
    process.exit(1);
  }
  console.log(`release-build: uploading ${files.length} files to the draft release v${version}.`);
  // electron-builder reads build.publish from the package.json in the current directory.
  process.chdir(desktop);
  const { publishArtifactsWithOptions } = createRequire(import.meta.url)(
    'electron-builder/out/publish.js',
  );
  let uploaded = null;
  try {
    uploaded = await publishArtifactsWithOptions(
      files.map(file => ({ file, arch: null })),
      version,
      undefined,
      undefined,
      { publish: 'always' },
    );
  } catch (error) {
    console.error(`release-build: upload failed: ${error.message}`);
  }
  // publishArtifactsWithOptions logs its own error and returns null instead of throwing.
  if (!uploaded) {
    console.error('release-build: the upload failed (see the error above).');
    process.exit(1);
  }
}
