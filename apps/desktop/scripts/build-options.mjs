// Bundle options shared by build-main.mjs and the tests that prove what a release bundle contains.
//
// Release builds (APLOS_RELEASE_BUILD=1) minify SYNTAX only. Defining __APLOS_TEST_MODE__ false turns every
// test-only branch into `if (false) ...`; without syntax minification esbuild keeps that dead text, so a release
// bundle would still carry test-only call sites (DECISIONS.md, 2026-10-31: kill points of the outbox harness).
// minifySyntax folds the dead branches away and drops what only they used. It renames nothing and keeps
// whitespace, so stack traces and a reader of dist/main stay as legible as today. Full minification is not used:
// it buys size we do not need and costs legibility of crash reports.
export const releaseBuild = env => env.APLOS_RELEASE_BUILD === '1';

export const syntaxOptions = env => (releaseBuild(env) ? { minifySyntax: true } : {});

// release-build.mjs refuses to package a bundle that was not built for release. It used to look for the text
// `var releaseBuild = true;`, which syntax minification inlines away, so a release bundle now carries this explicit
// banner instead. The banner and the define come from the same build() call (build-main.mjs spreads the options),
// so a bundle with the banner was built with APLOS_RELEASE_BUILD=1.
export const RELEASE_BANNER = '/* aplos-build: release */';

export const bannerOptions = env => (releaseBuild(env) ? { banner: { js: RELEASE_BANNER } } : {});

/** True for a bundle source that build-main.mjs produced for a release build. */
export const isReleaseBundle = source =>
  typeof source === 'string' && source.includes(RELEASE_BANNER);
