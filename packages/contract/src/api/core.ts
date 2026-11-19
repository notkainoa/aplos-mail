import * as z from 'zod/mini';
import { area } from '../registry/define';
import { Count, Empty, Id, line, OpId, openEnum, Receipt, State } from '../schemas/common';
import { Session } from '../schemas/session';
import { Settings, SettingsPatch } from '../schemas/settings';

export const session = area('session', {
  'Session/get': {
    summary:
      'Handshake facts: versions, dbEpoch and state, engine state, capabilities, whether any account exists, the engine clock.',
    kind: 'query',
    scope: 'read',
    input: Empty,
    output: Session,
  },
  'Session/changes': {
    summary:
      'What changed since a state, for catch-up after a reconnect; `cannotCalculateChanges` below the change-log floor or across dbEpochs.',
    kind: 'query',
    scope: 'read',
    input: z.object({
      since: State,
      types: z.optional(z.array(line(40)).check(z.maxLength(50))),
      maxChanges: z.optional(z.int().check(z.minimum(1), z.maximum(10_000))),
    }),
    output: z.object({
      oldState: State,
      newState: State,
      hasMore: z.boolean(),
      /** `*` is a coarse "this type changed in account id" entry written once per backfill page (ARCH 3.5). */
      changes: z.array(z.object({ type: line(40), id: Id, op: openEnum(['u', 'd', '*']) })),
    }),
  },
});

export const settings = area('settings', {
  'Settings/get': {
    summary: 'The settings singleton.',
    kind: 'query',
    scope: 'read',
    input: Empty,
    output: Settings,
  },
  'Settings/set': {
    summary:
      'Change settings by section; `stateMismatch` when `ifInState` is behind. The `ai` section (providers, their addresses, the paid mark, features, background) and three `mail` fields that change what the owner is exposed to or can undo (`remoteImages`, `imageAllowList`, `undoSendSeconds`) are for Electron windows only.',
    kind: 'command',
    scope: 'admin',
    audit: true,
    windowOnlyArgs: [
      'patch.ai',
      'patch.mail.remoteImages',
      'patch.mail.imageAllowList',
      'patch.mail.undoSendSeconds',
    ],
    input: z.object({ opId: OpId, patch: SettingsPatch, ifInState: z.optional(State) }),
    output: z.object({ settings: Settings, receipt: Receipt }),
  },
});

export const outbox = area('outbox', {
  'Outbox/pending': {
    summary:
      'Work that will not happen while Aplos is quit, for the ⌘Q warning: scheduled sends, reminders and unconfirmed sends.',
    kind: 'query',
    scope: 'read',
    input: Empty,
    output: z.object({
      scheduledSends: Count,
      reminders: Count,
      uncertain: Count,
      nextAt: z.optional(Count),
    }),
  },
});
