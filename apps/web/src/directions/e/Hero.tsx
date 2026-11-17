import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { HERO_KEYS, type KeyId, type KeyInfo } from './demo';
import { ActionView, AskView, HomeView } from './Mocks';
import { useDemo, type DemoState } from './useDemo';

const KEY_MAP: Record<string, KeyId> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  z: 'z',
  Z: 'z',
  a: 'a',
  A: 'a',
};

const PRESS_MS = 160;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function hasModifier(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey;
}

function useInView(ref: RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      threshold: 0.3,
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return inView;
}

/** Which demo key, if any, this keydown means. Space counts only while the keys have focus. */
function keyFor(event: KeyboardEvent, region: HTMLElement | null, inView: boolean): KeyId | null {
  if (event.defaultPrevented || hasModifier(event) || isTyping(event.target)) return null;
  const focusedHere = !!region && region.contains(document.activeElement);
  if (event.key === ' ') return focusedHere ? 'space' : null;
  const key = KEY_MAP[event.key];
  if (!key || !inView) return null;
  return key;
}

function useKeyboard(
  region: RefObject<HTMLElement | null>,
  inView: boolean,
  press: (key: KeyId) => void,
) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const key = keyFor(event, region.current, inView);
      if (!key) return;
      event.preventDefault();
      if (!event.repeat) press(key);
    }
    function onKeyUp(event: KeyboardEvent) {
      const inside = !!region.current && region.current.contains(document.activeElement);
      if (event.key === ' ' && inside) event.preventDefault();
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [region, inView, press]);
}

function Keycap({
  info,
  on,
  down,
  onPress,
}: {
  info: KeyInfo;
  on: boolean;
  down: boolean;
  onPress: () => void;
}) {
  const classes = ['cap', `cap--${info.id}`, on ? 'is-on' : '', down ? 'is-down' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={`cap-slot cap-slot--${info.id}`}>
      <button
        type="button"
        className={classes}
        aria-label={info.label}
        aria-keyshortcuts={info.id === 'space' ? 'Space' : info.glyph}
        aria-controls="keys-stage"
        onClick={onPress}
      >
        <span className="cap-glyph" aria-hidden="true">
          {info.glyph}
        </span>
      </button>
      <span className="cap-word" aria-hidden="true">
        {info.word}
      </span>
    </div>
  );
}

function StageBody({ state }: { state: DemoState }) {
  if (state.mode === 'ask') return <AskView />;
  if (state.mode === 'action') return <ActionView index={state.index} />;
  return <HomeView index={state.index} />;
}

function NoteKey({ last }: { last: KeyId | null }) {
  const info = HERO_KEYS.find(item => item.id === last);
  if (!info) return null;
  return (
    <kbd className="kbd note-key" aria-hidden="true">
      {info.glyph}
    </kbd>
  );
}

function Stage({ state }: { state: DemoState }) {
  const enter = state.last ? `enter-${state.last}` : '';
  return (
    <div className="stage" id="keys-stage">
      <p className="stage-note" aria-live="polite" data-claim="key-list home-focus">
        <NoteKey last={state.last} />
        <span>{state.note}</span>
      </p>
      <div className={`stage-body ${enter}`} key={state.tick}>
        <StageBody state={state} />
      </div>
    </div>
  );
}

function usePress(dispatch: (key: KeyId) => void) {
  const [down, setDown] = useState<KeyId | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const press = useCallback(
    (key: KeyId) => {
      dispatch(key);
      setDown(key);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setDown(null), PRESS_MS);
    },
    [dispatch],
  );
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { down, press };
}

export function Hero() {
  const [state, dispatch] = useDemo();
  const { down, press } = usePress(dispatch);
  const hero = useRef<HTMLElement>(null);
  const region = useRef<HTMLDivElement>(null);
  const inView = useInView(hero);
  useKeyboard(region, inView, press);

  return (
    <section className="hero" ref={hero} aria-labelledby="hero-title">
      <p className="hero-kicker" data-claim="gmail-google-calendar">
        A Mac app for Gmail and Google Calendar
      </p>
      <h1 id="hero-title" className="hero-title">
        Finish your inbox, one email at a time.
      </h1>
      <p className="hero-sub" data-claim="keyboard-first">
        Your hands stay on the keyboard from the first email to the last.
      </p>
      <div className="keys" ref={region} role="group" aria-label="Try the keys">
        <div className="caps">
          {HERO_KEYS.map(info => (
            <Keycap
              key={info.id}
              info={info}
              on={state.last === info.id}
              down={down === info.id}
              onPress={() => press(info.id)}
            />
          ))}
        </div>
        <p className="keys-hint">
          <span className="hint-fine">
            Press ← → Z or A on your keyboard. Space works once you click a key.
          </span>
          <span className="hint-touch">Tap a key to see what it does.</span>
        </p>
        <Stage state={state} />
      </div>
    </section>
  );
}
