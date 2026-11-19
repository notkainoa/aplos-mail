import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadAccounts,
  preflight,
  reconnectBy,
  saveAccount,
  vaultDir,
  type AccountMeta,
} from '../../../apps/desktop/scripts/live/vault';

const DAY = 86_400_000;
const GRANT = Date.UTC(2026, 9, 27, 16, 0, 0);
const account = (extra: Partial<AccountMeta> = {}): AccountMeta => ({
  provider: 'gmail',
  grantedAt: new Date(GRANT).toISOString(),
  keychainService: 'aplos-mail-live-agent',
  ...extra,
});

test('vault directory comes from APLOS_LIVE_VAULT, with the Application Support folder as the default', () => {
  assert.equal(vaultDir({ APLOS_LIVE_VAULT: '/tmp/somewhere' }), '/tmp/somewhere');
  assert.match(vaultDir({}), /Library\/Application Support\/Aplos Mail Live$/);
});

test('reconnectBy is the earlier of grant + 7 days and the expiry Google reported', () => {
  assert.equal(reconnectBy(account()), GRANT + 7 * DAY);
  assert.equal(
    reconnectBy(account({ refreshExpiresAt: new Date(GRANT + 3 * DAY).toISOString() })),
    GRANT + 3 * DAY,
  );
  assert.equal(
    reconnectBy(account({ refreshExpiresAt: new Date(GRANT + 30 * DAY).toISOString() })),
    GRANT + 7 * DAY,
  );
});

test('preflight: a token that must be reconnected within 24 hours is skipped, however short the run', () => {
  const run = 10 * 60_000;
  const reconnect = GRANT + 7 * DAY;
  const soon = preflight(account(), 'agent', run, reconnect - 23 * 3600_000);
  assert.equal(soon.ok, false);
  assert.match((soon as { message: string }).message, /reconnect it first/);
  assert.equal(preflight(account(), 'agent', run, reconnect - 11 * 60_000).ok, false);
  assert.equal(preflight(account(), 'agent', run, reconnect - DAY - 60_000).ok, true);
});

test('preflight: ok with days left, and a plain skip when the token has expired or expires inside the run', () => {
  const run = 10 * 60_000;
  assert.deepEqual(preflight(account(), 'agent', run, GRANT + 2 * DAY), { ok: true, daysLeft: 5 });
  assert.equal(
    (preflight(account(), 'agent', run, GRANT + 2 * DAY + 12 * 3600_000) as { daysLeft: number })
      .daysLeft,
    4,
  );

  const expired = preflight(account(), 'agent', run, GRANT + 8 * DAY);
  assert.deepEqual(expired, {
    ok: false,
    daysLeft: -1,
    message: 'test account agent expires 2026-11-03, reconnect it first',
  });

  // Expires 5 minutes into a 10 minute run: skip. Expires after the run ends: go.
  assert.equal(preflight(account(), 'agent', run, GRANT + 7 * DAY - 5 * 60_000).ok, false);
  assert.equal(preflight(account(), 'agent', run, GRANT + 7 * DAY - 25 * 3600_000).ok, true);
  // Google's own earlier date wins over the 7-day rule.
  assert.equal(
    preflight(
      account({ refreshExpiresAt: new Date(GRANT + DAY).toISOString() }),
      'agent',
      run,
      GRANT + 2 * DAY,
    ).ok,
    false,
  );
});

test('accounts.json holds metadata only: round trip, and any extra field (such as a token) is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-vault-'));
  assert.deepEqual(await loadAccounts(dir), {});
  await saveAccount(dir, 'agent', account());
  await saveAccount(
    dir,
    'owner',
    account({
      refreshExpiresAt: new Date(GRANT + DAY).toISOString(),
      keychainService: 'aplos-mail-live-owner',
    }),
  );
  const loaded = await loadAccounts(dir);
  assert.deepEqual(Object.keys(loaded).sort(), ['agent', 'owner']);
  assert.equal(loaded.agent!.keychainService, 'aplos-mail-live-agent');

  await assert.rejects(
    saveAccount(dir, 'agent', { ...account(), refreshToken: '1//secret' } as never),
    /metadata only/,
  );
  await assert.rejects(saveAccount(dir, 'someone@example.test', account()), /lowercase names/);
  await writeFile(
    join(dir, 'accounts.json'),
    JSON.stringify({ agent: { ...account(), accessToken: 'ya29.x' } }),
  );
  await assert.rejects(loadAccounts(dir), /metadata only/);
  const text = await readFile(join(dir, 'accounts.json'), 'utf8');
  assert.ok(!text.includes('1//secret'));
});
