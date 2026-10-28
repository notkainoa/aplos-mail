import type { Fixture, Handlers } from '../engine';
import { account } from './account';
import { ai } from './ai';
import { compose } from './compose';
import { core } from './core';
import { mail } from './mail';

/** Every engine method of contract v1. A method missing here fails the typecheck, so the fixture never falls behind the registry. */
export function handlers(fx: Fixture): Handlers {
  return { ...core(fx), ...mail(fx), ...compose(fx), ...ai(fx), ...account(fx) };
}
