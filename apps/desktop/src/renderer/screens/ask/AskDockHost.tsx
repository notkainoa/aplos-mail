/**
 * The Ask dock's host (DESIGN §7.7, §8 Ask and Global): data hooks and `api.ask` in, `AskPanel` out, the ask
 * context's commands attached to the registry, hold-A dictation through `useDictation`. The shell mounts it while the
 * dock is open and owns `tab`/open; the props are optional so the host also runs stand-alone on `askStore`
 * (preview, tests).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CommandHandlers, PaletteChild } from '../../commands';
import {
  api,
  getNow,
  useAccounts,
  useConsent,
  useFrames,
  useRow,
  useSettings,
  useView,
} from '../../data';
import type { AiProvider, Calendar, ErrorBody, ModelRef, ProgressFrame } from '../../data';
import {
  navigate,
  openCompose,
  openRoute,
  openThread,
  pushToast,
  useAccountScope,
  useAppRoute,
  useCurrentTarget,
  useRegisterCommands,
  useShellKeyLayer,
  type CommandHandlerTable,
} from '../../shell';
import { useDictation } from '../compose/runtime/useDictation';
import { keepsOnRelease } from '../compose/model/dictationModel';
import { openDraftAccount } from '../compose/runtime/useComposeSession';
import { askRunArgs } from './ask.context';
import { todayCalendar, type TodayCalendar } from '../today/today.model';
import { TodayHost } from '../today/TodayHost';
import {
  advance,
  arrow,
  askKeyLayer,
  consentDropped,
  consentGranted,
  consentLineNeeded,
  consentNeededInput,
  decide,
  decided,
  dockView,
  editQueued,
  escape,
  newChat,
  openConversation,
  otherProviders,
  pendingQuestionReady,
  providerLabel,
  pruneDecisions,
  retry,
  runRefused,
  runStarted,
  sendNow,
  setField,
  stop,
  submit,
  toggleSteps,
  trackedRunIds,
  FALLBACK_SUGGESTIONS,
  type AskEffect,
  type AskInputs,
  type AskState,
  type AskStep,
} from './ask.model';
import { AskPanel } from './AskPanel';
import { ConsentLine } from './AskConsent';
import { oncePerTask } from './oncePerTask';
import { askStore, defaultDockWidth, dockWidthPersisted, useDock } from './askStore';
import { accountLabel } from '../../ui/accountLabel';
import { setFormatClock } from '../../ui/ask/format';
import './ask-screen.css';

export interface AskDockHostProps {
  /** Active tab; default the store's (which the commands also write). */
  readonly tab?: 'ask' | 'today';
  /** Tab asked for; default records it on the store. */
  readonly onTab?: (tab: 'ask' | 'today') => void;
  /** Close the dock (⌘J, the close button, the end of the Esc ladder). */
  readonly onClose?: () => void;
  /** The Today tab body; default `TodayHost`. */
  readonly today?: ReactNode;
}

interface AiStatus {
  readonly ready: boolean;
  readonly model?: ModelRef;
}

/** The closed provider union the API inputs want (`AiProviderId`'s input side is stricter than its `Open<>` output). */
type ProviderId =
  | 'groq'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openrouter'
  | 'opencode-go'
  | 'ollama'
  | 'lmstudio'
  | 'custom';

function errorBody(error: unknown): Pick<ErrorBody, 'type' | 'reasonCode' | 'message'> {
  const body = (error as { body?: ErrorBody } | null)?.body;
  return body ?? { type: 'internal', message: 'Something went wrong. Try again.' };
}

const APPLIED_TOAST: Readonly<Record<string, string>> = {
  'Add to Calendar': 'Added to Calendar',
  Reply: 'Saved as a draft',
};

/** The `Ai/status` row for Ask (the feature the engine reports), as the host needs it. */
interface AiFeatureStatus {
  readonly feature: string;
  readonly ready: boolean;
  readonly model?: ModelRef;
}

function askFeature(features: readonly AiFeatureStatus[]): AiStatus {
  const ask = features.find(f => f.feature === 'ask');
  return { ready: ask?.ready === true, model: ask?.model };
}

