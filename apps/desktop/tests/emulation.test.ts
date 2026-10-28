import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmulatedSession } from '../scripts/emulation/session';
import { emulatedIdentity } from '../scripts/emulation/providers';
import { startServer } from '../src/main/server';
import type { AppState, Draft } from '@aplos/contract/legacy/types';

test('real application API and provider adapters handle local OAuth, refresh, sync, queue recovery, send and restart', async () => {
  const session = await createEmulatedSession();
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  const invoke = async (method: string, payload: unknown = {}): Promise<any> => {
    const response = await fetch(
      `http://127.0.0.1:${(app!.server.address() as { port: number }).port}/api/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, payload }),
      },
    );
    const result = (await response.json()) as { result?: unknown; error?: string };
    if (result.error) throw new Error(result.error);
    return result.result;
  };
  const until = async (predicate: () => Promise<boolean>) => {
    for (let n = 0; n < 100; n++) {
      if (await predicate()) return;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.fail('Emulated application did not settle');
  };
  try {
    app = await startServer({
      service: await session.createService(),
      loadEnv: false,
      port: 0,
      vite: false,
    });
    await assert.rejects(session.emulator.fetch('https://example.com/mail'), /External network/);
    const invalid = await session.emulator.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: 'emulated-aplos',
        grant_type: 'authorization_code',
        code: 'unissued',
        code_verifier: 'incorrect',
      }),
    });
    assert.equal(invalid.status, 400);
    for (const provider of ['google', 'microsoft'] as const) {
      const identity = emulatedIdentity(provider);
      const connected = (await invoke('account.connect', { provider })) as AppState;
      assert.ok(connected.accounts.some(a => a.id === identity.id));
      await invoke('sync', { accountId: identity.id });
      let state = (await invoke('state.get')) as AppState;
      assert.equal(state.accounts.find(a => a.id === identity.id)?.error, undefined);
      assert.equal(state.threads.filter(t => t.accountId === identity.id).length, 2);
      session.emulator.add(provider, 'arrival', 'A new original delivery after the first sync.');
      await invoke('sync', { accountId: identity.id });
      state = await invoke('state.get');
      assert.ok(state.threads.some(t => t.id === `${identity.id}:arrival`));
      const id = `${identity.id}:studio`;
      session.emulator.failNext(provider, 'POST', provider === 'google' ? '/modify' : '/move');
      await invoke('thread.update', { ids: [id], patch: { status: 'done' } });
      await until(async () => Boolean((await invoke('state.get')).sync.pending));
      assert.equal(
        (await invoke('state.get')).threads.find((t: { id: string }) => t.id === id).status,
        'done',
      );
      await invoke('sync', { accountId: identity.id });
      await until(async () => !(await invoke('state.get')).sync.pending);
      assert.ok(!session.emulator.mail[provider].get('studio')!.labels.includes('INBOX'));
      await invoke('thread.undo');
      await invoke('sync', { accountId: identity.id });
      assert.ok(session.emulator.mail[provider].get('studio')!.labels.includes('INBOX'));
      session.emulator.failNext(
        provider,
        'GET',
        provider === 'google' ? '/history' : '/delta',
        401,
      );
      await invoke('sync', { accountId: identity.id });
      assert.ok(
        (await invoke('state.get')).accounts.find((a: { id: string }) => a.id === identity.id)
          .error,
      );
      await invoke('account.connect', { provider });
      await invoke('sync', { accountId: identity.id });
      assert.equal(
        (await invoke('state.get')).accounts.find((a: { id: string }) => a.id === identity.id)
          .error,
        undefined,
      );
      // Exact-copy cleanup reaches each real adapter's archive operation, even with a read-only Done mapping.
      await invoke('settings.update', { patch: { doneAction: 'read' } });
      session.emulator.add(provider, 'arrival-copy');
      const original = session.emulator.mail[provider].get('arrival')!,
        copy = session.emulator.mail[provider].get('arrival-copy')!;
      copy.subject = original.subject;
      copy.text = original.text;
      copy.date = new Date(Date.parse(original.date) + 1000).toISOString();
      await invoke('sync', { accountId: identity.id });
      await until(async () => !(await invoke('state.get')).sync.pending);
      assert.ok(!session.emulator.mail[provider].get('arrival')!.labels.includes('INBOX'));
      assert.ok(session.emulator.mail[provider].get('arrival-copy')!.labels.includes('INBOX'));
      await invoke('sync', { accountId: identity.id });
      assert.equal(
        (await invoke('state.get')).threads.find(
          (t: { id: string }) => t.id === `${identity.id}:arrival`,
        ).status,
        'done',
      );
      await invoke('settings.update', { patch: { doneAction: 'archive' } });
      await invoke('settings.update', { patch: { undoSeconds: 0 } });
      const draft: Draft = {
        id: `send-${provider}`,
        accountId: identity.id,
        to: 'reader@verification.example',
        cc: '',
        bcc: '',
        subject: `Synthetic ${provider} send`,
        html: '<p>This message stays inside the local emulator.</p>',
        attachments: [],
        mode: 'new',
        signature: false,
        updatedAt: new Date().toISOString(),
        revision: 0,
      };
      await invoke('draft.save', { draft });
      await invoke('draft.send', { id: draft.id });
      await until(
        async () => !(await invoke('state.get')).drafts.some((d: Draft) => d.id === draft.id),
      );
      assert.ok(
        [...session.emulator.mail[provider].values()].some(
          m => m.subject === draft.subject && m.labels.includes('SENT'),
        ),
      );
    }
    assert.equal(session.emulator.stats.pkce, 4);
    assert.ok(session.emulator.stats.refresh >= 4);
    assert.equal(session.emulator.stats.sends, 2);
    await app.close();
    app = undefined;
    const reopened = await session.createService();
    try {
      await reopened.invoke('sync');
      const state = (await reopened.invoke('state.get')) as AppState;
      assert.equal(state.accounts.filter(a => a.connected && a.provider !== 'demo').length, 2);
      assert.ok(!state.accounts.some(a => a.error));
      assert.equal(state.threads.filter(t => t.subject.startsWith('Synthetic ')).length, 2);
    } finally {
      await reopened.close();
    }
  } finally {
    await app?.close();
    await session.close();
  }
});
