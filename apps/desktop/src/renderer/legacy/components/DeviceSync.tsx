import { useEffect, useState } from 'react';
import { invoke } from '../bridge';
import { Badge, Button, GroupRow, Notice, confirmAction } from '../ui';

interface Status {
  enabled: boolean;
  available: boolean;
  error?: string;
}

/** Turn on sharing of Done, Later, todos and reminders between this device and others, protected by a sync code. */
export function DeviceSync({ notify }: { notify: (text: string) => void }) {
  const [status, setStatus] = useState<Status>();
  const [code, setCode] = useState('');
  const [entry, setEntry] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    void invoke<Status>('workflow.status')
      .then(setStatus)
      .catch(e => setError((e as Error).message));
  }, []);
  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  const enable = (typed?: string) =>
    run('enable', async () => {
      const result = await invoke<{ code: string }>(
        'workflow.enable',
        typed === undefined ? {} : { code: typed },
      );
      setCode(result.code);
      setEntry(null);
      setStatus(s => ({ ...s!, enabled: true }));
      notify('Device sync is on');
    });
  if (!status) return error ? <Notice>{error}</Notice> : null;
  if (!status.available)
    return (
      <p className="group-note">
        Syncing between devices is available in the Aplos Mail desktop app.
      </p>
    );
  return (
    <>
      {error && <Notice>{error}</Notice>}
      {status.error && <Notice>{status.error}</Notice>}
      <GroupRow
        label="Done, Later and todos"
        description={
          status.enabled
            ? 'Shared with your other devices through a hidden “Aplos” folder in each account, encrypted with your sync code.'
            : 'Keep triage, todos, due dates and reminders the same on every device. Your mail provider only stores encrypted data.'
        }
      >
        {status.enabled ? (
          <Badge tone="green">On</Badge>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'enable' && entry === null}
            onClick={() => void enable()}
          >
            Turn on
          </Button>
        )}
      </GroupRow>
      {!status.enabled && (
        <GroupRow
          label="Already using Aplos elsewhere?"
          description="Enter the sync code shown on your other device."
        >
          {entry === null ? (
            <Button variant="secondary" size="sm" onClick={() => setEntry('')}>
              Enter code
            </Button>
          ) : (
            <form
              className="sync-code-entry"
              onSubmit={e => {
                e.preventDefault();
                if (entry.trim()) void enable(entry);
              }}
            >
              <input
                aria-label="Sync code"
                value={entry}
                placeholder="XXXX-XXXX-XXXX-…"
                spellCheck={false}
                autoCapitalize="characters"
                autoComplete="off"
                onChange={e => setEntry(e.target.value)}
              />
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                loading={busy === 'enable'}
                disabled={!entry.trim()}
              >
                Connect
              </Button>
            </form>
          )}
        </GroupRow>
      )}
      {status.enabled && (
        <GroupRow
          label="Sync code"
          description="Enter this code on your other devices. Keep it private; anyone with it and access to your mailbox can read your workflow data."
        >
          {code ? (
            <code className="sync-code" aria-label="Sync code">
              {code}
            </code>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              loading={busy === 'code'}
              onClick={() =>
                void run('code', async () => {
                  setCode((await invoke<{ code: string }>('workflow.code')).code);
                })
              }
            >
              Show code
            </Button>
          )}
        </GroupRow>
      )}
      {status.enabled && (
        <GroupRow
          label="Stop syncing"
          description="This device stops sharing. What is already synced stays in your accounts."
        >
          <Button
            variant="text"
            size="sm"
            className="danger"
            loading={busy === 'disable'}
            onClick={async () => {
              if (
                await confirmAction({
                  title: 'Stop syncing this device?',
                  message:
                    'Done, Later and todos on this device will no longer follow your other devices. You can turn it on again with your sync code.',
                  confirmLabel: 'Stop syncing',
                  danger: true,
                })
              )
                void run('disable', async () => {
                  await invoke('workflow.disable');
                  setCode('');
                  setStatus(s => ({ ...s!, enabled: false }));
                });
            }}
          >
            Stop syncing
          </Button>
        </GroupRow>
      )}
    </>
  );
}
