import type { ViewSpec } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import {
  draftsPlan,
  labelPlan,
  mailboxPlan,
  scheduledPlan,
  threadMessagesPlan,
  workflowListPlan,
} from './lists';
import { searchPlan } from './search';
import { homePlan, laterPlan, lowSendersPlan } from './sections';
import type { ViewCompiler, ViewEnv, ViewPlan } from './specs';

/*
 * The spec registry (views-1). Built-in kinds are registered here; `events` and `plans` (prov-cal) and
 * `conversations` (eng-ai) register from their own modules, so no other lane edits this file.
 */

type Kind = ViewSpec['kind'];
type SpecOf<K extends Kind> = Extract<ViewSpec, { kind: K }>;

const compilers = new Map<string, ViewCompiler<never>>();

/** Adds a compiler for a spec kind. A kind registers once; a second registration is a wiring bug and throws. */
export function registerViewKind<K extends Kind>(kind: K, compile: ViewCompiler<SpecOf<K>>): void {
  if (compilers.has(kind)) throw new Error(`View kind ${kind} is registered twice`);
  compilers.set(kind, compile as ViewCompiler<never>);
}

export function hasViewKind(kind: string): boolean {
  return compilers.has(kind);
}

/** Compiles a validated spec. A kind nobody registered yet answers `unsupported` with a sentence the UI can show. */
export function compileView(spec: ViewSpec, env: ViewEnv): ViewPlan {
  const compile = compilers.get(spec.kind) as ViewCompiler<ViewSpec> | undefined;
  if (!compile)
    throw new ContractError({ type: 'unsupported', message: 'This view is not available yet.' });
  return compile(spec, env);
}

registerViewKind('home', homePlan);
registerViewKind('homeSection', homePlan);
registerViewKind('oneByOne', homePlan);
registerViewKind('lowSenders', lowSendersPlan);
registerViewKind('lowBySender', lowSendersPlan);
registerViewKind('mailbox', mailboxPlan);
registerViewKind('label', labelPlan);
registerViewKind('later', laterPlan);
registerViewKind('bookmarks', workflowListPlan);
registerViewKind('replyState', workflowListPlan);
registerViewKind('done', workflowListPlan);
registerViewKind('drafts', draftsPlan);
registerViewKind('scheduled', scheduledPlan);
registerViewKind('search', searchPlan);
registerViewKind('thread', threadMessagesPlan);

/**
 * One spec of every built-in kind and shape, for the bench gate (store-7) and the EXPLAIN test: each plan's
 * `statements()` lists the SQL to assert `EXPLAIN QUERY PLAN` on.
 */
export const BENCH_SPECS: readonly ViewSpec[] = [
  { kind: 'home' },
  { kind: 'home', accountId: 'acct-1' },
  { kind: 'homeSection', section: 'do' },
  { kind: 'homeSection', section: 'update' },
  { kind: 'homeSection', section: 'low' },
  { kind: 'homeSection', section: 'follow' },
  { kind: 'oneByOne', section: 'do' },
  { kind: 'lowSenders' },
  { kind: 'lowBySender' },
  ...(['inbox', 'all', 'sent', 'trash', 'spam', 'archive', 'starred', 'important'] as const).map(
    role => ({ kind: 'mailbox', role }) as const,
  ),
  { kind: 'mailbox', role: 'inbox', accountId: 'acct-1' },
  { kind: 'label', folderId: 'acct-1:Label_1' },
  { kind: 'label', folderId: 'acct-1:Label_empty' },
  { kind: 'later' },
  { kind: 'bookmarks' },
  { kind: 'replyState', status: 'needsReply' },
  { kind: 'replyState', status: 'awaitingReply' },
  { kind: 'done' },
  { kind: 'drafts' },
  { kind: 'scheduled' },
  { kind: 'search', query: { text: 'budget' } },
  { kind: 'search', query: { text: 'budget', from: 'ada', in: 'inbox', is: ['unread'] } },
  { kind: 'search', query: { text: '', is: ['unread'] } },
  { kind: 'search', query: { text: '', in: 'later' } },
  { kind: 'search', query: { text: '', in: 'acct-1:Label_1', after: '2026-10-01' } },
];
