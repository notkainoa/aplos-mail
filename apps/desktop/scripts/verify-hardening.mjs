// Checks that a built Aplos Mail .app is hardened the way plan 40 Q2 expects: fuses, Info.plist,
// signature and notarization, entitlements of the app and of every nested executable, the designated
// requirement, no secrets in app.asar or anywhere else under Contents/Resources, and the aplos-symbols
// helper. Prints one PASS/FAIL/SKIP row per check and exits 1 on any FAIL.
//
// Usage: node scripts/verify-hardening.mjs <path-to-.app> [--expect release|adhoc] [--json] [--launch-checks[=guard]]
//   --expect adhoc   a source build: skips notarization, stapling and the team checks, uses entitlements.adhoc.plist
//   --launch-checks  also starts the app: once plainly (the control, which must stay up), then with hostile
//                    flags (debug ports, ELECTRON_RUN_AS_NODE, NODE_OPTIONS). Off by default because it launches
//                    the real app, which shows a window today. Refuses to run while another copy is running.
//   --launch-checks=guard  only the debug-switch launches, which a working guard refuses before any window
//                    (release-build.mjs and the Release workflow use this on the release artifact).
//
// A matched secret is never printed: rows name the file, the byte offset and a redacted marker.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAUNCH_CASES, runLaunchChecks } from './verify-hardening-launch.mjs';

export * from './verify-hardening-launch.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

export const BUNDLE_ID = 'com.aplos.mail';
export const TEAM_ID = 'VW9NDM428H';
/** The only bundle allowed to carry the Google client secret (scripts/build-main.mjs inlines it there). */
export const ENGINE_BUNDLE = 'dist/main/engine.cjs';
export const ENTITLEMENTS = {
  release: join(here, '../build/entitlements.mac.plist'),
  adhoc: join(here, '../build/entitlements.adhoc.plist'),
};
/**
 * What every nested executable is signed with (electron-builder's mac.entitlementsInherit). Today package.json
 * points it at the same file as the main app; if Q2.1 adds a separate inherit file, point this at it.
 */
export const ENTITLEMENTS_INHERIT = { ...ENTITLEMENTS };

/** Fuse name -> index in the wire, from @electron/fuses (FuseV1Options). */
export const FUSE_INDEX = require('@electron/fuses').FuseV1Options;
const FUSE_ON = 49,
  FUSE_OFF = 48,
  FUSE_REMOVED = 114; // @electron/fuses FuseState
/** Plan 40 Q2 item 1 / ARCHITECTURE 2.5. */
export const EXPECTED_FUSES = {
  RunAsNode: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  EnableCookieEncryption: false, // Aplos stores no cookies; turning it on would only add Keychain use.
  GrantFileProtocolExtraPrivileges: true, // Stays on until the renderer is served from aplos-app:// (Q2 item 5).
};

