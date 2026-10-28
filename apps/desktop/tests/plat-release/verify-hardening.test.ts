import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The script is plain ESM without type declarations, so load it untyped.
const scriptPath = fileURLToPath(new URL('../../scripts/verify-hardening.mjs', import.meta.url));
const vh: any = await import(new URL('../../scripts/verify-hardening.mjs', import.meta.url).href);
const asar: any = createRequire(import.meta.url)('@electron/asar');

// Key-shaped fixtures are assembled at runtime so this file never contains one.
const fakeKey = (prefix: string, length: number) => prefix + 'A1b2C3d4'.repeat(Math.ceil(length / 8)).slice(0, length);
const ON = 49, OFF = 48, REMOVED = 114;

function wire(overrides: Record<string, boolean | number> = {}) {
  const result: Record<string, unknown> = { version: '1' };
  for (const [name, want] of Object.entries({ ...vh.EXPECTED_FUSES, ...overrides })) {
    result[vh.FUSE_INDEX[name]] = typeof want === 'number' ? want : want ? ON : OFF;
  }
  return result;
}

test('fuses: the expected table passes and every gap is named', () => {
  assert.equal(vh.checkFuses(wire()).status, 'PASS');
  // Electron's defaults, which today's build ships.
  const today = vh.checkFuses(wire({ RunAsNode: true, EnableNodeOptionsEnvironmentVariable: true, EnableNodeCliInspectArguments: true, EnableEmbeddedAsarIntegrityValidation: false, OnlyLoadAppFromAsar: false }));
  assert.equal(today.status, 'FAIL');
  for (const name of ['RunAsNode is on', 'EnableNodeOptionsEnvironmentVariable is on', 'EnableNodeCliInspectArguments is on', 'EnableEmbeddedAsarIntegrityValidation is off', 'OnlyLoadAppFromAsar is off']) assert.match(today.reason, new RegExp(name));
  assert.match(vh.checkFuses(wire({ EnableCookieEncryption: true })).reason, /EnableCookieEncryption is on, want off/);
  assert.match(vh.checkFuses(wire({ GrantFileProtocolExtraPrivileges: false })).reason, /GrantFileProtocolExtraPrivileges is off, want on/);
  assert.match(vh.checkFuses(wire({ RunAsNode: REMOVED })).reason, /RunAsNode is removed/);
  const missing = wire(); delete missing[vh.FUSE_INDEX.OnlyLoadAppFromAsar];
  assert.match(vh.checkFuses(missing).reason, /OnlyLoadAppFromAsar is missing/);
  assert.equal(vh.checkFuses({ ...wire(), version: '2' }).status, 'FAIL');
});

test('Info.plist: macOS 13 minimum and asar integrity', () => {
  assert.equal(vh.checkMinimumMacos({ LSMinimumSystemVersion: '13.0' }).status, 'PASS');
  assert.equal(vh.checkMinimumMacos({ LSMinimumSystemVersion: '13' }).status, 'PASS');
  assert.match(vh.checkMinimumMacos({ LSMinimumSystemVersion: '12.0' }).reason, /12\.0, want 13\.0/);
  assert.equal(vh.checkMinimumMacos({ LSMinimumSystemVersion: '13.1' }).status, 'FAIL');
  assert.equal(vh.checkMinimumMacos({}).status, 'FAIL');

  const header = '{"files":{"package.json":{"size":2,"offset":"0"}}}';
  const hash = vh.headerHash(header);
  assert.match(hash, /^[0-9a-f]{64}$/);
  const info = { ElectronAsarIntegrity: { 'Resources/app.asar': { algorithm: 'SHA256', hash } } };
  assert.equal(vh.checkAsarIntegrity(info, hash).status, 'PASS');
  assert.equal(vh.checkAsarIntegrity(info).status, 'PASS');
  assert.match(vh.checkAsarIntegrity(info, vh.headerHash(header + ' ')).reason, /does not match/);
  assert.equal(vh.checkAsarIntegrity({}).status, 'FAIL');
  assert.equal(vh.checkAsarIntegrity({ ElectronAsarIntegrity: { 'Resources/app.asar': { algorithm: 'MD5', hash } } }).status, 'FAIL');
});

