// The frame's base reading style. It comes first, so the mail's own CSS still wins for layout;
// only Aplos's own marks, quotes and image placeholders use classes the mail cannot rely on.

/** The cascade layer of the root and body rules. The sanitizer moves every mail layer name to `m-<name>`. */
export const READING_LAYER = 'aplos-reading';

/** What the root and the body both keep, whatever the mail says: sized by the content, in flow, upright. */
const COMMON = [
  'height:auto',
  'max-height:none',
  'position:static',
  'inset:auto',
  'float:none',
  'writing-mode:horizontal-tb',
  'zoom:1',
  'offset-path:none',
  'contain:none',
  'content-visibility:visible',
  'container-type:normal',
];

function important(declarations: readonly string[]): string {
  return declarations.map(declaration => `${declaration}!important`).join(';');
}

/**
 * The root: a box that is the in-flow content (no margin outside it, containing the body's margins, never
 * transformed), at least 1 px tall, so an empty letter still has a size.
 */
const ROOT_RULE = `html:root{${important([
  ...COMMON,
  'display:flow-root',
  'min-height:1px',
  'margin:0',
  'transform:none',
  'scale:none',
  'rotate:none',
  'translate:none',
])}}`;

/**
 * The body: positioned (`relative`, no offsets), so it is the containing block of absolutely positioned
 * content and its scroll height takes that content in, which the root's box leaves out (reporter.js).
 */
const BODY_RULE = `html:root>body{${important([
  ...COMMON.filter(declaration => declaration !== 'position:static'),
  'position:relative',
  'min-height:0',
  'display:block',
])}}`;

/**
 * A plain email (plain.ts): drawn straight on the reader's card in the app's own type and colours, with no box of its
 * own. The values are the app's tokens (apps/desktop `ui/tokens.json`; tests/plain.test.ts fails if they drift). Light is
 * the paper colour; dark follows the app's theme through `prefers-color-scheme`, which Electron ties to it
 * (`nativeTheme`). The body's padding is the host's to give, so it is none here. Whether a letter is plain is NOT told by
 * these colours: the reporter reports the root's `data-aplos-plain` marker, which only the sanitiser sets.
 */
export const PLAIN_LIGHT = {
  surface: '#ffffff',
  ink: '#1d1e21',
  dim: '#63666c',
  accent: '#0b5394',
} as const;
export const PLAIN_DARK = {
  surface: '#212225',
  ink: '#ececed',
  dim: '#9a9da4',
  accent: '#88aee0',
  rule: '#0e0f10',
} as const;
/** The `read` type role (tokens.json): the app's own message type. */
export const PLAIN_TYPE = {
  family: '-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif',
  size: '15px',
  line: '26px',
  weight: 400,
  tracking: '-0.12px',
} as const;
const PLAIN = 'html[data-aplos-plain]';
const PLAIN_CSS = [
  `${PLAIN} body{padding:0;background:${PLAIN_LIGHT.surface};color:${PLAIN_LIGHT.ink};font:${PLAIN_TYPE.weight} ${PLAIN_TYPE.size}/${PLAIN_TYPE.line} ${PLAIN_TYPE.family};letter-spacing:${PLAIN_TYPE.tracking}}`,
  `${PLAIN} a{color:${PLAIN_LIGHT.accent}}`,
  `@media (prefers-color-scheme:dark){${PLAIN}{color-scheme:dark}`,
  `${PLAIN} body{background:${PLAIN_DARK.surface};color:${PLAIN_DARK.ink}}`,
  `${PLAIN} a{color:${PLAIN_DARK.accent}}`,
  `${PLAIN} blockquote{border-left-color:${PLAIN_DARK.rule};color:${PLAIN_DARK.dim}}`,
  `${PLAIN} details.aplos-quote>summary{color:${PLAIN_DARK.dim}}`,
  `${PLAIN} details.aplos-quote>summary::before{background:${PLAIN_DARK.rule}}}`,
].join('\n');

/**
 * A blocked image keeps its width but never its height: a hero image (an itinerary, a newsletter banner) would otherwise
 * leave a gray slab filling the first screen and push the text below the fold. It sits in the `aplos-reading` layer (see
 * below) so the mail's own `!important` rules cannot undo it, and `min-height` and `padding` are neutralized because
 * `min-height` outranks `max-height`. The placeholder carries no `style` attribute (sanitize.ts `image`), which would
 * outrank the layer.
 */
export const BLOCKED_IMAGE_CAP = 48;
const BLOCKED_IMAGE_RULE = `img.aplos-blocked{max-height:${BLOCKED_IMAGE_CAP}px!important;min-height:0!important;padding:0!important}`;

export const READING_CSS = [
  ':root{color-scheme:light}',
  // The frame is sized to the letter, so the letter must size itself: the root and body keep an auto height,
  // their place in the flow, a horizontal writing mode and no zoom, whatever the mail's CSS says (a root or
  // body positioned or turned sideways is sized by the frame, and the frame by it, 50 px at a time). These
  // rules sit in the layer `aplos-reading`, declared before any mail CSS: for !important declarations the
  // earliest layer wins over every later layer and over unlayered rules, whatever their specificity. It does
  // NOT win over an element's own style attribute (element-attached styles rank before layers), so the frame
  // body's style is cut to an explicit property-name allowlist (body-style.ts) that holds nothing able to size
  // or move the body, and the frame html takes no style at all. The mail cannot join the layer: its @layer
  // names move to `m-` (css.ts). The body is `display:block` so it keeps a box (`display:contents` would
  // leave `position:relative` no containing block). The host's growth fence is still required: css.ts rewrites
  // away the ways measured to follow the frame (height, shape and orientation features in @media and
  // @container, `if()` and its `media()` conditions, `writing-mode` under any prefix, scroll-driven animation
  // timelines), but a layout that follows the frame by some other means is not covered.
  `@layer ${READING_LAYER}{${ROOT_RULE}${BODY_RULE}${BLOCKED_IMAGE_RULE}}`,
  'body{margin:0;padding:16px 20px;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Helvetica,Arial,sans-serif;color:#1f2328;overflow-wrap:break-word;word-break:normal}',
  'img{max-width:100%;height:auto}',
  'pre{white-space:pre-wrap}',
  'a{color:#2557c7}',
  'blockquote{margin:0 0 0 4px;padding-left:12px;border-left:2px solid #d8dbe0;color:#4b5058}',
  'mark.aplos-find{background:#ffe48a;color:inherit;border-radius:2px}',
  'details.aplos-quote{margin:12px 0}',
  'details.aplos-quote>summary{cursor:default;color:#6b7079;font-size:13px;list-style:none;user-select:none}',
  'details.aplos-quote>summary::-webkit-details-marker{display:none}',
  'details.aplos-quote>summary::before{content:"\\2026";display:inline-block;padding:0 8px;margin-right:6px;border-radius:6px;background:#eef0f3}',
  'img.aplos-blocked{background:#f1f2f4;border-radius:4px}',
  PLAIN_CSS,
].join('\n');
