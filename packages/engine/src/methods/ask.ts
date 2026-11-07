import type { AreaHandlers } from './types';

/**
 * The `ask` area, owned by lane `eng-ai`. Conversation reads and the suggestion list are served here; `Ask/run` and
 * `Ask/decide` lazy-load the agent loop from `ai/impl/` so the neutral engine stays inside its bundle budget.
 */
const impl = () => import('../ai/impl/ask');

export const handlers: AreaHandlers<'ask'> = {
  'Ask/run': async (args, ctx) => (await impl()).run(args, ctx),
  'Ask/cancel': async (args, ctx) => (await impl()).cancel(args, ctx),
  'Ask/decide': async (args, ctx) => (await impl()).decide(args, ctx),
  'Ask/suggestions': async (args, ctx) => (await impl()).suggestions(args, ctx),
  'Conversation/get': async (args, ctx) => (await impl()).conversationGet(args, ctx),
  'Conversation/destroy': async (args, ctx) => (await impl()).conversationDestroy(args, ctx),
};
