import test from 'node:test';
import assert from 'node:assert/strict';
import type { ImapFlow } from 'imapflow';
import { ProviderError } from '@aplos/engine/legacy/provider';
import { imapflowSession } from '../src/main/imap-session';

/** Just enough of imapflow to see which commands the session issues and how it treats false results. */
function fakeFlow(
  capabilities: string[],
  results: { flags?: boolean; move?: false; copy?: false } = {},
) {
  const calls: string[] = [];
  const client = {
    capabilities: new Map(capabilities.map(c => [c, true])),
    enabled: new Set<string>(),
    usable: true,
    mailbox: { path: 'INBOX' },
    on() {},
    async getMailboxLock() {
      return { release() {} };
    },
    async messageFlagsAdd(range: string, flags: string[]) {
      calls.push(`+${flags.join(' ')} ${range}`);
      return results.flags ?? true;
    },
    async messageFlagsRemove(range: string, flags: string[]) {
      calls.push(`-${flags.join(' ')} ${range}`);
      return results.flags ?? true;
    },
    async messageMove(range: string, destination: string) {
      calls.push(`move ${range} ${destination}`);
      return (
        results.move ?? { path: 'INBOX', destination, uidValidity: 7n, uidMap: new Map([[1, 10]]) }
      );
    },
    async messageCopy(range: string, destination: string) {
      calls.push(`copy ${range} ${destination}`);
      return results.copy ?? { path: 'INBOX', destination };
    },
    async messageDelete(range: string) {
      calls.push(`delete ${range}`);
      return true;
    },
  };
  const session = imapflowSession(
    { host: 'imap.example.test', port: 993, secure: true, user: 'u', pass: 'p' },
    () => client as unknown as ImapFlow,
  );
  return { client, calls, session };
}

test("moves never fall back to a plain EXPUNGE that would remove other clients' deleted mail", async () => {
  for (const caps of [['MOVE'], ['UIDPLUS'], ['IMAP4rev2']]) {
    const f = fakeFlow(caps);
    assert.deepEqual(await f.session.move('INBOX', [1], 'Archive'), {
      uidValidity: '7',
      map: new Map([[1, 10]]),
    });
    assert.deepEqual(f.calls, ['move 1 Archive'], `server move used with ${caps}`);
  }
  const bare = fakeFlow(['IMAP4rev1']);
  assert.deepEqual(await bare.session.move('INBOX', [1, 2], 'Archive'), {
    uidValidity: undefined,
    map: undefined,
  });
  await bare.session.remove('Aplos', [3]);
  assert.deepEqual(
    bare.calls,
    ['copy 1,2 Archive', '+\\Deleted 1,2', '+\\Deleted 3'],
    'without MOVE or UIDPLUS the copies are only marked \\Deleted',
  );
  const plus = fakeFlow(['UIDPLUS']);
  await plus.session.remove('Aplos', [3]);
  assert.deepEqual(plus.calls, ['delete 3']);
  const failed = fakeFlow(['IMAP4rev1'], { copy: false });
  await assert.rejects(failed.session.move('INBOX', [1], 'Archive'), ProviderError);
  assert.deepEqual(failed.calls, ['copy 1 Archive'], 'nothing is marked when the copy failed');
});

test('refused flag changes and moves reject instead of reporting success', async () => {
  const refused = fakeFlow(['MOVE'], { flags: false, move: false });
  for (const action of [
    () => refused.session.flags('INBOX', [1], 'add', ['\\Seen']),
    () => refused.session.flags('INBOX', [1], 'remove', ['\\Flagged']),
    () => refused.session.move('INBOX', [1], 'Archive'),
  ])
    await assert.rejects(
      action(),
      (e: unknown) => e instanceof ProviderError && !e.uncertain && /refused/.test(e.message),
    );
  refused.client.usable = false;
  await assert.rejects(
    refused.session.flags('INBOX', [1], 'add', ['\\Seen']),
    (e: unknown) => e instanceof ProviderError && e.uncertain,
    'a dropped connection is uncertain',
  );
  const ok = fakeFlow(['MOVE']);
  await ok.session.flags('INBOX', [1, 2], 'add', ['\\Seen']);
  assert.deepEqual(ok.calls, ['+\\Seen 1,2']);
});