test('signature, hardened runtime, Gatekeeper and stapling', () => {
  assert.equal(vh.checkCodesignVerify({ status: 0, stdout: '', stderr: 'valid on disk' }).status, 'PASS');
  assert.match(vh.checkCodesignVerify({ status: 1, stdout: '', stderr: 'Aplos Mail.app: code has no resources but signature indicates they must be present' }).reason, /no resources/);

  const runtime = 'CodeDirectory v=20500 size=446 flags=0x10000(runtime) hashes=3+7 location=embedded';
  assert.equal(vh.checkHardenedRuntime(runtime, 'release').status, 'PASS');
  assert.equal(vh.checkHardenedRuntime('flags=0x20002(adhoc,linker-signed)', 'release').status, 'FAIL');
  assert.equal(vh.checkHardenedRuntime('flags=0x20002(adhoc,linker-signed)', 'adhoc').status, 'SKIP');

  const accepted = { status: 0, stdout: '', stderr: 'Aplos Mail.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Kainoa Newton (VW9NDM428H)' };
  assert.equal(vh.checkGatekeeper(accepted, 'release').status, 'PASS');
  assert.equal(vh.checkGatekeeper(accepted, 'adhoc').status, 'SKIP');
  assert.match(vh.checkGatekeeper({ status: 0, stdout: '', stderr: 'X.app: accepted\nsource=Unnotarized Developer ID\norigin=Developer ID Application: Kainoa Newton (VW9NDM428H)' }, 'release').reason, /not "Notarized Developer ID"/);
  assert.match(vh.checkGatekeeper({ status: 0, stdout: '', stderr: 'X.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Someone (ABCDE12345)' }, 'release').reason, /not team VW9NDM428H/);
  assert.match(vh.checkGatekeeper({ status: 3, stdout: '', stderr: 'Aplos Mail.app: rejected' }, 'release').reason, /rejected/);

  assert.equal(vh.checkStapler({ status: 0, stdout: 'Processing: X.app\nThe validate action worked!', stderr: '' }, 'release').status, 'PASS');
  assert.match(vh.checkStapler({ status: 65, stdout: 'Processing: X.app\nX.app does not have a ticket stapled to it.', stderr: '' }, 'release').reason, /does not have a ticket/);
  assert.equal(vh.checkStapler({}, 'adhoc').status, 'SKIP');
});

test('entitlements must match the file exactly', () => {
  const expected = { 'com.apple.security.cs.allow-jit': true, 'com.apple.security.device.audio-input': true };
  assert.equal(vh.compareEntitlements({ ...expected }, expected, 'build/entitlements.mac.plist').status, 'PASS');
  assert.match(vh.compareEntitlements({ ...expected, 'com.apple.security.get-task-allow': true }, expected, 'x').reason, /extra com\.apple\.security\.get-task-allow/);
  assert.match(vh.compareEntitlements({ 'com.apple.security.cs.allow-jit': true }, expected, 'x').reason, /missing com\.apple\.security\.device\.audio-input/);
  assert.match(vh.compareEntitlements({ ...expected, 'com.apple.security.cs.allow-jit': false }, expected, 'x').reason, /allow-jit is false, want true/);
  assert.equal(vh.compareEntitlements({}, expected, 'x').status, 'FAIL'); // unsigned app shows no entitlements
});

test('the ad-hoc entitlements file is a copy of the release file', { skip: process.platform !== 'darwin' && 'needs plutil' }, () => {
  const read = (file: string) => JSON.parse(spawnSync('plutil', ['-convert', 'json', '-o', '-', '--', file], { encoding: 'utf8' }).stdout);
  const release = read(vh.ENTITLEMENTS.release), adhoc = read(vh.ENTITLEMENTS.adhoc);
  assert.equal(vh.compareEntitlements(adhoc, release, 'release').status, 'PASS');
  assert.equal(adhoc['com.apple.security.cs.disable-library-validation'], true);
});

