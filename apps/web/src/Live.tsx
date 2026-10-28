import { Fragment, useEffect, useRef, useState } from 'react';

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// The shortcut list answers the real keyboard: while it is on screen, pressing one of its keys presses its cap.
const keys: [string, string, string[]][] = [
  ['Space', 'The email’s main action, like Reply', [' ']],
  ['←', 'Set it aside for Later', ['ArrowLeft']],
  ['→', 'Mark it Done', ['ArrowRight']],
  ['Z', 'Undo the last action', ['z', 'Z']],
  ['B', 'Bookmark', ['b', 'B']],
  ['A', 'Ask, or hold it to talk', ['a', 'A']],
  ['C', 'Compose', ['c', 'C']],
  ['?', 'Every shortcut in the app', ['?']],
];
export function KeyList() {
  const ref = useRef<HTMLDListElement>(null);
  const [pressed, setPressed] = useState<string | null>(null);
  const visible = useRef(false);
  useEffect(() => {
    const list = ref.current!;
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible.current = entry.isIntersecting;
      },
      { threshold: 0.4 },
    );
    observer.observe(list);
    const down = (event: KeyboardEvent) => {
      if (!visible.current || event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.target as HTMLElement).closest('input, textarea, select')) return;
      const hit = keys.find(([, , codes]) => codes.includes(event.key));
      if (hit) setPressed(hit[0]);
    };
    const up = () => setPressed(null);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', up);
    return () => {
      observer.disconnect();
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', up);
    };
  }, []);
  return (
    <dl className="keylist" data-ui ref={ref}>
      {keys.map(([key, label], i) => (
        <div
          key={key}
          data-pressed={pressed === key || undefined}
          data-reveal
          style={{ '--d': `${60 + i * 40}ms` } as React.CSSProperties}
          onPointerDown={() => setPressed(key)}
          onPointerUp={() => setPressed(null)}
          onPointerLeave={() => setPressed(p => (p === key ? null : p))}
        >
          <dt>
            <kbd>{key}</kbd>
          </dt>
          <dd>{label}</dd>
        </div>
      ))}
    </dl>
  );
}

