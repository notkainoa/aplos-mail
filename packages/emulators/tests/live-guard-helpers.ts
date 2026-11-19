import assert from 'node:assert/strict';
import {
  createGuardedFetch,
  GuardRefusal,
  type GuardReason,
  type GuardedFetch,
} from '../../../apps/desktop/scripts/live/guard';
import type { Tier } from '../../../apps/desktop/scripts/live/types';

/** Shared stand-ins for the guard tests: a fake network, guards pointed at it, and refusals. */

export const SELF = 'self@example.test';
export const OTHER = 'other@example.test';
export const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';
export const CAL = 'https://www.googleapis.com/calendar/v3';

export interface Call {
  url: string;
  method: string;
  redirect?: string;
  body?: unknown;
}

/** A stand-in for the network: records what was really sent and answers with canned JSON. */
export function network(answer: (url: string, method: string) => unknown = () => ({})) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, redirect: init?.redirect, body: init?.body });
    return new Response(JSON.stringify(answer(url, method)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

export function guardFor(tier: Tier, answer?: (url: string, method: string) => unknown) {
  const net = network(answer);
  const guard = createGuardedFetch(net.fetchImpl, {
    tier,
    selfAddress: SELF,
    calendarRunId: 'run-test',
  });
  return { ...net, guard };
}

export async function refusal(
  guard: GuardedFetch,
  url: string,
  init?: RequestInit,
): Promise<GuardRefusal> {
  try {
    await guard(url, init);
  } catch (error) {
    assert.ok(error instanceof GuardRefusal, `expected a GuardRefusal, got ${String(error)}`);
    return error;
  }
  assert.fail(`${init?.method ?? 'GET'} ${url} should have been refused`);
}

export async function assertRefused(
  tier: Tier,
  reason: GuardReason,
  url: string,
  init?: RequestInit,
  answer?: (url: string, method: string) => unknown,
): Promise<void> {
  const { guard, calls } = guardFor(tier, answer);
  const error = await refusal(guard, url, init);
  assert.equal(error.reason, reason, `${init?.method ?? 'GET'} ${url}`);
  assert.equal(calls.length, 0, 'nothing may be sent for a refused request');
}

export const json = (value: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});
export const b64 = (text: string): string => Buffer.from(text, 'latin1').toString('base64url');
export const message = (headers: string[], body = 'Hello'): string =>
  b64(`${headers.join('\r\n')}\r\n\r\n${body}`);
