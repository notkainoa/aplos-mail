// The frame's base reading style. It comes first, so the mail's own CSS still wins for layout;
// only Aplos's own marks, quotes and image placeholders use classes the mail cannot rely on.
// The exception is the measuring rules for `<html>` and `<body>`: `!important`, in the document's first cascade
// layer, `aplos`. An important declaration in the first layer outranks every important one in a later layer or in
// none, and the mail can never join this layer (css.ts moves its layer names to `m-<name>`) or style `<html>`
// inline; the `<body>` style attribute loses its `!important`. So no mail rule outranks these. With them the root's
// box is the letter's content height, which the reporter measures, and never the frame's: a letter can shrink again.
// The root never scrolls vertically (the host sizes the frame to the letter); a wide letter still scrolls sideways.

const MEASURED = [
  'display:block',
  'position:static',
  'float:none',
  'height:auto',
  'max-height:none',
  'contain:none',
  'content-visibility:visible',
];

function important(declarations: readonly string[]): string {
  return declarations.map(declaration => `${declaration}!important`).join(';');
}

/** The root's box is what is measured: no margin outside it, no transform scaling it, at least 1 px tall. */
const ROOT_ONLY = [
  'min-height:1px',
  'margin:0',
  'transform:none',
  'scale:none',
  'rotate:none',
  'translate:none',
  'overflow-y:hidden',
];

/** The frame's own first layer. Mail layer names always start `m-`, so this one is never the mail's. */
export const MEASURING_LAYER = 'aplos';

export const READING_CSS = [
  `@layer ${MEASURING_LAYER}{html{${important([...MEASURED, ...ROOT_ONLY])}}body{${important([...MEASURED, 'min-height:0'])}}}`,
  ':root{color-scheme:light}',
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
