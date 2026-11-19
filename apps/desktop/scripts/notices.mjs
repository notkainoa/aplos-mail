#!/usr/bin/env node
// Third-party notices for the production dependency tree of @aplos/desktop.
// Usage: node scripts/notices.mjs [--out THIRD_PARTY_NOTICES.txt] [--check] [--root <package dir>]
//   (no flag)  walk node_modules from <root>/package.json "dependencies" and write the notices file.
//   --check    write nothing; exit 1 if a production package is missing from the --out file, has no
//              license field, or has no license text that can be printed. Packages are listed on stderr.
//   --require-chromium  also fail when Electron's LICENSES.chromium.html cannot be found. When writing,
//              the file is copied next to --out so both ship together (extra resource in the app).
// Output is sorted and has no dates or machine paths, so the same tree gives the same file.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const LICENSE_FILE = /^(licen[sc]e|copying|notice)([-._].*)?$/i;

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Find node_modules/<name> by walking up from `from`, like Node's resolver. */
function locate(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

export function licenseOf(pkg) {
  if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim();
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses.length)
    return pkg.licenses.map(l => l.type || l).join(' OR ');
  return undefined;
}
function repositoryOf(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  return repo ? repo.replace(/^git\+/, '') : undefined;
}
const CODE_FILE = /\.(m?js|cjs|ts|tsx|json|html?|css|map|py|sh)$/i;
/** LICENSE/COPYING/NOTICE files at the top of a package and in its own subfolders (vendored code), never in nested node_modules. */
function licenseFiles(dir, rel = '', depth = 6) {
  const found = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? rel + '/' + entry.name : entry.name;
    if (
      entry.isFile() &&
      LICENSE_FILE.test(entry.name) &&
      !CODE_FILE.test(entry.name) &&
      !/header/i.test(entry.name)
    ) {
      const text = readFileSync(join(dir, path), 'utf8').replace(/\r\n/g, '\n').trim();
      if (text) found.push({ file: path, text });
    } else if (
      entry.isDirectory() &&
      depth > 0 &&
      entry.name !== 'node_modules' &&
      !entry.name.startsWith('.')
    )
      found.push(...licenseFiles(dir, path, depth - 1));
  }
  return found.sort((a, b) => cmp(a.file, b.file));
}

/** Standard texts for packages that declare a simple license but ship no file. The holder comes from package.json. */
function holderOf(pkg) {
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
  return author ? author.replace(/\s*[<(].*$/, '').trim() : undefined;
}
const TEMPLATES = {
  MIT: holder => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
  ISC: holder => `ISC License

Copyright (c) ${holder}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`,
};
export const GENERATED_LABEL = 'generated from package.json, the package ships no license file';
function generatedLicense(pkg, license) {
  const holder = holderOf(pkg);
  const template = TEMPLATES[String(license).replace(/^\((.*)\)$/, '$1')];
  return template && holder
    ? [{ file: GENERATED_LABEL, text: template(holder), generated: true }]
    : [];
}

/**
 * Walk the production tree from <root>/package.json. Required dependencies that cannot be found are
 * reported in `missing`; optional ones (platform builds) and peers that are not installed are skipped.
 * Returns {packages: [{name,version,license,repository,files}], missing: [name]} sorted by name@version.
 */
export function collectPackages(root) {
  const rootPkg = readJson(join(root, 'package.json'));
  const found = new Map();
  const missing = new Set();
  const visit = (name, from, required) => {
    const dir = locate(name, from);
    if (!dir) {
      if (required) missing.add(name);
      return;
    }
    const pkg = readJson(join(dir, 'package.json'));
    const key = `${pkg.name || name}@${pkg.version}`;
    if (found.has(key)) return;
    const license = licenseOf(pkg);
    let files = licenseFiles(dir);
    if (!files.length && license) files = generatedLicense(pkg, license);
    found.set(key, {
      name: pkg.name || name,
      version: pkg.version,
      license,
      repository: repositoryOf(pkg),
      files,
    });
    for (const dep of Object.keys(pkg.dependencies || {})) visit(dep, dir, true);
    for (const dep of Object.keys(pkg.optionalDependencies || {})) visit(dep, dir, false);
    for (const dep of Object.keys(pkg.peerDependencies || {})) visit(dep, dir, false);
  };
  for (const dep of Object.keys(rootPkg.dependencies || {})) visit(dep, root, true);
  for (const dep of Object.keys(rootPkg.optionalDependencies || {})) visit(dep, root, false);
  return {
    packages: [...found.values()].sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version)),
    missing: [...missing].sort(),
  };
}

/** Where Electron ships Chromium's licence file, or undefined if the binary was never downloaded. */
export function findChromiumLicenses(root) {
  const electron = locate('electron', root);
  if (!electron) return { version: undefined, file: undefined };
  const version = readJson(join(electron, 'package.json')).version;
  const dist = join(electron, 'dist');
  const search = (dir, depth) => {
    if (!existsSync(dir) || depth < 0) return undefined;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name === 'LICENSES.chromium.html') return join(dir, entry.name);
    }
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      cmp(a.name, b.name),
    )) {
      if (entry.isDirectory()) {
        const hit = search(join(dir, entry.name), depth - 1);
        if (hit) return hit;
      }
    }
  };
  return { version, file: search(dist, 4), electronDir: electron };
}

const RULE = '='.repeat(78);
const hash = text => createHash('sha256').update(text).digest('hex');

