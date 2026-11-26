// Layer rules for the depcruise hill-climb scorer (scripts/audit/hillclimb/scorers/depcruise.mjs,
// roadmap 5.1c). The `error` rules mirror the aplos/boundaries zones in eslint.config.mjs — they
// match resolved paths where ESLint matched specifiers, so an `@aplos/engine` import and a
// relative `../../packages/engine/...` import are the same edge. The `warn` rules are the extra
// layer rules from the task (not in the ESLint zones). Circular edges are scored separately.
//
// Not mirrored (they need syntax the graph does not see): the zones' flagDynamic check on
// non-literal dynamic imports/requires, and eslint.config.mjs's no-restricted-properties/globals
// rules for engine core (process.getBuiltinModule, require, __dirname).
module.exports = {
  forbidden: [
    {
      name: 'engine-core-no-electron',
      severity: 'error',
      comment:
        'boundaries engine-core: packages/engine/src must run outside Electron (ARCHITECTURE 2.6)',
      from: { path: '^packages/engine/src' },
      // electron, electron-* and @electron/*, like the zone's specifier regex.
      to: { path: 'node_modules/@?electron' },
    },
    {
      name: 'engine-core-no-node',
      severity: 'error',
      comment:
        'boundaries engine-core: no node: or bare Node builtins; go through a port (ARCHITECTURE 2.6)',
      from: { path: '^packages/engine/src' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'contract-isolation',
      severity: 'error',
      comment: "boundaries contract: only zod and the package's own files (except src/legacy)",
      from: {
        path: '^packages/contract/(src|generated)/',
        pathNot: '^packages/contract/src/legacy/',
      },
      to: {
        pathNot: '^(packages/contract/(src|generated)/|node_modules/zod/)',
        dependencyTypesNot: ['core'],
      },
    },
    {
      name: 'contract-no-builtins',
      severity: 'error',
      comment:
        'boundaries contract: builtins are not zod or own files, so they are denied too (the allow-list is exhaustive)',
      from: {
        path: '^packages/contract/(src|generated)/',
        pathNot: '^packages/contract/src/legacy/',
      },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'renderer-no-engine-or-host',
      severity: 'error',
      comment:
        'boundaries renderer: the renderer talks to the engine through the contract, not by importing it',
      from: { path: '^apps/desktop/src/renderer/' },
      to: { path: '^(apps/desktop/src/(main|host|engine)/|packages/engine/)' },
    },
    {
      name: 'renderer-no-child-process',
      severity: 'error',
      comment: 'boundaries renderer: the renderer must not spawn processes',
      from: { path: '^apps/desktop/src/renderer/' },
      to: { path: '^(node:)?child_process$' },
    },
    {
      name: 'no-legacy-imports',
      severity: 'error',
      comment: 'boundaries legacy: legacy/ code may be imported only by other legacy code',
      from: { pathNot: '(^|/)legacy/' },
      to: { path: '(^|/)legacy/' },
    },
    {
      name: 'no-circular-engine',
      severity: 'error',
      comment: 'no circular dependencies inside packages/engine/src',
      from: { path: '^packages/engine/src' },
      to: { circular: true, path: '^packages/engine/src' },
    },
    {
      name: 'packages-no-apps',
      severity: 'warn',
      comment: 'package layout: packages/* never import apps/*',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'main-no-renderer',
      severity: 'warn',
      comment: 'package layout: main may not import the renderer',
      from: { path: '^apps/desktop/src/main/' },
      to: { path: '^apps/desktop/src/renderer/' },
    },
  ],
  options: {
    // Type-only imports are checked too, like the ESLint rule.
    tsPreCompilationDeps: true,
    // Only the repo's own sources are cruised as `from` modules; without this a scoped run
    // still walks everything under the entry points and takes minutes.
    includeOnly: {
      path: '^(apps|packages|scripts|tools|tests)/',
    },
    // npm packages still appear as `to` edges so the forbidden rules can see them, but their
    // own dependency trees are never followed — the difference between seconds and minutes.
    doNotFollow: {
      path: 'node_modules',
    },
    // Node builtins and npm packages stay in the graph so the forbidden rules above can see them;
    // depcruise does not descend into them.
    exclude: {
      path: '(^|/)(dist|release|coverage|\\.stryker-tmp|artifacts|mockups|research)/',
    },
    reporterOptions: {
      dot: { collapsePattern: 'node_modules/[^/]+' },
      text: { highlightFocused: true },
    },
  },
};
