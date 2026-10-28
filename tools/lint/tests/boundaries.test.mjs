// RuleTester cases for aplos/boundaries, run with the real zones from eslint.config.mjs.
// Run: node --test tools/lint/tests/
import path from 'node:path';
import { describe, it } from 'node:test';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { boundaryZones } from '../../../eslint.config.mjs';
import plugin, { globToRegExp } from '../eslint-plugin-aplos.mjs';

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const options = [{ zones: boundaryZones }];
const at = file => path.join(process.cwd(), file);
const valid = (name, file, code) => ({ name, filename: at(file), code, options });
const invalid = (name, file, code, ...zones) => ({
  name,
  filename: at(file),
  code,
  options,
  errors: zones.map(zone => ({ messageId: zone === 'dynamic' ? 'dynamic' : 'denied' })),
});

const ENGINE = 'packages/engine/src/store/db.ts';
const CONTRACT = 'packages/contract/src/messages.ts';
const RENDERER = 'apps/desktop/src/renderer/Inbox.tsx';

tester.run('aplos/boundaries', plugin.rules.boundaries, {
  valid: [
    valid('engine core: relative and package imports', ENGINE, "import { a } from './a'; import z from 'zod';"),
    valid('engine core: type-only relative import', ENGINE, "import type { T } from '../types';"),
    valid('engine legacy may use electron and node: modules', 'packages/engine/src/legacy/mail.ts', "import { app } from 'electron'; import fs from 'node:fs';"),
    valid('engine legacy may import other legacy code', 'packages/engine/src/legacy/mail.ts', "import { x } from './legacy/helper'; export * from '../legacy/other';"),
    valid('legacy file anywhere may import legacy', 'apps/desktop/src/renderer/legacy/App.tsx', "import { y } from '../legacy/Shell';"),
    valid('contract: zod and relative files', CONTRACT, "import { z } from 'zod'; import { b } from './b'; export * from '../src/c';"),
    valid('renderer: contract and relative files', RENDERER, "import { Msg } from '@aplos/contract'; import './inbox.css';"),
    valid('main may import electron and the engine', 'apps/desktop/src/main/windows.ts', "import { app } from 'electron'; import { start } from '@aplos/engine';"),
    valid('non-literal dynamic import outside engine core', 'apps/desktop/src/main/windows.ts', 'const m = await import(name);'),
    valid('word legacy inside a segment name is fine', 'apps/desktop/src/main/a.ts', "import { x } from './legacy-notes';"),
  ],
  invalid: [
    invalid('engine core: static import of electron', ENGINE, "import { app } from 'electron';", 'engine-core'),
    invalid('engine core: dynamic import("electron")', ENGINE, "const e = await import('electron');", 'engine-core'),
    invalid('engine core: import of a node: module', ENGINE, "import { readFile } from 'node:fs/promises';", 'engine-core'),
    invalid('engine core: require("node:fs")', ENGINE, "const fs = require('node:fs');", 'engine-core'),
    invalid('engine core: bare builtin and subpath', ENGINE, "import fs from 'fs'; import p from 'fs/promises';", 'engine-core', 'engine-core'),
    invalid('engine core: export from a builtin', ENGINE, "export { join } from 'path';", 'engine-core'),
    invalid('engine core: non-literal dynamic import', ENGINE, 'const m = await import(name);', 'dynamic'),
    invalid('engine core: non-literal require', ENGINE, 'const m = require(name);', 'dynamic'),
    invalid('engine core: TypeScript import type("electron")', ENGINE, "type E = import('electron').App;", 'engine-core'),
    invalid('engine core: import x = require("child_process")', ENGINE, "import cp = require('child_process');", 'engine-core'),
    invalid('contract: any package but zod', CONTRACT, "import _ from 'lodash';", 'contract'),
    invalid('contract: relative path that leaves the package', CONTRACT, "import { x } from '../../engine/src/x';", 'contract'),
    invalid('renderer: relative import of main', RENDERER, "import { w } from '../main/windows';", 'renderer'),
    invalid('renderer: relative import of host', RENDERER, "export * from '../host/x';", 'renderer'),
    invalid('renderer: relative path into packages/engine', RENDERER, "import { e } from '../../../../packages/engine/src/index';", 'renderer'),
    invalid('renderer: today\'s engine location', RENDERER, "import { d } from '../engine/discover';", 'renderer'),
    invalid('renderer: @aplos/engine and subpath', RENDERER, "import a from '@aplos/engine'; import b from '@aplos/engine/store';", 'renderer', 'renderer'),
    invalid('renderer: child_process via require', RENDERER, "const cp = require('node:child_process');", 'renderer'),
    invalid('non-legacy: export * from ../legacy/x', 'packages/engine/src/index.ts', "export * from '../legacy/x';", 'legacy'),
    invalid('non-legacy: @aplos/engine/src/legacy/y', 'apps/desktop/src/main/windows.ts', "import { y } from '@aplos/engine/src/legacy/y';", 'legacy'),
    invalid('non-legacy: dynamic import of a legacy path', 'apps/desktop/src/main/windows.ts', "const m = await import('./legacy/x');", 'legacy'),
    invalid('engine core: a legacy path is rejected by the legacy zone', 'packages/engine/src/a.ts', "import { x } from './legacy/electron';", 'legacy'),
  ],
});

describe('globToRegExp', () => {
  it('treats dir/** as the directory and everything below it', () => {
    const re = globToRegExp('apps/desktop/src/main/**');
    for (const hit of ['apps/desktop/src/main', 'apps/desktop/src/main/a/b.ts']) {
      if (!re.test(hit)) throw new Error(`should match ${hit}`);
    }
    if (re.test('apps/desktop/src/mainframe/a.ts')) throw new Error('should not match mainframe');
  });
});