/** `Ai/status`, `Ai/providers`, `Ask/suggestions` and `Calendar/get` once per mount; `refresh` asks again. */
function useAskSources() {
  const [status, setStatus] = useState<AiStatus>({ ready: false });
  const [providers, setProviders] = useState<readonly AiProvider[]>([]);
  const [suggestions, setSuggestions] = useState<readonly string[]>([]);
  const [calendars, setCalendars] = useState<ReadonlyMap<string, TodayCalendar>>(new Map());
  /** False until the first batch answers, so a pending status never reads as "no provider". */
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [status, providerList, suggestionList, calendarList] = await Promise.allSettled([
        api.ai.status(),
        api.ai.providers(),
        api.ask.suggestions(),
        api.calendar.get({}),
      ]);
      if (!alive) return;
      setLoaded(true);
      if (status.status === 'fulfilled') setStatus(askFeature(status.value.features));
      if (providerList.status === 'fulfilled') setProviders(providerList.value.list);
      if (suggestionList.status === 'fulfilled') setSuggestions(suggestionList.value.list);
      if (calendarList.status === 'fulfilled') {
        setCalendars(
          new Map(calendarList.value.list.map((c: Calendar) => [c.id, todayCalendar(c)])),
        );
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, []);
  return { status, setStatus, providers, suggestions, calendars, loaded };
}

/** An unused slot's filter: contract ids are non-empty, so this `runId` matches nothing. */
const NO_RUN = '';

/**
 * The dock's `progress` frames: one runId-scoped subscription per run the state tracks (`trackedRunIds` — the live
 * run plus its `PAST_RUNS` remembered ones, four slots), never a source-wide one. Only a filter that names a runId
 * is seeded with the frames the run already sent, so a dock reopened after the run finished folds its whole log and
 * settles instead of hanging 'working' on an empty buffer beside the stored turn.
 */
function useAskFrames(runIds: readonly (string | undefined)[]): readonly ProgressFrame[] {
  const opts = { max: 5_000 };
  const live = useFrames('progress', { source: 'ask', runId: runIds[0] ?? NO_RUN }, opts).frames;
  const p1 = useFrames('progress', { source: 'ask', runId: runIds[1] ?? NO_RUN }, opts).frames;
  const p2 = useFrames('progress', { source: 'ask', runId: runIds[2] ?? NO_RUN }, opts).frames;
  const p3 = useFrames('progress', { source: 'ask', runId: runIds[3] ?? NO_RUN }, opts).frames;
  return useMemo(() => [...live, ...p1, ...p2, ...p3], [live, p1, p2, p3]);
}

