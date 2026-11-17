import { useRef, useState } from 'react';
import { BubbleIcon, CheckIcon, CloseIcon } from './Icons';
import { questions, wordCount, type Answer, type Proposal } from './askData';
import { useAskScript, useHoldToDictate } from './askHooks';

type Booking = 'open' | 'added' | 'dismissed';

function Listening() {
  return (
    <span className="ask-listening" role="status">
      Listening
      <span className="ask-level" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

type TalkProps = { listening: boolean; listen: () => void; release: () => void };

function TalkButton({ listening, listen, release }: TalkProps) {
  const onKey = (event: React.KeyboardEvent, down: boolean) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    if (down && !event.repeat) listen();
    if (!down) release();
  };
  return (
    <button
      type="button"
      className="ask-talk"
      aria-label="Hold A to dictate"
      onPointerDown={event => {
        event.currentTarget.setPointerCapture(event.pointerId);
        listen();
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onKeyDown={event => onKey(event, true)}
      onKeyUp={event => onKey(event, false)}
      onContextMenu={event => event.preventDefault()}
    >
      {listening ? (
        'Release to ask'
      ) : (
        <>
          Hold <kbd className="kbd">A</kbd> to dictate
        </>
      )}
    </button>
  );
}

type FieldProps = TalkProps & { typed: string };

function AskField({ typed, listening, listen, release }: FieldProps) {
  return (
    <div className={`ask-field${listening ? ' is-listening' : ''}`}>
      {listening ? (
        <Listening />
      ) : (
        <span className={typed ? 'ask-typed' : 'ask-placeholder'} aria-hidden="true">
          {typed || 'Ask about your mail or calendar'}
        </span>
      )}
      {typed ? null : <TalkButton listening={listening} listen={listen} release={release} />}
    </div>
  );
}

function Suggestions({ onAsk }: { onAsk: (index: number) => void }) {
  return (
    <div className="ask-body">
      <p className="ask-label">Try asking</p>
      <ul className="ask-list">
        {questions.map(([question], index) => (
          <li key={question}>
            <button type="button" onClick={() => onAsk(index)}>
              <BubbleIcon />
              {question}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

type ProposalProps = {
  proposal: Proposal;
  shown: boolean;
  booking: Booking;
  onBook: (b: Booking) => void;
};

function ProposalCard({ proposal, shown, booking, onBook }: ProposalProps) {
  return (
    <div className={`ask-event${shown ? ' on' : ''}`}>
      <div className="ask-event-text">
        <b>{proposal.title}</b>
        <span>
          {proposal.when} · {proposal.calendar}
        </span>
      </div>
      {booking === 'open' ? (
        <div className="ask-event-actions">
          <button
            type="button"
            className="app-text"
            onClick={() => onBook('dismissed')}
            tabIndex={shown ? 0 : -1}
          >
            Not now
          </button>
          <button
            type="button"
            className="app-filled"
            onClick={() => onBook('added')}
            tabIndex={shown ? 0 : -1}
          >
            Add to calendar
          </button>
        </div>
      ) : null}
      {booking === 'added' ? (
        <p className="ask-event-state" role="status">
          <CheckIcon />
          Added to Friday
        </p>
      ) : null}
      {booking === 'dismissed' ? (
        <p className="ask-event-state" role="status">
          Nothing was added.
        </p>
      ) : null}
    </div>
  );
}

type AnswerProps = {
  question: string;
  answer: Answer;
  words: number;
  booking: Booking;
  onBook: (b: Booking) => void;
};

function AnswerView({ question, answer, words, booking, onBook }: AnswerProps) {
  const done = words >= wordCount(answer.text);
  return (
    <div className="ask-body">
      <p className="ask-question">{question}</p>
      <p className="ask-answer">
        {answer.text.split(' ').map((word, i) => (
          <span key={i} className={i < words ? 'w on' : 'w'}>
            {word}{' '}
          </span>
        ))}
      </p>
      {answer.sources ? (
        <ul className={`ask-sources${done ? ' on' : ''}`} aria-label="Messages and events used">
          {answer.sources.map(source => (
            <li key={source}>{source}</li>
          ))}
        </ul>
      ) : null}
      {answer.proposal ? (
        <ProposalCard proposal={answer.proposal} shown={done} booking={booking} onBook={onBook} />
      ) : null}
    </div>
  );
}

// A scripted copy of the Ask panel. Questions and answers come from the app's original demo data; nothing is sent
// anywhere. A question types itself into the field, then the answer streams in a word at a time, like the app.
export function Ask() {
  const panel = useRef<HTMLDivElement>(null);
  const script = useAskScript();
  const [booking, setBooking] = useState<Booking>('open');
  // The pressed suggestion or clear button goes away with the view it was in; keep keyboard focus in the panel.
  const keepFocus = () =>
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) panel.current?.focus({ preventScroll: true });
    });
  const ask = (index: number) => {
    setBooking('open');
    script.ask(index);
    keepFocus();
  };
  const clear = () => {
    script.clear();
    keepFocus();
  };
  const book = (next: Booking) => {
    setBooking(next);
    keepFocus();
  };
  const dictate = useHoldToDictate(panel, ask);
  const { asked, typed, words } = script;
  const answer = asked === null ? null : questions[asked][1];
  const done = answer !== null && words >= wordCount(answer.text);

  return (
    <div
      className="ask-panel"
      data-claim="ask-cites ask-dictate plans-confirm"
      ref={panel}
      tabIndex={-1}
    >
      <div className="ask-head">
        <BubbleIcon />
        <span>Ask</span>
        {asked !== null ? (
          <button
            type="button"
            className="app-icon"
            onClick={clear}
            aria-label="Clear the question"
          >
            <CloseIcon />
          </button>
        ) : null}
      </div>
      {asked === null || !answer ? (
        <Suggestions onAsk={ask} />
      ) : (
        <AnswerView
          key={`${asked}-${script.run}`}
          question={questions[asked][0]}
          answer={answer}
          words={words}
          booking={booking}
          onBook={book}
        />
      )}
      <AskField typed={typed} {...dictate} />
      {/* One region that stays mounted, so screen readers hear the answer once it is complete. */}
      <p className="sr" aria-live="polite">
        {done && answer ? answer.text : ''}
      </p>
    </div>
  );
}
