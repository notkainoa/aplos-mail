/**
 * The recorded walkthroughs (development only): the onboarding window and the weekly reconnect running live on the
 * stand-in engine, so `film.mjs` can capture them headless to .webm (plan 30 U8 acceptance 6). `?film=walkthrough`
 * boots `OnboardingApp` on the `empty` scenario (a fresh install) with stand-in window ports; `?film=reconnect`
 * boots the `needs-reauth` account's status slot and mounts the real `ReconnectFlow` when its action fires.
 * Stand-in data only; nothing here runs in a release.
 */
import { StrictMode, useEffect, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import '../../ui/styles.css';
import '../onboarding.css';
import { connectStandInDataLayer } from '../../data/standin-layer';
import { useAccounts, useSetupStatus, useStatus } from '../../data';
import { dismissToast, runToastAction, useToasts } from '../../shell';
import { accountColor, toSyncStatus } from '../../shell/status-map';
import { ToastStack } from '../../ui/surfaces';
import { StatusSlot } from '../../ui/status/StatusSlot';
import { statusCopy } from '../../ui/status/StatusSlot';
import { OnboardingApp } from '../OnboardingApp';
import { ReconnectFlow } from '../reconnect/ReconnectFlow';
import { SlotBackdrop } from '../reconnect/states';
import { ZeroAccountsView } from '../ZeroAccounts';
import type { AiPorts } from '../steps/Ai';
import type { AiProvider } from '../../data';

const params = new URLSearchParams(window.location.search);
const film = params.get('film') === 'reconnect' ? 'reconnect' : 'walkthrough';
document.documentElement.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light';

/** Groq with its key in the environment, so the AI step's Continue works and asks for consent. */
const AI_PROVIDERS: AiProvider[] = [
  {
    id: 'groq',
    label: 'Groq',
    group: 'hosted',
    status: 'ok',
    keySource: 'env',
    envVar: 'GROQ_API_KEY',
    keyOptional: false,
    trainsOnInputs: false,
    sttCapable: true,
    local: false,
  } as AiProvider,
];

const aiPorts: Partial<AiPorts> = {
  providers: async () => ({ list: AI_PROVIDERS }),
  models: async () => ({
    list: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', tools: true },
      { id: 'whisper-large-v3', label: 'Whisper Large v3', stt: true },
    ],
    live: true,
  }),
};

/* ---------- walkthrough ---------- */

/** The mail pane as the handoff leaves it: first sync still reading, the status slot carrying the same words. */
function MailAfterOnboarding(): JSX.Element {
  const setup = useSetupStatus();
  const account = useAccounts()[0];
  const row = setup?.accounts[0];
  const status = {
    kind: 'syncing',
    firstWindow: { read: row?.firstWindow.read ?? 0, of: row?.firstWindow.total ?? 50 },
  } as const;
  const copy = statusCopy(status);
  return (
    <SlotBackdrop
      slot={
        <StatusSlot
          status={status}
          {...(account
            ? { account: { address: account.address, color: accountColor(account) } }
            : {})}
          onAction={() => {}}
        />
      }
    >
      <div className="onb-list-column">
        <ZeroAccountsView
          firstSyncRunning
          detail={copy?.text}
          onAddAccount={() => {}}
          onTryDemo={() => {}}
        />
      </div>
    </SlotBackdrop>
  );
}

function Walkthrough(): JSX.Element {
  const [handedOff, setHandedOff] = useState(false);
  if (handedOff) return <MailAfterOnboarding />;
  return (
    <OnboardingApp
      mode="first"
      ports={{
        finish: async () => {
          setHandedOff(true);
        },
      }}
      connectPorts={{ discover: async () => ({ provider: 'google' }) }}
      aiPorts={aiPorts}
    />
  );
}

/* ---------- reconnect ---------- */

/** The status slot of the account Gmail is asking about, with the sheet and the toast stack mounted on demand. */
function ReconnectScene(): JSX.Element {
  const account = useAccounts()[0];
  const slot = useStatus(account?.id ?? '');
  const toasts = useToasts();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // Let the "due" state read before the keyboard reaches Reconnect.
    (window as unknown as { __reconnectOpen?: () => void }).__reconnectOpen = () => setOpen(true);
  }, []);
  if (!account) return <></>;
  return (
    <SlotBackdrop
      slot={
        <StatusSlot
          {...(slot ? { status: toSyncStatus(slot) } : { status: { kind: 'needsReauth' } })}
          account={{ address: account.address, color: accountColor(account) }}
          onAction={() => setOpen(true)}
        />
      }
    >
      <>
        {open ? <ReconnectFlow accountId={account.id} onClose={() => setOpen(false)} /> : null}
        <ToastStack toasts={toasts} onAction={runToastAction} onDismiss={dismissToast} />
      </>
    </SlotBackdrop>
  );
}

/* ---------- boot ---------- */

const layer = connectStandInDataLayer({
  scenario: film === 'reconnect' ? 'needs-reauth' : 'empty',
});

function Film(): JSX.Element {
  useEffect(() => {
    void document.fonts.ready.then(() =>
      requestAnimationFrame(() => {
        document.documentElement.dataset.previewReady = 'true';
      }),
    );
  }, []);
  return (
    <div className="onb-window">{film === 'reconnect' ? <ReconnectScene /> : <Walkthrough />}</div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div className="onb-frame">
      <Film />
    </div>
  </StrictMode>,
);

// The layer closes with the page.
void layer;