export function renderNotices(packages, electronInfo = {}) {
  const texts = new Map(); // sha -> {id,file,text,users:[]}
  const sections = packages.map(p => {
    const ids = p.files.map(f => {
      const key = hash(f.text);
      if (!texts.has(key)) texts.set(key, { id: `T${texts.size + 1}`, text: f.text, users: [] });
      const entry = texts.get(key);
      entry.users.push(`${p.name}@${p.version}`);
      return `${entry.id} (${f.file})`;
    });
    return [
      `Package: ${p.name}@${p.version}`,
      `License: ${p.license ?? 'NOT DECLARED'}`,
      `Repository: ${p.repository ?? 'not declared'}`,
      `Notice files: ${ids.length ? ids.join(', ') : 'none in the package'}`,
    ].join('\n');
  });
  const out = [];
  out.push(
    'Third-party notices for Aplos Mail',
    '',
    'Aplos Mail includes the software below. Each package is listed with the license it declares,',
    'then the full text of every license or notice file shipped with it. Identical texts are printed',
    'once and referred to by number.',
    '',
    RULE,
    'Electron and Chromium',
    RULE,
    '',
    `Aplos Mail runs on Electron${electronInfo.version ? ' ' + electronInfo.version : ''}, which is MIT licensed (text T-ELECTRON below).`,
    'Electron bundles Chromium, Node.js and many other components. Their licenses are collected in',
    'the file LICENSES.chromium.html, which is installed in the same folder as this file',
    '(Aplos Mail.app/Contents/Resources). It is not repeated here because of its size.',
    '',
  );
  if (electronInfo.licenseText)
    out.push('T-ELECTRON (Electron LICENSE)', '-'.repeat(40), electronInfo.licenseText, '');
  out.push(
    RULE,
    `Packages (${packages.length})`,
    RULE,
    '',
    sections.join('\n\n'),
    '',
    RULE,
    'License texts',
    RULE,
    '',
  );
  for (const t of texts.values()) {
    out.push(`${t.id}  used by: ${[...new Set(t.users)].join(', ')}`, '-'.repeat(40), t.text, '');
  }
  return out.join('\n');
}

/** Packages not mentioned in `text`, with no license field, or with a license field but no text to print. */
export function checkNotices(text, packages) {
  const listed = new Set([...text.matchAll(/^Package: (\S+)$/gm)].map(m => m[1]));
  return {
    absent: packages
      .filter(p => !listed.has(`${p.name}@${p.version}`))
      .map(p => `${p.name}@${p.version}`),
    unlicensed: packages.filter(p => !p.license).map(p => `${p.name}@${p.version}`),
    noText: packages.filter(p => p.license && !p.files.length).map(p => `${p.name}@${p.version}`),
  };
}

function parseArgs(argv) {
  const args = {
    out: 'THIRD_PARTY_NOTICES.txt',
    check: false,
    requireChromium: false,
    root: resolve(scriptDir, '..'),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--require-chromium') args.requireChromium = true;
    else if (argv[i] === '--root') args.root = resolve(argv[++i]);
    else throw new Error('Unknown option ' + argv[i]);
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(
      error.message +
        '\nUsage: notices.mjs [--out file] [--check] [--require-chromium] [--root dir]',
    );
    process.exit(2);
  }
  const { packages, missing } = collectPackages(args.root);
  const chromium = findChromiumLicenses(args.root);
  console.error(
    `${packages.length} production packages; Electron ${chromium.version ?? 'not installed'}; LICENSES.chromium.html ${chromium.file ? 'present' : 'NOT present in node_modules/electron/dist'}`,
  );
  if (args.check) {
    const text = existsSync(args.out) ? readFileSync(args.out, 'utf8') : '';
    const { absent, unlicensed, noText } = checkNotices(text, packages);
    const chromiumCopy = join(dirname(resolve(args.out)), 'LICENSES.chromium.html');
    let chromiumBad = 0;
    if (args.requireChromium) {
      if (!chromium.file) {
        console.error('FAIL LICENSES.chromium.html not found in node_modules/electron/dist');
        chromiumBad++;
      }
      if (!existsSync(chromiumCopy)) {
        console.error('FAIL LICENSES.chromium.html is not next to ' + args.out);
        chromiumBad++;
      }
    }
    for (const name of noText)
      console.error('FAIL license declared but no license text available: ' + name);
    if (!existsSync(args.out)) console.error('FAIL ' + args.out + ' does not exist');
    for (const name of missing) console.error('FAIL declared dependency not installed: ' + name);
    for (const name of absent) console.error('FAIL missing from notices: ' + name);
    for (const name of unlicensed) console.error('FAIL no license field: ' + name);
    const bad =
      absent.length +
      unlicensed.length +
      noText.length +
      missing.length +
      chromiumBad +
      (existsSync(args.out) ? 0 : 1);
    if (bad) process.exit(1);
    console.log(`PASS ${packages.length} packages are in ${args.out} and all declare a license`);
    return;
  }
  const electronLicense =
    chromium.electronDir && existsSync(join(chromium.electronDir, 'LICENSE'))
      ? readFileSync(join(chromium.electronDir, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trim()
      : undefined;
  if (args.requireChromium && !chromium.file) {
    console.error(
      'FAIL LICENSES.chromium.html not found in node_modules/electron/dist. Electron downloads its binary on first use, not at install; run node node_modules/electron/install.js first.',
    );
    process.exit(1);
  }
  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(
    args.out,
    renderNotices(packages, { version: chromium.version, licenseText: electronLicense }),
  );
  if (chromium.file) {
    copyFileSync(chromium.file, join(dirname(resolve(args.out)), 'LICENSES.chromium.html'));
    console.log('copied LICENSES.chromium.html next to ' + args.out);
  } else
    console.error(
      'WARN LICENSES.chromium.html not found; the notices refer to it, so do not ship without it',
    );
  for (const name of missing) console.error('WARN declared dependency not installed: ' + name);
  console.log(`wrote ${args.out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
