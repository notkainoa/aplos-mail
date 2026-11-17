import { useEffect, useRef, useState } from 'react';
import { questions, wordCount } from './askData';

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const TYPE_MS = 22;
const PAUSE_MS = 260;
const WORD_MS = 38;
const HOLD_MS = 350;

/** Types the asked question into the field, then streams the answer a word at a time. */
export function useAskScript() {
  const [asked, setAsked] = useState<number | null>(null);
  const [typed, setTyped] = useState('');
  const [words, setWords] = useState(0);
  const [run, setRun] = useState(0); // counts asks, so asking the same question again replays it
  const timer = useRef(0);

  useEffect(() => {
    if (asked === null) return;
    const [question, answer] = questions[asked];
    const total = wordCount(answer.text);
    if (reduced()) {
      setTyped(question);
      setWords(total);
      return;
    }
    let chars = 0;
    let count = 0;
    const streamNext = () => {
      count += 1;
      setWords(count);
      if (count < total) timer.current = window.setTimeout(streamNext, WORD_MS);
    };
    const typeNext = () => {
      chars += 1;
      setTyped(question.slice(0, chars));
      const more = chars < question.length;
      timer.current = window.setTimeout(more ? typeNext : streamNext, more ? TYPE_MS : PAUSE_MS);
    };
    typeNext();
    return () => window.clearTimeout(timer.current);
  }, [asked, run]);

  const reset = () => {
    window.clearTimeout(timer.current);
    setTyped('');
    setWords(0);
  };
  const ask = (index: number) => {
    reset();
    setAsked(index);
    setRun(n => n + 1);
  };
  const clear = () => {
    reset();
    setAsked(null);
  };
  return { asked, typed, words, run, ask, clear };
}

function isDictateKey(event: KeyboardEvent) {
  if (event.key.toLowerCase() !== 'a' || event.repeat) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target as HTMLElement;
  return !target.closest('input, textarea, select, [role="group"]');
}

function useVisible(target: React.RefObject<HTMLElement | null>) {
  const visible = useRef(false);
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible.current = entry.isIntersecting;
      },
      { threshold: 0.5 },
    );
    observer.observe(target.current!);
    return () => observer.disconnect();
  }, [target]);
  return visible;
}

/**
 * Hold to dictate: while A (or the hint button) is held the panel listens; on release it "hears" the next sample
 * question. A tap shorter than HOLD_MS does nothing, like the app.
 */
export function useHoldToDictate(
  panel: React.RefObject<HTMLElement | null>,
  onHeard: (index: number) => void,
) {
  const [listening, setListening] = useState(false);
  const hold = useRef({ on: false, since: 0, next: 0 });
  const visible = useVisible(panel);

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
    if (performance.now() - hold.current.since < HOLD_MS) return;
    const next = hold.current.next;
    hold.current.next = (next + 1) % questions.length;
    onHeard(next);
  };

  const latest = useRef({ listen, release });
  latest.current = { listen, release };
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (visible.current && isDictateKey(event)) latest.current.listen();
    };
    const up = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'a') latest.current.release();
    };
    const blur = () => latest.current.release();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [visible]);

  return { listening, listen, release };
}
