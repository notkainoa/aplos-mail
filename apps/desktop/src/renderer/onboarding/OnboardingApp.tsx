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
 *   focus; first sync's engine-driven keys (Open Aplos turning on) move it only from nowhere or from the footer.
 * - The handoff (`Window/finishOnboarding`): asked once at a time by the step machine. A refusal is drawn in the step
 *   as a visible line with Try again (and announced once); Return, Esc, Open Aplos and Skip setup ask again too.
 * - Reconnect from a failed first-sync row opens the reconnect sheet (`reconnect/ReconnectFlow`), one account at a
 *   time; the screen's keys wait while it is open.
 * - Keys follow the owner's settings (single-key shortcuts, remaps), read from `Settings.ui`.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useAccounts, useSettings } from '../data';
import type { Account } from '../data';
import { activeFocus, focusTarget, showTop } from './focusTarget';
import { createAppRegistry, focusKindOf } from '../commands';
import type { CommandContext } from '../commands';
import { WINDOW_COPY } from './copy';
import { FirstSyncContainer } from './firstSync/FirstSyncContainer';
import { ReconnectFlow } from './reconnect/ReconnectFlow';
import { openReconnect, type ReconnectPorts } from './reconnect/reconnect.model';
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
  keyPrefsFor,
  MAIN_LABEL,
  reduceFlow,
  sessionSetupId,
  shouldMoveFocus,
  type FlowEffect,
  type FlowEvent,
  type StepChrome,
  type StepId,
  type StepKeys,
  type WindowNotice,
} from './flow';
import { AccountsStep, type AccountRowData } from './steps/Accounts';
import { AiContainer, type AiPorts } from './steps/Ai';
import { PermissionsContainer, type SystemPorts } from './steps/Permissions';
import { Welcome } from './steps/Welcome';

/** What the first-sync screen (`onboarding/firstSync/`) gets from the window. */
export interface FirstSyncSlotProps {
  /**
   * Open Aplos: Return, Esc, "Continue anyway", or by itself on a clean finish. Ends setup once and hands over; after a
   * failed handoff it asks again, so the screen calls it every time and never latches.
   */
  readonly onOpen: () => void;
  /** Reconnect one account from a failed row: the window opens the reconnect sheet (one account at a time). */
  readonly onReconnect: (accountId: string) => void;
  /** "Open Settings" after a sorting failure: hand over with Settings → AI open in the mail window. */
  readonly onOpenSettings?: () => void;
  /** The window's failed handoff, for the screen to draw visibly with Try again. */
  readonly notice?: WindowNotice;
  /** Tells the window the screen's focus target and when it changes (F12). */
  readonly bindKeys?: (keys: StepKeys) => void;
  /** A sheet is open over the screen: the screen's keys wait. */
  readonly keysSuspended?: boolean;
}

export { defaultWindowPorts, type WindowPorts } from './windowPorts';
import { defaultWindowPorts, type WindowPorts } from './windowPorts';

export interface OnboardingAppProps {
  /** 'first' = first run; 'review' = "Show welcome" from Settings beside the mail window. */
  readonly mode?: 'first' | 'review';
  /** The first-sync screen; defaults to `onboarding/firstSync/`'s container. */
  readonly renderFirstSync?: (props: FirstSyncSlotProps) => ReactNode;
  readonly ports?: Partial<WindowPorts>;
  /** The reconnect sheet's calls (first sync's Reconnect). */
  readonly reconnectPorts?: Partial<ReconnectPorts>;
  readonly connectPorts?: Partial<ConnectPorts>;
  readonly aiPorts?: Partial<AiPorts>;
  readonly systemPorts?: Partial<SystemPorts>;
}

/* ---------- Focus (F12) ---------- */

export { activeFocus, buttonLabel, focusTarget, showTop } from './focusTarget';

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

