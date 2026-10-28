/**
 * The Ask dock's container (DESIGN §7.7, §8 Ask and Global): data hooks and `api.ask` in, `AskPanel` out, the ask
 * context's commands attached to the registry, hold-A dictation through `Blob/put` and `Ai/transcribe`. It cannot run
 * until `ui-shell` lands the data layer; what the data surface does not have yet comes through `AskPorts` (REQUESTs in
 * the lane report).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CommandContext, Condition, PaletteChild, Registry } from '../../commands';
import { api, useFrames, useRow, useSettings, useView } from '../../data';
import type { AiProvider, ErrorBody, ModelRef, Receipt } from '../../data';
import type { SettingRoute } from '../../commands';
import type { DictationState } from '../../ui/props';
import type { TodayCalendar } from '../today/today.model';
import {
  advance,
  arrow,
  decide,
  decided,
  dockView,
  editQueued,
  escape,
  newChat,
  openConversation,
  otherProviders,
  pruneDecisions,
  retry,
  runRefused,
  runStarted,
  sendNow,
  setField,
  stop,
  submit,
  toggleSteps,
  FALLBACK_SUGGESTIONS,
  type AskEffect,
  type AskState,
  type AskStep,
} from './ask.model';
import { AskPanel } from './AskPanel';
import { askStore, defaultDockWidth, useDock } from './askStore';
import './ask-screen.css';

/** A recording of the microphone: the level for the meter, then the bytes on release. */
export interface DictationRecorder {
  start(onLevel: (level: number) => void): Promise<void>;
  stop(): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }>;
  cancel(): void;
}

/** What the dock needs that `renderer/data` and `renderer/shell` do not offer yet (REQUESTs to ui-shell). */
export interface AskPorts {
  readonly registry: Registry;
  /** The current command context (target and stack) for "Ask about this email". */
  readonly context: () => CommandContext;
  /** Publishes the ask context's conditions for the resolver (`streaming`, `askText`, `proposal`, `queued`). */
  readonly publishConditions: (conditions: Partial<Record<Condition, boolean>>) => void;
  /** `Ai/status` for Ask. */
  readonly askStatus: { readonly ready: boolean; readonly model?: ModelRef };
  /** `Ai/providers`. */
  readonly providers: readonly AiProvider[];
  /** `Ask/suggestions`; empty uses the plain fallbacks. */
  readonly suggestions: readonly string[];
  /** `Ask/decide`. */
  readonly decide: (args: {
    conversationId: string;
    turnId: string;
    proposalId: string;
    accept: boolean;
  }) => Promise<{ receipt: Receipt; eventId?: string; draftId?: string }>;
  /** Calendars by id, for the proposal's calendar name and colour. */
  readonly calendars: ReadonlyMap<string, TodayCalendar>;
  /** Account names by id, for "left out" notes. */
  readonly accountNames: ReadonlyMap<string, string>;
  /** Routes: the reader at a message, the calendar at an event, compose on a draft, Settings → AI. */
  readonly openThread: (threadId: string, messageId?: string) => void;
  readonly openEvent: (eventId: string) => void;
  readonly openDraft: (draftId: string) => void;
  readonly openRoute: (route: SettingRoute) => void;
  /** "Use another provider": make it the Ask provider (no one-off override exists on `Ask/run`). */
  readonly useProvider: (providerId: string) => void;
  /** The shell's toast stack. */
  readonly pushToast: (toast: {
    id: string;
    kind: 'done' | 'error' | 'info';
    message: string;
    undoable: boolean;
    actions?: { id: string; label: string; commandId?: string }[];
  }) => void;
  readonly recorder: DictationRecorder;
  /** The window's width, for the dock's default (320 under 1180 px). */
  readonly windowWidth: number;
}

function oncePerTask() {
  const seen = new Set<string>();
  return (key: string, run: () => void) => {
    if (seen.has(key)) return;
    seen.add(key);
    queueMicrotask(() => seen.delete(key));
    run();
  };
}

function errorBody(error: unknown): Pick<ErrorBody, 'type' | 'reasonCode' | 'message'> {
  const body = (error as { body?: ErrorBody } | null)?.body;
  return body ?? { type: 'internal', message: 'Something went wrong. Try again.' };
}

