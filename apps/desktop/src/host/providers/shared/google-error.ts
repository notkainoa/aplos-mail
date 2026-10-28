/**
 * Parses a Google API error body into stable facts. This is the base shared by Gmail and Calendar;
 * the mapping from reasons to error classes lives with each adapter, because the same reason can mean
 * different things per API (Calendar `quotaExceeded` is anti-abuse, Gmail's is a daily quota).
 *
 * Handles the Gmail/Calendar v1 envelope, the 429 RESOURCE_EXHAUSTED form whose reason hides in a
 * `google.rpc.ErrorInfo` detail, OAuth token endpoint errors, non-JSON bodies and empty bodies.
 * Returns data only; it never logs.
 */
export interface GoogleErrorInfo {
  status: number;
  /** Google's own code, verbatim. 'unknown' when the body names none (empty or non-JSON). */
  reason: string;
  domain?: string;
  /** google.rpc status such as RESOURCE_EXHAUSTED or PERMISSION_DENIED. */
  rpcStatus?: string;
  /** Whitespace-collapsed, at most 300 characters. Diagnostics only, never shown in the UI. */
  message: string;
  /** OAuth `error_description`, collapsed and truncated like `message`. */
  oauthDescription?: string;
}

export const MAX_MESSAGE_LENGTH = 300;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function tidy(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_MESSAGE_LENGTH) return collapsed;
  let cut = collapsed.slice(0, MAX_MESSAGE_LENGTH);
  // Do not leave half of a surrogate pair at the end.
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** OAuth token endpoint: {"error": "invalid_grant", "error_description": "..."} */
function oauthError(status: number, code: string, root: Json): GoogleErrorInfo {
  const description = str(root.error_description);
  return {
    status,
    reason: code || 'unknown',
    message: tidy(description ?? code),
    ...(description ? { oauthDescription: tidy(description) } : {}),
  };
}

/** The `google.rpc.ErrorInfo` detail, else the first detail that names a reason. */
function errorInfoDetail(error: Json): Json | undefined {
  if (!Array.isArray(error.details)) return undefined;
  return (
    error.details.find(
      (d): d is Json =>
        isObject(d) &&
        typeof d['@type'] === 'string' &&
        d['@type'].endsWith('google.rpc.ErrorInfo'),
    ) ?? error.details.find((d): d is Json => isObject(d) && typeof d.reason === 'string')
  );
}

export function parseGoogleError(status: number, bodyText: string): GoogleErrorInfo {
  const body = parseJson(bodyText);
  const root = isObject(body) ? body : undefined;
  if (!root) return { status, reason: 'unknown', message: tidy(bodyText ?? '') };

  if (typeof root.error === 'string') return oauthError(status, root.error, root);

  const error = isObject(root.error) ? root.error : undefined;
  if (!error) return { status, reason: 'unknown', message: tidy(bodyText) };

  const first =
    Array.isArray(error.errors) && isObject(error.errors[0]) ? error.errors[0] : undefined;
  const info = errorInfoDetail(error);

  const rpcStatus = str(error.status);
  const domain = str(first?.domain) ?? str(info?.domain);
  return {
    status,
    reason: str(first?.reason) ?? str(info?.reason) ?? rpcStatus ?? 'unknown',
    ...(domain ? { domain } : {}),
    ...(rpcStatus ? { rpcStatus } : {}),
    message: tidy(str(error.message) ?? str(first?.message) ?? ''),
  };
}