export function AskDockHost(props: AskDockHostProps) {
  const dock = useDock();
  const settings = useSettings();
  const consent = useConsent();
  const accounts = useAccounts();
  const target = useCurrentTarget();
  const screen = useAppRoute();
  const once = useRef(oncePerTask()).current;
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const [proposalFocused, setProposalFocused] = useState(false);
  const frames = useAskFrames(trackedRunIds(dock.ask));
  const conversation = useRow('Conversation', dock.ask.conversationId);
  const history = useView({ kind: 'conversations' });
  const sources = useAskSources();
  const dictation = useDictation(text => {
    const field = askStore.get().ask.field;
    const joined = field ? `${field} ${text.trim()}` : text.trim();
    askStore.update(s => ({ ...s, ask: setField(s.ask, joined) }));
    fieldRef.current?.focus();
  });

  // The dock's relative times (recent chats, citation dates) read the renderer clock (DESIGN 5 rule 15).
  useEffect(() => {
    setFormatClock(() => getNow());
    return () => setFormatClock(null);
  }, []);

  const tab = props.tab ?? dock.tab;
  const onTab = props.onTab ?? ((t: 'ask' | 'today') => askStore.open(t));
  const onClose = props.onClose ?? (() => undefined);

  const recents = useMemo(
    () =>
      history.ids
        .map(id => history.rows.get(id))
        .filter((c): c is NonNullable<typeof c> => c !== undefined)
        .map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
    [history.ids, history.rows],
  );
  const accountNames = useMemo(
    () => new Map(accounts.map(a => [a.id, accountLabel(a)])),
    [accounts],
  );
  const inputs: AskInputs = {
    conversation,
    frames,
    providers: sources.providers,
    askReady: sources.status.ready,
    askModel: sources.status.model,
    calendars: sources.calendars,
    accountNames,
    suggestions: sources.suggestions.length > 0 ? sources.suggestions : FALLBACK_SUGGESTIONS,
    recents,
    // The gate every run start answers to, wider than the line's display rule: "Not now" dismisses
    // only the line — never the requirement — and an unknown record holds rather than runs.
    consentNeeded: consentNeededInput(sources.loaded, sources.status.model, consent),
  };
  const view = dockView(dock.ask, inputs);
  const viewRef = useRef(view);
  viewRef.current = view;
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const targetRef = useRef(target);
  targetRef.current = target;
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const accountScope = useAccountScope();
  const accountScopeRef = useRef(accountScope);
  accountScopeRef.current = accountScope;

  /* ── state and effects ── */

  const cur = () => askStore.get().ask;

  function setAsk(next: AskState) {
    askStore.update(s => ({ ...s, ask: next }));
  }

  function perform(stepped: AskStep) {
    setAsk(stepped.state);
    for (const effect of stepped.effects) runEffect(effect);
  }

  function runEffect(effect: AskEffect) {
    switch (effect.kind) {
      case 'run':
        void effectRun(effect);
        break;
      case 'cancel':
        void api.ask.cancel({ runId: effect.runId }).catch(() => undefined);
        break;
      case 'decide':
        void effectDecide(effect);
        break;
      case 'close':
        onCloseRef.current();
        break;
      case 'openConversation':
        break;
    }
  }

  async function effectRun(effect: Extract<AskEffect, { kind: 'run' }>) {
    try {
      // Read at run start, not at mount: which draft is open (and in which account) can change while the
      // dock stays put, and a run fired after the composer closed must carry no stale account.
      const out = await api.ask.run(
        askRunArgs(
          effect,
          {
            target: targetRef.current,
            screen: screenRef.current,
            draftAccountId: openDraftAccount(),
            accountScope: accountScopeRef.current,
          },
          Intl.DateTimeFormat().resolvedOptions().timeZone,
        ),
      );
      perform(runStarted(askStore.get().ask, effect.clientId, out.runId, out.conversationId));
    } catch (error) {
      setAsk(runRefused(askStore.get().ask, effect.clientId, errorBody(error)));
    }
  }

  async function effectDecide(effect: Extract<AskEffect, { kind: 'decide' }>) {
    const card = viewRef.current.turns
      .map(t => t.proposal)
      .find(p => p?.proposalId === effect.proposalId);
    try {
      const out = await api.ask.decide({
        conversationId: effect.conversationId,
        turnId: effect.turnId,
        proposalId: effect.proposalId,
        accept: effect.accept,
      });
      setAsk(
        decided(askStore.get().ask, effect.proposalId, {
          ok: true,
          eventId: out.eventId,
          draftId: out.draftId,
        }),
      );
      if (effect.accept && card) {
        pushToast({
          id: out.receipt.opId,
          kind: 'done',
          message: APPLIED_TOAST[card.kicker] ?? card.appliedText ?? card.kicker,
          undoable: true,
          actions: [{ id: 'undo', label: 'Undo', commandId: 'app.undo' }],
        });
        if (out.draftId) openCompose({ draftId: out.draftId });
      }
    } catch {
      setAsk(decided(askStore.get().ask, effect.proposalId, { ok: false }));
      if (effect.accept && card) {
        pushToast({
          id: `ask-decide-${effect.proposalId}`,
          kind: 'info',
          message: `Couldn’t ${card.kicker.toLowerCase()}.`,
          undoable: false,
        });
      }
    }
  }

  /** "Use another provider": point `settings.ai.features.ask` at the provider's first model. */
  async function switchProvider(providerId: string) {
    try {
      const { list } = await api.ai.models({ provider: providerId as ProviderId });
      const model = list[0]?.id;
      const current = settingsRef.current;
      if (!model || !current) return;
      await api.settings.set({
        patch: {
          ai: {
            features: {
              ...current.ai.features,
              ask: { provider: providerId as ProviderId, model },
            },
          },
        },
      });
      const status = await api.ai.status();
      sources.setStatus(askFeature(status.features));
    } catch {
      // Absence is quiet: the provider table keeps telling the truth (DESIGN §9 rule 7).
    }
  }

  // The run's frames move it on: settle, then the next queued question.
  useEffect(() => {
    const stepped = advance(askStore.get().ask, frames, inputsRef.current.consentNeeded === true);
    if (stepped.state !== askStore.get().ask || stepped.effects.length > 0) perform(stepped);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames]);

  // Once the store has a decision, the store rules (an Undo brings the card back).
  useEffect(() => {
    const pruned = pruneDecisions(askStore.get().ask, conversation);
    if (pruned !== askStore.get().ask) setAsk(pruned);
  }, [conversation]);

  // The palette's Ask row. The question stays in the store until the sources and the consent record
  // have both answered: submitting earlier would run it past the consent gate entirely.
  useEffect(() => {
    const question = askStore.get().pendingQuestion;
    if (!question || !pendingQuestionReady(sources.loaded, consent)) return;
    askStore.update(s => ({ ...s, pendingQuestion: undefined }));
    const ready = setField(askStore.get().ask, question);
    askStore.update(s => ({ ...s, ask: ready }));
    perform(submit(ready, dockView(ready, inputsRef.current), 'ask'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dock.pendingQuestion, sources.loaded, consent]);

  // A question held while the sources or the consent record were still loading resolves itself once
  // the gate clears: granted and current runs it; no provider lets the refusal path answer.
  useEffect(() => {
    if (!dock.ask.consentHeld) return;
    if (consentNeededInput(sources.loaded, sources.status.model, consent)) return;
    perform(consentGranted(cur()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dock.ask.consentHeld, sources.loaded, sources.status.model, consent]);

  // Hold-A while the dock was closed: the shell's `ask.dictate` fallback opened it and left a pending
  // dictation; start listening now (the key's release reaches this host's handler once attached).
  useEffect(() => {
    if (!dock.pendingDictation) return;
    askStore.update(s => ({ ...s, pendingDictation: undefined }));
    dictation.controller.start('A');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dock.pendingDictation]);

  // A, ⌘J and ⇧A move focus to the field.
  useEffect(() => {
    if (tab === 'ask') fieldRef.current?.focus();
  }, [dock.focusTick, tab]);

  // Width: the saved one, or the layout default for this window; a dragged width writes back debounced.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !settings) return;
    restored.current = true;
    const saved = settings.ui.dock.width;
    const seed = typeof window === 'undefined' ? 360 : defaultDockWidth(window.innerWidth);
    askStore.update(s => ({ ...s, width: saved ?? seed }));
  }, [settings]);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const draggedWidth = useRef(false);
  const pendingWidth = useRef<number | undefined>(undefined);
  const writeWidth = useRef((width: number) => {
    const current = settingsRef.current;
    if (!current) return;
    const seed = typeof window === 'undefined' ? 360 : defaultDockWidth(window.innerWidth);
    const persist = dockWidthPersisted(width, seed, current.ui.dock.width, draggedWidth.current);
    if (persist === undefined) return;
    void api.settings
      .set({ patch: { ui: { dock: { ...current.ui.dock, width: persist } } } })
      .catch(() => undefined);
  });
  useEffect(() => {
    if (!restored.current) return;
    pendingWidth.current = dock.width;
    const timer = setTimeout(() => {
      pendingWidth.current = undefined;
      writeWidth.current(dock.width);
    }, 400);
    return () => clearTimeout(timer);
  }, [dock.width]);
  // Closing the dock inside the debounce still keeps the owner's width.
  useEffect(
    () => () => {
      const owed = pendingWidth.current;
      pendingWidth.current = undefined;
      if (owed !== undefined) writeWidth.current(owed);
    },
    [],
  );

  // The resolver's conditions for the ask context, which the dock root's data-keyctx scopes to focus inside.
  useShellKeyLayer(askKeyLayer(view, proposalFocused));

  /* ── consent (first use, before anything else) ── */

  const askModel = sources.status.model;
  const providerRow = sources.providers.find(p => p.id === askModel?.provider);
  // The consent line waits for the provider table so it can name the provider rather than a raw id.
  const needsConsent =
    tab === 'ask' &&
    !view.working &&
    sources.loaded &&
    consentLineNeeded(consent, dock.consentDismissed, dock.ask.consentHeld !== undefined) &&
    askModel;
  const consentNode = needsConsent ? (
    <ConsentLine
      provider={providerLabel(askModel.provider, sources.providers) ?? askModel.provider}
      model={askModel.model}
      local={providerRow?.local === true}
      onAllow={() => {
        if (!consent) return;
        void api.consent
          .grant({
            scope: 'background',
            version: consent.currentVersion,
            provider: askModel.provider as ProviderId,
            model: askModel.model,
          })
          .then(() => perform(consentGranted(cur())))
          .catch(() => undefined);
      }}
      onNotNow={() =>
        askStore.update(s => ({
          ...s,
          consentDismissed: consent?.currentVersion ?? 0,
          ask: consentDropped(s.ask),
        }))
      }
    />
  ) : undefined;

  /* ── commands ── */

  const proposalFocusedRef = useRef(proposalFocused);
  proposalFocusedRef.current = proposalFocused;
  const onTabRef = useRef((t: 'ask' | 'today') => {
    askStore.open(t);
    onTab(t);
  });
  onTabRef.current = t => {
    askStore.open(t);
    onTab(t);
  };
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;
  const providersRef = useRef(sources.providers);
  providersRef.current = sources.providers;

  const handlers = useMemo<CommandHandlerTable>(() => {
    const esc = () =>
      once('esc', () => perform(escape(cur(), viewRef.current, proposalFocusedRef.current)));
    const submitAs = (mode: 'ask' | 'searchAll') =>
      once('submit', () => perform(submit(cur(), viewRef.current, mode)));
    const attach = (run: CommandHandlers['run']): CommandHandlers => ({ run });
    return {
      'ask.open': {
        run: () => onTabRef.current('ask'),
        labelFor: ctx => (ctx.target?.kind === 'thread' ? 'Ask about this email' : undefined),
        suggested: ctx => ctx.target?.kind === 'thread',
      },
      'ask.dictate': {
        run: () => {
          onTabRef.current('ask');
          dictationRef.current.controller.start('A');
        },
        release: (_ctx, release) =>
          void dictationRef.current.controller.release(keepsOnRelease(release)),
      },
      'ask.toggleDock': attach(() => onCloseRef.current()),
      'nav.today': attach(() => onTabRef.current('today')),
      'ask.submit': attach(() => submitAs('ask')),
      'ask.searchAllMail': attach(() => submitAs('searchAll')),
      'ask.sendNow': attach(() =>
        once('submit', () => {
          const first = cur().queued[0];
          if (first) perform(sendNow(cur(), viewRef.current, first.id));
        }),
      ),
      'ask.newChat': attach(() => once('new', () => perform(newChat(cur())))),
      'ask.stop': attach(esc),
      'ask.clear': attach(esc),
      'ask.close': attach(esc),
      'ask.declineProposal': attach(esc),
      'ask.acceptProposal': attach(() =>
        once('accept', () => perform(decide(cur(), viewRef.current, true))),
      ),
      'ask.previousSuggestion': attach(() => setAsk(arrow(cur(), viewRef.current, -1))),
      'ask.nextSuggestion': attach(() => setAsk(arrow(cur(), viewRef.current, 1))),
      'ask.useAnotherProvider': {
        run: () => undefined,
        children: (): readonly PaletteChild[] => {
          const failing = viewRef.current.turns.at(-1)?.provider;
          const failingId = providersRef.current.find(p => p.label === failing)?.id;
          return otherProviders(providersRef.current, failingId).map(p => ({
            id: `provider-${p.id}`,
            label: p.label,
            detail: p.local ? 'on this Mac' : undefined,
            run: () => void switchProvider(p.id),
          }));
        },
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRegisterCommands(handlers);

  // Until Ai/status answers, `ready:false` would flash the no-provider pane over an existing chat;
  // the conversation/empty shell shows while it is pending instead.
  const shownView = sources.loaded ? view : { ...view, providerReady: true };

  return (
    <div
      className="ask-screen"
      data-keyctx="ask"
      onFocus={event =>
        setProposalFocused(Boolean((event.target as HTMLElement).closest('.ui-proposal-card')))
      }
    >
      <AskPanel
        view={shownView}
        tab={tab}
        width={dock.width}
        today={props.today ?? <TodayHost />}
        consent={consentNode}
        dictation={dictation.shown}
        fieldRef={fieldRef}
        handlers={{
          onTabChange: t => onTabRef.current(t),
          onClose: () => onCloseRef.current(),
          onWidthChange: width => {
            draggedWidth.current = true;
            askStore.update(s => ({ ...s, width }));
          },
          onOpenSettings: () => openRoute('settings/ai'),
          onChange: text => setAsk(setField(cur(), text)),
          onSubmit: mode => once('submit', () => perform(submit(cur(), viewRef.current, mode))),
          onStop: () => perform(stop(cur())),
          onQueuedChange: (id, text) => setAsk(editQueued(cur(), id, text)),
          onSendQueuedNow: id => once('submit', () => perform(sendNow(cur(), viewRef.current, id))),
          onPickSuggestion: question =>
            once('submit', () =>
              perform(submit(setField(cur(), question), viewRef.current, 'ask')),
            ),
          onOpenRecent: id => perform(openConversation(cur(), id)),
          onToggleSteps: turnId => setAsk(toggleSteps(cur(), turnId)),
          onOpenCitation: (_turnId, threadId) => openThread(threadId),
          onOpenEventCitation: () => navigate('calendar'),
          onRetry: turnId => once('submit', () => perform(retry(cur(), viewRef.current, turnId))),
          onUseAnotherProvider: () => openRoute('settings/ai'),
          onConfirmProposal: proposalId =>
            once('accept', () => perform(decide(cur(), viewRef.current, true, proposalId))),
          onDismissProposal: proposalId =>
            once('esc', () => perform(decide(cur(), viewRef.current, false, proposalId))),
        }}
      />
    </div>
  );
}