test('designated requirement names the bundle and team; cdhash-only is flagged', () => {
  const good = 'Executable=/x/Aplos Mail.app/Contents/MacOS/Aplos Mail\ndesignated => identifier "com.aplos.mail" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = VW9NDM428H';
  assert.equal(vh.checkDesignatedRequirement(good, 'release').status, 'PASS');
  assert.equal(vh.checkDesignatedRequirement(good.replace('= VW9NDM428H', '= "VW9NDM428H"'), 'release').status, 'PASS');

  const cdhash = 'Executable=/x\n# designated => cdhash H"d4eeb21224b2ac503a3a8b9bddae6a14e2b138d2"';
  assert.match(vh.checkDesignatedRequirement(cdhash, 'release').reason, /cdhash-only/);
  assert.equal(vh.checkDesignatedRequirement(cdhash, 'release').status, 'FAIL');
  assert.equal(vh.checkDesignatedRequirement(cdhash, 'adhoc').status, 'SKIP');

  assert.match(vh.checkDesignatedRequirement(good.replace('"com.aplos.mail"', '"com.aplos.mail.evil"'), 'release').reason, /does not name identifier/);
  assert.match(vh.checkDesignatedRequirement(good.replace('VW9NDM428H', 'VW9NDM428HX'), 'release').reason, /does not pin/);
  assert.match(vh.checkDesignatedRequirement(good.replace('anchor apple generic and ', ''), 'release').reason, /not anchored to Apple/);
  assert.match(vh.checkDesignatedRequirement(`${good} or cdhash H"00"`, 'release').reason, /"or" branch/);
  assert.equal(vh.checkDesignatedRequirement('Executable=/x', 'release').status, 'FAIL');
});

test('key scan: each key shape is caught and never printed', () => {
  const keys = [fakeKey('gsk_', 52), fakeKey('sk-ant-api03-', 40), fakeKey('sk-proj-', 40), fakeKey('sk-', 48), fakeKey('AIza', 35), fakeKey('ghp_', 36), fakeKey('github_pat_', 60)];
  for (const key of keys) {
    const scan = vh.scanFiles([{ path: 'dist/main/electron.cjs', data: Buffer.from(`const a="${key}";`) }]);
    const [, row] = vh.asarRows(scan);
    assert.equal(row.status, 'FAIL', key.slice(0, 6));
    assert.ok(!row.reason.includes(key), 'the secret value must not be printed');
    assert.match(row.reason, /dist\/main\/electron\.cjs @9: .*…\(redacted\)/);
  }
  assert.equal(vh.asarRows(vh.scanFiles([{ path: 'a.js', data: Buffer.from('sk-short gsk_short AIzaShort') }]))[1].status, 'PASS');
});

test('key scan: a PEM private key fails, a bare header in docs does not', () => {
  const body = Array.from({ length: 4 }, () => fakeKey('', 64)).join('\n');
  const pem = `-----BEGIN ${'PRIVATE'} KEY-----\n${body}\n-----END ${'PRIVATE'} KEY-----`;
  const withKey = vh.asarRows(vh.scanFiles([{ path: 'x.js', data: Buffer.from(JSON.stringify(pem)) }]))[1];
  assert.equal(withKey.status, 'FAIL');
  assert.ok(!withKey.reason.includes(body.slice(0, 64)));
  const docs = vh.asarRows(vh.scanFiles([{ path: 'node_modules/dotenv/README.md', data: Buffer.from(`-----BEGIN RSA ${'PRIVATE'} KEY-----\n...\nKh9NV...\n-----END RSA ${'PRIVATE'} KEY-----`) }]))[1];
  assert.equal(docs.status, 'PASS');
  assert.match(docs.reason, /1 PEM header\(s\) without key material ignored \(node_modules\/dotenv\/README\.md\)/);
});