const defaultFirstSync = (slot: FirstSyncSlotProps) => <FirstSyncContainer {...slot} />;

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
  // The step where "Try demo mail" failed: its notice shows there only.
  const [demoFailedAt, setDemoFailedAt] = useState<StepId | null>(null);
  // The account whose reconnect sheet is open (first sync's Reconnect), one at a time.
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const reconnectingRef = useRef(reconnecting);
  reconnectingRef.current = reconnecting;
  const setupId = useRef<string | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const settings = useSettings();
  const keyPrefs = keyPrefsFor(settings?.ui);
  const keyPrefsRef = useRef(keyPrefs);
  keyPrefsRef.current = keyPrefs;

  /* Effects of the step machine: one Setup/end, then the handoff, whose answer goes back to the machine. */
  const flowAnswer = useRef<(event: FlowEvent) => void>(noop);
  const runFlowEffects = useCallback(
    (effects: readonly FlowEffect[]) => {
      for (const effect of effects) {
        if (effect.type === 'setupEnd') {
          const id = setupId.current;
          ports.setupEnd({ ...(id ? { setupId: id } : {}), reason: effect.reason }).catch(noop);
        } else {
          ports
            .finish(effect.to ? { to: effect.to } : undefined)
            .then(() => flowAnswer.current({ type: 'handoffDone' }))
            .catch(() => flowAnswer.current({ type: 'handoffFailed' }));
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
        // A connect after the session ended (a demo or skip whose handoff failed) carries no setupId.
        void runAccountsEffect(
          effect,
          connectPorts,
          onAccountsAnswer,
          sessionSetupId(flowRef.current, setupId.current),
        );
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
          reduceAccounts(accRef.current, {
            type: 'enter',
            hasAccounts: accountsRef.current.length > 0,
          }),
        );
      }
      runFlowEffects(out.effects);
    },
    [applyAcc, runFlowEffects],
  );
  flowAnswer.current = dispatchFlow;

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
      if (
        target &&
        shouldMoveFocus(newStep, keys.keepUserFocus === true, activeFocus(rootRef.current))
      ) {
        focusTarget(rootRef.current, target, newStep);
      } else if (newStep) showTop(rootRef.current);
    });
  }, []);

  const handleEsc = useCallback(() => {
    if (keysRef.current?.esc?.()) return;
    dispatchFlow({ type: 'esc' });
  }, [dispatchFlow]);

  const registry = useMemo(() => createAppRegistry(keyPrefsRef.current), []);
  useEffect(() => {
    registry.configure(keyPrefsRef.current);
    // The prefs object is rebuilt each render; the stored settings are what change.
  }, [registry, settings?.ui]);
  useEffect(() => {
    // After a failed handoff Return asks for the mail window again, whatever the step's own main action is.
    const handoffFailed = () => flowView(flowRef.current).handoffFailed;
    const detach = [
      registry.attach('onboarding.continue', {
        when: () => handoffFailed() || Boolean(keysRef.current?.main),
        run: () =>
          handoffFailed() ? dispatchFlow({ type: 'retryHandoff' }) : keysRef.current?.main?.(),
      }),
      registry.attach('onboarding.back', { run: handleEsc }),
      registry.attach('onboarding.skipSetup', { run: handleEsc }),
      registry.attach('onboarding.openAplos', { run: handleEsc }),
    ];
    return () => detach.forEach(off => off());
  }, [registry, handleEsc, dispatchFlow]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      // The reconnect sheet is open: its keys are its own.
      if (reconnectingRef.current !== null) return;
      const view = flowView(flowRef.current);
      const ctx: CommandContext = {
        stack: view.contexts,
        target: null,
        selection: [],
        conditions: { welcome: view.welcome },
        prefs: keyPrefsRef.current,
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
    setDemoFailedAt(null);
    setStatus(WINDOW_COPY.demoLoading);
    ports
      .demoLoad()
      .then(() => {
        setStatus(undefined);
        dispatchFlow({ type: 'demoLoaded' });
      })
      .catch(() => {
        setStatus(undefined);
        setDemoFailedAt(flowRef.current.step);
      })
      .finally(() => {
        demoBusy.current = false;
      });
  }, [ports, dispatchFlow]);

  const view = flowView(flow);
  const mode = shownMode(acc, accounts.length);
  // A failed handoff or demo load is drawn in the step (DESIGN 7.15) and announced once.
  const notice: WindowNotice | undefined = view.handoffFailed
    ? { text: WINDOW_COPY.handoffFailed, onRetry: () => dispatchFlow({ type: 'retryHandoff' }) }
    : demoFailedAt === view.step && view.tryDemo && !hasDemo
      ? { text: WINDOW_COPY.demoFailed, onRetry: onTryDemo }
      : undefined;
  const announced = notice?.text ?? status;
  const chrome: StepChrome = {
    ...(view.dashes ? { dashes: view.dashes } : {}),
    connected: flow.connected.length > 0 || accounts.length > 0,
    ...(view.tryDemo && !hasDemo ? { onTryDemo } : {}),
    onBack: handleEsc,
    ...(announced ? { status: announced } : {}),
    ...(notice ? { notice } : {}),
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
    }
    // First sync names its own focus through `bindKeys` (FirstSyncSlotProps).
  });

  const renderFirstSync = props.renderFirstSync ?? defaultFirstSync;

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
        renderFirstSync({
          onOpen: () => dispatchFlow({ type: 'open' }),
          onReconnect: accountId => setReconnecting(current => openReconnect(current, accountId)),
          onOpenSettings: () => dispatchFlow({ type: 'openSettings' }),
          ...(notice ? { notice } : {}),
          bindKeys,
          keysSuspended: reconnecting !== null,
        })
      )}
      {reconnecting !== null ? (
        <ReconnectFlow
          key={reconnecting}
          accountId={reconnecting}
          onClose={() => setReconnecting(null)}
          {...(props.reconnectPorts ? { ports: props.reconnectPorts } : {})}
        />
      ) : null}
    </div>
  );
}
