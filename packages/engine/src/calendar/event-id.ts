/**
 * The remote id of an event a create makes, derived from the account and the caller's op id. The same create sent twice
 * names the SAME event, so a request whose answer was lost meets "already exists" at the provider instead of making a
 * second event. One helper for every create path (`Event/set` and a confirmed plan), so they cannot disagree.
 * 26 characters of base32hex (a-v, 0-9): the alphabet Google accepts for a client-chosen id, and safe elsewhere.
 */
const ALPHABET = '0123456789abcdefghijklmnopqrstuv';

export async function eventIdForOp(accountId: string, opId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`aplos-event:${accountId}:${opId}`);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const byte of digest) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}
