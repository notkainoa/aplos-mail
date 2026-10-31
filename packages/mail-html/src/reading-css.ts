// The frame's base reading style. It comes first, so the mail's own CSS still wins for layout;
// only Aplos's own marks, quotes and image placeholders use classes the mail cannot rely on.

export const READING_CSS = [
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
