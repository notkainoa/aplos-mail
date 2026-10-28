/**
 * The onboarding window's root (DESIGN 7.11; plan 30 U8; Appendix C F1, F9, F12, F13). A separate 640 × 600 window,
 * full-bleed white paper. Each step draws its own frame through `OnboardingStep`: the 48 px strip with "Try demo
 * mail", the top-anchored step in a 64 px side margin that scrolls inside the window (Welcome alone is centred with
 * `safe center`), and the footer with the dashes, "Setup continues in the background." and the step's buttons.
 *
 * What the root owns:
 * - The step machine (`flow.ts`) and the Accounts connect flow (`connect.ts`), because a connect can answer after the
 *   owner left the Accounts step, or after the window closed. Such an answer updates the account list and is
 *   recorded; it never navigates (F9).
 * - `Setup/begin` on mount and exactly one `Setup/end` for the session: on finish, Skip setup, demo, or `pagehide`
 *   (F1). Main also calls `Setup/end` when the window closes; the call is idempotent.
 * - Keys, through the command registry's `onboarding` and `firstSync` contexts: Return runs the step's main action
 *   when focus is not on a control, Esc lets the step undo its own state first, then goes back a step; on Welcome it
 *   is "Skip setup" and on first sync it opens Aplos. Tab order is the DOM order, which is the visual order.
 * - Focus (F12): on every step change and every internal state change the step names its main action, and the root
 *   moves focus there after the frame paints. A late engine answer never changes the focus key, so it never moves
 *   focus.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, useAccounts } from '../data';
import type { Account, Input, Output } from '../data';
import { createAppRegistry, DEFAULT_KEY_PREFS, focusKindOf } from '../commands';
import type { CommandContext } from '../commands';
import type { TagColor } from '../ui/props';
import {
  accountsEsc,
  accountsFocus,
  accountsMain,
  defaultConnectPorts,
  frameEvent,
  frameOutcome,
  initialAccounts,
  reduceAccounts,
  runAccountsEffect,
  shownMode,
  useConnectFrames,
  type AccountsEvent,
  type AccountsResult,
  type ConnectPorts,
} from './connect';
import {
  flowView,
  initialFlow,
  MAIN_LABEL,
  missingMethod,
  reduceFlow,
  type FlowEffect,
  type FlowEvent,
  type FocusTarget,
  type StepChrome,
  type StepId,
  type StepKeys,
} from './flow';
import { AccountsStep, type AccountRowData } from './steps/Accounts';
import { AiContainer, type AiPorts } from './steps/Ai';
import { PermissionsContainer, type SystemPorts } from './steps/Permissions';
import { Welcome } from './steps/Welcome';

/** What the first-sync screen (`onboarding/firstSync/`) gets from the window. */
export interface FirstSyncSlotProps {
  /** Open Aplos: Return, Esc, "Continue anyway", or by itself on a clean finish. Ends setup once and hands over. */
  readonly onOpen: () => void;
  /** Reconnect one account from a failed row. */
  readonly onReconnect: (accountId: string) => void;
}

/** The window-level calls. Defaults come from `renderer/data`; the preview and tests pass their own. */
export interface WindowPorts {
  setupBegin(input: Input<'Setup/begin'>): Promise<Output<'Setup/begin'>>;
  setupEnd(input: Input<'Setup/end'>): Promise<unknown>;
  demoLoad(): Promise<unknown>;
  /** `Window/finishOnboarding`: main shows the mail window on `ready-to-show` and closes this one (F4). */
  finish(): Promise<unknown>;
  reconnect(input: Input<'Account/reconnect'>): Promise<unknown>;
}

// REQUEST ui-shell: `Window/finishOnboarding` (and `Window/openOnboarding` for "Show welcome") are desktop methods that
// `renderer/data`'s api does not expose yet.
export const defaultWindowPorts: WindowPorts = {
  setupBegin: async input => api.setup.begin(input),
  setupEnd: async input => api.setup.end(input),
  demoLoad: async () => api.demo.load(),
  finish: async () => {
    throw missingMethod('Window/finishOnboarding');
  },
  reconnect: async input => api.account.reconnect(input),
};

