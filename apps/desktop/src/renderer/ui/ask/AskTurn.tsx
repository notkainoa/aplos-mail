import { useEffect, useRef, type ReactNode } from 'react';
import type { AskTurnProps, CitationData } from '../props';
import { Icon } from '../compose/icons';
import { Btn } from '../compose/parts';
import { answerBlocks } from './answerBlocks';
import { Citation } from './Citation';
import { ProposalCard } from './ProposalCard';
import { StepLog } from './StepLog';

/** A run of list items: numbered (it may start above 1) or bulleted. */
function ListTag(props: { ordered: boolean; start?: number; items: ReactNode }) {
  const { ordered, start, items } = props;
  if (!ordered) return <ul>{items}</ul>;
  return <ol start={start && start > 1 ? start : undefined}>{items}</ol>;
}

/**
 * Whether the "Answered" status announces: only when this mount saw the turn unfinished first. A turn that mounts
 * already answered (a reopened conversation) stays quiet instead of queueing one status per turn.
 */
export function announcesAnswered(sawUnfinished: boolean, state: AskTurnProps['state']): boolean {
  return sawUnfinished && state === 'answered';
}

/**
 * One question and its answer (DESIGN §6 AskTurn, §7.7). The question is a `base` 500 line with no bubble and no rule.
 * The answer is serif `answer` prose straight on the pane, the decisive fact at weight 500, citations as mono chips.
 * Every answer cites its sources or says "No source in your mail". Streaming shows one thin, non-blinking caret.
 * A failure is an inline line with Retry and "Use another provider", never a red wall.
 */
export function AskTurn(props: AskTurnProps) {
  const {
    id,
    question,
    state,
    steps,
    answer,
    citations,
    provider,
    provenance,
    proposal,
    onOpenCitation,
    onOpenEventCitation,
    onRetry,
    onUseAnotherProvider,
    onOpenSettings,
  } = props;
  const questionId = `${id}-question`;
  // Any non-answered state this mount committed counts: the transition into 'answered' announces, a reopen does not.
  const sawUnfinished = useRef(state !== 'answered');
  useEffect(() => {
    if (state !== 'answered') sawUnfinished.current = true;
  }, [state]);
  const byIndex = new Map<number, CitationData>(citations.map(c => [c.index, c]));
  const referenced = new Set<number>();
  const hasAnswer = Boolean(answer && answer.length > 0);
  // Hover only (DESIGN §9 rule 5): "Answer by Groq", "Answer by Ollama on this Mac".
  const provenanceText = provenance
    ? `Answer by ${provenance.provider}${provenance.local ? ' on this Mac' : ''}`
    : undefined;

  // One paragraph's runs: text, the decisive fact, citation chips, and the streaming caret on the last one.
  const prose = (at: number) => (
    <>
      {answer![at].map((segment, s) => {
        if (segment.kind === 'item') return null;
        if (segment.kind === 'text') {
          return segment.strong ? (
            <strong key={s}>{segment.text}</strong>
          ) : (
            <span key={s}>{segment.text}</span>
          );
        }
        const source = byIndex.get(segment.index);
        referenced.add(segment.index);
        return source ? (
          <Citation key={s} {...source} onOpen={onOpenCitation} onOpenEvent={onOpenEventCitation} />
        ) : (
          <span key={s} className="ui-ask-turn__orphan">{`[${segment.index}]`}</span>
        );
      })}
      {state === 'streaming' && at === answer!.length - 1 ? (
        <span className="ui-ask-turn__caret" aria-hidden="true" />
      ) : null}
    </>
  );

  return (
    <article
      id={id}
      className="ui-ask-turn"
      aria-labelledby={questionId}
      data-state={state}
      aria-busy={state === 'working' || state === 'streaming'}
    >
      <p className="ui-ask-turn__question" id={questionId} dir="auto">
        {question}
      </p>
      {announcesAnswered(sawUnfinished.current, state) ? (
        <span className="ui-sr-only" role="status">
          Answered
        </span>
      ) : null}
      {steps ? <StepLog {...steps} /> : null}
      {hasAnswer ? (
        <div className="ui-ask-turn__answer" dir="auto" title={provenanceText}>
          {answerBlocks(answer!).map(block =>
            block.kind === 'paragraph' ? (
              <p key={block.at}>{prose(block.at)}</p>
            ) : (
              <ListTag
                key={block.items[0]}
                ordered={block.ordered}
                start={block.start}
                items={block.items.map(at => (
                  <li key={at}>{prose(at)}</li>
                ))}
              />
            ),
          )}
        </div>
      ) : null}
      {hasAnswer && citations.some(c => !referenced.has(c.index)) ? (
        <p className="ui-ask-turn__sources">
          {citations
            .filter(c => !referenced.has(c.index))
            .map(c => (
              <Citation
                key={c.index}
                {...c}
                onOpen={onOpenCitation}
                onOpenEvent={onOpenEventCitation}
              />
            ))}
        </p>
      ) : null}
      {hasAnswer && (state === 'answered' || state === 'stopped') && citations.length === 0 ? (
        <p className="ui-ask-turn__no-source">No source in your mail</p>
      ) : null}
      {state === 'stopped' ? (
        <p className="ui-ask-turn__stopped" role="status">
          Stopped.
        </p>
      ) : null}
      {state === 'paused' ? (
        <p className="ui-ask-turn__paused" role="status">
          Paused for today. Resumes tomorrow.
          {onUseAnotherProvider ? (
            <>
              {' '}
              <Btn variant="text" label="Use another provider" onPress={onUseAnotherProvider} />
            </>
          ) : null}
        </p>
      ) : null}
      {state === 'excluded' ? (
        <p className="ui-ask-turn__excluded" role="status">
          This account is turned off for AI. Turn it on in Settings, or ask from another account.
          {onOpenSettings ? (
            <>
              {' '}
              <Btn variant="text" label="Open Settings" onPress={onOpenSettings} />
            </>
          ) : null}
        </p>
      ) : null}
      {state === 'failed' ? (
        <div className="ui-ask-turn__error" role="alert">
          <Icon name="alert" />
          <span dir="auto">{`${provider?.trim() || 'Ask'} didn't answer.`}</span>
          <span className="ui-ask-turn__error-acts">
            {onRetry ? <Btn variant="text" label="Retry" onPress={onRetry} /> : null}
            {onUseAnotherProvider ? (
              <Btn variant="text" label="Use another provider" onPress={onUseAnotherProvider} />
            ) : null}
          </span>
        </div>
      ) : null}
      {proposal ? <ProposalCard {...proposal} /> : null}
    </article>
  );
}
