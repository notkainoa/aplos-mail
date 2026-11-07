/**
 * What an `Ask/run` reports about where the owner is (contract `context`): the screen the shell shows, the
 * focused thread or event, and — while a composer is open — the account its draft is being written in, so a
 * draft in an account left out of AI can refuse the run (`ai.accountExcluded`). Pure: the host reads the live
 * values at run start, so a run fired after the composer closed carries no stale account. Never the draft's
 * body, recipients or subject — the account only.
 */
import type { TargetSummary } from '../../commands';
import type { api } from '../../data';
import type { Screen } from '../../shell';

type RunArgs = Parameters<typeof api.ask.run>[0];

/** `Ask/run`'s `context` input. */
export type AskRunContext = NonNullable<RunArgs['context']>;

/** The shell facts a run's context is built from, each read at run start. */
export interface AskShellState {
  /** `useCurrentTarget`: the focused thread or event. */
  readonly target: TargetSummary | null;
  /** `useAppRoute`: the screen the shell shows ('compose' while a draft page is open). */
  readonly screen: Screen;
  /** `openDraftAccount`: the account an open composer is writing in; absent while none is open. */
  readonly draftAccountId?: string;
}

/** The `context` one `Ask/run` carries; a draft's account goes only while its composer is open. */
export function askContext(shell: AskShellState): AskRunContext {
  const { screen, target } = shell;
  return {
    view: typeof screen === 'string' ? screen : screen.label,
    threadId: target?.kind === 'thread' ? target.id : undefined,
    eventId: target?.kind === 'event' ? target.id : undefined,
    ...(shell.draftAccountId !== undefined ? { draft: { accountId: shell.draftAccountId } } : {}),
  };
}

/** The `Ask/run` input a run effect sends: the question, the search-all scope, the live shell context. */
export function askRunArgs(
  effect: {
    readonly question: string;
    readonly conversationId?: string;
    readonly searchAll: boolean;
  },
  shell: AskShellState,
  timeZone: string,
): RunArgs {
  return {
    question: effect.question,
    conversationId: effect.conversationId,
    scope: effect.searchAll ? { searchAllMail: true } : undefined,
    context: askContext(shell),
    timeZone,
  };
}
