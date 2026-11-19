// PKCE (RFC 7636, S256) and the `state` value for the installed-app sign-in. Randomness is injectable so tests can
// check what was asked for; the default is Node's CSPRNG.

import { createHash, randomBytes } from 'node:crypto';

export type RandomSource = (size: number) => Uint8Array;

/** 64 bytes give an 86-character verifier, inside RFC 7636's 43 to 128. */
export const verifierBytes = 64;
export const stateBytes = 32;

export const nodeRandom: RandomSource = size => randomBytes(size);

export interface Pkce {
  verifier: string;
  challenge: string;
  method: 'S256';
}

function take(random: RandomSource, size: number): string {
  const bytes = random(size);
  if (bytes.length < size) throw new Error('The random source returned too few bytes.');
  return Buffer.from(bytes).toString('base64url');
}

export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function createPkce(random: RandomSource = nodeRandom): Pkce {
  const verifier = take(random, verifierBytes);
  return { verifier, challenge: challengeFor(verifier), method: 'S256' };
}

export function createState(random: RandomSource = nodeRandom): string {
  return take(random, stateBytes);
}
