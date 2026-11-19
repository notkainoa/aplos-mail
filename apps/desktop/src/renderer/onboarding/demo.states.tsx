/**
 * Preview fixtures for "Try demo mail" (DESIGN 7.1 demo row, 7.11 step 1, 7.13; plan 30 U8 acceptance 6; flow.ts
 * `demoLoaded` ends the session as `demo` and skips first sync).
 *
 * - `demo-loading`: Welcome while `Demo/load` runs. The window shows what `OnboardingApp.onTryDemo` sets: the one
 *   visually hidden status "Loading demo mail." and a second click is ignored. Welcome's strip button has no busy
 *   look yet (REQUEST ui-foundation: a `demoBusy` flag on `OnboardingStep`), so the picture is Welcome itself.
 * - `demo-loaded`: the moment after the handoff, drawn as the mail window: the sidebar footer's status slot says
 *   "Demo mail · Remove in Settings" (real `StatusSlot`) and the one toast says "Demo mail loaded. Remove it any
 *   time in Settings." (real `ToastStack`) over the pane. Home's list belongs to the Home lane and is left out.
 *
 * The gallery (`./preview/main.tsx`) imports `demoStates` with the same shape as `stepStates`.
 */
import type { JSX } from 'react';
import { ToastStack } from '../ui/surfaces';
import { StatusSlot } from '../ui/status/StatusSlot';
import { DEMO_NOTICE } from './demo';
import { SlotBackdrop } from './reconnect/states';
import { Welcome } from './steps/Welcome';

const noop = () => undefined;

/** The status line the window announces while `Demo/load` runs (OnboardingApp `setStatus`). */
export const DEMO_LOADING_STATUS = 'Loading demo mail.';

export const demoStates: Record<
  string,
  { title: string; render: () => JSX.Element; height?: number }
> = {
  'demo-loading': {
    title:
      'Try demo mail clicked: Demo/load running (Welcome, one status line announced, second click ignored)',
    render: () => (
      <Welcome
        chrome={{
          dashes: { step: 1, of: 4 },
          onTryDemo: noop,
          onBack: noop,
          status: DEMO_LOADING_STATUS,
        }}
        onAddAccount={noop}
        onSkip={noop}
      />
    ),
  },
  'demo-loaded': {
    title:
      'Demo mail loaded: the mail window with the demo status slot and the "Demo mail loaded" toast',
    render: () => (
      <SlotBackdrop slot={<StatusSlot status={{ kind: 'demo' }} onAction={noop} />}>
        <ToastStack
          toasts={[
            {
              id: 'demo-loaded',
              kind: 'info',
              message: DEMO_NOTICE.loaded,
              undoable: false,
              persistent: true,
            },
          ]}
          onAction={noop}
          onDismiss={noop}
        />
      </SlotBackdrop>
    ),
  },
};
