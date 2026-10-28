import type { AskTurnProps, CitationData } from '../props';
import { Icon } from '../compose/icons';
import { Btn } from '../compose/parts';
import { Citation } from './Citation';
import { ProposalCard } from './ProposalCard';
import { StepLog } from './StepLog';

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
  } = props;
  const questionId = `${id}-question`;
  const byIndex = new Map<number, CitationData>(citations.map(c => [c.index, c]));
  const referenced = new Set<number>();
  const hasAnswer = Boolean(answer && answer.length > 0);
  // Hover only (DESIGN §9 rule 5): "Answer by Groq", "Answer by Ollama on this Mac".
  const provenanceText = provenance
    ? `Answer by ${provenance.provider}${provenance.local ? ' on this Mac' : ''}`
    : undefined;

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
      {steps ? <StepLog {...steps} /> : null}
      {hasAnswer ? (
        <div className="ui-ask-turn__answer" dir="auto" title={provenanceText}>
          {answer!.map((paragraph, p) => (
            <p key={p}>
              {paragraph.map((segment, s) => {
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
                  <Citation
                    key={s}
                    {...source}
                    onOpen={onOpenCitation}
                    onOpenEvent={onOpenEventCitation}
                  />
                ) : (
                  <span key={s} className="ui-ask-turn__orphan">{`[${segment.index}]`}</span>
                );
              })}
              {state === 'streaming' && p === answer!.length - 1 ? (
                <span className="ui-ask-turn__caret" aria-hidden="true" />
              ) : null}
            </p>
          ))}
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