const row = (id, status, reason) => ({ id, status, reason });
const pass = (id, reason) => row(id, 'PASS', reason);
const fail = (id, reason) => row(id, 'FAIL', reason);
const skip = (id, reason) => row(id, 'SKIP', reason);
const lines = text =>
  String(text ?? '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
const firstLine = text => lines(text)[0]?.slice(0, 200) ?? '';
const lastLine = text => lines(text).at(-1)?.slice(0, 200) ?? '';

// ---- (1) fuses -------------------------------------------------------------------------------

const fuseState = state =>
  ({ [FUSE_ON]: 'on', [FUSE_OFF]: 'off', [FUSE_REMOVED]: 'removed' })[state] ??
  (state === undefined ? 'missing' : `state ${state}`);

/** `wire` is what @electron/fuses getCurrentFuseWire returns: {version:'1', 0:49, 1:48, ...}. */
export function checkFuses(wire) {
  if (wire?.version !== '1')
    return fail('fuses', `unknown fuse wire version ${JSON.stringify(wire?.version)}`);
  const wrong = [];
  for (const [name, want] of Object.entries(EXPECTED_FUSES)) {
    const state = wire[FUSE_INDEX[name]];
    if (state !== (want ? FUSE_ON : FUSE_OFF))
      wrong.push(`${name} is ${fuseState(state)}, want ${want ? 'on' : 'off'}`);
  }
  return wrong.length
    ? fail('fuses', wrong.join('; '))
    : pass('fuses', `all ${Object.keys(EXPECTED_FUSES).length} expected fuses match`);
}

// ---- (2) Info.plist --------------------------------------------------------------------------

const versionParts = value => String(value).split('.').map(Number);
const sameVersion = (a, b) => {
  const x = versionParts(a),
    y = versionParts(b);
  return x.every(n => Number.isInteger(n)) && [0, 1, 2].every(i => (x[i] ?? 0) === (y[i] ?? 0));
};

export function checkMinimumMacos(info) {
  const value = info?.LSMinimumSystemVersion;
  if (value === undefined) return fail('min-macos', 'Info.plist has no LSMinimumSystemVersion');
  return sameVersion(value, '13.0')
    ? pass('min-macos', 'LSMinimumSystemVersion is 13.0')
    : fail(
        'min-macos',
        `LSMinimumSystemVersion is ${value}, want 13.0 (Electron 44 needs macOS 13)`,
      );
}

/** Electron's asar integrity hash is the SHA-256 of the archive's JSON header string. */
export const headerHash = headerString => createHash('sha256').update(headerString).digest('hex');

/** `actualHash` is the hash of the shipped app.asar header, when known. */
export function checkAsarIntegrity(info, actualHash) {
  const entry = info?.ElectronAsarIntegrity?.['Resources/app.asar'];
  if (!entry)
    return fail(
      'asar-integrity',
      'Info.plist has no ElectronAsarIntegrity entry for Resources/app.asar',
    );
  if (entry.algorithm !== 'SHA256' || !/^[0-9a-f]{64}$/.test(entry.hash ?? ''))
    return fail(
      'asar-integrity',
      `ElectronAsarIntegrity entry is malformed (algorithm ${entry.algorithm})`,
    );
  if (actualHash !== undefined && actualHash !== entry.hash)
    return fail('asar-integrity', 'ElectronAsarIntegrity hash does not match the app.asar header');
  return pass(
    'asar-integrity',
    actualHash === undefined
      ? 'ElectronAsarIntegrity present'
      : 'ElectronAsarIntegrity present and matches the app.asar header',
  );
}

// ---- (3) signature, Gatekeeper, stapling -----------------------------------------------------

/** Results are {status, stdout, stderr} from the command named in each check. */
export function checkCodesignVerify(result) {
  // Skip codesign's progress lines and report the first real error.
  if (result.status !== 0)
    result = {
      ...result,
      stderr: lines(result.stderr)
        .filter(line => !/^--(prepared|validated):/.test(line))
        .join('\n'),
    };
  return result.status === 0
    ? pass('codesign', 'codesign --verify --strict --deep accepts the bundle')
    : fail(
        'codesign',
        `codesign --verify --strict --deep: ${firstLine(result.stderr || result.stdout) || `exit ${result.status}`}`,
      );
}

/** `details` is the stderr of `codesign -dv --verbose=4`. */
export function checkHardenedRuntime(details, expect) {
  const flags = /flags=0x[0-9a-f]+\(([^)]*)\)/.exec(details ?? '')?.[1] ?? '';
  if (flags.split(',').includes('runtime'))
    return pass('hardened-runtime', 'main executable is signed with the hardened runtime');
  if (expect === 'adhoc')
    return skip(
      'hardened-runtime',
      'ad-hoc build is not signed with the hardened runtime (not required for source builds)',
    );
  return fail('hardened-runtime', 'main executable is not signed with the hardened runtime');
}

export function checkGatekeeper(result, expect) {
  if (expect === 'adhoc') return skip('gatekeeper', 'ad-hoc build: not notarized by design');
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0 || !/: accepted$/m.test(text))
    return fail(
      'gatekeeper',
      `spctl rejects the app: ${firstLine(text) || `exit ${result.status}`}`,
    );
  const source = /^source=(.*)$/m.exec(text)?.[1]?.trim();
  if (source !== 'Notarized Developer ID')
    return fail('gatekeeper', `spctl source is not "Notarized Developer ID" (${source ?? 'none'})`);
  // Only the origin line counts: spctl also echoes the bundle path, which could contain "(VW9NDM428H)".
  const origin = /^origin=(.*)$/m.exec(text)?.[1]?.trim() ?? '';
  if (!origin.endsWith(`(${TEAM_ID})`))
    return fail('gatekeeper', `spctl origin is not team ${TEAM_ID} (${origin || 'none'})`);
  return pass(
    'gatekeeper',
    `spctl: accepted, source=Notarized Developer ID, origin team ${TEAM_ID}`,
  );
}

