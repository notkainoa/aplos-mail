import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  Download,
  Keyboard,
  Mic,
  Plus,
  RefreshCw,
  ShieldCheck,
} from './icons';
import type {
  AppState,
  Capabilities,
  Settings as Preferences,
  UpdateInfo,
} from '@aplos/contract/legacy/types';
import { invoke, saveFile } from './bridge';
import {
  Avatar,
  Badge,
  Button,
  Group,
  GroupRow,
  Notice,
  Select,
  Switch,
  Tabs,
  Tooltip,
  confirmAction,
  cx,
} from './ui';
import { AddAccountDialog } from './components/AddAccount';
import { DomainCheck } from './components/DomainCheck';
import { DeviceSync } from './components/DeviceSync';
import { AiSettings } from './components/AiSettings';
import { showWelcome } from './components/Welcome';
import { AppIcon } from './components/AppIcon';
import { askModelLabel } from '@aplos/contract/legacy/ask';

const categories = [
  'General',
  'Mail',
  'Calendar',
  'AI',
  'Notifications',
  'Accounts',
  'Help & about',
] as const;
export type SettingsCategory = (typeof categories)[number];
type Category = SettingsCategory;
const mailboxActions: [string, string][] = [
  ['archive', 'Archive'],
  ['read', 'Keep in inbox (read)'],
  ['unread', 'Keep in inbox (unread)'],
];
const tabKey = 'aplos.settingsTab',
  leftKey = 'aplos.settingsLeftAt';
// Coming back within a few minutes resumes the same tab; after that Settings starts fresh on General.
const resumeMs = 5 * 60_000;
function storedTab(): Category {
  const value = localStorage.getItem(tabKey);
  const left = Number(localStorage.getItem(leftKey));
  if (left && Date.now() - left > resumeMs) return 'General';
  return (categories as readonly string[]).includes(value ?? '') ? (value as Category) : 'General';
}
function markLeft() {
  localStorage.setItem(leftKey, String(Date.now()));
}
/** Choose which settings category opens next (or switch it now if Settings is showing). */
export function showSettingsTab(tab: Category) {
  localStorage.setItem(tabKey, tab);
  localStorage.removeItem(leftKey);
  dispatchEvent(new CustomEvent<Category>('aplos:settings-tab', { detail: tab }));
}

async function inputDevices() {
  return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
}

/** Typing stays local; the setting is written after a pause, on blur and when leaving. */
function SignatureField({ value, onSave }: { value: string; onSave: (value: string) => void }) {
  const [text, setText] = useState(value);
  const pending = useRef<string | null>(null);
  const save = useRef(onSave);
  save.current = onSave;
  const focused = useRef(false);
  const flush = useCallback(() => {
    if (pending.current === null) return;
    const next = pending.current;
    pending.current = null;
    save.current(next);
  }, []);
  useEffect(() => {
    if (!focused.current && pending.current === null) setText(value);
  }, [value]);
  useEffect(() => {
    if (pending.current === null) return;
    const timer = setTimeout(flush, 600);
    return () => clearTimeout(timer);
  }, [text, flush]);
  useEffect(() => flush, [flush]);
  return (
    <textarea
      className="signature-setting"
      aria-label="Email signature"
      rows={4}
      value={text}
      placeholder={'Your name\nA line or two about you'}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        flush();
      }}
      onChange={e => {
        pending.current = e.target.value;
        setText(e.target.value);
      }}
    />
  );
}

/** Current version, what the updater is doing and when it last checked. */
function UpdatesRow({
  update,
  busy,
  check,
  restart,
}: {
  update: UpdateInfo;
  busy: boolean;
  check: () => void;
  restart: () => void;
}) {
  const status = update.status;
  const checked = update.lastCheck
    ? 'Last checked ' + new Date(update.lastCheck).toLocaleString()
    : 'Not checked yet';
  const description =
    status.state === 'disabled'
      ? status.reason
      : status.state === 'checking'
        ? 'Checking for updates…'
        : status.state === 'downloading'
          ? `Downloading Aplos ${status.version}${status.percent !== undefined ? ` · ${status.percent}%` : ''}…`
          : status.state === 'ready'
            ? `Aplos ${status.version} is ready. Restart to update.`
            : status.state === 'current'
              ? `Up to date · ${checked}`
              : status.state === 'error'
                ? `Couldn’t check: ${status.message} · ${checked}`
                : `Checks automatically every 6 hours · ${checked}`;
  return (
    <Group title="Updates">
      <GroupRow label={`Aplos Mail ${update.currentVersion}`} description={description}>
        {status.state === 'ready' ? (
          <Button variant="secondary" size="sm" onClick={restart}>
            Restart
          </Button>
        ) : status.state !== 'disabled' ? (
          <Button
            variant="secondary"
            size="sm"
            icon={RefreshCw}
            loading={busy || status.state === 'checking'}
            onClick={check}
          >
            Check now
          </Button>
        ) : undefined}
      </GroupRow>
    </Group>
  );
}

