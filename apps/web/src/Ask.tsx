import { useEffect, useRef, useState } from 'react';

// A scripted copy of the Ask panel. Questions and answers come from the app's original demo data; nothing is sent anywhere.
type Proposal = { title: string; when: string; calendar: string };
type Answer = { text: string; sources?: string[]; proposal?: Proposal };
const questions: [string, Answer][] = [
  [
    'What plans do I have this week?',
    {
      text: 'Besides the 9 AM standups: design critique Monday at 1, dinner with Sam Tuesday at 7, a welcome lunch Wednesday at noon, yoga Thursday at 6 and team retro Friday at 10. The cabin weekend starts Friday.',
      sources: ['Design critique', 'Dinner with Sam', 'Cabin weekend'],
    },
  ],
  [
    'Which emails still need a reply?',
    {
      text: 'Three are waiting on you. Jordan Park wants your pick of two layout directions by tomorrow. Rowan Pottery is holding a seat in the Tuesday evening class. Drew’s October invoice is overdue for approval.',
      sources: ['Jordan Park', 'Rowan Pottery', 'Drew'],
    },
  ],
  [
    'Book lunch with Maya Friday at noon',
    {
      text: 'Here is the event. It goes on your calendar only when you add it.',
      proposal: { title: 'Lunch with Maya', when: 'Friday, 12:00 – 1:00 PM', calendar: 'Personal' },
    },
  ],
];

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function Bubble() {
  return (
    <svg className="ask-bubble" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3 3.5h10a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 13 11.5H7.5L4.5 14v-2.5H3A1.5 1.5 0 0 1 1.5 10V5A1.5 1.5 0 0 1 3 3.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Ask() {
  const [asked, setAsked] = useState<number | null>(null);
  const [typed, setTyped] = useState('');
  const [words, setWords] = useState(0);
  const [booking, setBooking] = useState<'open' | 'added' | 'dismissed'>('open');
  const [run, setRun] = useState(0); // counts asks, so asking the same question again replays it
  const timer = useRef(0);
  const panel = useRef<HTMLDivElement>(null);
  // Hold to talk: while A (or the hint) is held the panel listens; on release it "hears" the next sample question.
  const [listening, setListening] = useState(false);
  const hold = useRef({ on: false, since: 0, next: 0 });
  const answer = asked === null ? null : questions[asked][1];
  const total = answer ? answer.text.split(' ').length : 0;
  const done = answer !== null && words >= total;

  // Type the question into the field, then stream the answer a word at a time, like the app.
  useEffect(() => {
    if (asked === null) return;
    const question = questions[asked][0];
    const answerWords = questions[asked][1].text.split(' ').length;
    if (reduced()) {
      setTyped(question);
      setWords(answerWords);
      return;
    }
    let chars = 0,
      count = 0;
    const typeNext = () => {
      chars++;
      setTyped(question.slice(0, chars));
      timer.current = window.setTimeout(
        chars < question.length ? typeNext : streamNext,
        chars < question.length ? 22 : 260,
      );
    };
    const streamNext = () => {
      count++;
      setWords(count);
      if (count < answerWords) timer.current = window.setTimeout(streamNext, 38);
    };
    typeNext();
    return () => window.clearTimeout(timer.current);
  }, [asked, run]);

  const ask = (i: number) => {
    window.clearTimeout(timer.current);
    setTyped('');
    setWords(0);
    setBooking('open');
    setAsked(i);
    setRun(n => n + 1);
  };
  const clear = () => {
    window.clearTimeout(timer.current);
    setAsked(null);
    setTyped('');
    setWords(0);
  };
  // The pressed suggestion or clear button goes away with the view it was in; keep keyboard focus in the panel.
  const keepFocus = () =>
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) panel.current?.focus({ preventScroll: true });
    });
  const listen = () => {
    if (hold.current.on) return;
    hold.current.on = true;
    hold.current.since = performance.now();
    setListening(true);
  };
  const release = () => {
    if (!hold.current.on) return;
    hold.current.on = false;
    setListening(false);
    if (performance.now() - hold.current.since < 350) return;
    const next = hold.current.next;
    hold.current.next = (next + 1) % questions.length;
    ask(next);
  };
  const listenRef = useRef({ listen, release, ask });
  listenRef.current = { listen, release, ask };
  // The suggestions in the screenshot at the top of the page ask here.
  useEffect(() => {
    const fromTour = (event: Event) => {
      panel.current!.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' });
      listenRef.current.ask((event as CustomEvent<number>).detail);
    };
    window.addEventListener('aplos:ask', fromTour);
    return () => window.removeEventListener('aplos:ask', fromTour);
  }, []);
  useEffect(() => {
    let visible = false;
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
      },
      { threshold: 0.5 },
    );
    observer.observe(panel.current!);
    const down = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== 'a' ||
        event.repeat ||
        !visible ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      if ((event.target as HTMLElement).closest('input, textarea, select, [role="group"]')) return;
      listenRef.current.listen();
    };
    const up = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'a') listenRef.current.release();
    };
    const blur = () => listenRef.current.release();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      observer.disconnect();
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  return (
    <div className="askp" data-ui ref={panel} tabIndex={-1}>
      <div className="askp-top">
        <div className="askp-tabs" aria-hidden="true">
          <span className="on">Ask</span>
          <span>Calendar</span>
        </div>
        {asked !== null && (
          <button
            type="button"
            className="askp-clear"
            onClick={() => {
              clear();
              keepFocus();
            }}
            aria-label="Clear the question"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="m4 4 8 8m0-8-8 8"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>
      <div className={`askp-field${listening ? ' is-listening' : ''}`}>
        {listening ? (
          <span className="askp-listening" role="status">
            Listening
            <span className="askp-level" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
          </span>
        ) : (
          <span className={typed ? 'askp-typed' : 'askp-placeholder'} aria-hidden="true">
            {typed || 'Ask me anything'}
          </span>
        )}
        {!typed && (
          <button
            type="button"
            className="askp-talk"
            aria-label="Hold to talk"
            onPointerDown={event => {
              event.currentTarget.setPointerCapture(event.pointerId);
              listen();
            }}
            onPointerUp={release}
            onPointerCancel={release}
            onKeyDown={event => {
              if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
                event.preventDefault();
                listen();
              }
            }}
            onKeyUp={event => {
              if (event.key === ' ' || event.key === 'Enter') release();
            }}
            onContextMenu={event => event.preventDefault()}
          >
            {listening ? (
              'Release to ask'
            ) : (
              <>
                Hold <kbd>A</kbd> to talk
              </>
            )}
          </button>
        )}
      </div>
      {asked === null ? (
        <div className="askp-body" key="list">
          <p className="askp-label">Try asking</p>
          <ul className="askp-list">
            {questions.map(([q], i) => (
              <li key={q}>
                <button
                  type="button"
                  onClick={() => {
                    ask(i);
                    keepFocus();
                  }}
                >
                  <Bubble />
                  {q}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="askp-body" key={`a${asked}-${run}`}>
          <p className="askp-answer">
            {answer!.text.split(' ').map((word, i) => (
              <span key={i} className={i < words ? 'w on' : 'w'}>
                {word}{' '}
              </span>
            ))}
          </p>
          {answer!.sources && (
            <ul
              className={`askp-sources${done ? ' on' : ''}`}
              aria-label="Messages and events used"
            >
              {answer!.sources.map(s => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}
          {answer!.proposal && (
            <div
              className={`askp-event${done ? ' on' : ''}${booking !== 'open' ? ` is-${booking}` : ''}`}
            >
              <div className="askp-event-text">
                <b>{answer!.proposal.title}</b>
                <span>
                  {answer!.proposal.when} · {answer!.proposal.calendar}
                </span>
              </div>
              {booking === 'open' && (
                <div className="askp-event-actions">
                  <button
                    type="button"
                    className="act"
                    onClick={() => {
                      setBooking('dismissed');
                      keepFocus();
                    }}
                    tabIndex={done ? 0 : -1}
                  >
                    Not now
                  </button>
                  <button
                    type="button"
                    className="act act-primary"
                    onClick={() => {
                      setBooking('added');
                      keepFocus();
                    }}
                    tabIndex={done ? 0 : -1}
                  >
                    Add to calendar
                  </button>
                </div>
              )}
              {booking === 'added' && (
                <p className="askp-event-state" role="status">
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path
                      d="m3.5 8.5 3 3 6-7"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  Added to Friday
                </p>
              )}
              {booking === 'dismissed' && (
                <p className="askp-event-state" role="status">
                  Nothing was added.
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {/* One region that stays mounted, so screen readers hear the answer once it is complete. */}
      <p className="sr" aria-live="polite">
        {done ? answer!.text : ''}
      </p>
    </div>
  );
}