export function checkStapler(result, expect) {
  if (expect === 'adhoc') return skip('stapler', 'ad-hoc build: no notarization ticket by design');
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return result.status === 0 && /The validate action worked/.test(text)
    ? pass('stapler', 'notarization ticket is stapled')
    : fail('stapler', `xcrun stapler validate: ${lastLine(text) || `exit ${result.status}`}`);
}

// ---- (4) entitlements ------------------------------------------------------------------------

/** Differences between two entitlement objects, as short phrases. */
export function entitlementDiff(actual, expected) {
  const problems = [];
  for (const key of Object.keys(expected)) if (!(key in actual)) problems.push(`missing ${key}`);
  for (const key of Object.keys(actual)) if (!(key in expected)) problems.push(`extra ${key}`);
  for (const key of Object.keys(expected))
    if (key in actual && JSON.stringify(actual[key]) !== JSON.stringify(expected[key]))
      problems.push(
        `${key} is ${JSON.stringify(actual[key])}, want ${JSON.stringify(expected[key])}`,
      );
  return problems;
}

/** The main executable's entitlements. Both arguments are plists already converted to plain objects. */
export function compareEntitlements(actual, expected, label) {
  const problems = entitlementDiff(actual, expected);
  return problems.length
    ? fail('entitlements', `differ from ${label}: ${problems.join('; ')}`)
    : pass('entitlements', `match ${label} exactly (${Object.keys(expected).length} keys)`);
}

/**
 * Every other executable in the bundle (the four helper apps, chrome_crashpad_handler, ShipIt, aplos-symbols).
 * electron-builder signs all of them with `mac.entitlementsInherit`, so each must match that file exactly:
 * a helper with, say, allow-dyld-environment-variables would otherwise pass every other row.
 * `items` is [{path, entitlements} | {path, error}].
 */
export function checkNestedEntitlements(items, expected, label) {
  const id = 'entitlements-nested';
  if (!items.length)
    return fail(id, 'found no nested executables (expected the helper apps and aplos-symbols)');
  const byProblem = new Map(); // one entry per distinct problem, so an unsigned build stays one readable line
  for (const item of items) {
    const problem = item.error ?? entitlementDiff(item.entitlements, expected).join(', ');
    if (problem) byProblem.set(problem, [...(byProblem.get(problem) ?? []), item.path]);
  }
  const bad = [...byProblem].map(
    ([problem, paths]) =>
      `${paths.length > 1 ? paths.map(path => safePath(basename(path))).join(', ') : safePath(paths[0])}: ${problem}`,
  );
  return bad.length
    ? fail(id, `differ from ${label}: ${bad.join('; ')}`)
    : pass(id, `all ${items.length} nested executables match ${label} exactly`);
}

const MH_EXECUTE = 2;
/** True when the file is a Mach-O executable (thin or fat). Libraries, bundles and scripts are not. */
export function isMachOExecutable(
  path,
  { open = openSync, read = readSync, close = closeSync } = {},
) {
  let fd;
  try {
    fd = open(path, 'r');
    const head = Buffer.alloc(32);
    if (read(fd, head, 0, 32, 0) < 16) return false;
    const thin = buf => {
      const magic = buf.readUInt32LE(0);
      if (magic === 0xfeedface || magic === 0xfeedfacf) return buf.readUInt32LE(12) === MH_EXECUTE;
      if (magic === 0xcefaedfe || magic === 0xcffaedfe) return buf.readUInt32BE(12) === MH_EXECUTE;
      return false;
    };
    const fat = head.readUInt32BE(0);
    if (fat === 0xcafebabe || fat === 0xcafebabf) {
      const count = head.readUInt32BE(4);
      if (count < 1 || count > 16) return false; // Java class files share the magic
      const offset = fat === 0xcafebabe ? head.readUInt32BE(16) : Number(head.readBigUInt64BE(16));
      const slice = Buffer.alloc(16);
      return read(fd, slice, 0, 16, offset) === 16 && thin(slice);
    }
    return thin(head);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) close(fd);
  }
}

