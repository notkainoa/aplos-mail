import test from 'node:test';
import assert from 'node:assert/strict';
import type { BoundGovernor, Clock } from '@aplos/engine/ports';
import { FakeClock } from '@aplos/emulators';
import { createHttpClient } from '../../src/host/providers/shared/http';
import {
  googleAuthUrl,
  googleRevokeUrl,
  revokeGrant,
  runAuthorization,
  type FlowContext,
  type FlowDeps,
} from '../../src/host/providers/oauth/flow';
import { googleTokenUrl } from '../../src/host/providers/oauth/token-source';

// The sign-in endpoints are fixed: no dependency, setting or variable may send a code, verifier, token or client
// secret to another host. Tests reroute at the transport only.

const passThrough: BoundGovernor = {
  run: (req, fn) => fn({ signal: req.signal ?? new AbortController().signal }),
  observe() {},
  charge() {},
  batchSize: () => 1,
};

function context(clock: FakeClock): FlowContext {
  const port: Clock = {
    now: () => clock.now(),
    sleep: (ms, signal) => clock.sleep(ms, signal),
    timer: () => assert.fail('the sign-in flow arms no timer'),
  };
  return { governor: passThrough, clock: port, signal: new AbortController().signal };
}

/** Answers the consent page by calling the loopback with a code and the state it was given. */
async function approve(url: string, opened: URL[]): Promise<void> {
  const consent = new URL(url);
  opened.push(consent);
  const callback = new URL(consent.searchParams.get('redirect_uri')!);
  callback.searchParams.set('code', '4/endpoint-test-code');
  callback.searchParams.set('state', consent.searchParams.get('state')!);
  await (await fetch(callback)).text();
}

test('consent, code exchange and revoke always use Google’s endpoints, whatever the deps say', async () => {
  const clock = new FakeClock({ auto: false });
  const urls: string[] = [];
  const opened: URL[] = [];
  const transport = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ access_token: 'ya29.endpoint', expires_in: 3599 }));
  }) as typeof fetch;
  const deps = {
    http: createHttpClient({ fetch: transport, clock, userAgent: 'aplos-test' }),
    openExternal: (url: string) => approve(url, opened),
    authUrl: 'https://consent.attacker.example/auth',
    tokenUrl: 'https://token.attacker.example/token',
    revokeUrl: 'https://revoke.attacker.example/revoke',
  } as FlowDeps;
  const request = { client: { clientId: 'client-a', clientSecret: 's' }, scopes: [], params: {} };
  await runAuthorization(deps, request, context(clock));
  await revokeGrant(deps, context(clock), '1//endpoint-refresh');
  assert.equal(opened[0].origin + opened[0].pathname, googleAuthUrl);
  assert.deepEqual(urls, [googleTokenUrl, googleRevokeUrl]);
});
