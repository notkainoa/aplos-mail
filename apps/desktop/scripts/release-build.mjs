// Builds the release artifacts (DMG + ZIP, arm64 + x64, latest-mac.yml) with electron-builder.
// Signs and notarizes only when the credentials exist; otherwise makes an ad-hoc signed build.
// Usage: node scripts/release-build.mjs [--publish never|always] [--expect release|adhoc] [--upload-only]
//        [extra electron-builder args]
// Run `APLOS_RELEASE_BUILD=1 npm run build` first (the npm scripts release:build / release:publish do);
// a bundle built without it is refused.
// After a successful build every .app it produced goes through scripts/verify-hardening.mjs (plan 40 Q2
// item 7): `--expect release` for a Developer ID build, `--expect adhoc` for an ad-hoc one (`--expect`
// forces one; the Release workflow forces release). A release expectation also runs the debug-guard launches
// (`--launch-checks=guard`). Any FAIL row makes this script exit 1, so a signed build that is not notarized,
// or whose fuses, entitlements or debug guard drifted, never ends in a green run.
// electron-builder itself never uploads (`--publish never`): with `--publish always` this script uploads the
// DMGs, ZIPs, blockmaps and latest-mac.yml to the draft release only after verification passed.
// Only a Developer ID release is ever uploaded: `--publish always` refuses before building when CSC_LINK /
// CSC_NAME are missing or `--expect adhoc` is given, so a local release:publish without the certificate
// uploads nothing.
// `--upload-only` skips the build and only uploads this version's artifacts, after the .app bundles under
// release/ pass verify-hardening `--expect release` again (static rows; the Release workflow's own
// verification step before it runs the debug-guard launches), so a failed check uploads nothing.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReleaseBundle } from './build-options.mjs';

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
if (publish === 'always' && forcedExpect === 'adhoc') {
  console.error(
    'release-build: --publish always uploads only a release; it cannot take --expect adhoc.',
  );
  process.exit(2);
}
const desktop = join(here, '..');
const output = join(desktop, 'release');

if (uploadOnly) {
  if (publish !== 'always') {
    console.error('release-build: --upload-only needs --publish always.');
    process.exit(2);
  }
  const apps = builtApps();
  if (!apps.length) {
    console.error(
      `release-build: not uploading; found no Aplos Mail.app under ${output} to verify.`,
    );
    process.exit(1);
  }
  if (!verifyApps(apps, ['--expect', 'release'])) {
    console.error(
      'release-build: not uploading; verify-hardening --expect release failed (see the FAIL rows above).',
    );
    process.exit(1);
  }
  await upload();
  process.exit(0);
}

const signed = Boolean(env.CSC_LINK || env.CSC_NAME);
if (publish === 'always' && !signed) {
  // An ad-hoc build passes only the ad-hoc expectation (no Gatekeeper, stapling, designated requirement or
  // debug-guard launches), so it is never a release candidate. Fail before building, as the workflow does.
  console.error(
    'release-build: --publish always needs a Developer ID certificate (CSC_LINK or CSC_NAME); nothing was packaged or uploaded. Use npm run release:build for a local ad-hoc build.',
  );
  process.exit(1);
}

// Only a bundle built with APLOS_RELEASE_BUILD=1 carries the release define, and with it the ADR 40-6
// debug guard and the release-only renderer rules (src/main/security.ts). Packaging a dev bundle as a
// release would ship a debuggable app with the release identity, so refuse it.
for (const bundle of ['electron.cjs', 'engine.cjs']) {
  let source = '';
  try {
    source = readFileSync(join(desktop, 'dist', 'main', bundle), 'utf8');
  } catch {
    // Missing: reported below like a non-release bundle.
  }
  if (!isReleaseBundle(source)) {
    console.error(
      `release-build: dist/main/${bundle} is missing or was not built with APLOS_RELEASE_BUILD=1; run npm run release:build (or APLOS_RELEASE_BUILD=1 npm run build) first.`,
    );
    process.exit(1);
  }
}