/** Paths (relative to Contents) of every Mach-O executable with an exec bit, symlinks not followed. */
export function findExecutables(contents) {
  const found = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && statSync(full).mode & 0o111 && isMachOExecutable(full))
        found.push(relative(contents, full));
    }
  };
  walk(contents);
  return found.sort();
}

// ---- (5) designated requirement --------------------------------------------------------------

/**
 * The designated requirement codesign generates for a Developer ID Application signature of this bundle.
 * The two field checks are Apple's Developer ID markers (intermediate CA and leaf certificate).
 */
export const EXPECTED_DR = `identifier "${BUNDLE_ID}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = ${TEAM_ID}`;

/** Comments removed, `/* exists *\/` written out, quotes around simple tokens dropped, spaces collapsed. */
export const normalizeRequirement = text =>
  String(text)
    .replace(/\]\s*\/\*\s*exists\s*\*\//g, '] exists')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/"([A-Za-z0-9._-]+)"/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * `text` is the output of `codesign -d -r-`; `satisfies` is the result of
 * `codesign --verify -R=<EXPECTED_DR>` (release only), which proves the signature really meets it.
 * The requirement must equal EXPECTED_DR exactly: a substring check would accept an extra
 * `and cdhash H"…"` (breaks Keychain trust on update) or a negated clause (widens trust to forgeries).
 */
