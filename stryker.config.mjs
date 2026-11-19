// Shared Stryker options for the mutation scorer (roadmap 5.1c). The scorer
// (scripts/audit/hillclimb/scorers/mutation.mjs) imports this and overlays the per-run mutate
// ranges, test command, timeout and report path. Only @stryker-mutator/core is installed: the
// command test runner and the default mutators are built in, so no test-runner plugin is needed.
const config = {
  testRunner: 'command',
  // The command runner cannot map coverage per test; off is the only supported analysis here.
  coverageAnalysis: 'off',
  plugins: [],
  reporters: ['json'],
  // Every sampled mutant must run to keep the score deterministic; bail-on-cascade would skip
  // the rest once half the mutants died.
  disableBail: true,
  // One sandbox at a time: the repo's DB and fixed-port tests flake when parallel sandboxes
  // collide, and a flaky failure counts as a kill the tests never earned.
  concurrency: 1,
  // The sandbox is a full copy of the checkout; prune the directories that are never inputs so
  // the copy stays small.
  ignorePatterns: [
    'coverage',
    'dist',
    'release',
    'artifacts',
    'mockups',
    'research',
    '.vercel',
    '.env*',
  ],
  symlinkNodeModules: true,
  cleanTempDir: true,
};

export default config;