// The app's segmented control. The selected card slides by clipping one full-width layer, so nothing resizes.
function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [clip, setClip] = useState<string | null>(null);
  useEffect(() => {
    const measure = () => {
      const tabs = row.current;
      const button = tabs?.querySelector<HTMLElement>(`[data-value="${value}"]`);
      if (tabs && button)
        setClip(
          `inset(${button.offsetTop - 3}px ${tabs.clientWidth - button.offsetLeft - button.offsetWidth}px ${tabs.clientHeight - button.offsetTop - button.offsetHeight - 3}px ${button.offsetLeft}px round 8px)`,
        );
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [value]);
  return (
    <div className="picker-tabs" data-ui role="group" aria-label={label} ref={row}>
      {clip && <span className="picker-pill" aria-hidden="true" style={{ clipPath: clip }} />}
      {options.map(o => (
        <button
          key={o}
          type="button"
          aria-pressed={o === value}
          data-value={o}
          onClick={() => onChange(o)}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

// A small copy of Settings → AI: choose the provider for each feature. Voice needs speech-to-text, which only Groq and OpenAI offer here.
const features = ['Summaries', 'Ask', 'Drafts', 'Plans', 'Voice'] as const;
type Feature = (typeof features)[number];
const providers = [
  'Groq',
  'OpenAI',
  'Claude',
  'Gemini',
  'OpenRouter',
  'OpenCode Go',
  'Ollama',
  'LM Studio',
  'your own server',
];
const local = new Set(['Ollama', 'LM Studio']);
const speech = new Set(['Groq', 'OpenAI']);
export function ProviderPicker() {
  const [feature, setFeature] = useState<Feature>('Summaries');
  const [chosen, setChosen] = useState<Record<Feature, string>>({
    Summaries: 'Groq',
    Ask: 'Groq',
    Drafts: 'Groq',
    Plans: 'Groq',
    Voice: 'Groq',
  });
  const provider = chosen[feature];
  const what =
    feature === 'Voice' ? 'Voice recordings' : feature === 'Ask' ? 'Questions to Ask' : feature;
  const where = local.has(provider)
    ? `${provider}, on your Mac. Nothing leaves it.`
    : provider === 'your own server'
      ? 'your own server, at the address you set.'
      : `${provider}${provider === 'Groq' ? ', the default' : ''}, and to no one else.`;
  return (
    <div className="picker">
      <Segmented label="AI feature" options={features} value={feature} onChange={setFeature} />
      <p className="providers" role="group" aria-label={`Provider for ${feature}`}>
        {providers.map((p, i) => {
          const off = feature === 'Voice' && !speech.has(p);
          return (
            <Fragment key={p}>
              <span className="provider-item">
                <button
                  type="button"
                  className={`provider${p === provider ? ' is-on' : ''}`}
                  aria-pressed={p === provider}
                  disabled={off}
                  title={off ? 'Voice needs a speech-to-text provider' : undefined}
                  onClick={() => setChosen(c => ({ ...c, [feature]: p }))}
                >
                  {p}
                </button>
                {i < providers.length - 2 ? ',' : i === providers.length - 1 ? '.' : ''}
              </span>
              {i === providers.length - 2 ? ' or ' : i < providers.length - 1 ? ' ' : ''}
            </Fragment>
          );
        })}
      </p>
      <p className="picker-result" aria-live="polite">
        <span key={`${feature}${provider}`}>
          {what} go to {where}
          {feature === 'Voice' ? ' Only Groq and OpenAI turn speech into text.' : ''}
        </span>
      </p>
    </div>
  );
}

// The hero icon leans a few degrees toward the pointer, eased each frame so it never snaps.
export function HeroIcon({ src, alt }: { src: string; alt: string }) {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (reduced() || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    const img = ref.current!;
    let target = { x: 0, y: 0 },
      now = { x: 0, y: 0 },
      frame = 0;
    const tick = () => {
      now = { x: now.x + (target.x - now.x) * 0.08, y: now.y + (target.y - now.y) * 0.08 };
      img.style.transform = `perspective(800px) rotateX(${now.y.toFixed(2)}deg) rotateY(${now.x.toFixed(2)}deg)`;
      frame =
        Math.abs(target.x - now.x) + Math.abs(target.y - now.y) > 0.01
          ? requestAnimationFrame(tick)
          : 0;
    };
    const move = (event: PointerEvent) => {
      const box = img.getBoundingClientRect();
      const dx = (event.clientX - (box.left + box.width / 2)) / window.innerWidth,
        dy = (event.clientY - (box.top + box.height / 2)) / window.innerHeight;
      target = {
        x: Math.max(-1, Math.min(1, dx * 2)) * 8,
        y: Math.max(-1, Math.min(1, dy * 2)) * -8,
      };
      if (!frame) frame = requestAnimationFrame(tick);
    };
    window.addEventListener('pointermove', move, { passive: true });
    return () => {
      window.removeEventListener('pointermove', move);
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <div className="hero-icon">
      <img ref={ref} src={src} width="512" height="512" alt={alt} />
    </div>
  );
}

// Splits a line into words or letters that rise in turn. Assistive tech reads the plain text instead.
export function Rise({
  text,
  by = 'word',
  step = 50,
}: {
  text: string;
  by?: 'word' | 'letter';
  step?: number;
}) {
  const parts = by === 'word' ? text.split(' ') : [...text];
  return (
    <span className="rise">
      <span className="sr">{text}</span>
      <span aria-hidden="true">
        {parts.map((part, i) => (
          <Fragment key={i}>
            <span
              className="rise-part"
              style={{ '--i': i, '--step': `${step}ms` } as React.CSSProperties}
            >
              {part === ' ' ? '\u00a0' : part}
            </span>
            {by === 'word' && i < parts.length - 1 ? ' ' : ''}
          </Fragment>
        ))}
      </span>
    </span>
  );
}