export function checkDesignatedRequirement(text, expect, satisfies) {
  const id = 'designated-requirement';
  // codesign prints an implicit requirement (ad-hoc builds) as a comment: "# designated => cdhash H"…"".
  const line = lines(text)
    .map(s => s.replace(/^#\s*/, ''))
    .find(s => s.startsWith('designated =>'));
  if (!line) return fail(id, 'codesign shows no designated requirement');
  const dr = normalizeRequirement(line.slice('designated =>'.length));
  const cdhashOnly = /\bcdhash\b/.test(dr) && !/\banchor\b/.test(dr);
  if (expect === 'adhoc')
    return skip(
      id,
      cdhashOnly
        ? 'ad-hoc build: cdhash-only requirement, so Keychain trust resets on every rebuild (expected from source)'
        : 'ad-hoc build: team check not applicable',
    );
  if (cdhashOnly)
    return fail(id, 'cdhash-only requirement: Keychain trust would break on every update');
  const problems = [];
  if (/\bcdhash\b/.test(dr))
    problems.push('pins a cdhash, so Keychain trust would break on every update');
  if (/!|\bnot\b/.test(dr)) problems.push('has a negated clause, which widens it');
  if (/\bor\b|\|\|/.test(dr)) problems.push('has an "or" branch, which widens it');
  if (!problems.length && dr !== normalizeRequirement(EXPECTED_DR))
    problems.push(
      `is not the expected Developer ID requirement for ${BUNDLE_ID} and team ${TEAM_ID}: ${dr.slice(0, 300)}`,
    );
  if (problems.length) return fail(id, `requirement ${problems.join('; ')}`);
  if (satisfies && satisfies.status !== 0)
    return fail(
      id,
      `signature does not satisfy the expected requirement: ${firstLine(satisfies.stderr) || `exit ${satisfies.status}`}`,
    );
  return pass(
    id,
    `exactly the Developer ID requirement for ${BUNDLE_ID} and team ${TEAM_ID}${satisfies ? ', and the signature satisfies it' : ''}`,
  );
}

// ---- (6) app.asar scan -----------------------------------------------------------------------

/** The providers in AGENTS.md; a `<NAME>_API_KEY=<value>` assignment for any of them is a leak. */
const PROVIDER_ENV =
  '(?:GROQ|OPENAI|ANTHROPIC|GEMINI|OPENROUTER|OPENCODE|OLLAMA|LM_STUDIO|CUSTOM_AI)_API_KEY';

/**
 * Key-shaped strings that must never ship. `keep` is how many leading characters the redacted marker shows.
 * Prefixes match in any case (real tokens are case-sensitive, but a re-cased copy is still a leak), except
 * AIza: case-insensitively it matches the base64-like tables in entities' decode-data-html.js.
 */
export const KEY_PATTERNS = [
  { name: 'Groq key', re: /gsk_[A-Za-z0-9]{20,}/gi, keep: 4 },
  { name: 'Anthropic key', re: /sk-ant-[A-Za-z0-9_-]{20,}/gi, keep: 7 },
  { name: 'OpenAI project key', re: /sk-proj-[A-Za-z0-9_-]{20,}/gi, keep: 8 },
  { name: 'OpenAI key', re: /sk-(?:svcacct|admin|none)-[A-Za-z0-9_-]{20,}/gi, keep: 7 },
  { name: 'OpenRouter key', re: /sk-or-v1-[0-9a-f]{64}/gi, keep: 9 },
  { name: 'OpenAI-style key', re: /sk-[A-Za-z0-9]{32,}/gi, keep: 3 },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/g, keep: 4 },
  { name: 'Google OAuth access token', re: /ya29\.[A-Za-z0-9_-]{20,}/gi, keep: 5 },
  { name: 'Google OAuth refresh token', re: /1\/\/0[A-Za-z0-9_-]{30,}/g, keep: 4 },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36}/gi, keep: 4 },
  { name: 'GitHub token', re: /github_pat_[A-Za-z0-9_]{22,}/gi, keep: 11 },
  // Not a key: a value that is itself an env var name (ANTHROPIC_API_KEY:"ANTHROPIC_API_KEY") or a placeholder
  // such as dotenv's README example "your-api-key-goes-here".
  {
    name: 'provider API key assignment',
    re: new RegExp(`${PROVIDER_ENV}\\s*[=:]\\s*["'\`]?[A-Za-z0-9_-]{16,}`, 'gi'),
    ignore: match => {
      const value = match.replace(/^[A-Za-z_]+\s*[=:]\s*["'`]?/, '');
      return (
        /^[A-Z0-9_]+$/.test(value) ||
        /your|here|example|placeholder|xxxx|changeme|replace/i.test(value)
      );
    },
    mark: match => `${/^[A-Za-z_]+/.exec(match)[0]}=…(redacted)`,
  },
  {
    name: 'private key',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/gi,
    marker: '-----BEGIN … PRIVATE KEY-----',
    confirm: hasPemBody,
  },
];
export const GOOGLE_SECRET = {
  name: 'Google client secret',
  re: /GOCSPX-[A-Za-z0-9_-]{20,}/gi,
  keep: 7,
};

/**
 * A PEM header only counts as a key when key material follows it: a base64 run of at least 48 characters
 * before the END line (spaces and "\\n" escapes removed). A bare header, as in a library's README, does not.
 */
export function hasPemBody(text, end) {
  const body = text
    .slice(end, end + 600)
    .split('-----END')[0]
    .replace(/\\[nr]|\s/g, '');
  return Math.max(0, ...(body.match(/[A-Za-z0-9+/=]+/g) ?? []).map(run => run.length)) >= 48;
}

const redact = (pattern, match) =>
  pattern.marker ?? pattern.mark?.(match) ?? `${match.slice(0, pattern.keep)}…(redacted)`;
const SECRET_PATTERNS = () => [...KEY_PATTERNS, GOOGLE_SECRET];
/** A path with every key-shaped part redacted, so a key used as a file name is never printed either. */
export const safePath = path =>
  SECRET_PATTERNS().reduce(
    (text, pattern) => text.replace(pattern.re, match => redact(pattern, match)),
    String(path),
  );
const isEnvFile = path => {
  const name = basename(path).toLowerCase();
  return name === '.env' || (name.startsWith('.env.') && name !== '.env.example');
};

function* matches(pattern, text) {
  for (const m of text.matchAll(pattern.re))
    if (!pattern.ignore?.(m[0]))
      yield {
        offset: m.index,
        marker: redact(pattern, m[0]),
        confirmed: pattern.confirm ? pattern.confirm(text, m.index + m[0].length) : true,
      };
}

/**
 * `files` yields {path, data: Buffer}: archive-relative paths for app.asar entries (no leading slash),
 * "Resources/…" for files on disk. File names are scanned too; their hits have offset "name".
 */
export function scanFiles(files, { engineBundle = ENGINE_BUNDLE } = {}) {
  const result = { files: 0, envFiles: [], keys: [], googleSecrets: [], bareHeaders: [] };
  for (const { path, data } of files) {
    result.files++;
    if (isEnvFile(path)) result.envFiles.push(path);
    for (const pattern of KEY_PATTERNS)
      for (const { confirmed, ...hit } of matches(pattern, path))
        if (confirmed) result.keys.push({ path, name: pattern.name, ...hit, offset: 'name' });
    for (const { confirmed, ...hit } of matches(GOOGLE_SECRET, path))
      if (confirmed)
        result.googleSecrets.push({
          path,
          name: GOOGLE_SECRET.name,
          ...hit,
          offset: 'name',
          allowed: false,
        });
    const text = data.toString('latin1'); // one char per byte, so offsets are byte offsets
    for (const pattern of KEY_PATTERNS)
      for (const { confirmed, ...hit } of matches(pattern, text))
        (confirmed ? result.keys : result.bareHeaders).push({ path, name: pattern.name, ...hit });
    for (const { confirmed, ...hit } of matches(GOOGLE_SECRET, text))
      if (confirmed)
        result.googleSecrets.push({
          path,
          name: GOOGLE_SECRET.name,
          ...hit,
          allowed: path === engineBundle,
        });
  }
  return result;
}

const describeHit = hit =>
  `${safePath(hit.path)} ${hit.offset === 'name' ? '(file name)' : `@${hit.offset}`}: ${hit.marker} (${hit.name})`;
const listSome = (items, show) =>
  items.slice(0, 5).map(show).join('; ') +
  (items.length > 5 ? `; and ${items.length - 5} more` : '');

export function asarRows(scan) {
  const envRow = scan.envFiles.length
    ? fail('asar-env', `.env file shipped: ${listSome(scan.envFiles, safePath)}`)
    : pass('asar-env', `no .env file among ${scan.files} files (app.asar and Contents/Resources)`);
  const bad = [...scan.keys, ...scan.googleSecrets.filter(hit => !hit.allowed)];
  if (bad.length)
    return [envRow, fail('asar-keys', `key-shaped strings: ${listSome(bad, describeHit)}`)];
  const allowed = scan.googleSecrets.filter(hit => hit.allowed);
  let note = allowed.length
    ? `; ${listSome(allowed, describeHit)} is inlined on purpose (RELEASING.md)`
    : '';
  if (scan.bareHeaders.length)
    note += `; ${scan.bareHeaders.length} PEM header(s) without key material ignored (${listSome([...new Set(scan.bareHeaders.map(hit => hit.path))], safePath)})`;
  return [envRow, pass('asar-keys', `no key-shaped strings in ${scan.files} files${note}`)];
}

/**
 * Every regular file listed in an asar header, read lazily. Unpacked entries are skipped here because
 * resourceFiles() reads everything in app.asar.unpacked from disk, including files the header does not list.
 */
export function* asarFiles(asarPath) {
  const asar = require('@electron/asar');
  const { header } = asar.getRawHeader(asarPath);
  function* walk(node, prefix) {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (child.files) yield* walk(child, path);
      else if (!child.link && !child.unpacked)
        yield { path, data: asar.extractFile(asarPath, path) };
    }
  }
  yield* walk(header, '');
}