export interface OnboardingAppProps {
  /** 'first' = first run; 'review' = "Show welcome" from Settings beside the mail window. */
  readonly mode?: 'first' | 'review';
  /** The first-sync screen, built in `onboarding/firstSync/`. */
  readonly renderFirstSync: (props: FirstSyncSlotProps) => ReactNode;
  readonly ports?: Partial<WindowPorts>;
  readonly connectPorts?: Partial<ConnectPorts>;
  readonly aiPorts?: Partial<AiPorts>;
  readonly systemPorts?: Partial<SystemPorts>;
}

/* ---------- Focus (F12) ---------- */

/** A button's visible label: its text without keycaps. */
export function buttonLabel(button: Element): string {
  let text = '';
  button.childNodes.forEach(node => {
    if (node.nodeName === 'KBD') return;
    text += node.textContent ?? '';
  });
  return text.trim();
}

/**
 * Moves focus to a step's main action. Returns false when the target is not on screen or cannot take focus.
 * `keepTop` (a new step) focuses without scrolling and shows the step from its top, so a long step at 640 × 520
 * opens on its title, never part-way down (F13); within a step, focus scrolls the control into view.
 */
export function focusTarget(root: HTMLElement | null, target: FocusTarget, keepTop = false): boolean {
  if (!root) return false;
  let el: HTMLElement | null = null;
  if (target.kind === 'field') {
    el = root.querySelector<HTMLElement>(`#${CSS.escape(target.id)}`);
  } else {
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('main button, footer button'));
    el = buttons.find(b => !b.disabled && buttonLabel(b) === target.label) ?? null;
  }
  if (!el || (el as HTMLButtonElement | HTMLInputElement).disabled) return false;
  el.focus(keepTop ? { preventScroll: true } : undefined);
  if (keepTop) showTop(root);
  return document.activeElement === el;
}

/** Scrolls the step's body back to its top. */
export function showTop(root: HTMLElement | null): void {
  const body = root?.querySelector('main');
  if (body) body.scrollTop = 0;
}

/* ---------- The root ---------- */

const TAGS: readonly TagColor[] = ['sky', 'hill', 'stamp', 'dusk', 'sand', 'ember'];

function tagOf(colorTag: string | undefined): TagColor | undefined {
  const name = colorTag?.replace(/^(--)?tag-/, '');
  return TAGS.find(t => t === name);
}

export function accountRows(accounts: readonly Account[]): AccountRowData[] {
  return accounts.map(a => {
    const color = tagOf(a.colorTag);
    return { id: a.id, address: a.address, demo: a.demo, ...(color ? { color } : {}) };
  });
}

const noop = () => {};

