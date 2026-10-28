// Property name helpers shared by the value-based rules.

export function toKebab(key) {
  if (key.startsWith('--')) return key;
  const vendor = /^(Webkit|Moz|Ms)(?=[A-Z])/.exec(key);
  const prefix = vendor ? `-${vendor[1].toLowerCase()}-` : '';
  const rest = vendor
    ? key.charAt(vendor[1].length).toLowerCase() + key.slice(vendor[1].length + 1)
    : key;
  return prefix + rest.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
}

export function stripVendor(prop) {
  return prop.replace(/^-(webkit|moz|ms)-/, '');
}

const KNOWN_EXACT = new Set([
  'color',
  'opacity',
  'display',
  'position',
  'width',
  'height',
  'top',
  'left',
  'right',
  'bottom',
  'gap',
  'row-gap',
  'column-gap',
  'grid-gap',
  'cursor',
  'visibility',
  'content',
  'transform',
  'transform-origin',
  'transform-style',
  'backface-visibility',
  'translate',
  'rotate',
  'scale',
  'perspective',
  'perspective-origin',
  'filter',
  'backdrop-filter',
  'box-shadow',
  'text-shadow',
  'z-index',
  'will-change',
  'fill',
  'stroke',
  'caret-color',
  'accent-color',
  'outline',
  'border',
  'background',
  'font',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'flex',
  'inset',
  'overflow',
  'pointer-events',
  'mask',
  'clip-path',
  'aspect-ratio',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'inline-size',
  'block-size',
  'min-inline-size',
  'min-block-size',
  'max-inline-size',
  'max-block-size',
  'transition',
  'animation',
  'padding',
  'margin',
]);

const KNOWN_FAMILIES = [
  'padding-',
  'margin-',
  'border-',
  'outline-',
  'transition-',
  'animation-',
  'background-',
  'font-',
  'flex-',
  'grid-',
  'inset-',
  'text-decoration-',
  'column-rule-',
  'scroll-padding-',
  'scroll-margin-',
  'mask-',
  'overflow-',
];

export function isKnownProp(prop) {
  if (prop.startsWith('--')) return true;
  const bare = stripVendor(prop);
  if (KNOWN_EXACT.has(bare)) return true;
  return KNOWN_FAMILIES.some(family => bare.startsWith(family));
}

export function isCustomProp(prop) {
  return prop.startsWith('--');
}

// Properties that carry a colour. Used for the named-colour check.
const COLOR_SHORTHANDS = new Set([
  'background',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-block',
  'border-inline',
  'border-block-start',
  'border-block-end',
  'border-inline-start',
  'border-inline-end',
  'outline',
  'fill',
  'stroke',
  'box-shadow',
  'text-shadow',
  'text-decoration',
  'column-rule',
]);

export function isColorProp(prop) {
  const bare = stripVendor(prop);
  if (isCustomProp(bare)) return false;
  return bare === 'color' || bare.endsWith('-color') || COLOR_SHORTHANDS.has(bare);
}

export function isTransitionProp(prop) {
  return /^transition(-|$)/.test(stripVendor(prop));
}

export function isAnimationProp(prop) {
  return /^animation(-|$)/.test(stripVendor(prop));
}

export function isMotionProp(prop) {
  return isTransitionProp(prop) || isAnimationProp(prop);
}

// Layout-affecting properties that must never be transitioned or animated.
const LAYOUT_EXACT = new Set([
  'all',
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'inline-size',
  'block-size',
  'min-inline-size',
  'max-inline-size',
  'min-block-size',
  'max-block-size',
  'top',
  'left',
  'right',
  'bottom',
  'flex',
  'flex-basis',
  'flex-grow',
  'flex-shrink',
  'font',
  'font-size',
  'font-weight',
  'letter-spacing',
  'line-height',
  'border-width',
  'gap',
  'row-gap',
  'column-gap',
  'grid-gap',
  'padding',
  'margin',
  'inset',
  'aspect-ratio',
  'display',
  'position',
  'overflow',
]);

export function isLayoutProp(name) {
  const bare = stripVendor(name.toLowerCase());
  if (LAYOUT_EXACT.has(bare)) return true;
  if (/^(padding|margin|inset|grid-template)-/.test(bare)) return true;
  if (/^border(-[a-z]+)*-width$/.test(bare)) return true;
  return false;
}

// The only things a keyframe may animate: compositor properties and colour.
const KEYFRAME_ALLOWED = new Set([
  'transform',
  'translate',
  'rotate',
  'scale',
  'opacity',
  'background-color',
  'color',
  'border-color',
  'fill',
  'stroke',
  'box-shadow',
  'outline-color',
  'animation-timing-function',
  'offset',
  'easing',
  'composite',
]);

export function isKeyframeProp(name) {
  return KEYFRAME_ALLOWED.has(stripVendor(name.toLowerCase()));
}

const SIZE_PROPS = [
  ['spacing', /^(padding|margin)(-[a-z-]+)?$/],
  ['gap', /^(gap|row-gap|column-gap|grid-gap)$/],
  ['fontSize', /^font-size$/],
  ['lineHeight', /^line-height$/],
  ['font', /^font$/],
  ['letterSpacing', /^letter-spacing$/],
  ['radius', /^border(-[a-z]+)*-radius$/],
  ['shadow', /^box-shadow$/],
  ['zIndex', /^z-index$/],
];

export function sizeKind(prop) {
  const bare = stripVendor(prop);
  if (isCustomProp(bare)) return null;
  for (const [kind, pattern] of SIZE_PROPS) {
    if (pattern.test(bare)) return kind;
  }
  return null;
}
