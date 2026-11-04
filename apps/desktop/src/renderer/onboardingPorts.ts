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
 * The onboarding window's own calls. `Window/finishOnboarding` takes no input yet, so first sync's "Open Settings"
 * (`to: 'settings.ai'`) hands over without the target (REQUEST contract: an optional `{ to }`).
 */
export const dataWindowPorts: Partial<WindowPorts> = {
  finish: () => api.window.finishOnboarding(),
};
