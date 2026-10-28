import buttonVariant from './button-variant.mjs';
import hoverNoLayout from './hover-no-layout.mjs';
import noBannedIcon from './no-banned-icon.mjs';
import noBannedString from './no-banned-string.mjs';
import noDecoration from './no-decoration.mjs';
import noLayoutMotion from './no-layout-motion.mjs';
import noLiteralMotion from './no-literal-motion.mjs';
import noLiteralSize from './no-literal-size.mjs';
import noRawColor from './no-raw-color.mjs';
import noStaticWillChange from './no-static-will-change.mjs';
import reducedMotionCovered from './reduced-motion-covered.mjs';

export const rules = [
  noRawColor,
  noDecoration,
  noLiteralMotion,
  noLayoutMotion,
  hoverNoLayout,
  noLiteralSize,
  noStaticWillChange,
  reducedMotionCovered,
  noBannedIcon,
  noBannedString,
  buttonVariant,
];

export function ruleById(id) {
  return rules.find(rule => rule.id === id);
}
