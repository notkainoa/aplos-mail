import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Mail } from '../icons';
import type { Capabilities } from '@aplos/contract/legacy/types';
import type { AccountPreset, ProviderKind, ServerSettings } from '@aplos/engine/legacy/provider';
import type { Discovery } from '@aplos/engine/legacy/discover';
import { invoke, openUrl } from '../bridge';
import { Button, Dialog, DialogHeader, Field, Notice, Select, Switch } from '../ui';

type Choice = { preset: AccountPreset; provider: ProviderKind; label: string };
const choices: Choice[] = [
  { preset: 'gmail', provider: 'google', label: 'Google' },
  { preset: 'outlook', provider: 'microsoft', label: 'Outlook' },
  { preset: 'icloud', provider: 'imap', label: 'iCloud' },
  { preset: 'fastmail', provider: 'jmap', label: 'Fastmail' },
  { preset: 'yahoo', provider: 'imap', label: 'Yahoo' },
  { preset: 'aol', provider: 'imap', label: 'AOL' },
  { preset: 'generic', provider: 'imap', label: 'Other' },
];
/** What each host asks for, and where the user gets it. */
const credential: Partial<
  Record<AccountPreset, { label: string; help: string; url?: string; link?: string }>
> = {
  icloud: {
    label: 'App-specific password',
    help: 'iCloud Mail needs an app-specific password, not your Apple Account password. Create one under Sign-In and Security → App-Specific Passwords.',
    url: 'https://account.apple.com/account/manage',
    link: 'Create an app-specific password',
  },
  yahoo: {
    label: 'App password',
    help: 'Yahoo needs an app password. Create one in your Yahoo account’s security settings.',
    url: 'https://login.yahoo.com/account/security',
    link: 'Open Yahoo account security',
  },
  aol: {
    label: 'App password',
    help: 'AOL needs an app password. Create one in your AOL account’s security settings.',
    url: 'https://login.aol.com/account/security',
    link: 'Open AOL account security',
  },
  fastmail: {
    label: 'API token',
    help: 'Create an API token in Fastmail under Settings → Privacy & Security → Connected apps & API tokens. Choose JMAP access to Email and Email submission.',
    url: 'https://app.fastmail.com/settings/security',
    link: 'Open Fastmail API tokens',
  },
  generic: {
    label: 'Password',
    help: 'Use the password or app password your provider gives to mail apps. Aplos connects over TLS and keeps it in your macOS keychain.',
  },
};
const blankServer: ServerSettings = {
  imap: { host: '', port: 993, secure: true },
  smtp: { host: '', port: 465, secure: true },
};

