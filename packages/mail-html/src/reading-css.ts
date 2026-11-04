// The frame's base reading style. It comes first, so the mail's own CSS still wins for layout;
// only Aplos's own marks, quotes and image placeholders use classes the mail cannot rely on.

/** The cascade layer of the root and body rules. The sanitizer moves every mail layer name to `m-<name>`. */
export const READING_LAYER = 'aplos-reading';

const SIZING =
  'height:auto!important;min-height:0!important;max-height:none!important;position:static!important;inset:auto!important;writing-mode:horizontal-tb!important';
const ROOT_RULE = `html:root{display:flow-root!important;${SIZING};transform:none!important;scale:none!important;rotate:none!important;translate:none!important;zoom:1!important}`;
const BODY_RULE = `html:root>body{${SIZING};zoom:1!important}`;

export const READING_CSS = [
  ':root{color-scheme:light}',
  // The frame is sized to the letter, so the letter must size itself: the root and body keep an auto height,
  // static position, horizontal writing mode and no transform or zoom, whatever the mail's CSS says (a root or
  // body positioned or turned sideways is sized by the frame, and the frame by it, 50 px at a time). These
  // rules sit in the layer `aplos-reading`, declared before any mail CSS: for !important declarations the
  // earliest layer wins over every later layer, over unlayered rules and over a style attribute, whatever their
  // specificity. The mail cannot join the layer: its @layer names move to `m-` (css.ts). The root also
  // contains the body's margins (flow-root), so they are counted.
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