/**
 * Every regular file under Contents/Resources except app.asar itself (app.asar.unpacked, bin/ from
 * extraResources, icons, anything a build step dropped there), as "Resources/<path>". Symlinks are not followed.
 */
export function* resourceFiles(resources) {
  function* walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(full);
      else if (entry.isFile() && full !== join(resources, 'app.asar'))
        yield { path: join('Resources', relative(resources, full)), data: readFileSync(full) };
    }
  }
  yield* walk(resources);
}

// ---- (7) aplos-symbols helper ----------------------------------------------------------------

/** `helper` is {exists, executable, verify: {status, stderr}, details: stderr of codesign -dv}. */
export function checkSymbolsHelper(helper, expect) {
  const id = 'symbols-helper';
  if (!helper.exists) return fail(id, 'Contents/Resources/bin/aplos-symbols is missing');
  if (!helper.executable) return fail(id, 'aplos-symbols is not executable');
  if (helper.verify.status !== 0)
    return fail(id, `aplos-symbols is not validly signed: ${firstLine(helper.verify.stderr)}`);
  const details = helper.details ?? '';
  if (expect === 'adhoc')
    return pass(
      id,
      /Signature=adhoc/.test(details) ? 'present and signed (ad-hoc)' : 'present and signed',
    );
  if (/Signature=adhoc/.test(details)) return fail(id, 'aplos-symbols is only ad-hoc signed');
  if (!details.includes(`TeamIdentifier=${TEAM_ID}`))
    return fail(id, `aplos-symbols is not signed by team ${TEAM_ID}`);
  return pass(id, `present and signed by team ${TEAM_ID}`);
}

