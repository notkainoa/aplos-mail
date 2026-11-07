import type { AiTransport } from '@aplos/engine';
import { createAiHost, type AiHostDeps } from '../../src/host/ai/index';

/**
 * Shared stubbing for the eng-ai transport tests. `stubFetch` records every call and answers through a
 * handler; `sse` builds a `text/event-stream` response from ready-made `data:` payloads. No real network,
 * and no test ever reads `process.env` — every host gets an explicit `env` object.
 */

export interface RecordedCall {
  url: string;
  init: RequestInit;
}

export function stubFetch(respond: (call: RecordedCall) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const stub = (async (input: unknown, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetch: stub, calls };
}

/** One SSE response from `data:` payloads (without the `data:` prefix). */
export function sse(chunks: string[]): Response {
  const text = chunks.map(chunk => `data: ${chunk}\n\n`).join('');
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

export const headers = (call: RecordedCall): Record<string, string> =>
  (call.init.headers ?? {}) as Record<string, string>;

/** The request body as parsed JSON (tests inspect the wire shape loosely). */
export const bodyJson = (call: RecordedCall) => JSON.parse(String(call.init.body));

/** A host wired for tests: stub fetch, explicit env, optional vault and addresses. */
export function testHost(
  stub: typeof fetch,
  env: Record<string, string>,
  extra: Partial<AiHostDeps> = {},
): AiTransport {
  return createAiHost({ fetch: stub, env: env as NodeJS.ProcessEnv, ...extra });
}