const extra = ['--publish', 'never'];
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

// The .app bundles this run wrote; older ones are ignored.
const apps = builtApps(startedAt - 1000);
if (!apps.length) {
  console.error(`release-build: found no freshly built Aplos Mail.app under ${output} to verify.`);
  process.exit(1);
}
const expect = forcedExpect ?? (signed ? 'release' : 'adhoc');
// The debug-guard launches exit before any window when the guard works; an ad-hoc build skips them so an
// agent's local build never starts the app.
const verifyArgs = ['--expect', expect, ...(expect === 'release' ? ['--launch-checks=guard'] : [])];
if (!verifyApps(apps, verifyArgs)) {
  console.error(
    'release-build: verify-hardening failed (see the FAIL rows above); this build is not a release candidate and nothing was uploaded.',
  );
  process.exit(1);
}
if (publish === 'always') await upload();

/** The .app bundles under release/ (mac/ for x64, mac-arm64/ for arm64) whose Info.plist is not older than `since`. */
function builtApps(since = 0) {
  if (!existsSync(output)) return [];
  return readdirSync(output, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('mac'))
    .map(entry => join(output, entry.name, 'Aplos Mail.app'))
    .filter(app => {
      const info = join(app, 'Contents', 'Info.plist');
      return existsSync(info) && statSync(info).mtimeMs >= since;
    });
}

/** Runs scripts/verify-hardening.mjs on every app; true only when every one passed. */
function verifyApps(apps, verifyArgs) {
  let passed = true;
  for (const app of apps) {
    console.log(`release-build: verify-hardening ${verifyArgs.join(' ')} ${app}`);
    const verify = spawnSync(
      process.execPath,
      [join(here, 'verify-hardening.mjs'), app, ...verifyArgs],
      // The guard launches start the app under test: give it no signing, notary, OAuth or GitHub secrets.
      { stdio: 'inherit', env: withoutSecrets(process.env) },
    );
    if (verify.status !== 0) passed = false;
  }
  return passed;
}

/** A copy of `source` without the variables that hold signing, notarization, OAuth or GitHub secrets. */
function withoutSecrets(source) {
  const secret = /^(CSC_|APPLE_|GOOGLE_|MICROSOFT_|GH_TOKEN$|GITHUB_TOKEN$)/;
  return Object.fromEntries(Object.entries(source).filter(([name]) => !secret.test(name)));
}

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
  // electron-builder's own `publish` command is not used: in 26.18.0 it merges a `build.publish` array into
  // itself and then rejects the result ("configuration.publish should be one of these"). This is that command's
  // body (electron-builder/out/publish.js) with package.json `build` (in the current directory) loaded without
  // that self-merge. Unlike that command, any error throws, so a failed upload exits 1.
  process.chdir(desktop);
  const { AppInfo, CancellationToken, Packager, PublishManager } = createRequire(import.meta.url)(
    'electron-builder',
  );
  // detectUpdateChannel: false, as in electron-builder's command (there is no built app to read a channel from).
  const options = { publish: 'always', config: { detectUpdateChannel: false } };
  try {
    const packager = new Packager(options, new CancellationToken());
    await packager.validateConfig();
    const appInfo = new AppInfo(packager, version);
    const manager = new PublishManager(packager, options, packager.cancellationToken);
    const configs = await manager.getGlobalPublishConfigurations();
    if (!configs?.length) throw new Error('package.json build.publish is empty');
    for (const file of files)
      for (const config of configs)
        await manager.scheduleUpload(
          config,
          { file, arch: null, safeArtifactName: basename(file) },
          appInfo,
        );
    await manager.awaitTasks();
  } catch (error) {
    console.error(`release-build: the upload failed: ${error.message}`);
    process.exit(1);
  }
  console.log('release-build: uploaded.');
}
