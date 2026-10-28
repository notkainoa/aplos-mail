# tools/lint

Lint tooling that is specific to this repo. The configs themselves are `eslint.config.mjs` and `stylelint.config.mjs` at the repo root.

- `eslint-plugin-aplos.mjs`: local ESLint plugin. Its one rule, `aplos/boundaries`, checks static imports, `export ... from`, dynamic `import('x')`, `require('x')` and TypeScript `import type('x')` against import zones.
- `tests/boundaries.test.mjs`: RuleTester cases for the rule, run with `npm run test:lint` (they use the real zones from `eslint.config.mjs`).
- `design/`: **UI-core's extension point** (DESIGN section 12.2). Do not put other rules there.

## What the zones enforce

The zones are listed in `eslint.config.mjs` (`boundaryZones`); change the rules there, not in the plugin.

- `packages/engine/src` (outside `legacy/`): no `electron`, no `node:` and no bare Node builtin imports, and no dynamic import with a non-literal specifier.
- `packages/contract/src` (outside `legacy/`): only `zod` and files inside the contract.
- `apps/desktop/src/renderer`: nothing from `src/main`, `src/host`, `packages/engine` or `@aplos/engine`, and no `child_process`.
- Anything outside a `legacy/` folder: no import path with a `legacy` segment.

`dangerouslySetInnerHTML` is rejected everywhere except `apps/desktop/src/renderer/mailframe`, and the renderer also rejects `eval`, `new Function` and implied eval (plain ESLint rules in `eslint.config.mjs`).

Limits: only string-literal specifiers are checked (a computed `require(name)` is flagged in engine core and ignored elsewhere), and an alias that points into a legacy folder without the word `legacy` in the import path is not seen.

## Adding a rule

- A new import boundary: add a zone to `boundaryZones` in `eslint.config.mjs` (`from`, optional `except`, then `deny` entries with `specifier`, `path`, `segment` or `builtin`, or an `allow` list), and add valid and invalid cases to `tests/boundaries.test.mjs`.
- A different kind of rule: add it to `eslint-plugin-aplos.mjs` under `rules`, enable it as `aplos/<name>` in `eslint.config.mjs` and test it with RuleTester in `tests/`.

## Existing violations

`eslint-suppressions.json` records violations that already existed (generate it with `npm run lint:baseline`). It is keyed by file path, so regenerate it after files move; it shrinks as code is fixed (`eslint . --prune-suppressions`).
