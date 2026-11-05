/**
 * The reason code a failed call carries (`copy.ts`'s copy key). A `ContractError` keeps it on the body
 * (`error.body.reasonCode`, packages/contract `ErrorBody`); the plain `{reasonCode}` objects ports and tests
 * throw are read too. Only a non-empty string counts.
 */
export function reasonOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const body = (error as { body?: unknown }).body;
  if (body && typeof body === 'object') {
    const code = (body as { reasonCode?: unknown }).reasonCode;
    if (typeof code === 'string' && code) return code;
  }
  const code = (error as { reasonCode?: unknown }).reasonCode;
  return typeof code === 'string' && code ? code : undefined;
}
