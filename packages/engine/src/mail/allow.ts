import type { Input, Output } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { MethodContext } from '../methods/types';
import { auditWrites } from '../host/module';
import { cleanList, editList, MAX_ALLOW_LIST } from './allow-list';
import { normaliseMatch, readAllowList } from './policy';

// `Mail/allowImages`: "Load images from this sender" adds a normalised address or `@domain` to
// `Settings.mail.imageAllowList`, or removes it, in one commit under the caller's `opId` (a replay changes nothing and
// answers the first receipt's state). Frames already issued keep the policy they were rendered with; the reader asks
// `Mail/frame` again for a new token.

export function allowImages(
  args: Input<'Mail/allowImages'>,
  ctx: MethodContext,
): Output<'Mail/allowImages'> {
  const { store } = ctx.services;
  const sender = normaliseMatch(args.sender);
  if (sender === undefined)
    throw new ContractError({ type: 'validation', message: 'Enter an email address or @domain.' });
  const allow = args.allow === true;
  const next = editList(cleanList(store.read(readAllowList)), sender, allow);
  if (next && next.length > MAX_ALLOW_LIST)
    throw new ContractError({
      type: 'tooLarge',
      message: 'Images are already allowed from 5,000 senders. Remove some first.',
    });
  const result = store.commit({
    opId: args.opId,
    origin: 'local',
    writes: [
      { kind: 'imageAllowList', sender, allow },
      // `audit: true`: a listener client's change is logged, content-free, in the same commit.
      ...auditWrites(ctx.caller, 'Mail/allowImages', sender),
    ],
  });
  return {
    opId: args.opId,
    appliedState: { dbEpoch: result.dbEpoch, seq: result.seq },
    undoable: false,
  };
}