test('asar scan on a real archive: .env, key-shaped strings, Google secret only in the engine bundle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vh-asar-'));
  try {
    const secret = fakeKey('GOCSPX-', 28);
    const build = async (name: string, files: Record<string, string>) => {
      const src = join(dir, name);
      for (const [path, text] of Object.entries(files)) { await mkdir(join(src, path, '..'), { recursive: true }); await writeFile(join(src, path), text); }
      const out = join(dir, `${name}.asar`);
      await asar.createPackageWithOptions(src, out, { dot: true });
      return [...vh.asarFiles(out)];
    };

    const clean = vh.asarRows(vh.scanFiles(await build('clean', { 'package.json': '{}', 'dist/main/engine.cjs': `var s="${secret}";`, 'dist/main/electron.cjs': 'var s="";' })));
    assert.deepEqual(clean.map((r: any) => r.status), ['PASS', 'PASS']);
    assert.match(clean[1].reason, /dist\/main\/engine\.cjs @7: GOCSPX-…\(redacted\) \(Google client secret\) is inlined on purpose \(RELEASING\.md\)/);
    assert.ok(!clean[1].reason.includes(secret));

    const leaked = vh.asarRows(vh.scanFiles(await build('leaked', { 'dist/main/engine.cjs': `var s="${secret}";`, 'dist/main/electron.cjs': `var s="${secret}";` })));
    assert.equal(leaked[1].status, 'FAIL');
    assert.match(leaked[1].reason, /dist\/main\/electron\.cjs @7: GOCSPX-…\(redacted\)/);
    assert.ok(!leaked[1].reason.includes('engine.cjs'), 'the engine copy stays allowed');
    assert.ok(!leaked[1].reason.includes(secret));

    const env = vh.asarRows(vh.scanFiles(await build('env', { '.env': `GROQ_API_KEY=${fakeKey('gsk_', 52)}\n`, 'dist/.env.local': 'A=1', 'dist/.env.example': 'A=' })));
    assert.equal(env[0].status, 'FAIL');
    assert.match(env[0].reason, /\.env; dist\/\.env\.local$/);
    assert.equal(env[1].status, 'FAIL');
    assert.match(env[1].reason, /^key-shaped strings: \.env @13: gsk_…\(redacted\) \(Groq key\)$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('aplos-symbols helper must exist, run and be signed by the team', () => {
  const signed = { exists: true, executable: true, verify: { status: 0, stderr: '' }, details: 'Identifier=aplos-symbols\nTeamIdentifier=VW9NDM428H' };
  assert.equal(vh.checkSymbolsHelper(signed, 'release').status, 'PASS');
  assert.equal(vh.checkSymbolsHelper({ exists: false }, 'adhoc').status, 'FAIL');
  assert.equal(vh.checkSymbolsHelper({ ...signed, executable: false }, 'adhoc').status, 'FAIL');
  assert.match(vh.checkSymbolsHelper({ ...signed, verify: { status: 1, stderr: 'code object is not signed at all' } }, 'adhoc').reason, /not signed at all/);
  const adhoc = { ...signed, details: 'Signature=adhoc\nTeamIdentifier=not set' };
  assert.equal(vh.checkSymbolsHelper(adhoc, 'adhoc').status, 'PASS');
  assert.match(vh.checkSymbolsHelper(adhoc, 'release').reason, /only ad-hoc/);
  assert.match(vh.checkSymbolsHelper({ ...signed, details: 'TeamIdentifier=ABCDE12345' }, 'release').reason, /not signed by team/);
});

// ---- launch checks with a fake spawn: nothing is launched ----

type Behaviour = (args: string[], env: Record<string, string>) => { output?: string; exitCode?: number } | undefined;
function fakeSpawn(behaviour: Behaviour, calls: Array<{ args: string[]; env: Record<string, string> }>) {
  return (_executable: string, args: string[], options: { env: Record<string, string> }) => {
    calls.push({ args, env: options.env });
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = (signal: string) => setImmediate(() => { child.emit('exit', null, signal); child.emit('close', null, signal); });
    const plan = behaviour(args, options.env) ?? {};
    setImmediate(() => {
      if (plan.output) child.stderr.emit('data', Buffer.from(plan.output));
      if (plan.exitCode !== undefined) { child.emit('exit', plan.exitCode, null); child.emit('close', plan.exitCode, null); }
    });
    return child; // no exitCode: keeps "running" until killed
  };
}
const inspectArg = (args: string[]) => args.find(a => a.startsWith('--inspect') || a.startsWith('--remote-debugging'));

async function launch(behaviour: Behaviour, extra: Record<string, unknown> = {}) {
  const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
  const removed: string[] = [];
  let n = 0;
  const rows = await vh.runLaunchChecks({
    executable: '/nowhere/Aplos Mail', spawn: fakeSpawn(behaviour, calls), timeoutMs: 40,
    baseEnv: { PATH: '/usr/bin', NODE_OPTIONS: '--require /tmp/evil.js', ELECTRON_RUN_AS_NODE: '1' },
    makeTempDir: () => `/tmp/fake-${++n}`, removeDir: (dir: string) => removed.push(dir), exists: () => false, ...extra,
  });
  return { rows, calls, removed };
}

test('launch checks: a hardened release passes every hostile launch', async () => {
  const { rows, calls, removed } = await launch(args => (inspectArg(args) ? { exitCode: 1 } : undefined));
  assert.deepEqual(rows.map((r: any) => [r.id, r.status]), [['launch-remote-debugging', 'PASS'], ['launch-inspect', 'PASS'], ['launch-run-as-node', 'PASS'], ['launch-node-options', 'PASS']]);
  assert.match(rows[0].reason, /exited \(code 1\)/);
  assert.match(rows[2].reason, /killed/);
  assert.deepEqual(removed, ['/tmp/fake-1', '/tmp/fake-2', '/tmp/fake-3', '/tmp/fake-4']);
  // Each launch gets its own temp data dir and Chromium profile, and only its own hostile variable.
  calls.forEach((call, i) => {
    assert.equal(call.env.APLOS_DATA_DIR, `/tmp/fake-${i + 1}`);
    assert.equal(call.args[0], `--user-data-dir=/tmp/fake-${i + 1}/chromium`);
  });
  assert.deepEqual(calls.map(c => [c.env.ELECTRON_RUN_AS_NODE, c.env.NODE_OPTIONS]), [[undefined, undefined], [undefined, undefined], ['1', undefined], [undefined, '--inspect=0']]);
});

test('launch checks: today\'s unfused build fails every hostile launch', async () => {
  const { rows } = await launch((args, env) => {
    if (env.ELECTRON_RUN_AS_NODE === '1') return { output: `node: bad option: ${args[0]}\n`, exitCode: 9 };
    if (args.some(a => a.startsWith('--remote-debugging'))) return { output: 'DevTools listening on ws://127.0.0.1:53111/devtools/browser/x\n' };
    if (args.some(a => a.startsWith('--inspect')) || env.NODE_OPTIONS) return { output: 'Debugger listening on ws://127.0.0.1:9229/x\n' };
    return undefined;
  });
  assert.deepEqual(rows.map((r: any) => r.status), ['FAIL', 'FAIL', 'FAIL', 'FAIL']);
  assert.match(rows[0].reason, /exposed a debugger/);
  assert.match(rows[2].reason, /ran as Node/);
  assert.match(rows[3].reason, /exposed a debugger/);
});

test('launch checks: Node output, a DevToolsActivePort file, staying up and spawn errors all fail', async () => {
  const ranNode = await launch((_args, env) => (env.ELECTRON_RUN_AS_NODE ? { output: 'aplos-ran-as-node', exitCode: 0 } : { exitCode: 1 }));
  assert.match(ranNode.rows[2].reason, /ran as Node/);

  const portFile = await launch(() => ({ exitCode: 1 }), { exists: (path: string) => path.endsWith('/fake-1/chromium/DevToolsActivePort') });
  assert.equal(portFile.rows[0].status, 'FAIL');
  assert.equal(portFile.rows[1].status, 'PASS');

  const stays = await launch(() => undefined);
  assert.match(stays.rows[0].reason, /still running after 0\.04s, then killed; a release must exit/);
  assert.equal(stays.rows[0].status, 'FAIL');

  const broken = await launch(() => undefined, { spawn: () => { throw new Error('ENOENT'); } });
  assert.ok(broken.rows.every((r: any) => r.status === 'FAIL' && /could not start the app: ENOENT/.test(r.reason)));
  assert.equal(broken.removed.length, 4);
});

test('CLI arguments, table output and exit codes', () => {
  assert.deepEqual(vh.parseArgs(['/x/Aplos Mail.app', '--expect', 'adhoc', '--json']), { expect: 'adhoc', json: true, launchChecks: false, app: '/x/Aplos Mail.app' });
  assert.equal(vh.parseArgs(['/x/A.app/', '--expect=release', '--launch-checks']).launchChecks, true);
  assert.throws(() => vh.parseArgs([]), /missing the path/);
  assert.throws(() => vh.parseArgs(['/x/A.app', '--expect', 'beta']), /release or adhoc/);
  assert.throws(() => vh.parseArgs(['/x/binary']), /not a \.app/);
  assert.throws(() => vh.parseArgs(['/x/A.app', '--nope']), /unknown argument/);

  const table = vh.formatTable([{ id: 'fuses', status: 'FAIL', reason: 'RunAsNode is on' }, { id: 'stapler', status: 'SKIP', reason: 'ad-hoc' }]);
  assert.match(table, /^FAIL  fuses    RunAsNode is on\nSKIP  stapler  ad-hoc\n\n0 passed, 1 failed, 1 skipped$/);

  assert.equal(spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [scriptPath, '/definitely/missing/Aplos Mail.app'], { encoding: 'utf8' }).status, 2);
});
