# tools/lint

Lint tooling that is specific to this repo. The configs themselves are `eslint.config.mjs` and `stylelint.config.mjs` at the repo root.

- `eslint-plugin-aplos.mjs`: local ESLint plugin with two rules. `aplos/boundaries` checks static imports, `export ... from`, dynamic `import('x')`, `require('x')` and TypeScript `import type('x')` against import zones. `aplos/no-dangerous-html` rejects the `dangerouslySetInnerHTML` prop in JSX, in object literals (spread props, `createElement`) and as a string key.
- `tests/boundaries.test.mjs`: RuleTester cases for the rule, run with `npm run test:lint` (they use the real zones from `eslint.config.mjs`).
- `design/`: **UI-core's extension point** (DESIGN section 12.2). Do not put other rules there.

## What the zones enforce

The zones are listed in `eslint.config.mjs` (`boundaryZones`); change the rules there, not in the plugin.

- `packages/engine/src` (outside `packages/engine/src/legacy`): no `electron`, `electron-*` or `@electron/*` packages, no `node:` and no bare Node builtin imports, and no dynamic import or `require` with a non-literal specifier. Without an import it also rejects `process.getBuiltinModule`, `process.binding`, `module.require`, `globalThis.require` and the CommonJS globals `require`, `module`, `__dirname`, `__filename` (plain ESLint rules in `eslint.config.mjs`). `process` and `Buffer` stay allowed (recorded choice: the engine may run in plain Node, ARCHITECTURE 2.6, which does not list them).
- `packages/contract/src` (outside `packages/contract/src/legacy`): only `zod` and files inside the contract, same non-literal and CommonJS rules as engine core.
- `apps/desktop/src/renderer`: nothing from `src/main`, `src/host`, `packages/engine` or `@aplos/engine`, and no `child_process`.
- Anything outside the three legacy roots (`packages/engine/src/legacy`, `packages/contract/src/legacy`, `apps/desktop/src/renderer/legacy`): no import path with a `legacy` segment. A folder merely named `legacy` elsewhere gets no exemption from any rule.

`aplos/no-dangerous-html` is on everywhere except `apps/desktop/src/renderer/mailframe`. It is a plugin rule on purpose: flat config replaces a rule's whole option list when a later config sets the same rule, so a `no-restricted-syntax` ban would be erased by design rules that use `no-restricted-syntax`. The renderer also rejects `eval`, `new Function` and implied eval.

The rules resolve paths from the repo root (the plugin's own location), so running ESLint from inside a package gives the same result as from the root.

Limits: only string-literal specifiers are checked (a computed `require(name)` is flagged in engine core and ignored elsewhere), and an alias that points into a legacy folder without the word `legacy` in the import path is not seen.

## Adding a rule

- A new import boundary: add a zone to `boundaryZones` in `eslint.config.mjs` (`from`, optional `except`, then `deny` entries with `specifier`, `path`, `segment` or `builtin`, or an `allow` list), and add valid and invalid cases to `tests/boundaries.test.mjs`.
- A different kind of rule: add it to `eslint-plugin-aplos.mjs` under `rules`, enable it as `aplos/<name>` in `eslint.config.mjs` and test it with RuleTester in `tests/`.

## Existing violations

`eslint-suppressions.json` records violations that already existed (generate it with `npm run lint:baseline`). It is keyed by file path, so regenerate it after files move.

- `npm run lint` and the pre-commit hook pass `--pass-on-unpruned-suppressions`, so fixing a suppressed violation never fails a commit or CI (without it ESLint exits 2). Lanes must not edit `eslint-suppressions.json` while fixing code: it is one shared file and parallel edits conflict.
- The Integrator runs `npm run lint:prune` periodically (after merges) to drop entries that no longer occur, and commits the result.
- `eslint-suppressions.json` must be listed in `.prettierignore`: ESLint writes it without a final newline, so `prettier --check` rejects it. The pre-commit hook already skips it.
- CSS: `stylelint-suppressions.json` works the same way for `no-descending-specificity`, `no-duplicate-selectors` and `keyframe-block-no-duplicate-selectors` (`npm run lint:css:baseline` regenerates it; fixed entries are tolerated). These rules stay errors, so only new violations fail.
