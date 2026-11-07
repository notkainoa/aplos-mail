import type { AreaHandlers } from './types';

/**
 * The `ai` area, owned by lane `eng-ai`. Every handler is a thin dispatcher: the provider table, feature readiness,
 * usage reads and the provider-call path all lazy-load `ai/impl/` so the neutral engine stays inside its bundle
 * budget (ARCH 8).
 */
const I = () => import('../ai/impl/ai-methods');
const R = () => import('../ai/impl/ai-reads');

export const handlers: AreaHandlers<'ai'> = {
  'Ai/request': async (args, ctx) => (await I()).request(args, ctx),
  'Ai/jobs': async (args, ctx) => (await I()).jobs(args, ctx),
  'Ai/polish': async (args, ctx) => (await I()).polish(args, ctx),
  'Ai/draft': async (args, ctx) => (await I()).draft(args, ctx),
  'Ai/transcribe': async (args, ctx) => (await I()).transcribe(args, ctx),
  'Ai/cancel': async (args, ctx) => (await I()).cancel(args, ctx),
  'Ai/followup': async (args, ctx) => (await I()).followup(args, ctx),
  'Ai/dismissFollowup': async (args, ctx) => (await I()).dismissFollowup(args, ctx),
  'Ai/providers': async (args, ctx) => (await R()).providers(args, ctx),
  'Ai/models': async (args, ctx) => (await R()).models(args, ctx),
  'Ai/status': async (args, ctx) => (await R()).status(args, ctx),
  'Ai/usage': async (args, ctx) => (await R()).usage(args, ctx),
  'Ai/setKey': async (args, ctx) => (await I()).setKey(args, ctx),
  'Ai/removeKey': async (args, ctx) => (await I()).removeKey(args, ctx),
  'Ai/testKey': async (args, ctx) => (await I()).testKey(args, ctx),
  'Ai/test': async (args, ctx) => (await I()).test(args, ctx),
};
