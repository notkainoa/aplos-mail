/**
 * The Ask dock as the screen draws it (DESIGN §7.7): `AskDock` with the model's turns as `AskTurn`s, the empty view,
 * the queued cards and the Today tab body. Presentational: it takes `DockView` from `ask.model.ts` and reports intent
 * through `handlers`. Provenance ("Answer by Groq") is a tooltip on the answer, so nothing shows at rest (§9 rule 5).
 */
import type { ReactNode, Ref } from 'react';
import { AskDock, AskTurn } from '../../ui/ask';
import { Tooltip } from '../../ui/buttons-keys';
import { Text } from '../../ui/surfaces';
import type { DictationState } from '../../ui/props';
import type { DockView, TurnView } from './ask.model';

export interface AskPanelHandlers {
  onTabChange: (tab: 'ask' | 'today') => void;
  onClose: () => void;
  onWidthChange: (width: number) => void;
  onOpenSettings: () => void;
  onChange: (value: string) => void;
  onSubmit: (mode: 'ask' | 'searchAll') => void;
  onStop: () => void;
  onQueuedChange: (id: string, text: string) => void;
  onSendQueuedNow: (id: string) => void;
  onPickSuggestion: (question: string) => void;
  onOpenRecent: (id: string) => void;
  onToggleSteps: (turnId: string) => void;
  /** A message citation's chip: the turn tells which message of the thread it quoted. */
  onOpenCitation: (turnId: string, threadId: string) => void;
  onOpenEventCitation: (eventId: string) => void;
  onRetry: (turnId: string) => void;
  onUseAnotherProvider: (turnId: string) => void;
  onConfirmProposal: (proposalId: string) => void;
  onDismissProposal: (proposalId: string) => void;
}

export interface AskPanelProps {
  view: DockView;
  tab: 'ask' | 'today';
  width: number;
  /** The Today tab body (`Today`). */
  today: ReactNode;
  dictation?: DictationState;
  fieldRef?: Ref<HTMLTextAreaElement>;
  handlers: AskPanelHandlers;
}

function Turn({ turn, handlers }: { turn: TurnView; handlers: AskPanelHandlers }) {
  const body = (
    <div className="ask-screen__turn" data-turn={turn.id}>
      <AskTurn
        id={`ask-turn-${turn.id}`}
        question={turn.question}
        state={turn.state}
        steps={turn.steps ? { ...turn.steps, onToggle: () => handlers.onToggleSteps(turn.id) } : undefined}
        answer={turn.answer}
        citations={turn.citations}
        provider={turn.provider}
        proposal={
          turn.proposal
            ? {
                ...turn.proposal,
                onConfirm: () => handlers.onConfirmProposal(turn.proposal!.proposalId),
                onDismiss: () => handlers.onDismissProposal(turn.proposal!.proposalId),
              }
            : undefined
        }
        onOpenCitation={threadId => handlers.onOpenCitation(turn.id, threadId)}
        onOpenEventCitation={handlers.onOpenEventCitation}
        onRetry={turn.state === 'failed' ? () => handlers.onRetry(turn.id) : undefined}
        onUseAnotherProvider={turn.state === 'failed' ? () => handlers.onUseAnotherProvider(turn.id) : undefined}
      />
      {turn.excludedNote ? (
        <div className="ask-screen__note">
          <Text variant="small" tone="dim">
            {turn.excludedNote}
          </Text>
        </div>
      ) : null}
    </div>
  );
  return turn.provenance ? <Tooltip label={turn.provenance}>{body}</Tooltip> : body;
}

export function AskPanel({ view, tab, width, today, dictation, fieldRef, handlers }: AskPanelProps) {
  const conversation =
    view.turns.length > 0 ? (
      <div className="ask-screen__turns">
        {view.turns.map(turn => (
          <Turn key={turn.id} turn={turn} handlers={handlers} />
        ))}
      </div>
    ) : undefined;
  return (
    <AskDock
      tab={tab}
      onTabChange={handlers.onTabChange}
      onClose={handlers.onClose}
      width={width}
      onWidthChange={handlers.onWidthChange}
      providerReady={view.providerReady}
      onOpenSettings={handlers.onOpenSettings}
      conversation={conversation}
      empty={
        view.empty
          ? { ...view.empty, onPickSuggestion: handlers.onPickSuggestion, onOpenRecent: handlers.onOpenRecent }
          : undefined
      }
      today={today}
      value={view.field}
      onChange={handlers.onChange}
      onSubmit={handlers.onSubmit}
      working={view.working}
      onStop={handlers.onStop}
      queued={view.queued}
      onQueuedChange={handlers.onQueuedChange}
      onSendQueuedNow={handlers.onSendQueuedNow}
      dictation={dictation}
      fieldRef={fieldRef}
    />
  );
}
