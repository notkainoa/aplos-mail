// The WHATWG URL parser, with a cheap scheme check first: most junk in mail is not a URL, and a
// thrown parse error costs microseconds, which 50,000 junk strings turn into a hostile slowdown.

/** The parser's own clean-up: leading and trailing C0 controls and spaces go, tabs and newlines anywhere. */
export function urlCleanup(value: string): string {
  const stripped = value.replace(/[\t\n\r]/g, '');
  let start = 0;
  let end = stripped.length;
  while (start < end && stripped.charCodeAt(start) <= 0x20) start++;
  while (end > start && stripped.charCodeAt(end - 1) <= 0x20) end--;
  return stripped.slice(start, end);
}

/** Parses an absolute URL whose scheme matches `scheme`, or returns undefined. */
export function parseUrl(value: string, scheme: RegExp): URL | undefined {
  if (!scheme.test(urlCleanup(value))) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
