import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckIcon, ClockIcon } from './Icons';
import { TriageCard, type Move } from './TriageCard';
import { laneLabel, leftInLane, mails, type Mail } from './triageData';

type Ghost = { id: number; mail: Mail; move: Move; x: number };

const GHOST_MS = 360;

function statusFor(move: Move, mail: Mail) {
  if (move === 'later') return `Moved to Later: ${mail.sender}`;
  if (move === 'done' || mail.action.kind === 'done') return `Done: ${mail.sender}`;
  if (mail.action.kind === 'reply') return `Opened a reply to ${mail.sender}`;
  return `Opened the email from ${mail.sender}`;
}

const keyMoves: Record<string, Move> = { ' ': 'act', ArrowLeft: 'later', ArrowRight: 'done' };

function hintFor(focused: boolean) {
  if (focused)
    return 'Space starts the button’s step, ← moves it to Later, → marks it Done, Z undoes.';
  const touch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  if (touch) return 'Tap the button, or swipe the card: left for Later, right for Done.';
  return 'Click the card, then press Space, ← or →, or drag it sideways.';
}

// The swipe underlay: Done shows on the left as the card moves right, Later on the right as it moves left.
function SwipeHints({ hints }: { hints: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div className="swipe-hints" ref={hints} aria-hidden="true">
      <span className="swipe-done">
        <CheckIcon />
        Done
      </span>
      <span className="swipe-later">
        <ClockIcon />
        Later
      </span>
    </div>
  );
}

function NextRows({ index }: { index: number }) {
  return (
    <ul className="mail-rows" aria-hidden="true">
      {mails.slice(index + 1, index + 4).map(mail => (
        <li key={mail.sender} className="mail-row">
          <span className="row-sender">{mail.sender}</span>
          <span className="row-text">
            {mail.subject}
            <span className="row-summary"> · {mail.summary}</span>
          </span>
          <span className="row-when">{mail.when}</span>
        </li>
      ))}
    </ul>
  );
}

function Finished({ onRestart }: { onRestart: () => void }) {
  return (
    <div className="triage-empty">
      <p>You handled {mails.length} emails.</p>
      <button type="button" className="app-text" tabIndex={-1} onClick={onRestart}>
        Start over
      </button>
    </div>
  );
}

function useHints() {
  const hints = useRef<HTMLDivElement>(null);
  const show = useCallback((x: number) => {
    const [done, later] = hints.current?.children ?? [];
    const amount = (value: number) => String(Math.min(1, Math.max(0, value) / 110));
    if (done) (done as HTMLElement).style.opacity = amount(x);
    if (later) (later as HTMLElement).style.opacity = amount(-x);
  }, []);
  return { hints, show };
}

type TriageState = {
  index: number;
  mail: Mail | undefined;
  ghosts: Ghost[];
  status: string;
  act: (move: Move, x?: number) => void;
  undo: () => void;
  restart: () => void;
};

// The demo's state: which email is in focus, the ghosts of cards on their way out, and the one-line status.
function useTriage(): TriageState {
  const [index, setIndex] = useState(0);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [history, setHistory] = useState<number[]>([]);
  const [status, setStatus] = useState('');
  const ghostId = useRef(0);
  const timers = useRef(new Set<number>());

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(id => window.clearTimeout(id));
  }, []);

  const removeLater = (id: number) => {
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setGhosts(list => list.filter(g => g.id !== id));
    }, GHOST_MS);
    timers.current.add(timer);
  };

  const act = (move: Move, x = 0) => {
    const current = mails[index];
    if (!current) return;
    const id = ++ghostId.current;
    setGhosts(list => [...list, { id, mail: current, move, x }]);
    removeLater(id);
    setHistory(list => [...list, index]);
    setIndex(index + 1);
    setStatus(statusFor(move, current));
  };

  const undo = () => {
    const previous = history.at(-1);
    if (previous === undefined) return;
    setHistory(history.slice(0, -1));
    setIndex(previous);
    setStatus(`Undone: ${mails[previous].sender}`);
  };

  const restart = () => {
    setIndex(0);
    setHistory([]);
    setStatus('');
  };

  return { index, mail: mails[index], ghosts, status, act, undo, restart };
}

// A small working copy of Home: one email in focus, acted on with the same keys as the app. Each action sends a
// ghost of the card off while the next one comes in, so quick presses never wait on an animation.
export function Triage() {
  const { index, mail, ghosts, status, act, undo, restart } = useTriage();
  const [focused, setFocused] = useState(false);
  const { hints, show } = useHints();

  // Holding a key does not repeat: one press is one email. Keys that do nothing are left to the page.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const move = keyMoves[event.key];
    const isUndo = event.key.toLowerCase() === 'z';
    if (!(move && mail) && !isUndo) return;
    event.preventDefault();
    if (event.repeat) return;
    if (move) act(move);
    else undo();
  };

  const lane = mail?.lane ?? 'updates';
  return (
    <div className="triage">
      <div
        className="triage-surface"
        tabIndex={0}
        role="group"
        aria-label="Try Home. Click, then use Space, the left and right arrow keys and Z."
        aria-keyshortcuts="Space ArrowLeft ArrowRight Z"
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        <div className="home-head">
          <span className="home-label">
            {mail ? laneLabel[lane] : 'Home'}
            <span className="home-count">{mail ? leftInLane(index, lane) : 0}</span>
          </span>
          <span className="home-link">Go one by one</span>
        </div>
        <div className="triage-stage">
          <SwipeHints hints={hints} />
          {ghosts.map(g => (
            <TriageCard key={`g${g.id}`} mail={g.mail} ghost={g.move} from={g.x} />
          ))}
          {mail ? (
            <TriageCard key={index} mail={mail} onMove={act} onDrag={show} />
          ) : (
            <Finished onRestart={restart} />
          )}
        </div>
        <NextRows index={index} />
      </div>
      <p className="demo-hint" aria-live="polite">
        {status && focused ? status : hintFor(focused)}
      </p>
    </div>
  );
}
