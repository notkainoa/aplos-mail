// Stylelint over the app CSS (stylelint-config-standard, pinned). Prettier does not format CSS
// here, and stylelint 16+ ships no stylistic rules, so nothing fights Prettier. The rules turned
// off below are the standard config's taste rules that today's compact hand-written CSS breaks.
import { existsSync } from 'node:fs';

// UI-core's DESIGN section 12.2 rules plug in here: tools/lint/design/stylelint.mjs may default-export
// { plugins?: string[], rules?: object } and it is merged on top of this config.
const designUrl = new URL('./tools/lint/design/stylelint.mjs', import.meta.url);
const design = existsSync(designUrl) ? (await import(designUrl.href)).default : {};

export default {
  extends: ['stylelint-config-standard'],
  ignoreFiles: ['**/dist/**', '**/release/**', '**/node_modules/**'],
  plugins: design.plugins ?? [],
  rules: {
    // Taste rules, off. The house style is one rule per line with several declarations on it.
    'declaration-block-single-line-max-declarations': null, // 1132 one-line rules; the house style
    'at-rule-empty-line-before': null, // blank-line taste
    'rule-empty-line-before': null, // blank-line taste
    'comment-empty-line-before': null, // blank-line taste
    'custom-property-empty-line-before': null, // blank-line taste
    'declaration-empty-line-before': null, // blank-line taste
    'alpha-value-notation': null, // .5 versus 50%: same value
    'color-function-notation': null, // rgba(0,0,0,.5) versus rgb(0 0 0 / 50%): same value
    'color-function-alias-notation': null, // rgba() versus rgb(): same value
    'color-hex-length': null, // #ffffff versus #fff: same value
    'selector-attribute-quotes': null, // [type=x] versus [type="x"]: same selector
    'media-feature-range-notation': null, // (min-width: 1px) versus (width >= 1px): same query
    'keyframe-selector-notation': null, // from/to versus 0%/100%: same keyframe
    'length-zero-no-unit': null, // 0px versus 0: same value
    'value-keyword-case': null, // currentColor, BlinkMacSystemFont: same keyword, camel case is idiomatic
    'shorthand-property-no-redundant-values': null, // margin: 0 0 versus 0: same value
    'declaration-block-no-redundant-longhand-properties': null, // top/left/right/bottom versus inset: same effect
    'property-no-vendor-prefix': null, // -webkit-backdrop-filter, -webkit-user-select, -webkit-mask-*: needed for Safari on the website

    // Correctness-flavoured rules stay on as errors. Today's violations (no-descending-specificity,
    // no-duplicate-selectors, keyframe-block-no-duplicate-selectors) are recorded in
    // stylelint-suppressions.json (npm run lint:css:baseline), so only new ones fail.

    ...design.rules,
  },
};