export function OnboardingApp(props: OnboardingAppProps) {
  const ports = useRef({ ...defaultWindowPorts, ...props.ports }).current;
  const connectPorts = useRef({ ...defaultConnectPorts, ...props.connectPorts }).current;
  const accounts = useAccounts();
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  const hasDemo = accounts.some(a => a.demo);

  const [flow, setFlow] = useState(() => initialFlow({ hasDemo }));
  const flowRef = useRef(flow);
  const [acc, setAcc] = useState(() => initialAccounts(accounts.length > 0));
  const accRef = useRef(acc);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const setupId = useRef<string | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);

  /* Effects of the step machine: one Setup/end, then the handoff. */
  const runFlowEffects = useCallback(
    (effects: readonly FlowEffect[]) => {
      for (const effect of effects) {
        if (effect.type === 'setupEnd') {
          const id = setupId.current;
          ports.setupEnd({ ...(id ? { setupId: id } : {}), reason: effect.reason }).catch(noop);
        } else {
          ports
            .finish()
            .then(() => setStatus(undefined))
            .catch(() =>
              setStatus("Aplos couldn't open your mail window. Press Return to try again."),
            );
        }
      }
    },
    [ports],
  );

  /* The Accounts flow: state, effects, and the answers they bring back. */
  const applyAcc = useCallback(
    (out: AccountsResult) => {
      accRef.current = out.state;
      setAcc(out.state);
      for (const effect of out.effects) {
        void runAccountsEffect(effect, connectPorts, onAccountsAnswer, setupId.current);
      }
    },
    // onAccountsAnswer (below) forwards through a ref, so this callback never goes stale.
    [connectPorts],
  );

  const dispatchFlow = useCallback(
    (event: FlowEvent) => {
      const before = flowRef.current.step;
      const out = reduceFlow(flowRef.current, event);
      flowRef.current = out.state;
      setFlow(out.state);
      if (before !== 'accounts' && out.state.step === 'accounts') {
        applyAcc(
          reduceAccounts(accRef.current, { type: 'enter', hasAccounts: accountsRef.current.length > 0 }),
        );
      }
      runFlowEffects(out.effects);
    },
    [applyAcc, runFlowEffects],
  );

  const answerRef = useRef<(event: AccountsEvent) => void>(noop);
  answerRef.current = (event: AccountsEvent) => {
    applyAcc(reduceAccounts(accRef.current, event));
    if (event.type === 'started' && accRef.current.connectId === event.connectId) {
      dispatchFlow({ type: 'connectStarted', connectId: event.connectId });
    }
  };
  function onAccountsAnswer(event: AccountsEvent): void {
    answerRef.current(event);
  }

  const dispatchAcc = useCallback(
    (event: AccountsEvent) => applyAcc(reduceAccounts(accRef.current, event)),
    [applyAcc],
  );

  /* Every new-account connect frame, late ones included (F9). */
  useConnectFrames(frame => {
    applyAcc(reduceAccounts(accRef.current, frameEvent(frame)));
    const outcome = frameOutcome(frame.state);
    if (outcome) {
      dispatchFlow({
        type: 'connectResolved',
        connectId: frame.connectId,
        outcome,
        ...(frame.accountId ? { accountId: frame.accountId } : {}),
      });
    }
  });

  /* Setup/begin once; Setup/end when the window goes away (main calls it too). */
  const began = useRef(false);
  useEffect(() => {
    if (began.current) return;
    began.current = true;
    ports
      .setupBegin({ origin: props.mode === 'review' ? 'settings' : 'onboarding' })
      .then(out => {
        setupId.current = out.setupId;
      })
      .catch(noop);
  }, [ports, props.mode]);

  useEffect(() => {
    const onHide = () => dispatchFlow({ type: 'close' });
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [dispatchFlow]);

  /* Keys and focus. */
  const keysRef = useRef<StepKeys | null>(null);
  const lastFocusKey = useRef('');
  const bindKeys = useCallback((keys: StepKeys) => {
    keysRef.current = keys;
    if (keys.focusKey === lastFocusKey.current) return;
    const newStep = keys.focusKey.split(':')[0] !== lastFocusKey.current.split(':')[0];
    lastFocusKey.current = keys.focusKey;
    const target = keys.focus;
    requestAnimationFrame(() => {
      if (lastFocusKey.current !== keys.focusKey) return;
      if (target) focusTarget(rootRef.current, target, newStep);
      else if (newStep) showTop(rootRef.current);
    });
  }, []);

  const handleEsc = useCallback(() => {
    if (keysRef.current?.esc?.()) return;
    dispatchFlow({ type: 'esc' });
  }, [dispatchFlow]);

  const registry = useMemo(() => createAppRegistry(), []);
  useEffect(() => {
    const detach = [
      registry.attach('onboarding.continue', {
        when: () => Boolean(keysRef.current?.main),
        run: () => keysRef.current?.main?.(),
      }),
      registry.attach('onboarding.back', { run: handleEsc }),
      registry.attach('onboarding.skipSetup', { run: handleEsc }),
      registry.attach('onboarding.openAplos', { run: handleEsc }),
    ];
    return () => detach.forEach(off => off());
  }, [registry, handleEsc]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const view = flowView(flowRef.current);
      const ctx: CommandContext = {
        stack: view.contexts,
        target: null,
        selection: [],
        conditions: { welcome: view.welcome },
        prefs: DEFAULT_KEY_PREFS,
        focus: focusKindOf(event.target),
      };
      const resolution = registry.resolve(event, ctx);
      if (!resolution || resolution.phase !== 'tap') return;
      event.preventDefault();
      registry.run(resolution.commandId, ctx);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [registry]);

  /* Step-guarded moves: a slow answer from a step the owner already left never moves the window. */
  const nextFrom = useCallback(
    (step: StepId) => () => {
      if (flowRef.current.step === step) dispatchFlow({ type: 'next' });
    },
    [dispatchFlow],
  );

  const demoBusy = useRef(false);
  const onTryDemo = useCallback(() => {
    if (demoBusy.current) return;
    demoBusy.current = true;
    setStatus('Loading demo mail.');
    ports
      .demoLoad()
      .then(() => dispatchFlow({ type: 'demoLoaded' }))
      .catch(() => setStatus("Demo mail didn't load. Try again, or add an account."))
      .finally(() => {
        demoBusy.current = false;
      });
  }, [ports, dispatchFlow]);

  const view = flowView(flow);
  const mode = shownMode(acc, accounts.length);
  const chrome: StepChrome = {
    ...(view.dashes ? { dashes: view.dashes } : {}),
    ...(view.tryDemo && !hasDemo ? { onTryDemo } : {}),
    onBack: handleEsc,
    ...(status ? { status } : {}),
  };

  const connect = useCallback(
    (loginHint?: string) => dispatchAcc({ type: 'connect', ...(loginHint ? { loginHint } : {}) }),
    [dispatchAcc],
  );

  // The root draws Welcome, Accounts and first sync itself, so it names their keys; AI and permissions bind their own.
  useLayoutEffect(() => {
    if (view.step === 'welcome') {
      bindKeys({
        focusKey: 'welcome',
        focus: { kind: 'button', label: MAIN_LABEL.welcome },
        main: nextFrom('welcome'),
      });
    } else if (view.step === 'accounts') {
      const main = accountsMain(mode);
      bindKeys({
        focusKey: `accounts:${mode}`,
        focus: accountsFocus(mode),
        main:
          main === 'discover'
            ? () => dispatchAcc({ type: 'submit' })
            : main === 'connect'
              ? () => connect(accRef.current.address)
              : main === 'retry'
                ? () => connect(accRef.current.loginHint ?? accRef.current.address)
                : main === 'continue'
                  ? nextFrom('accounts')
                  : undefined,
        esc: () => {
          const out = accountsEsc(accRef.current, accountsRef.current.length > 0);
          if (out.handled) applyAcc(out);
          return out.handled;
        },
      });
    } else if (view.step === 'firstSync') {
      bindKeys({ focusKey: 'firstSync' });
    }
  });

  return (
    <div className="onb-window" ref={rootRef}>
      {view.step === 'welcome' ? (
        <Welcome
          chrome={chrome}
          onAddAccount={nextFrom('welcome')}
          onSkip={() => dispatchFlow({ type: 'skip' })}
        />
      ) : view.step === 'accounts' ? (
        <AccountsStep
          chrome={chrome}
          mode={mode}
          address={acc.address}
          notice={acc.notice}
          failure={acc.failure}
          accounts={accountRows(accounts)}
          onEdit={address => dispatchAcc({ type: 'edit', address })}
          onSubmit={() => dispatchAcc({ type: 'submit' })}
          onConnect={() =>
            connect(acc.mode === 'failed' ? (acc.loginHint ?? acc.address) : acc.address)
          }
          onChooseGoogle={() => connect()}
          onCancel={() => dispatchAcc({ type: 'cancel' })}
          onClear={() => dispatchAcc({ type: 'clear' })}
          onContinue={nextFrom('accounts')}
          onAddAnother={() => dispatchAcc({ type: 'addAnother' })}
        />
      ) : view.step === 'ai' ? (
        <AiContainer
          chrome={chrome}
          bindKeys={bindKeys}
          onDone={nextFrom('ai')}
          {...(props.aiPorts ? { ports: props.aiPorts } : {})}
        />
      ) : view.step === 'permissions' ? (
        <PermissionsContainer
          chrome={chrome}
          bindKeys={bindKeys}
          onFinish={nextFrom('permissions')}
          {...(props.systemPorts ? { ports: props.systemPorts } : {})}
        />
      ) : (
        props.renderFirstSync({
          onOpen: () => dispatchFlow({ type: 'open' }),
          onReconnect: accountId => void ports.reconnect({ accountId }).catch(noop),
        })
      )}
    </div>
  );
}
