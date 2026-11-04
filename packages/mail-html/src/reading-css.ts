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
])}}`;

export const READING_CSS = [
  ':root{color-scheme:light}',
  // The frame is sized to the letter, so the letter must size itself: the root and body keep an auto height,
  // their place in the flow, a horizontal writing mode and no zoom, whatever the mail's CSS says (a root or
  // body positioned or turned sideways is sized by the frame, and the frame by it, 50 px at a time). These
  // rules sit in the layer `aplos-reading`, declared before any mail CSS: for !important declarations the
  // earliest layer wins over every later layer and over unlayered rules, whatever their specificity. It does
  // NOT win over an element's own style attribute (element-attached styles rank before layers), so the frame
  // body's style is cut to an explicit property-name allowlist (body-style.ts) that holds nothing able to size
  // or move the body, and the frame html takes no style at all. The mail cannot
  // join the layer: its @layer names move to `m-` (css.ts). Not covered, the host's growth fence is required:
  // content in an orthogonal writing mode or a height-dependent media query is rewritten away (css.ts), but a
  // layout that follows the frame by other means (percentage chains with intrinsic sizes, say) is not.
  `@layer ${READING_LAYER}{${ROOT_RULE}${BODY_RULE}}`,
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
].join('\n');
