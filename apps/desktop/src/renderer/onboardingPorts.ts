/**
 * The onboarding lane's ports, supplied from the data layer (the "ports wiring" `renderer/onboarding` asks the shell
 * for). `onboarding/connect.ts` and `OnboardingApp` default to ports that throw "not on the data surface yet"; the
 * data surface has the methods now, so the onboarding window (`main.tsx`) and the inline Add account host
 * (`shell/AddAccountHost`) pass these instead.
 */
import { api } from './data';
import type { ConnectPorts } from './onboarding/connect';
import type { WindowPorts } from './onboarding/OnboardingApp';

/** Discover, connect and cancel a new-account flow through `api.account`. */
export const dataConnectPorts: ConnectPorts = {
  discover: input => api.account.discover(input),
  connect: input => api.account.connect(input),
  cancelConnect: input => api.account.cancelConnect(input),
};

/**
 * The onboarding window's own calls. `Window/finishOnboarding` takes an optional `{ to: 'settings.ai' }` (eng-contract,
 * #289): first sync's "Open Settings" passes it through, every other handoff sends none. Main ignores `to` until
 * eng-host's follow-up, so this only forwards it.
 */
export const dataWindowPorts: Partial<WindowPorts> = {
  finish: input => api.window.finishOnboarding(input ?? {}),
};
