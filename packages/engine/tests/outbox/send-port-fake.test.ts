import { fakeClock } from '../../src/clock/module';
import { sendPortContract } from '../ports/send-port-contract';
import { ACCOUNT } from '../store/helpers';
import { countingSend } from './helpers';

/** The counting fake is a `SendPort` like any adapter, so it must pass the same `findSent` contract. */
sendPortContract('counting fake SendPort', () => {
  const server = countingSend(fakeClock(Date.UTC(2026, 9, 28, 9, 0, 0)));
  return {
    port: server.port,
    account: ACCOUNT,
    deliver: (internetId, at) => server.seedSent(internetId, at),
    keepDraft: internetId => server.uploadDraft(internetId),
  };
});