const APPLIED_TOAST: Readonly<Record<string, string>> = {
  'Add to Calendar': 'Added to Calendar',
  Reply: 'Saved as a draft',
};

export function AskContainer({ ports, today }: { ports: AskPorts; today: ReactNode }) {
  const dock = useDock();
  const settings = useSettings();
  const once = useRef(oncePerTask()).current;
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const [dictation, setDictation] = useState<DictationState | undefined>();
  const [proposalFocused, setProposalFocused] = useState(false);
  const frames = useFrames('progress', { source: 'ask' }, { max: 5_000 }).frames;
  const conversation = useRow('Conversation', dock.ask.conversationId);
  const history = useView({ kind: 'conversations' });

  const recents = useMemo(
    () =>
      history.ids
        .map(id => history.rows.get(id))
        .filter((c): c is NonNullable<typeof c> => c !== undefined)
        .map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
    [history.ids, history.rows],
  );
  const inputs = {
    conversation,
    frames,
    providers: ports.providers,
    askReady: ports.askStatus.ready,
    askModel: ports.askStatus.model,
    calendars: ports.calendars,
    accountNames: ports.accountNames,
    suggestions: ports.suggestions.length > 0 ? ports.suggestions : FALLBACK_SUGGESTIONS,
    recents,
  };
  const view = dockView(dock.ask, inputs);
  const viewRef = useRef(view);
  viewRef.current = view;

  /* ── state and effects ── */

  function setAsk(next: AskState) {
    askStore.update(s => ({ ...s, ask: next }));
  }

  function perform(stepped: AskStep) {
    setAsk(stepped.state);
    for (const effect of stepped.effects) runEffect(effect);
  }

  function runEffect(effect: AskEffect) {
    switch (effect.kind) {
      case 'run': {
        const context = ports.context();
        const target = context.target;
        api.ask
          .run({
            question: effect.question,
            conversationId: effect.conversationId,
            scope: effect.searchAll ? { searchAllMail: true } : undefined,
            context: {
              threadId: target?.kind === 'thread' ? target.id : undefined,
              eventId: target?.kind === 'event' ? target.id : undefined,
              selectedIds:
                context.selection.length > 0 ? [...context.selection].slice(0, 50) : undefined,
            },
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          })
          .then(out =>
            perform(runStarted(askStore.get().ask, effect.clientId, out.runId, out.conversationId)),
          )
          .catch((error: unknown) =>
            setAsk(runRefused(askStore.get().ask, effect.clientId, errorBody(error))),
          );
        break;
      }
      case 'cancel':
        void api.ask.cancel({ runId: effect.runId }).catch(() => undefined);
        break;
      case 'decide': {
        const card = viewRef.current.turns
          .map(t => t.proposal)
          .find(p => p?.proposalId === effect.proposalId);
        ports
          .decide(effect)
          .then(out => {
            setAsk(
              decided(askStore.get().ask, effect.proposalId, {
                ok: true,
                eventId: out.eventId,
                draftId: out.draftId,
              }),
            );
            if (effect.accept && card) {
              ports.pushToast({
                id: out.receipt.opId,
                kind: 'done',
                message: APPLIED_TOAST[card.kicker] ?? card.appliedText ?? card.kicker,
                undoable: true,
                actions: [{ id: 'undo', label: 'Undo', commandId: 'app.undo' }],
              });
              if (out.draftId) ports.openDraft(out.draftId);
            }
          })
          .catch(() => {
            setAsk(decided(askStore.get().ask, effect.proposalId, { ok: false }));
            if (effect.accept && card) {
              ports.pushToast({
                id: `ask-decide-${effect.proposalId}`,
                kind: 'error',
                message: `Couldn’t ${card.kicker.toLowerCase()}.`,
                undoable: false,
              });
            }
          });
        break;
      }
      case 'close':
        askStore.update(s => ({ ...s, open: false }));
        break;
      case 'openConversation':
        break;
    }
  }

  // The run's frames move it on: settle, then the next queued question.
  useEffect(() => {
    const stepped = advance(askStore.get().ask, frames);
    if (stepped.state !== askStore.get().ask || stepped.effects.length > 0) perform(stepped);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames]);

  // Once the store has a decision, the store rules (an Undo brings the card back).
  useEffect(() => {
    const pruned = pruneDecisions(askStore.get().ask, conversation);
    if (pruned !== askStore.get().ask) setAsk(pruned);
  }, [conversation]);

  // The palette's Ask row.
  useEffect(() => {
    const question = dock.pendingQuestion;
    if (!question) return;
    askStore.update(s => ({ ...s, pendingQuestion: undefined }));
    const ready = setField(askStore.get().ask, question);
    perform(submit(ready, dockView(ready, inputs), 'ask'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dock.pendingQuestion]);

  // A, ⌘J and ⇧A move focus to the field.
  useEffect(() => {
    if (dock.open && dock.tab === 'ask') fieldRef.current?.focus();
  }, [dock.focusTick, dock.open, dock.tab]);

  // Remembered: open, tab and width (closed on first run, DESIGN decision 9).
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !settings) return;
    restored.current = true;
    const saved = settings.ui.dock;
    askStore.update(s => ({
      ...s,
      open: saved.open,
      tab: saved.tab,
      width: saved.width ?? defaultDockWidth(ports.windowWidth),
    }));
  }, [settings, ports.windowWidth]);
  useEffect(() => {
    if (!restored.current) return;
    const timer = setTimeout(() => {
      void api.settings
        .set({ patch: { ui: { dock: { open: dock.open, tab: dock.tab, width: dock.width } } } })
        .catch(() => undefined);
    }, 400);
    return () => clearTimeout(timer);
  }, [dock.open, dock.tab, dock.width]);

  // The resolver's conditions for the ask context.
  useEffect(() => {
    ports.publishConditions({
      streaming: view.working,
      askText: view.field.length > 0,
      proposal: proposalFocused && view.pendingProposal !== undefined,
      queued: view.queued.length > 0,
    });
  }, [ports, view.working, view.field, proposalFocused, view.pendingProposal, view.queued.length]);

  /* ── dictation (hold A) ── */

  function startDictation() {
    askStore.open('ask');
    setDictation({ holdKey: 'A', level: 0 });
    ports.recorder
      .start(level => setDictation(d => (d ? { ...d, level } : d)))
      .catch(() => {
        setDictation(undefined);
        ports.pushToast({
          id: 'ask-mic',
          kind: 'error',
          message: 'Aplos can’t use the microphone. Type your question instead.',
          undoable: false,
        });
      });
  }

  useEffect(() => {
    if (!dictation) return;
    // Release keeps (the transcript goes in the field, ready to ask); Esc cancels. A typed path always exists.
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'a') return;
      setDictation(undefined);
      ports.recorder
        .stop()
        .then(async ({ bytes, mime }) => {
          const blob = await api.blob.put({ bytes, mime }, { transfer: [bytes.buffer] });
          const { text } = await api.ai.transcribe({ blobId: blob.blobId });
          const field = askStore.get().ask.field;
          setAsk(setField(askStore.get().ask, field ? `${field} ${text.trim()}` : text.trim()));
          fieldRef.current?.focus();
        })
        .catch(() =>
          ports.pushToast({
            id: 'ask-transcribe',
            kind: 'error',
            message: 'Couldn’t turn that into text. Type it instead.',
            undoable: false,
          }),
        );
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      ports.recorder.cancel();
      setDictation(undefined);
    };
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [dictation !== undefined]);

  /* ── the ask context's commands ── */

  useEffect(() => {
    const { registry } = ports;
    const cur = () => askStore.get().ask;
    const esc = () =>
      once('esc', () => perform(escape(cur(), viewRef.current, proposalFocusedRef.current)));
    const submitAs = (mode: 'ask' | 'searchAll') =>
      once('submit', () => perform(submit(cur(), viewRef.current, mode)));
    const detach = [
      registry.attach('ask.open', {
        run: () => askStore.open('ask'),
        labelFor: ctx => (ctx.target?.kind === 'thread' ? 'Ask about this email' : undefined),
        suggested: ctx => ctx.target?.kind === 'thread',
      }),
      registry.attach('ask.dictate', { run: () => startDictation() }),
      registry.attach('ask.toggleDock', {
        run: () =>
          once('toggle', () =>
            askStore.update(s => ({ ...s, open: !s.open, focusTick: s.focusTick + 1 })),
          ),
      }),
      registry.attach('nav.today', { run: () => askStore.open('today') }),
      registry.attach('ask.submit', { run: () => submitAs('ask') }),
      registry.attach('ask.searchAllMail', { run: () => submitAs('searchAll') }),
      registry.attach('ask.sendNow', {
        run: () =>
          once('submit', () => {
            const first = cur().queued[0];
            if (first) perform(sendNow(cur(), viewRef.current, first.id));
          }),
      }),
      registry.attach('ask.newChat', { run: () => once('new', () => perform(newChat(cur()))) }),
      registry.attach('ask.stop', { run: esc }),
      registry.attach('ask.clear', { run: esc }),
      registry.attach('ask.close', { run: esc }),
      registry.attach('ask.declineProposal', { run: esc }),
      registry.attach('ask.acceptProposal', {
        run: () => once('accept', () => perform(decide(cur(), viewRef.current, true))),
      }),
      registry.attach('ask.previousSuggestion', {
        run: () => setAsk(arrow(cur(), viewRef.current, -1)),
      }),
      registry.attach('ask.nextSuggestion', {
        run: () => setAsk(arrow(cur(), viewRef.current, 1)),
      }),
      registry.attach('ask.useAnotherProvider', {
        run: () => undefined,
        children: (): readonly PaletteChild[] => {
          const failing = viewRef.current.turns.at(-1)?.provider;
          const failingId = ports.providers.find(p => p.label === failing)?.id;
          return otherProviders(ports.providers, failingId).map(p => ({
            id: `provider-${p.id}`,
            label: p.label,
            detail: p.local ? 'on this Mac' : undefined,
            run: () => ports.useProvider(p.id),
          }));
        },
      }),
    ];
    return () => detach.forEach(d => d());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ports.registry]);
  const proposalFocusedRef = useRef(proposalFocused);
  proposalFocusedRef.current = proposalFocused;

  if (!dock.open) return null;
  const cur = () => askStore.get().ask;
  return (
    <div
      className="ask-screen"
      data-keyctx="ask"
      onFocus={event =>
        setProposalFocused(Boolean((event.target as HTMLElement).closest('.ui-proposal-card')))
      }
    >
      <AskPanel
        view={view}
        tab={dock.tab}
        width={dock.width}
        today={today}
        dictation={dictation}
        fieldRef={fieldRef}
        handlers={{
          onTabChange: tab => askStore.update(s => ({ ...s, tab })),
          onClose: () => askStore.update(s => ({ ...s, open: false })),
          onWidthChange: width => askStore.update(s => ({ ...s, width })),
          onOpenSettings: () => ports.openRoute('settings/ai'),
          onChange: text => setAsk(setField(cur(), text)),
          onSubmit: mode => once('submit', () => perform(submit(cur(), viewRef.current, mode))),
          onStop: () => perform(stop(cur())),
          onQueuedChange: (id, text) => setAsk(editQueued(cur(), id, text)),
          onSendQueuedNow: id => once('submit', () => perform(sendNow(cur(), viewRef.current, id))),
          onPickSuggestion: question =>
            perform(submit(setField(cur(), question), viewRef.current, 'ask')),
          onOpenRecent: id => perform(openConversation(cur(), id)),
          onToggleSteps: turnId => setAsk(toggleSteps(cur(), turnId)),
          onOpenCitation: (turnId, threadId) => {
            const turn = viewRef.current.turns.find(t => t.id === turnId);
            const target = turn
              ? [...turn.targets.values()].find(t => t.kind === 'thread' && t.threadId === threadId)
              : undefined;
            ports.openThread(threadId, target?.kind === 'thread' ? target.messageId : undefined);
          },
          onOpenEventCitation: eventId => ports.openEvent(eventId),
          onRetry: turnId => perform(retry(cur(), viewRef.current, turnId)),
          onUseAnotherProvider: () => ports.openRoute('settings/ai'),
          onConfirmProposal: proposalId =>
            once('accept', () => perform(decide(cur(), viewRef.current, true, proposalId))),
          onDismissProposal: proposalId =>
            once('esc', () => perform(decide(cur(), viewRef.current, false, proposalId))),
        }}
      />
    </div>
  );
}
