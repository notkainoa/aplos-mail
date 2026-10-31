// Element ids and anchor names are moved into the mail's own namespace, `m-<id>`. A name with a
// hyphen cannot be a JavaScript identifier, so `<a id="addEventListener">` or `<img id="token">`
// can no longer shadow a global the frame's one script reads (DOM clobbering). Fragment links,
// `headers`, the ARIA id references and `#id` selectors in the mail's CSS are moved the same way,
// so in-mail anchors and id-styled layouts keep working. Already-moved names are left alone, which
// keeps the sanitizer idempotent.

export const ID_PREFIX = 'm-';

/** Attributes whose value is a space-separated list of ids. */
export const ID_LIST_ATTRIBUTES = new Set([
  'headers',
  'aria-activedescendant',
  'aria-controls',
  'aria-describedby',
  'aria-details',
  'aria-errormessage',
  'aria-flowto',
  'aria-labelledby',
  'aria-owns',
]);

export function scopeId(id: string): string {
  return id.startsWith(ID_PREFIX) ? id : ID_PREFIX + id;
}

export function scopeIdList(value: string): string {
  return value
    .split(/[\t\n\f\r ]+/)
    .filter(Boolean)
    .map(scopeId)
    .join(' ');
}

/** Aplos's own class names (find marks, quote wrappers, placeholders, the clipped note). */
export function isOwnClass(name: string): boolean {
  return name.slice(0, 6).toLowerCase() === 'aplos-';
}

const OWN_NAME = /(^|[\t\n\f\r ])(aplos-)/gi;

/**
 * `value` with every `aplos-` name (at its start or after whitespace) moved to `m-aplos-`, and
 * nothing else changed: whitespace stays as written. Markup class lists and `[class=…]` selector
 * values both go through this, so `=`, `^=` and `$=` compare exactly what they compared before.
 */
export function moveOwnNames(value: string): string {
  return value.replace(OWN_NAME, `$1${ID_PREFIX}$2`);
}

/**
 * A mail's `class` value with any `aplos-` name moved to `m-aplos-`, so neither its markup nor its
 * CSS can pose as, or hide, what Aplos adds. Case-insensitive, as quirks-mode class matching is.
 */
export function scopeClassList(value: string): string {
  return moveOwnNames(value);
}

/** `#x` to `#m-x`; a bare `#` stays (it scrolls to the top). */
export function scopeFragment(fragment: string): string {
  return fragment.length > 1 ? `#${scopeId(fragment.slice(1))}` : fragment;
}
