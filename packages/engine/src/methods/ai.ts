import type { AreaHandlers } from './types';
import { notImplemented } from './types';

/**
 * The `ai` area, owned by lane `eng-ai`. Every handler is a thin dispatcher: the provider table, feature readiness,
 * usage reads and the provider-call path all lazy-load `ai/impl/` so the neutral engine stays inside its bundle
 * budget (ARCH 8).
 */
const impl = () => import('../ai/impl/ai-methods');
const reads = () => import('../ai/impl/ai-reads');

export const handlers: AreaHandlers<'ai'> = {
  'Ai/request': async (args, ctx) => (await impl()).impl.request(args, ctx),
  'Ai/jobs': async (args, ctx) => (await impl()).impl.jobs(args, ctx),
  'Ai/polish': notImplemented('Ai/polish'),
  'Ai/draft': notImplemented('Ai/draft'),
  'Ai/transcribe': notImplemented('Ai/transcribe'),
  'Ai/cancel': async (args, ctx) => (await impl()).impl.cancel(args, ctx),
  'Ai/followup': notImplemented('Ai/followup'),
  'Ai/dismissFollowup': notImplemented('Ai/dismissFollowup'),
  'Ai/providers': async (args, ctx) => (await reads()).providers(args, ctx),
  'Ai/models': async (args, ctx) => (await reads()).models(args, ctx),
  'Ai/status': async (args, ctx) => (await reads()).status(args, ctx),
  'Ai/usage': async (args, ctx) => (await reads()).usage(args, ctx),
  'Ai/setKey': async (args, ctx) => (await impl()).impl.setKey(args, ctx),
  'Ai/removeKey': async (args, ctx) => (await impl()).impl.removeKey(args, ctx),
  'Ai/testKey': async (args, ctx) => (await impl()).impl.testKey(args, ctx),
  'Ai/test': async (args, ctx) => (await impl()).impl.test(args, ctx),
};