export function Settings({
  state,
  capabilities,
  update,
  onUpdate,
  onChange,
  notify,
  shortcuts,
}: {
  state: AppState;
  capabilities: Capabilities;
  update?: UpdateInfo;
  onUpdate: (info: UpdateInfo) => void;
  onChange: (p: Partial<Preferences>) => void;
  notify: (t: string) => void;
  shortcuts: () => void;
}) {
  const [tab, setTabState] = useState<Category>(storedTab);
  const [busy, setBusy] = useState('');
  const [adding, setAdding] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState('');
  const s = state.settings;
  function setTab(next: Category) {
    localStorage.setItem(tabKey, next);
    setTabState(next);
    setError('');
  }
  useEffect(() => {
    localStorage.removeItem(leftKey);
    addEventListener('pagehide', markLeft);
    return () => {
      removeEventListener('pagehide', markLeft);
      markLeft();
    };
  }, []);
  useEffect(() => {
    const change = (event: Event) => {
      setTabState((event as CustomEvent<Category>).detail);
      setError('');
    };
    addEventListener('aplos:settings-tab', change);
    return () => removeEventListener('aplos:settings-tab', change);
  }, []);
  // Device labels are only readable after access was granted, so a labeled list means we can show it right away.
  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) return;
    let live = true;
    const refresh = () =>
      void inputDevices()
        .then(list => {
          if (live && list.some(d => d.label)) setDevices(list);
        })
        .catch(() => {});
    refresh();
    media.addEventListener?.('devicechange', refresh);
    return () => {
      live = false;
      media.removeEventListener?.('devicechange', refresh);
    };
  }, []);
  async function run(name: string, fn: () => Promise<unknown>) {
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
  async function microphones() {
    await run('microphone', async () => {
      const audio = await navigator.mediaDevices.getUserMedia({ audio: true });
      audio.getTracks().forEach(t => t.stop());
      setDevices(await inputDevices());
    });
  }
  type BooleanKey = {
    [K in keyof Preferences]: Preferences[K] extends boolean ? K : never;
  }[keyof Preferences];
  const toggle = (label: string, description: string, key: BooleanKey) => (
    <GroupRow label={label} description={description}>
      <Switch label={label} checked={!!s[key]} onChange={value => onChange({ [key]: value })} />
    </GroupRow>
  );
  const choice = (
    label: string,
    description: string,
    key: keyof Preferences,
    options: [string, string][],
  ) => (
    <GroupRow label={label} description={description}>
      <Select
        label={label}
        value={String(s[key])}
        options={options}
        onChange={value => onChange({ [key]: key === 'undoSeconds' ? Number(value) : value })}
      />
    </GroupRow>
  );
  const accountRows = (
    <>
      {state.accounts.map(a => (
        <div className="settings-account" key={a.id}>
          <Avatar name={a.name} color={a.color} />
          <div>
            <span>{a.name}</span>
            <p>{a.email}</p>
            {a.error && <p className="danger">{a.error}</p>}
          </div>
          <Badge tone={a.provider === 'demo' ? 'neutral' : a.connected ? 'green' : 'amber'}>
            {a.provider === 'demo'
              ? 'Local demo'
              : a.connected
                ? 'Connected'
                : 'Reconnect required'}
          </Badge>
          {a.provider !== 'demo' && (
            <Button
              variant="text"
              className="danger"
              onClick={async () => {
                if (
                  await confirmAction({
                    title: 'Disconnect ' + a.email + '?',
                    message:
                      'Local cached mail for this account will be removed from Aplos. Nothing changes in your mailbox.',
                    confirmLabel: 'Disconnect',
                    danger: true,
                  })
                )
                  void run('disconnect', () => invoke('account.disconnect', { id: a.id }));
              }}
            >
              Disconnect
            </Button>
          )}
        </div>
      ))}
      <div className="settings-account-actions">
        <Button variant="secondary" icon={Plus} disabled={!!busy} onClick={() => setAdding(true)}>
          Add account
        </Button>
      </div>
      <AddAccountDialog
        open={adding}
        close={() => setAdding(false)}
        capabilities={capabilities}
        connected={() => notify('Account connected')}
      />
    </>
  );
  const customDomain = state.accounts
    .map(a => a.email.split('@')[1]?.toLowerCase())
    .find(
      domain =>
        domain &&
        !/^(gmail|googlemail|outlook|hotmail|live|msn|icloud|me|mac|yahoo|ymail|aol|fastmail)\./.test(
          domain,
        ) &&
        !domain.endsWith('.test'),
    );
  return (
    <div className="settings-page">
      <Tabs
        variant="nav"
        semantics="nav"
        label="Settings categories"
        className="settings-nav"
        value={tab}
        onChange={setTab}
        items={categories.map(id => ({ id, label: id }))}
      />
      <div className="settings-content" key={tab}>
        {error && (
          <Notice
            action={
              <Button variant="text" size="sm" onClick={() => setError('')}>
                Dismiss
              </Button>
            }
          >
            {error}
          </Notice>
        )}
        {tab === 'General' && (
          <>
            <Group title="Appearance">
              {choice('Theme', 'A comfortable place for your mail.', 'theme', [
                ['light', 'Light'],
                ['dark', 'Dark'],
                ['system', 'Match system'],
              ])}
              {choice(
                'Sidebar',
                'A full sidebar, or everything in a small menu at the top left.',
                'sidebarStyle',
                [
                  ['normal', 'Normal'],
                  ['minimized', 'Minimized'],
                ],
              )}
              {toggle('Zen mode', 'Show only the Home count in the sidebar.', 'zen')}
            </Group>
            <Group title="System">
              <GroupRow label="Open at login" description="Aplos is ready when your day begins.">
                <Switch
                  label="Open at login"
                  checked={s.launchAtLogin}
                  disabled={busy === 'login'}
                  onChange={enabled =>
                    void run('login', async () => {
                      const result = await invoke<{ enabled: boolean }>('system.login', {
                        enabled,
                      });
                      onChange({ launchAtLogin: result.enabled });
                    })
                  }
                />
              </GroupRow>
              <GroupRow
                label="Default email app"
                description="Open email links from other apps in Aplos."
              >
                <Button
                  variant="secondary"
                  size="sm"
                  iconRight={ArrowUpRight}
                  loading={busy === 'default'}
                  onClick={() =>
                    void run('default', async () => {
                      const result = await invoke<{ success: boolean }>('system.defaultMail');
                      if (!result.success)
                        throw new Error(
                          'macOS could not change the default email app. Choose Aplos in your default mail app settings.',
                        );
                      notify('Aplos registered for email links');
                    })
                  }
                >
                  Set as default
                </Button>
              </GroupRow>
            </Group>
            {update && (
              <UpdatesRow
                update={update}
                busy={busy === 'update'}
                check={() =>
                  void run('update', async () => onUpdate(await invoke<UpdateInfo>('update.check')))
                }
                restart={() => void invoke('update.restart')}
              />
            )}
            <Group title="Voice & audio">
              <GroupRow
                label="Microphone"
                description={`Record instructions and questions. Audio is transcribed by ${askModelLabel(s.voiceModel, 'voice').provider}.`}
              >
                {devices.length ? (
                  <Select
                    label="Microphone"
                    value={s.microphone}
                    options={[
                      ['', 'Default input'],
                      ...devices.map(
                        d => [d.deviceId, d.label || 'Microphone'] as [string, string],
                      ),
                    ]}
                    onChange={microphone => onChange({ microphone })}
                  />
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={Mic}
                    loading={busy === 'microphone'}
                    onClick={() => void microphones()}
                  >
                    Allow access
                  </Button>
                )}
              </GroupRow>
              {toggle('Send sound', 'Play a gentle sound after sending.', 'sendSound')}
            </Group>
          </>
        )}
        {tab === 'Mail' && (
          <>
            <Group title="Triage & inbox">
              {choice(
                'Triage direction',
                'Arrow keys, swipe gestures and action positions.',
                'triageDirection',
                [
                  ['done-right', 'Done → · ← Later'],
                  ['done-left', '← Done · Later →'],
                ],
              )}
              {toggle(
                'Drag to triage',
                'Drag an email or the open card sideways, or swipe with two fingers on your trackpad.',
                'swipe',
              )}
            </Group>
            <Group title="Actions in your mailbox">
              {choice(
                'When I mark Done',
                'Choose how your mail provider’s inbox follows along.',
                'doneAction',
                mailboxActions,
              )}
              {choice(
                'When I mark Later',
                'Aplos keeps it in your Later list.',
                'laterAction',
                mailboxActions,
              )}
              {choice(
                'Low-importance Done',
                'Keep background mail out of the way.',
                'lowAction',
                mailboxActions,
              )}
            </Group>
            <Group title="Writing & sending">
              {choice(
                'Default reply action',
                'Choose who receives a reply by default.',
                'defaultReply',
                [
                  ['reply', 'Reply'],
                  ['reply-all', 'Reply all'],
                ],
              )}
              {choice('Undo send', 'Hold messages briefly before delivery.', 'undoSeconds', [
                ['0', 'Off'],
                ['5', '5 seconds'],
                ['10', '10 seconds'],
                ['20', '20 seconds'],
                ['30', '30 seconds'],
              ])}
              {toggle(
                'Auto-polish',
                'Polish voice drafts with your Drafts model before you review them.',
                'autoPolish',
              )}
              {toggle('Aplos footer', 'Add “Sent with Aplos Mail” to messages.', 'footer')}
            </Group>
            <Group title="Signature">
              {choice('Include signature', 'Use your own plain-text signature.', 'signatureMode', [
                ['always', 'Every message'],
                ['new', 'New messages & forwards'],
                ['never', 'Never'],
              ])}
              <SignatureField value={s.signature} onSave={signature => onChange({ signature })} />
            </Group>
            <Group title="Reading">
              {toggle(
                'Load remote images',
                'Images can reveal that an email was opened.',
                'remoteImages',
              )}
            </Group>
            <Group title="Blocked senders">
              {state.blockedSenders.length ? (
                state.blockedSenders.map(email => (
                  <GroupRow
                    key={email}
                    label={email}
                    description="Future messages are kept in Spam."
                  >
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={busy === 'unblock:' + email}
                      onClick={() =>
                        void run('unblock:' + email, () => invoke('sender.unblock', { email }))
                      }
                    >
                      Unblock
                    </Button>
                  </GroupRow>
                ))
              ) : (
                <p className="group-note">
                  No blocked senders. Use a thread’s menu to block someone.
                </p>
              )}
            </Group>
          </>
        )}
        {tab === 'Calendar' && (
          <>
            <Group title="Plans from your mail">
              {toggle(
                'Automatically add plans',
                'Your Plans model (Settings → AI) detects meetings, reservations and flights during sync. Review your calendar regularly.',
                'autoCalendar',
              )}
              {toggle(
                'Show Google’s Gmail events',
                'Include events Google has created from your mail.',
                'gmailEvents',
              )}
            </Group>
            <Group title="Calendar access">
              {accountRows}
              <p className="group-note">
                Google and Outlook accounts include their calendars. iCloud calendars use the same
                app-specific password. Aplos never sends invitations without your action.
              </p>
            </Group>
          </>
        )}
        {tab === 'AI' && (
          <AiSettings settings={s} groqReady={capabilities.groq} onChange={onChange} />
        )}
        {tab === 'Notifications' && (
          <>
            <Group title="Desktop notifications">
              {toggle(
                'Show notifications',
                'Get a heads-up when new mail arrives.',
                'notifications',
              )}
              <GroupRow
                label="Test notification"
                description="Click the notification to return to Aplos."
              >
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy === 'notification'}
                  onClick={() => void run('notification', () => invoke('notification.test'))}
                >
                  Send test
                </Button>
              </GroupRow>
            </Group>
            <Group title="For each account">
              {state.accounts.map(a => (
                <GroupRow key={a.id} label={a.name} description={a.email}>
                  <Switch
                    label={'Notifications for ' + a.email}
                    checked={s.accountNotifications[a.id] !== false}
                    onChange={on =>
                      onChange({ accountNotifications: { ...s.accountNotifications, [a.id]: on } })
                    }
                  />
                </GroupRow>
              ))}
            </Group>
          </>
        )}
        {tab === 'Accounts' && (
          <Group title="Your accounts">
            {accountRows}
            <GroupRow
              label="Refresh all accounts"
              description={
                state.sync.pending
                  ? `${state.sync.pending} change${state.sync.pending === 1 ? '' : 's'} waiting to reach your mail provider. They are sent automatically when it can be reached.`
                  : state.sync.lastSync
                    ? 'Last checked ' + new Date(state.sync.lastSync).toLocaleString()
                    : 'Mail stays available offline.'
              }
            >
              <Button
                variant="secondary"
                size="sm"
                icon={RefreshCw}
                loading={state.sync.busy || busy === 'sync'}
                onClick={() => void run('sync', () => invoke('sync'))}
              >
                Sync now
              </Button>
            </GroupRow>
          </Group>
        )}
        {tab === 'Accounts' && (
          <Group title="Your other devices">
            <DeviceSync notify={notify} />
          </Group>
        )}
        {tab === 'Accounts' && (
          <Group title="Custom domain">
            <p className="group-note">
              Check that a domain you send from has the mail records its host needs, so your
              messages are trusted and delivered.
            </p>
            <DomainCheck initial={customDomain} />
          </Group>
        )}
        {tab === 'Help & about' && (
          <>
            <div className="about-card">
              <AppIcon size={72} />
              <h2>Aplos Mail</h2>
              <p>A little less inbox. A little more life.</p>
              <span className="version">
                Version {capabilities.version} ·{' '}
                {capabilities.desktop ? 'macOS desktop' : 'Browser preview'}
              </span>
            </div>
            <Group title="A few useful things">
              <GroupRow label="Keyboard shortcuts" description="Make light work of your inbox.">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={Keyboard}
                  shortcut="?"
                  onClick={shortcuts}
                >
                  View shortcuts
                </Button>
              </GroupRow>
              <GroupRow
                label="AI"
                description="Providers and the model each feature uses are in Settings → AI."
              >
                <Button variant="secondary" size="sm" onClick={() => showSettingsTab('AI')}>
                  Open AI settings
                </Button>
              </GroupRow>
              <GroupRow
                label="Welcome and setup"
                description="Add an account, an AI key and the microphone, one step at a time."
              >
                <Button variant="secondary" size="sm" onClick={showWelcome}>
                  Show welcome
                </Button>
              </GroupRow>
              <GroupRow
                label="Export local data"
                description="Includes your cached mail and drafts. Keep it somewhere private."
              >
                <Button
                  variant="secondary"
                  size="sm"
                  icon={Download}
                  loading={busy === 'export'}
                  onClick={() =>
                    void run('export', async () => {
                      const data = await invoke<string>('data.export');
                      await saveFile('aplos-export.json', btoa(unescape(encodeURIComponent(data))));
                      notify('Export prepared');
                    })
                  }
                >
                  Export
                </Button>
              </GroupRow>
              <GroupRow
                label="Reset demo mail"
                description="Replace local demo accounts with fresh original examples."
              >
                <Button
                  variant="danger"
                  size="sm"
                  loading={busy === 'reset'}
                  onClick={async () => {
                    if (
                      await confirmAction({
                        title: 'Reset demo mail?',
                        message:
                          'Demo accounts and demo drafts return to their original examples. Connected accounts are preserved.',
                        confirmLabel: 'Reset demo',
                        danger: true,
                      })
                    )
                      void run('reset', () => invoke('demo.reset'));
                  }}
                >
                  Reset demo
                </Button>
              </GroupRow>
            </Group>
            <p className="small muted about-note">
              <ShieldCheck size={14} />
              AI keys are encrypted with your macOS keychain. Email is sent only when you choose
              Send. Aplos is an independent personal project.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
