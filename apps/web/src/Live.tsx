import { useEffect, useRef, useState } from 'react';
import { CheckIcon } from './Icons';
import { observeVisible } from './reveal';

// The shortcut list answers the real keyboard: while it is on screen, pressing one of its keys presses its cap.
const keys: [string, string, string[]][] = [
  ['Space', 'Start the suggested step', [' ']],
  ['→', 'Done', ['ArrowRight']],
  ['←', 'Later', ['ArrowLeft']],
  ['Z', 'Undo', ['z', 'Z']],
  ['B', 'Bookmark', ['b', 'B']],
  ['C', 'Compose', ['c', 'C']],
  ['A', 'Ask, or hold to dictate', ['a', 'A']],
  ['?', 'Every shortcut', ['?']],
];

function useKeyboardPress(list: React.RefObject<HTMLElement | null>) {
  const [pressed, setPressed] = useState<string | null>(null);
  useEffect(() => {
    let visible = false;
    const stopWatching = observeVisible(list.current!, 0.4, isVisible => {
      visible = isVisible;
    });
    const down = (event: KeyboardEvent) => {
      if (!visible || event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.target as HTMLElement).closest('input, textarea, select')) return;
      const hit = keys.find(([, , codes]) => codes.includes(event.key));
      if (hit) setPressed(hit[0]);
    };
    const up = () => setPressed(null);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', up);
    return () => {
      stopWatching();
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', up);
    };
  }, [list]);
  return [pressed, setPressed] as const;
}

export function KeyList() {
  const ref = useRef<HTMLDListElement>(null);
  const [pressed, setPressed] = useKeyboardPress(ref);
  return (
    <dl className="key-grid" data-claim="key-list" ref={ref}>
      {keys.map(([key, label]) => (
        <div
          key={key}
          className="key-item"
          data-pressed={pressed === key || undefined}
          onPointerDown={() => setPressed(key)}
          onPointerUp={() => setPressed(null)}
          onPointerLeave={() => setPressed(p => (p === key ? null : p))}
        >
          <dt>
            <kbd className="cap">{key}</kbd>
          </dt>
          <dd>{label}</dd>
        </div>
      ))}
    </dl>
  );
}

type SegmentedProps<T extends string> = {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
};

// The app's segmented control. The thumb is one equal-width layer that slides by transform, so nothing resizes.
function Segmented<T extends string>({ label, options, value, onChange }: SegmentedProps<T>) {
  const style = { '--n': options.length, '--i': options.indexOf(value) } as React.CSSProperties;
  return (
    <div className="segmented" role="group" aria-label={label} style={style}>
      <span className="segmented-thumb" aria-hidden="true" />
      {options.map(option => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          data-value={option}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

// A small copy of Settings → AI: choose the provider for each feature. Voice needs speech-to-text, which only Groq
// and OpenAI offer here.
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
  'Your own server',
];
const local = new Set(['Ollama', 'LM Studio']);
const routers = new Set(['OpenRouter', 'OpenCode Go']); // they pass each request on to the company that runs the model
const speech = new Set(['Groq', 'OpenAI']);
const defaults: Record<Feature, string> = {
  Summaries: 'Groq',
  Ask: 'Groq',
  Drafts: 'Groq',
  Plans: 'Groq',
  Voice: 'Groq',
};

function subjectOf(feature: Feature) {
  if (feature === 'Voice') return 'Voice recordings';
  if (feature === 'Ask') return 'Questions to Ask';
  return feature;
}

function destination(provider: string) {
  if (local.has(provider))
    return `${provider}, running on your Mac at its default address, so they stay there.`;
  if (routers.has(provider))
    return `${provider}, which passes them to the company that runs the model you pick.`;
  if (provider === 'Your own server') return 'your own server, at the address you set.';
  return `${provider}${provider === 'Groq' ? ', the default' : ''}, and to no one else.`;
}

function routeSentence(feature: Feature, provider: string) {
  const voice = feature === 'Voice' ? ' Only Groq and OpenAI turn speech into text.' : '';
  const gemini = provider === 'Gemini' ? ' A free Gemini key never gets mail.' : '';
  return `${subjectOf(feature)} go to ${destination(provider)}${voice}${gemini}`;
}

type ProviderListProps = { feature: Feature; chosen: string; onPick: (p: string) => void };

function ProviderList({ feature, chosen, onPick }: ProviderListProps) {
  return (
    <ul className="provider-list" aria-label={`Provider for ${feature}`} data-claim="ai-providers">
      {providers.map(provider => {
        const off = feature === 'Voice' && !speech.has(provider);
        const on = provider === chosen;
        return (
          <li key={provider}>
            <button
              type="button"
              className={`provider${on ? ' is-on' : ''}`}
              aria-pressed={on}
              disabled={off}
              title={off ? 'Voice needs a speech-to-text provider' : undefined}
              onClick={() => onPick(provider)}
            >
              <span>{provider}</span>
              {on ? <CheckIcon /> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function ProviderPicker() {
  const [feature, setFeature] = useState<Feature>('Summaries');
  const [chosen, setChosen] = useState(defaults);
  const provider = chosen[feature];
  return (
    <div className="settings-card">
      <div className="settings-head">
        <span>Settings</span>
        <span className="settings-crumb">AI</span>
      </div>
      <div className="settings-body">
        <Segmented label="AI feature" options={features} value={feature} onChange={setFeature} />
        <ProviderList
          feature={feature}
          chosen={provider}
          onPick={p => setChosen(c => ({ ...c, [feature]: p }))}
        />
        <p
          className="settings-result"
          aria-live="polite"
          data-claim="provider-per-feature ai-providers ai-routers local-models no-training-providers"
        >
          <span key={`${feature}${provider}`}>{routeSentence(feature, provider)}</span>
        </p>
      </div>
    </div>
  );
}