export function AddAccountDialog({
  open,
  close,
  capabilities,
  connected,
}: {
  open: boolean;
  close: () => void;
  capabilities: Capabilities;
  connected: () => void;
}) {
  const [step, setStep] = useState<'start' | 'details'>('start');
  const [email, setEmail] = useState('');
  const [secret, setSecret] = useState('');
  const [name, setName] = useState('');
  const [choice, setChoice] = useState<Choice>();
  const [server, setServer] = useState<ServerSettings>(blankServer);
  const [discovery, setDiscovery] = useState<Discovery>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) return;
    setStep('start');
    setSecret('');
    setError('');
    setBusy('');
    setDiscovery(undefined);
    setChoice(undefined);
  }, [open]);
  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  function pick(next: Choice, found?: Discovery) {
    setChoice(next);
    setDiscovery(found);
    setServer(found?.server ?? blankServer);
    setStep('details');
    setError('');
  }
  const discover = () =>
    run('discover', async () => {
      const found = await invoke<Discovery>('account.discover', { email: email.trim() });
      if (found.unsupported) throw new Error(found.unsupported);
      pick(
        choices.find(c => c.preset === found.preset && c.provider === found.provider) ?? {
          preset: found.preset,
          provider: found.provider,
          label: found.preset,
        },
        found,
      );
    });
  const oauth = choice && (choice.provider === 'google' || choice.provider === 'microsoft');
  const unavailable =
    choice?.provider === 'google'
      ? !capabilities.google
      : choice?.provider === 'microsoft'
        ? !capabilities.microsoft
        : false;
  const connect = () =>
    run('connect', async () => {
      if (!choice) return;
      const request: Record<string, unknown> = { provider: choice.provider, preset: choice.preset };
      if (!oauth) {
        request.email = email.trim();
        request.secret = secret;
        if (name.trim()) request.name = name.trim();
      }
      if (choice.preset === 'generic')
        request.server = {
          ...server,
          caldav: server.caldav && server.caldav !== 'https://' ? server.caldav : undefined,
        };
      if (discovery?.sessionUrl && choice.provider === 'jmap')
        request.sessionUrl = discovery.sessionUrl;
      await invoke('account.connect', request);
      setSecret('');
      connected();
      close();
    });
  const info = choice ? credential[choice.preset] : undefined;
  const endpoint = (key: 'imap' | 'smtp', label: string) => (
    <div className="server-fields">
      <Field label={`${label} server`}>
        <input
          value={server[key].host}
          placeholder={key === 'imap' ? 'imap.example.com' : 'smtp.example.com'}
          spellCheck={false}
          autoCapitalize="off"
          onChange={e =>
            setServer(s => ({ ...s, [key]: { ...s[key], host: e.target.value.trim() } }))
          }
        />
      </Field>
      <Field label="Port">
        <input
          inputMode="numeric"
          value={String(server[key].port)}
          onChange={e =>
            setServer(s => ({
              ...s,
              [key]: { ...s[key], port: Number(e.target.value.replace(/\D/g, '')) || 0 },
            }))
          }
        />
      </Field>
      <Field label="Security">
        <Select
          label={`${label} security`}
          variant="field"
          value={server[key].secure ? 'tls' : 'starttls'}
          options={[
            ['tls', 'TLS'],
            ['starttls', 'STARTTLS'],
          ]}
          onChange={value =>
            setServer(s => ({ ...s, [key]: { ...s[key], secure: value === 'tls' } }))
          }
        />
      </Field>
    </div>
  );
  const ready =
    !!choice &&
    (oauth
      ? !unavailable
      : !!email.trim() &&
        !!secret &&
        (choice.preset !== 'generic' || (!!server.imap.host && !!server.smtp.host)));
  return (
    <Dialog open={open} onClose={close} label="Add an account" className="add-account">
      <DialogHeader
        title={
          step === 'start'
            ? 'Add an account'
            : choice?.label === 'Other'
              ? 'Other mail account'
              : `Connect ${choice?.label}`
        }
        onClose={close}
      />
      {error && <Notice>{error}</Notice>}
      {step === 'start' ? (
        <>
          <form
            className="add-account-email"
            onSubmit={e => {
              e.preventDefault();
              if (email.trim()) void discover();
            }}
          >
            <Field
              label="Email address"
              hint="Aplos finds the right way to connect from your address."
            >
              <input
                type="email"
                data-autofocus
                value={email}
                placeholder="you@example.com"
                autoCapitalize="off"
                spellCheck={false}
                onChange={e => setEmail(e.target.value)}
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              iconRight={ArrowRight}
              loading={busy === 'discover'}
              disabled={!email.trim() || !!busy}
            >
              Continue
            </Button>
          </form>
          <p className="add-account-or">Or choose your provider</p>
          <div className="provider-grid">
            {choices.map(c => (
              <button key={c.preset} className="provider-choice" onClick={() => pick(c)}>
                <Mail size={15} />
                {c.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="add-account-details">
          {discovery && discovery.confidence !== 'known' && (
            <p className="small muted">Found from {discovery.source}.</p>
          )}
          {discovery?.help && discovery.confidence !== 'known' && (
            <p className="small muted">{discovery.help}</p>
          )}
          {oauth ? (
            <>
              <p>
                You’ll sign in with {choice!.provider === 'google' ? 'Google' : 'Microsoft'} in your
                browser, then come back here. Aplos asks only for mail
                {choice!.provider === 'microsoft' ? ', calendar and profile' : ' and calendar'}{' '}
                access.
              </p>
              {unavailable && (
                <p className="configuration-note">
                  {choice!.provider === 'google'
                    ? capabilities.googleUnavailable ||
                      'Google sign-in isn’t available in this build.'
                    : capabilities.microsoftUnavailable ||
                      'Outlook sign-in isn’t available in this build.'}
                </p>
              )}
            </>
          ) : (
            <>
              <Field label="Email address">
                <input
                  type="email"
                  value={email}
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={e => setEmail(e.target.value)}
                />
              </Field>
              {choice?.preset === 'generic' && (
                <Field label="Your name" hint="Shown to people you write to.">
                  <input value={name} onChange={e => setName(e.target.value)} />
                </Field>
              )}
              <Field label={info?.label ?? 'Password'}>
                <input
                  type="password"
                  value={secret}
                  autoComplete="off"
                  onChange={e => setSecret(e.target.value)}
                />
              </Field>
              {info && (
                <p className="small muted">
                  {info.help}
                  {info.url && (
                    <>
                      {' '}
                      <Button
                        variant="text"
                        size="sm"
                        iconRight={ArrowUpRight}
                        onClick={() =>
                          void openUrl(info.url!).catch(e => setError((e as Error).message))
                        }
                      >
                        {info.link}
                      </Button>
                    </>
                  )}
                </p>
              )}
              {choice?.preset === 'generic' && (
                <>
                  {endpoint('imap', 'Incoming (IMAP)')}
                  {endpoint('smtp', 'Outgoing (SMTP)')}
                  <div className="server-username">
                    <Field label="Login name" hint="Leave empty to use your email address.">
                      <input
                        value={server.username ?? ''}
                        autoCapitalize="off"
                        spellCheck={false}
                        onChange={e =>
                          setServer(s => ({ ...s, username: e.target.value.trim() || undefined }))
                        }
                      />
                    </Field>
                  </div>
                  <div className="server-calendar">
                    <span>Calendar (CalDAV)</span>
                    <Switch
                      label="Use a CalDAV calendar"
                      checked={server.caldav !== undefined}
                      onChange={on =>
                        setServer(s => ({
                          ...s,
                          caldav: on ? (s.caldav ?? 'https://') : undefined,
                        }))
                      }
                    />
                  </div>
                  {server.caldav !== undefined && (
                    <Field label="CalDAV address">
                      <input
                        value={server.caldav}
                        spellCheck={false}
                        autoCapitalize="off"
                        onChange={e => setServer(s => ({ ...s, caldav: e.target.value.trim() }))}
                      />
                    </Field>
                  )}
                </>
              )}
            </>
          )}
          <footer>
            <Button
              variant="secondary"
              icon={ArrowLeft}
              disabled={!!busy}
              onClick={() => {
                setStep('start');
                setError('');
              }}
            >
              Back
            </Button>
            <Button
              variant="primary"
              loading={busy === 'connect'}
              disabled={!ready || !!busy}
              onClick={() => void connect()}
            >
              {oauth
                ? `Continue with ${choice!.provider === 'google' ? 'Google' : 'Microsoft'}`
                : 'Connect'}
            </Button>
          </footer>
        </div>
      )}
    </Dialog>
  );
}
