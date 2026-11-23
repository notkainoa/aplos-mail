/** The provider conformance suite against the Google provider on the emulator (`google.ts`). */
import { makeGoogle } from './google';
import { runProviderConformance } from './suite';

const IGNORES_FLAG =
  "GmailAdapter offers this area whatever the account's Capabilities say; refusing it needs an adapter change";

runProviderConformance(makeGoogle, {
  todo: {
    'capabilities:serverSearch': IGNORES_FLAG,
    'capabilities:filters': IGNORES_FLAG,
  },
});
