/**
 * The sheet host (DESIGN 7.1; plan 30 4.5 #1): renders the one open sheet. The reconnect sheet runs its flow here
 * (`Account/reconnect` or `Account/grantPermissions`, followed by `connect` frames) and closes with a "Reconnected"
 * toast. The consent card is a Dialog. Failure copy is ours, picked from the frame's reason code; a provider's own text
 * never reaches the sheet.
 */
import { useEffect, useMemo, useRef } from 'react';
import { api, useAccounts, useAccountsLoaded, useConsent, useSettings } from '../data';
import { ReconnectFlow } from '../onboarding/reconnect/ReconnectFlow';
import { callForSheetMode, enableForSheetMode } from '../onboarding/reconnect/reconnect.model';
import { ConsentCard } from '../ui/onboarding';
import { Dialog } from '../ui/surfaces';
import { RECONNECT_FAILED_COPY, SAVE_FAILED_COPY } from './failure-copy';
import { AddAccountHost } from './AddAccountHost';
import { closeSheet, pushToast, useRegisterCommands, useSheet, type SheetArgs } from './index';

/** Plain words for a failed connect, from the frame's reason code. */
export function failureReason(reasonCode: string | undefined): string {
  switch (reasonCode) {
    case 'auth.wrongAccount':
      return 'That was a different account. Sign in with the same one.';
    case 'auth.cancelled':
    case 'auth.denied':
      return 'Sign-in was canceled. Nothing changed.';
    case 'auth.timeout':
      return 'Sign-in timed out. Nothing changed.';
    default:
      return RECONNECT_FAILED_COPY;
  }
}

type ReconnectArgs = SheetArgs['reconnect'];

/** True once the frame for this flow says it ended (anything but waiting). */
export function flowEnded(
  latest: { connectId: string; state: string | undefined },
  connectId: string,
) {
  return latest.connectId === connectId && latest.state !== undefined && latest.state !== 'waiting';
}

/** The frame, unless it names another account than the sheet's: a frame for someone else's flow is ignored. */
export function ownFrame<F extends { readonly connectId: string; readonly accountId?: string }>(
  frame: F | undefined,
  accountId: string,
): F | undefined {
  return frame && (frame.accountId === undefined || frame.accountId === accountId)
    ? frame
    : undefined;
}

/** True once accounts have loaded and the sheet's account is not among them (it was removed). */
export function accountGone(
  loaded: boolean,
  accounts: readonly { readonly id: string }[],
  accountId: string,
): boolean {
  return loaded && !accounts.some(a => a.id === accountId);
}

/** True only once accounts have loaded and the sheet's account is among them: a reconnect is never requested for an account known to be missing, nor before the list is known. */
export function canStartFlow(
  loaded: boolean,
  accounts: readonly { readonly id: string }[],
  accountId: string,
): boolean {
  return loaded && !accountGone(loaded, accounts, accountId);
}

/** Return in the reconnect sheet: Try again when the flow failed, nothing otherwise. */
export function reconnectDefault(failed: boolean, retry: () => void): () => void {
  return () => {
    if (failed) retry();
  };
}

/**
 * The reconnect sheet is ui-onboard's `ReconnectFlow` (STATUS DECIDED 2026-10-28: the same flow for the
 * status slot, the Settings row and the switcher). It picks the call (`Account/reconnect` or
 * `grantPermissions`) from the account's own health, starts it on mount, follows the `connect` frames,
 * pushes the "Reconnected" toast and reports through `onClose`; Esc inside it cancels the flow, and a
 * close or a replacing sheet unmounts it, which cancels a wait in flight. The host keeps only the shell's
 * own rule: the sheet closes if its account is removed.
 */
function ReconnectHost({ args }: { readonly args: ReconnectArgs }) {
  const accounts = useAccounts();
  const loaded = useAccountsLoaded();
  const gone = accountGone(loaded, accounts, args.accountId);
  useEffect(() => {
    if (gone) closeSheet();
  }, [gone]);
  // The entry point's mode wins (`openSheet('reconnect', {mode: 'grant'})` grants even on a healthy account;
  // 'enableEditing' is the same grant call plus `enable: 'calendarWrite'`).
  return (
    <ReconnectFlow
      accountId={args.accountId}
      call={callForSheetMode(args.mode)}
      {...(enableForSheetMode(args.mode) ? { enable: 'calendarWrite' as const } : {})}
      onClose={() => closeSheet()}
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
    Promise.resolve()
      .then(() =>
        api.consent.grant({
          scope: 'background',
          version: consent.currentVersion,
          provider,
          model,
        }),
      )
      .then(closeSheet, () =>
        pushToast({
          id: 'consent-failed',
          kind: 'info',
          message: SAVE_FAILED_COPY,
          undoable: false,
        }),
      );
  };
  const allowRef = useRef(allow);
  allowRef.current = allow;
  const handlers = useMemo(() => ({ 'sheet.default': { run: () => allowRef.current() } }), []);
  useRegisterCommands(handlers);
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

/** Identity of a reconnect sheet: another account or mode is another flow, so it gets fresh state. */
export function reconnectKey({ accountId, mode }: ReconnectArgs): string {
  return `${accountId}:${mode}`;
}

const SHEET_CANCEL_HANDLERS = { 'sheet.cancel': { run: () => closeSheet() } } as const;

/** Esc anywhere in the window while a sheet is open: closes it (the key stack carries `sheet`, so nothing behind answers). */
function SheetKeys() {
  useRegisterCommands(SHEET_CANCEL_HANDLERS);
  return null;
}

/** The open sheet, or nothing. */
export function SheetHost() {
  const sheet = useSheet();
  if (!sheet) return null;
  return (
    <>
      <SheetKeys />
      <OpenSheetView sheet={sheet} />
    </>
  );
}

function OpenSheetView({ sheet }: { readonly sheet: NonNullable<ReturnType<typeof useSheet>> }) {
  if (sheet.name === 'reconnect') {
    return <ReconnectHost key={reconnectKey(sheet.args)} args={sheet.args} />;
  }
  if (sheet.name === 'addAccount') return <AddAccountHost />;
  return <ConsentHost args={sheet.args} />;
}
