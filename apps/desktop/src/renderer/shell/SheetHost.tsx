/**
 * The sheet host (DESIGN 7.1; plan 30 4.5 #1): renders the one open sheet. The reconnect sheet runs its flow here
 * (`Account/reconnect` or `Account/grantPermissions`, followed by `connect` frames) and closes with a "Reconnected"
 * toast. The consent card is a Dialog. Failure copy is ours, picked from the frame's reason code; a provider's own text
 * never reaches the sheet.
 */
import { useEffect, useRef, useState } from 'react';
import { api, useAccounts, useConsent, useFrames, useSettings } from '../data';
import { ConsentCard } from '../ui/onboarding';
import { Dialog } from '../ui/surfaces';
import { ReconnectSheet } from '../ui/status';
import { closeSheet, pushToast, useSheet, type SheetArgs } from './index';

function ignore(): void {
  return undefined;
}

/** Plain words for a failed connect, from the frame's reason code. */
export function failureReason(reasonCode: string | undefined): string {
  switch (reasonCode) {
    case 'auth.wrongAccount':
      return 'That was a different account. Sign in with the same one.';
    case 'auth.cancelled':
    case 'auth.denied':
      return 'Sign-in was cancelled. Nothing changed.';
    case 'auth.timeout':
      return 'Sign-in timed out. Nothing changed.';
    default:
      return 'Couldn’t reconnect. Your mail is safe here and local changes are kept.';
  }
}

type ReconnectArgs = SheetArgs['reconnect'];

function startFlow(args: ReconnectArgs) {
  return args.mode === 'grant'
    ? api.account.grantPermissions({ accountId: args.accountId })
    : api.account.reconnect({ accountId: args.accountId });
}

/** Starts the flow and follows its frames; returns the connect id once known. */
function useReconnectFlow({ accountId, mode }: ReconnectArgs, attempt: number) {
  const [connectId, setConnectId] = useState('');
  const [refused, setRefused] = useState(false);
  const finished = useRef(false);
  useEffect(() => {
    let stale = false;
    let started = '';
    finished.current = false;
    setRefused(false);
    startFlow({ accountId, mode }).then(
      result => {
        started = result.connectId;
        if (stale) void api.account.cancelConnect({ connectId: started }).catch(ignore);
        else setConnectId(started);
      },
      () => {
        if (!stale) setRefused(true);
      },
    );
    return () => {
      stale = true;
      if (started && !finished.current)
        void api.account.cancelConnect({ connectId: started }).catch(ignore);
    };
  }, [accountId, mode, attempt]);
  const last = useFrames('connect', { connectId }).last;
  if (last && last.state !== 'waiting') finished.current = true;
  return { connectId, last, refused };
}

function ReconnectHost({ args }: { readonly args: ReconnectArgs }) {
  const accounts = useAccounts();
  const [attempt, setAttempt] = useState(0);
  const { connectId, last, refused } = useReconnectFlow(args, attempt);
  const address = accounts.find(a => a.id === args.accountId)?.address ?? '';
  const state = last?.state;
  useEffect(() => {
    if (state === 'connected') {
      pushToast({
        id: `reconnected-${connectId}`,
        kind: 'info',
        message: 'Reconnected',
        undoable: false,
      });
      closeSheet();
    } else if (state === 'cancelled') closeSheet();
  }, [state, connectId]);
  const failed = refused || state === 'failed';
  return (
    <ReconnectSheet
      open
      address={address}
      state={failed ? 'failed' : 'waiting'}
      reason={failed ? failureReason(last?.reasonCode) : undefined}
      mode={args.mode}
      onCancel={() => {
        if (connectId) void api.account.cancelConnect({ connectId }).catch(ignore);
        closeSheet();
      }}
      onRetry={() => setAttempt(n => n + 1)}
    />
  );
}

const PROVIDER_NAMES = {
  groq: 'Groq',
  openai: 'OpenAI',
  anthropic: 'Claude',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
  'opencode-go': 'OpenCode Go',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  custom: 'Custom server',
} as const;

type KnownProvider = keyof typeof PROVIDER_NAMES;

function isKnownProvider(id: string | undefined): id is KnownProvider {
  return id !== undefined && Object.hasOwn(PROVIDER_NAMES, id);
}

const LOCAL_PROVIDERS: readonly string[] = ['ollama', 'lmstudio'];

const SENT_COPY =
  'The sender, subject and text of each new email, so it can write a one-line summary. Attachments are not sent.';

function ConsentHost({ args }: { readonly args: SheetArgs['consent'] }) {
  const consent = useConsent();
  const settings = useSettings();
  const summaries = settings?.ai.features.summaries;
  const provider = args.provider ?? consent?.provider ?? summaries?.provider;
  const model = args.model ?? consent?.model ?? summaries?.model ?? '';
  const allow = () => {
    if (!consent || !isKnownProvider(provider)) return;
    api.consent
      .grant({ scope: 'background', version: consent.currentVersion, provider, model })
      .then(closeSheet, ignore);
  };
  return (
    <Dialog open title="Background summaries" size="md" onClose={closeSheet}>
      <ConsentCard
        provider={isKnownProvider(provider) ? PROVIDER_NAMES[provider] : 'your provider'}
        model={model}
        sent={SENT_COPY}
        showLocalNote={isKnownProvider(provider) && !LOCAL_PROVIDERS.includes(provider)}
        onAllow={allow}
        onNotNow={closeSheet}
      />
    </Dialog>
  );
}

/** The open sheet, or nothing. */
export function SheetHost() {
  const sheet = useSheet();
  if (!sheet) return null;
  if (sheet.name === 'reconnect') return <ReconnectHost args={sheet.args} />;
  return <ConsentHost args={sheet.args} />;
}