// ---- running the checks against an app -------------------------------------------------------

/** Runs a command without a shell. `input` goes to stdin. */
export function run(command, args, { input } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  return {
    status: result.status ?? (result.error ? -1 : 1),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error?.message || ''),
  };
}

function plistObject(exec, { path, text }) {
  const result = path
    ? exec('plutil', ['-convert', 'json', '-o', '-', '--', path])
    : exec('plutil', ['-convert', 'json', '-o', '-', '-'], { input: text });
  if (result.status !== 0)
    throw new Error(`plutil could not read ${path ?? 'the plist'}: ${firstLine(result.stderr)}`);
  return JSON.parse(result.stdout);
}

async function attempt(id, fn) {
  try {
    const out = await fn();
    return Array.isArray(out) ? out : [out];
  } catch (error) {
    return [fail(id, firstLine(error.message))];
  }
}

export async function verifyApp(
  appPath,
  { expect = 'release', launchChecks = false, exec: runCommand = run, spawn = nodeSpawn } = {},
) {
  const app = resolve(appPath);
  // Tool messages repeat the full bundle path; shorten it so each row stays one readable line.
  const exec = (command, args, options) => {
    const r = runCommand(command, args, options);
    const tidy = t =>
      [`/private${app}`, app].reduce(
        (text, path) => text.split(`${path}/`).join('').split(path).join(basename(app)),
        t,
      );
    return { ...r, stderr: tidy(r.stderr) };
  };
  const contents = join(app, 'Contents');
  const asarPath = join(contents, 'Resources', 'app.asar');
  const rows = [];
  const add = async (id, fn) => rows.push(...(await attempt(id, fn)));
  let info = {};

  await add('fuses', async () =>
    checkFuses(await require('@electron/fuses').getCurrentFuseWire(app)),
  );
  await add('min-macos', () => {
    info = plistObject(exec, { path: join(contents, 'Info.plist') });
    return checkMinimumMacos(info);
  });
  await add('asar-integrity', () =>
    checkAsarIntegrity(
      info,
      headerHash(require('@electron/asar').getRawHeader(asarPath).headerString),
    ),
  );
  await add('codesign', () =>
    checkCodesignVerify(exec('codesign', ['--verify', '--strict', '--deep', app])),
  );
  await add('hardened-runtime', () =>
    checkHardenedRuntime(exec('codesign', ['-dv', '--verbose=4', app]).stderr, expect),
  );
  await add('gatekeeper', () =>
    expect === 'adhoc'
      ? checkGatekeeper({}, expect)
      : checkGatekeeper(exec('spctl', ['-a', '-vv', '-t', 'exec', app]), expect),
  );
  await add('stapler', () =>
    checkStapler(expect === 'adhoc' ? {} : exec('xcrun', ['stapler', 'validate', app]), expect),
  );
  const entitlementsOf = path => {
    const shown = exec('codesign', ['-d', '--entitlements', ':-', path]);
    if (shown.status !== 0)
      throw new Error(`codesign could not show entitlements: ${firstLine(shown.stderr)}`);
    return shown.stdout.trim() ? plistObject(exec, { text: shown.stdout }) : {};
  };
  await add('entitlements', () => {
    const file = ENTITLEMENTS[expect];
    const label = `build/${basename(file)}`;
    return compareEntitlements(entitlementsOf(app), plistObject(exec, { path: file }), label);
  });
  await add('entitlements-nested', () => {
    const file = ENTITLEMENTS_INHERIT[expect];
    const main = join('MacOS', info.CFBundleExecutable || 'Aplos Mail');
    const items = findExecutables(contents)
      .filter(path => path !== main)
      .map(path => {
        try {
          return { path, entitlements: entitlementsOf(join(contents, path)) };
        } catch (error) {
          return { path, error: firstLine(error.message) };
        }
      });
    const label = `build/${basename(file)} (entitlementsInherit)`;
    return checkNestedEntitlements(items, plistObject(exec, { path: file }), label);
  });
  await add('designated-requirement', () => {
    const r = exec('codesign', ['-d', '-r-', app]);
    const satisfies =
      expect === 'adhoc' ? undefined : exec('codesign', ['--verify', `-R=${EXPECTED_DR}`, app]);
    return checkDesignatedRequirement(`${r.stdout}\n${r.stderr}`, expect, satisfies);
  });
  await add('asar-keys', () => {
    if (!existsSync(asarPath)) throw new Error('Contents/Resources/app.asar is missing');
    const files = (function* () {
      yield* asarFiles(asarPath);
      yield* resourceFiles(join(contents, 'Resources'));
    })();
    return asarRows(scanFiles(files));
  });
  await add('symbols-helper', () => {
    const helper = join(contents, 'Resources', 'bin', 'aplos-symbols');
    if (!existsSync(helper)) return checkSymbolsHelper({ exists: false }, expect);
    let executable = true;
    try {
      accessSync(helper, fsConstants.X_OK);
    } catch {
      executable = false;
    }
    const verify = exec('codesign', ['--verify', '--strict', helper]);
    const details = exec('codesign', ['-dv', '--verbose=4', helper]).stderr;
    return checkSymbolsHelper({ exists: true, executable, verify, details }, expect);
  });

  const only = launchChecks === 'guard' ? 'guard' : undefined;
  if (launchChecks) {
    const name = info.CFBundleExecutable || 'Aplos Mail';
    await add('launch', () =>
      runLaunchChecks({ executable: join(contents, 'MacOS', name), spawn, only }),
    );
  }
  for (const testCase of LAUNCH_CASES)
    if (!launchChecks || (only && !testCase.guardExit))
      rows.push(
        skip(
          testCase.id,
          only
            ? 'not run (pass --launch-checks; it launches the app)'
            : 'not run (pass --launch-checks or --launch-checks=guard; it launches the app)',
        ),
      );
  return rows;
}

