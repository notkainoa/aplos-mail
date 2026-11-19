/**
 * Plain sentences for the engine’s reason codes, as onboarding, first sync and the reconnect sheet show them
 * (DESIGN 7.12, 7.15, 10). The screens never show a provider’s own wording or a raw error; they pass the code
 * and a few facts, and this file writes the sentence. The words say what happened and, where it helps, what
 * happens next. They never mention Testing mode, verification or cost.
 *
 * Round 1 is Google only, so the account provider is always "Google". The AI provider name comes from the
 * provider table ("Groq", "OpenAI", …).
 */
import type { ReasonCode } from '@aplos/contract';

/** Facts a sentence may name. */
export interface ReasonFacts {
  /** The account’s address, for "Choose jordan@gmail.com to reconnect." */
  readonly address?: string;
  /** The AI provider’s display name, e.g. "Groq". */
  readonly aiProvider?: string;
}

/** The engine’s codes are an open string enum: unknown codes fall back to a neutral sentence. */
export type AnyReasonCode = ReasonCode | (string & {});

const account: Record<string, string> = {
  'rate.minute': 'Google asked us to slow down.',
  'rate.concurrency': 'Google asked us to slow down.',
  'quota.daily': 'Google’s daily limit is reached. Resuming tomorrow.',
  'quota.bandwidth': 'Google’s daily download limit is reached. Resuming tomorrow.',
  'quota.project': 'Google is limiting Aplos for a while. It will try again by itself.',
  'quota.calendarAbuse': 'Google Calendar asked us to wait a few hours.',
  'auth.expired': 'Google needs you to sign in again.',
  'auth.testingModeExpiry': 'Google needs you to sign in again.',
  'auth.revoked': 'Access to this account was turned off. Sign in again to reconnect.',
  'auth.adminPolicy': 'Your organization has blocked Aplos. Ask your administrator.',
  'auth.adminConsent': 'Your organization has blocked Aplos. Ask your administrator.',
  'auth.denied': 'Google sign-in was declined. Nothing changed.',
  'auth.cancelled': 'Sign-in was canceled. Nothing changed.',
  'auth.timeout': 'Google sign-in took too long. Try again.',
  'permission.mailModify': 'Aplos needs permission to read your Gmail.',
  'permission.filters': 'Aplos needs permission to manage your Gmail filters.',
  'permission.calendar': 'Aplos needs permission to use your Google Calendar.',
  'permission.settings': 'Aplos needs permission to read your Gmail settings.',
  'config.apiDisabled': 'Google sign-in isn’t set up in this build.',
  'config.clientMissing': 'Google sign-in isn’t set up in this build.',
  'net.offline': 'You’re offline. Aplos continues when you’re back online.',
  'server.unavailable': 'Google isn’t answering right now. Aplos will try again.',
  'server.connectionLimit': 'The mail server is busy. Aplos will try again.',
  'server.limitedMode': 'The mail server is busy. Aplos will try again.',
  'cursor.expired': 'Aplos is catching up on recent changes.',
};

/**
 * One plain sentence for an account or connect reason code (first-sync failures, the reconnect sheet,
 * the Accounts step). `auth.wrongAccount` names the expected address when it is known.
 */
export function reasonSentence(code: AnyReasonCode | undefined, facts: ReasonFacts = {}): string {
  if (code === 'auth.wrongAccount') {
    return facts.address
      ? `That was a different Google account. Choose ${facts.address} to reconnect.`
      : 'That was a different Google account. Choose the same account to reconnect.';
  }
  if (code && code.startsWith('ai.')) return aiSentence(code, facts);
  return (code && account[code]) ?? SYNC_FALLBACK;
}

const SYNC_FALLBACK = 'Sync hit a problem. Try again.';

/**
 * A new account's sign-in that did not finish (the Accounts step). Nothing synced yet, so a code Aplos has no sentence
 * for (or no code at all) says the sign-in didn’t finish rather than "Sync hit a problem".
 */
export function connectSentence(code: AnyReasonCode | undefined, facts: ReasonFacts = {}): string {
  const sentence = code && !code.startsWith('ai.') ? reasonSentence(code, facts) : SYNC_FALLBACK;
  return sentence === SYNC_FALLBACK ? 'Google sign-in didn’t finish. Try again.' : sentence;
}

/**
 * The line under the AI step's key field after `Ai/setKey` failed. `Ai/setKey` only stores the key on this Mac, so a
 * failure is a local save failure unless the code says the key itself was refused; either way it names the provider
 * the key was for, never another one.
 */
export function keySaveSentence(code: AnyReasonCode | null | undefined, provider: string): string {
  if (isAdminBlock(code ?? undefined)) return 'Your organization has turned off saving keys.';
  if (code === 'ai.missingKey' || (code && code.startsWith('auth.'))) {
    return `${provider} didn’t take that key. Paste it again, or skip for now.`;
  }
  return `Aplos couldn’t save your ${provider} key on this Mac. Paste it again, or skip for now.`;
}

/**
 * The onboarding window's own lines: the demo load and the handoff to the mail window (drawn visibly in the step and
 * announced once), and the zero-accounts state's "Add an account" when the setup window could not open.
 */
export const WINDOW_COPY = {
  demoLoading: 'Loading demo mail.',
  demoFailed: 'Demo mail didn’t load. Nothing changed.',
  handoffFailed: 'Aplos couldn’t open your mail window. Nothing was lost.',
  setupWindowFailed: 'Aplos couldn’t open the setup window. Try again.',
} as const;

/**
 * The sorting pass’s reason (DESIGN 7.12: "Couldn’t sort with Groq: the key was refused. Mail is ready;
 * sorting will retry."). Returns the first sentence only; the screen adds what is safe and what happens next.
 */
export function aiSentence(code: AnyReasonCode | undefined, facts: ReasonFacts = {}): string {
  const name = facts.aiProvider ?? 'your AI provider';
  // The name opens some sentences: "Your AI provider asked us to slow down."
  const Name = name.charAt(0).toUpperCase() + name.slice(1);
  switch (code) {
    case 'ai.noProvider':
      return 'No AI provider is set up.';
    case 'ai.missingKey':
      return `Couldn’t sort with ${name}: the key was refused.`;
    case 'ai.unreachable':
      return `Couldn’t sort with ${name}: it didn’t answer.`;
    case 'ai.rateLimited':
      return `${Name} asked us to slow down.`;
    case 'ai.dailyCap':
      return 'Today’s AI limit is reached. Sorting resumes tomorrow.';
    case 'ai.noConsent':
      return 'Sorting waits until you allow it.';
    case 'ai.trainsOnInputs':
      return `${Name} may learn from what it’s sent, so Aplos doesn’t send it your mail.`;
    case 'ai.accountExcluded':
      return 'This account’s mail isn’t used for AI.';
    default:
      return `Couldn’t sort with ${name}.`;
  }
}

/** Codes that a Reconnect fixes: the sheet is offered instead of Try again. */
export function needsReconnect(code: AnyReasonCode | undefined): boolean {
  return (
    !!code && (code.startsWith('auth.') || code.startsWith('permission.')) && !isAdminBlock(code)
  );
}

/** Codes nobody but an administrator can fix: no action is offered. */
export function isAdminBlock(code: AnyReasonCode | undefined): boolean {
  return code === 'auth.adminPolicy' || code === 'auth.adminConsent';
}
