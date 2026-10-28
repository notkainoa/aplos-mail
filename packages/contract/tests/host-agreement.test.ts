import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { legacyDesktopMethods, legacyEngineMethods, legacyMethods } from '../generated/methods.generated';

/**
 * Today three hand lists decide which methods a window may call (preload), main serves (electron.ts) and the browser
 * preview serves (server.ts), and they drift. This test reads them as they are and reports how each differs from the
 * generated legacy set, which must contain them all. Restructure step 3 makes the three files derive from the
 * generated set; then the drift printed here is empty and the equality assertions at the bottom can be switched on.
 */
const main = join(import.meta.dirname, '..', '..', '..', 'apps', 'desktop', 'src', 'main');
const source = (file: string) => readFileSync(join(main, file), 'utf8');
/** The string literals of `<name> = new Set([...])` (or `<name>=new Set([...])`) in a file. */
function setLiteral(file: string, name: string): Set<string> {
  const match = new RegExp(`\\b${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(source(file));
  assert.ok(match, `${file} no longer declares ${name} as a Set literal; update this test with the wiring`);
  return new Set([...match[1]!.matchAll(/'([^']+)'/g)].map(m => m[1]!));
}
const minus = (a: Iterable<string>, b: Set<string>) => [...a].filter(x => !b.has(x)).sort();

test('the generated legacy set covers every hand list, and the drift between them is reported', t => {
  const generated = new Set<string>(legacyMethods), engine = new Set<string>(legacyEngineMethods), desktop = new Set<string>(legacyDesktopMethods);
  const preload = setLiteral('preload.ts', 'allowed');
  const electronEngine = setLiteral('electron.ts', 'methods');
  const electronNative = setLiteral('electron.ts', 'nativeMethods');
  // main answers `ai.key.paste` itself before either set is consulted
  const electronAll = new Set([...electronEngine, ...electronNative, ...(/method==='ai\.key\.paste'/.test(source('electron.ts')) ? ['ai.key.paste'] : [])]);
  const serverEngine = setLiteral('server.ts', 'serviceMethods');
  const serverWeb = setLiteral('server.ts', 'webMethods');
  const serverAll = new Set([...serverEngine, ...serverWeb]);

  for (const [name, list] of [['preload', preload], ['electron', electronAll], ['server', serverAll]] as const) {
    assert.deepEqual(minus(list, generated), [], `${name} allows methods missing from the generated legacy set`);
  }
  assert.deepEqual(minus(electronEngine, engine), [], 'electron.ts sends only engine methods to the engine');
  assert.deepEqual(minus(electronNative, desktop), [], 'electron.ts serves only desktop methods natively');
  assert.deepEqual(minus(serverEngine, engine), [], 'server.ts sends only engine methods to the engine');

  const drift = {
    'generated legacy methods preload does not allow': minus(generated, preload),
    'generated legacy methods electron.ts does not serve (engine set + native set + ai.key.paste)': minus(generated, electronAll),
    'generated legacy methods server.ts does not serve (service set + web set)': minus(generated, serverAll),
    'server.ts web methods that main does not serve natively': minus(serverWeb, electronNative),
    'counts preload / electron / server / generated': [preload.size, electronAll.size, serverAll.size, generated.size].map(String),
  };
  for (const [label, names] of Object.entries(drift)) t.diagnostic(`${label}: ${names.length ? names.join(', ') : 'none'}`);
});