export function formatTable(rows) {
  const width = Math.max(...rows.map(r => r.id.length));
  const lines = rows.map(r => `${r.status.padEnd(4)}  ${r.id.padEnd(width)}  ${r.reason}`);
  const count = status => rows.filter(r => r.status === status).length;
  return [
    ...lines,
    '',
    `${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped`,
  ].join('\n');
}

export function parseArgs(argv) {
  const options = { expect: 'release', json: false, launchChecks: false, app: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--launch-checks') options.launchChecks = true;
    else if (arg === '--launch-checks=guard') options.launchChecks = 'guard';
    else if (arg === '--expect') options.expect = argv[++i];
    else if (arg.startsWith('--expect=')) options.expect = arg.slice('--expect='.length);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (!arg.startsWith('-') && !options.app) options.app = arg;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.help && !options.app) throw new Error('missing the path to the .app');
  if (!['release', 'adhoc'].includes(options.expect))
    throw new Error(`--expect must be release or adhoc, not ${options.expect}`);
  if (options.app && !resolve(options.app).endsWith('.app'))
    throw new Error(`${options.app} is not a .app bundle`);
  return options;
}

const USAGE =
  'Usage: node scripts/verify-hardening.mjs <path-to-.app> [--expect release|adhoc] [--json] [--launch-checks[=guard]]';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`verify-hardening: ${error.message}\n${USAGE}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!existsSync(options.app)) {
    console.error(`verify-hardening: ${options.app} does not exist`);
    process.exit(2);
  }
  const rows = await verifyApp(options.app, options);
  const ok = !rows.some(r => r.status === 'FAIL');
  if (options.json) {
    const out = { app: resolve(options.app), expect: options.expect, ok, rows };
    console.log(JSON.stringify(out, null, 2));
  } else
    console.log(
      `verify-hardening: ${resolve(options.app)} (expect ${options.expect})\n\n${formatTable(rows)}`,
    );
  process.exit(ok ? 0 : 1);
}
