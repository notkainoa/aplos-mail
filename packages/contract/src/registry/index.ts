import type * as z from 'zod/mini';
import { ContractError } from '../errors';
import { messages } from '../schemas/common';
import { account, sync, unsubscribe, workflow } from '../api/account';
import { ai, ask, consent, demo, setup } from '../api/ai';
import { clients, data, diagnostics, listener, notification, queue, sender } from '../api/admin';
import { draft, event, submission } from '../api/compose';
import { outbox, session, settings } from '../api/core';
import { blob, later, mail, operation, reminder, thread, view } from '../api/mail';
import { native } from '../api/native';
import type { Area, EngineArea, MethodDef } from './define';

export * from './define';

/** The whole v1 contract: every method's schemas and metadata. The single source the generator, hosts and clients read. */
export const methods = {
  ...session,
  ...settings,
  ...view,
  ...thread,
  ...operation,
  ...mail,
  ...blob,
  ...draft,
  ...submission,
  ...outbox,
  ...later,
  ...reminder,
  ...notification,
  ...ai,
  ...ask,
  ...setup,
  ...demo,
  ...consent,
  ...queue,
  ...diagnostics,
  ...listener,
  ...clients,
  ...account,
  ...sync,
  ...workflow,
  ...unsubscribe,
  ...event,
  ...sender,
  ...data,
  ...native,
};

const groups = [
  session,
  settings,
  view,
  thread,
  operation,
  mail,
  blob,
  draft,
  submission,
  outbox,
  later,
  reminder,
  notification,
  ai,
  ask,
  setup,
  demo,
  consent,
  queue,
  diagnostics,
  listener,
  clients,
  account,
  sync,
  workflow,
  unsubscribe,
  event,
  sender,
  data,
  native,
];
if (groups.reduce((n, group) => n + Object.keys(group).length, 0) !== Object.keys(methods).length)
  throw new Error('Two areas register the same method name.');

export type Methods = typeof methods;
export type MethodName = keyof Methods & string;
export type EngineMethodName = {
  [K in MethodName]: Methods[K]['host'] extends 'engine' ? K : never;
}[MethodName];
export type DesktopMethodName = Exclude<MethodName, EngineMethodName>;
/** The methods one area file owns. */
export type AreaMethodName<A extends Area> = {
  [K in MethodName]: Methods[K]['area'] extends A ? K : never;
}[MethodName];
export type Input<M extends MethodName> = z.infer<Methods[M]['input']>;
export type Output<M extends MethodName> = z.infer<Methods[M]['output']>;
export type { EngineArea };

export const methodNames = Object.keys(methods) as MethodName[];

export function isMethod(name: string): name is MethodName {
  return Object.prototype.hasOwnProperty.call(methods, name);
}

export function getMethod(name: string): MethodDef {
  if (!isMethod(name))
    throw new ContractError({ type: 'unsupported', message: 'Unsupported application method.' });
  return methods[name] as MethodDef;
}

type Issue = { code: string; message: string; path: PropertyKey[]; expected?: unknown };

/**
 * Today's validators speak in sentences the UI shows. A schema's own message wins; zod's generic "Invalid input" maps to
 * the sentence today's hand-written validators used for the same kind of mistake.
 */
export function issueMessage(issue: Issue): string {
  if (issue.message && issue.message !== 'Invalid input') return issue.message;
  if (issue.code === 'invalid_type') {
    if (issue.expected === 'object') return messages.object;
    if (issue.expected === 'boolean') return messages.checkbox;
    if (issue.expected === 'number' || issue.expected === 'int') return messages.number;
    return messages.text;
  }
  if (issue.code === 'too_big' || issue.code === 'too_small') return messages.text;
  if (issue.code === 'invalid_value' || issue.code === 'invalid_union') return messages.option;
  return 'Invalid input.';
}

function failure(issues: readonly Issue[]): ContractError {
  const issue = issues[0];
  const path = issue.path.filter(
    (p): p is string | number => typeof p === 'string' || typeof p === 'number',
  );
  return new ContractError({
    type: 'validation',
    message: issueMessage(issue),
    ...(path.length ? { path } : {}),
  });
}

/** Validates a call's arguments at a host boundary; throws `validation` with the human sentence and the field's path. */
export function parseArgs<M extends MethodName>(method: M, args: unknown): Input<M> {
  const result = getMethod(method).input.safeParse(args ?? {});
  if (!result.success) throw failure(result.error.issues as readonly Issue[]);
  return result.data as Input<M>;
}

/** Validates a result against the method's output schema. For tests and dev builds only (ARCH 9.3). */
export function checkResult<M extends MethodName>(method: M, result: unknown): Output<M> {
  const parsed = getMethod(method).output.safeParse(result);
  if (!parsed.success)
    throw new ContractError({
      type: 'internal',
      message: `${method} returned a result outside its schema: ${issueMessage(parsed.error.issues[0] as Issue)}`,
    });
  return parsed.data as Output<M>;
}

/** The engine areas in a stable order, with the methods each owns (F5 dispatch, registry tests). */
export function methodsByArea(): Record<EngineArea, string[]> {
  const out = {} as Record<EngineArea, string[]>;
  for (const name of methodNames) {
    const def = getMethod(name);
    if (def.host === 'engine') (out[def.area as EngineArea] ??= []).push(name);
  }
  return out;
}
