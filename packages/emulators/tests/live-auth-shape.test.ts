/**
 * Tier R probe `gmail.auth-results-shape` (apps/desktop/scripts/live/probes/gmail-auth-results.ts): structure counts of
 * Authentication-Results headers through the real runner against the emulator. The report holds numbers only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGmailEmulator, FakeClock, type GmailEmulator } from '../src/index';
import { runLive, type RunDeps } from '../../../apps/desktop/scripts/live/run';
import { signIn } from '../../../apps/desktop/scripts/live/signin';
import { PROBES } from '../../../apps/desktop/scripts/live/probes';
import { COUNT_KEYS } from '../../../apps/desktop/scripts/live/evidence';
import {
  addMessageShape,
  AUTH_SHAPE_KEYS,
  emptyShape,
} from '../../../apps/desktop/scripts/live/probes/gmail-auth-results';

const CLIENT = { clientId: 'live-client', clientSecret: 'live-secret' };
const h = (name: string, value: string) => ({ name, value });

const GOOD =
  'mx.google.com; dkim=pass header.i=@news.example.test header.s=sel header.b=AbCdEfGh; ' +
  'arc=pass (i=1 spf=pass spfdomain=news.example.test dkim=pass dkdomain=news.example.test dmarc=pass fromdomain=news.example.test); ' +
  'spf=pass (google.com: domain of bounce@news.example.test designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@news.example.test; ' +
  'dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=news.example.test';
const SIGNATURE =
  'v=1; a=rsa-sha256; d=news.example.test; s=sel; h=from:list-unsubscribe:list-unsubscribe-post; bh=x; b=AbCdEfGhIjKlMnOp';

const listMail = (authResults: string | undefined) => [
  ...(authResults ? [h('Authentication-Results', authResults)] : []),
  h('DKIM-Signature', SIGNATURE),
  h('From', 'News <news@news.example.test>'),
  h('List-Unsubscribe', '<https://news.example.test/u/1>'),
  h('List-Unsubscribe-Post', 'List-Unsubscribe=One-Click'),
];

test('shape: Google-style header is in the expected order, parsed and authenticated', () => {
  const shape = emptyShape();
  addMessageShape(listMail(GOOD), shape);
  assert.equal(shape.messagesSampled, 1);
  assert.equal(shape.withAuthResults, 1);
  assert.equal(shape.googleParsed, 1);
  assert.equal(shape.shapeExpected, 1);
  assert.equal(shape.arcBeforeDkim, 0);
  assert.equal(shape.headerBMin, 8);
  assert.equal(shape.headerBMax, 8);
  assert.equal(shape.headerBNotEight, 0);
  assert.equal(shape.dkimResultsMax, 1);
  assert.equal(shape.withQuote, 0);
  assert.equal(shape.withNestedParens, 0);
  assert.equal(shape.commentsMax, 3);
  assert.equal(shape.authTrue, 1);
  assert.equal(shape.authFalse, 0);
});

test('shape: arc first, a quoted value, nested parentheses and two dkim results are each counted', () => {
  const arcFirst = emptyShape();
  addMessageShape(
    listMail(
      'mx.google.com; arc=pass (i=1); dkim=pass header.d=news.example.test header.b=AbCdEfGh',
    ),
    arcFirst,
  );
  assert.equal(arcFirst.arcBeforeDkim, 1);
  assert.equal(arcFirst.shapeUnexpected, 1);
  assert.equal(
    arcFirst.notGoogleOrMalformed,
    1,
    'the strict parser refuses a dkim result after arc',
  );
  assert.equal(arcFirst.googleParsed, 0);
  assert.equal(arcFirst.authFalse, 1);
  assert.equal(arcFirst.falseNotGoogle, 1);

  const broken = emptyShape();
  addMessageShape(
    listMail('mx.google.com; spf=pass (unterminated smtp.mailfrom=x.example.test'),
    broken,
  );
  assert.equal(broken.notTokenizable, 1);

  const quoted = emptyShape();
  addMessageShape(
    listMail('mx.google.com; dkim=pass header.d=x.example.test header.b="AbCdEfGh"'),
    quoted,
  );
  assert.equal(quoted.withQuote, 1);

  const nested = emptyShape();
  addMessageShape(
    listMail('mx.google.com; spf=pass (a (b) c) smtp.mailfrom=x.example.test'),
    nested,
  );
  assert.equal(nested.withNestedParens, 1);

  const two = emptyShape();
  addMessageShape(
    listMail(
      'mx.google.com; dkim=pass header.d=a.example.test header.b=AbCdEfGh; dkim=fail header.d=b.example.test header.b=ZyXwVuTsRq',
    ),
    two,
  );
  assert.equal(two.severalDkimResults, 1);
  assert.equal(two.dkimResultsMax, 2);
  assert.equal(two.headerBNotEight, 1);
  assert.equal(two.headerBMax, 10);
});

test('shape: missing header, not Google, no List-Unsubscribe and an unpaired one-click are told apart', () => {
  const none = emptyShape();
  addMessageShape(listMail(undefined), none);
  assert.equal(none.withoutAuthResults, 1);
  assert.equal(none.authUnknown, 1);

  const other = emptyShape();
  addMessageShape(
    listMail('mx.other.example.test; dkim=pass header.d=news.example.test header.b=AbCdEfGh'),
    other,
  );
  assert.equal(other.notGoogleOrMalformed, 1);
  assert.equal(other.foreignAuthservId, 1);
  assert.equal(
    other.shapeExpected + other.shapeUnexpected,
    0,
    'no order is read from a foreign header',
  );
  assert.equal(other.falseNotGoogle, 1);

  const plain = emptyShape();
  addMessageShape([h('Authentication-Results', GOOD), h('From', 'a <a@x.example.test>')], plain);
  assert.equal(plain.authNotJudged, 1);
  assert.equal(plain.authTrue + plain.authFalse + plain.authUnknown, 0);

  const noPost = emptyShape();
  addMessageShape(
    listMail(GOOD).filter(x => x.name !== 'List-Unsubscribe-Post'),
    noPost,
  );
  assert.equal(noPost.authFalse, 1);
  assert.equal(noPost.falseNoListPair, 1);
  assert.equal(noPost.withListUnsubscribePost, 0);

  const several = emptyShape();
  addMessageShape(
    [...listMail(GOOD), h('Authentication-Results', 'mx.other.example.test; spf=pass')],
    several,
  );
  assert.equal(several.severalAuthResults, 1);
});

test('every count the probe reports is on the evidence allowlist', () => {
  for (const key of AUTH_SHAPE_KEYS) assert.ok(COUNT_KEYS.includes(key), key);
});

async function runProbe(): Promise<{
  text: string;
  counts: Record<string, number>;
  written: string[];
}> {
  const clock = new FakeClock();
  const emu: GmailEmulator = createGmailEmulator({ clock, latencyMs: 0 });
  emu.oauth.addClient(CLIENT.clientId, CLIENT.clientSecret);
  for (let i = 0; i < 3; i++)
    emu.mailbox.addMessage({
      from: 'News <news@news.example.test>',
      to: ['agent@example.test'],
      subject: `Secret subject ${i}`,
      text: 'Secret body text',
      labelIds: ['INBOX'],
      headers: {
        'Authentication-Results': i === 2 ? 'mx.other.example.test; spf=pass' : GOOD,
        'DKIM-Signature': SIGNATURE,
        'List-Unsubscribe': '<https://news.example.test/u/1>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
  const vault = await mkdtemp(join(tmpdir(), 'aplos-live-vault-'));
  const evidence = await mkdtemp(join(tmpdir(), 'aplos-live-evidence-'));
  const secrets = new Map<string, string>();
  const readSecret = async (service: string) => secrets.get(service)!;
  await signIn(
    { label: 'agent', client: CLIENT },
    {
      fetch: emu.fetch,
      opener: async url => {
        await fetch(new URL(emu.oauth.authorize(url)));
      },
      readSecret,
      writeSecret: async (service, value) => void secrets.set(service, value),
      now: () => clock.now(),
      vaultDir: vault,
      timeoutMs: 5000,
    },
  );
  const deps: RunDeps = {
    env: {
      APLOS_LIVE_VAULT: vault,
      APLOS_GOOGLE_CLIENT_ID: CLIENT.clientId,
      APLOS_GOOGLE_CLIENT_SECRET: CLIENT.clientSecret,
    },
    fetch: emu.fetch,
    readSecret,
    now: () => clock.now(),
    sleep: ms => clock.advance(ms),
    log: () => undefined,
    evidenceDir: evidence,
    probes: PROBES.filter(p => p.id === 'gmail.auth-results-shape'),
  };
  const before = emu.log.length;
  const outcome = await runLive(
    { provider: 'gmail', tier: 'R', account: 'agent', dryRun: false, confirmMutating: false },
    deps,
  );
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.results));
  return {
    text: await readFile(outcome.evidencePath!, 'utf8'),
    counts: outcome.results[0]!.counts,
    written: emu.log
      .slice(before)
      .filter(e => e.httpMethod !== 'GET')
      .map(e => e.apiMethod),
  };
}

test('run: the real runner reports counts only, reads only, and the evidence has no content', async () => {
  const { text, counts, written } = await runProbe();
  assert.equal(counts.messagesSampled, 3);
  assert.equal(counts.withAuthResults, 3);
  assert.equal(counts.googleParsed, 2);
  assert.equal(counts.notGoogleOrMalformed, 1);
  assert.equal(counts.authTrue, 2);
  assert.equal(counts.authFalse, 1);
  assert.deepEqual(written, ['oauth.token'], 'the token refresh is the only non-GET');
  assert.match(text, /### gmail\.auth-results-shape: pass/);
  assert.match(text, /messagesSampled=3/);
  assert.ok(
    !/[@]|Secret|example\.test|mx\.google|AbCdEf/.test(text),
    'no address, subject, body or header text',
  );
});
