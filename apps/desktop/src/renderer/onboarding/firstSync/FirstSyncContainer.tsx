/**
 * The first-sync screen wired to the data layer (DESIGN 7.12). Thin: it reads `Setup/status`, the accounts, the
 * consent record, the settings and the clock, feeds `buildFirstSyncView`, keeps the drill's state, sends Try again
 * once per press (`Setup/retry`, idempotent [F5]), opens Aplos by itself only on a clean finish and never while the
 * drill is open, and attaches the screen's key handlers to the window's registry (Esc always opens Aplos [F8]).
 *
 * Every Open Aplos goes to the window: the window's step machine asks for the mail window once at a time and asks again
 * after a failed handoff, so nothing here latches. The window's failed handoff is drawn on this screen (`notice`).
 * The screen names its focus target to the window (F12), reads the owner's key settings (single-key shortcuts,
 * remaps) and leaves the keys alone while the reconnect sheet is open over it.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  createAppRegistry,
  focusKindOf,
  type CommandContext,
  type ContextName,
  type Registry,
} from '../../commands';
import { api, useAccounts, useConsent, useNow, useSettings, useSetupStatus } from '../../data';
import { keyPrefsFor } from '../flow';
import type { FirstSyncSlotProps } from '../OnboardingApp';
import { FirstSync } from './FirstSync';
import { DRILL_START, drillPick, drillReduce, type DrillKey, type DrillState } from './drill.model';
import {
  AUTO_OPEN_DELAY_MS,
  buildFirstSyncView,
  firstSyncCommands,
  firstSyncFocus,
  shouldSendRetry,
  type FirstSyncView,
} from './model';
import './firstSync.css';

/** Display names for the contract's provider ids (Settings → AI uses the same words). */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  groq: 'Groq',
  openai: 'OpenAI',
  anthropic: 'Claude',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
  'opencode-go': 'OpenCode Go',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  custom: 'your server',
};

export interface FirstSyncContainerProps extends FirstSyncSlotProps {
  /** The onboarding window's registry; the screen attaches its first-sync and drill handlers to it. */
  readonly registry?: Registry;
}

export function FirstSyncContainer({
  onOpen,
  onReconnect,
  onOpenSettings,
  notice,
  bindKeys,
  keysSuspended = false,
  registry,
}: FirstSyncContainerProps) {
  const status = useSetupStatus();
  const accounts = useAccounts();
  const consent = useConsent();
  const settings = useSettings();
  const now = useNow({ granularity: 'second' });

  const providerId = settings?.ai.background ? settings.ai.features.summaries.provider : undefined;
  const aiProvider = providerId ? (PROVIDER_NAMES[providerId] ?? providerId) : null;
  const consentStored = consent?.granted === true && !consent.needsReconsent;

  // Counters never move backwards within a run: each build reads the view before it.
  const previous = useRef<FirstSyncView | undefined>(undefined);
  const view = buildFirstSyncView({
    status,
    accounts,
    aiProvider,
    consentStored,
    now,
    previous: previous.current,
  });
  previous.current = view;

  const [drill, setDrill] = useState<DrillState | null>(null);

  // Esc, Return, a button or the clean finish: the window's step machine decides whether to ask for the mail window
  // (once at a time, and again after a failed handoff), so a failed handoff never leaves these keys dead.
  const open = () => onOpen();

  // Aplos opens by itself only on a clean finish, after "Your mail is ready" has shown, and not while the drill is open.
  useEffect(() => {
    if (!view.autoOpen || drill) return;
    const timer = setTimeout(open, AUTO_OPEN_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.autoOpen, drill !== null]);

  // One Try again in flight per account [F5].
  const inFlight = useRef(new Set<string>());
  const retry = (accountId: string) => {
    if (!shouldSendRetry(view, accountId, inFlight.current)) return;
    inFlight.current.add(accountId);
    void api.setup
      .retry({ accountId, setupId: status?.setupId })
      .catch(() => undefined)
      .finally(() => inFlight.current.delete(accountId));
  };

  const drillKey = (key: DrillKey) => setDrill(d => (d ? drillReduce(d, key) : d));

  // Focus (F12): the filled button or Continue anyway on entering, again when the button turns on, the drill's list.
  const focus = firstSyncFocus(view, drill !== null);
  useLayoutEffect(() => {
    bindKeys?.(focus);
  });

  // The owner's key settings: the single-key switch and remaps apply to the drill's letters too (WCAG 2.1.4).
  const prefs = keyPrefsFor(settings?.ui);

  // Keys come through the registry; the handlers read the latest view and drill at key time.
  const latest = useRef({ view, drill, open, drillKey, prefs, keysSuspended, notice });
  latest.current = { view, drill, open, drillKey, prefs, keysSuspended, notice };
  // Without the window's registry the screen still owns Esc [F8]: it resolves keys through a registry of its
  // own, so a missing wiring can never leave Esc stuck — and the drill's keycaps read the same remaps.
  const own = useMemo(
    () => (registry ? null : createAppRegistry(latest.current.prefs)),
    [registry],
  );
  useEffect(() => {
    own?.configure(prefs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [own, settings?.ui]);
  useEffect(() => {
    const target = registry ?? own;
    if (!target) return;
    const handlers = firstSyncCommands({
      view: () => latest.current.view,
      drillOpen: () => latest.current.drill !== null,
      notice: () => latest.current.notice,
      onOpen: () => latest.current.open(),
      onDrill: key => latest.current.drillKey(key),
      onLeaveDrill: () => setDrill(null),
    });
    const detach = Object.entries(handlers).map(([id, h]) => target.attach(id, h));
    let unlisten = () => undefined as void;
    if (!registry) {
      const onKey = (event: KeyboardEvent) => {
        if (event.isComposing || event.defaultPrevented) return;
        // The reconnect sheet is open over the screen: Esc and Return are the sheet's.
        if (latest.current.keysSuspended) return;
        const stack: ContextName[] = latest.current.drill
          ? ['onboarding', 'firstSync', 'drill']
          : ['onboarding', 'firstSync'];
        const ctx: CommandContext = {
          stack,
          target: null,
          selection: [],
          conditions: {},
          prefs: latest.current.prefs,
          focus: focusKindOf(document.activeElement),
        };
        const hit = target.resolve(event, ctx);
        if (!hit) return;
        // A focused button keeps its own Return and Space.
        if (
          (event.key === 'Enter' || event.key === ' ') &&
          document.activeElement instanceof HTMLButtonElement
        )
          return;
        event.preventDefault();
        target.run(hit.commandId, ctx);
      };
      window.addEventListener('keydown', onKey, true);
      unlisten = () => window.removeEventListener('keydown', onKey, true);
    }
    return () => {
      unlisten();
      detach.forEach(d => d());
    };
  }, [registry, own]);

  return (
    <FirstSync
      view={view}
      drill={drill}
      now={now}
      registry={registry ?? own ?? undefined}
      onOpen={open}
      onRetry={retry}
      onReconnect={onReconnect}
      onOpenSettings={onOpenSettings}
      onTryKeys={() => setDrill(DRILL_START)}
      onLeaveDrill={() => setDrill(null)}
      onDrillKey={drillKey}
      onDrillPick={index => setDrill(d => (d ? drillPick(d, index) : d))}
      {...(notice ? { notice } : {})}
    />
  );
}
