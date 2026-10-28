import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, ChevronsUpDown, Copy, KeyRound, Search } from '../icons';
import { ApiKeyField, useKeyStore, type KeyInfo, type KeyStore } from './ApiKey';
import { Button, Group, GroupRow, Popover, Spinner, cx } from '../ui';
import {
  aiFeatures,
  askProvider,
  askProviders,
  askServerSetting,
  isAskServer,
  parseAskModel,
  voiceProviders,
  type AiFeature,
  type AiModelSetting,
  type AskModelInfo,
  type AskProviderId,
  type AskServerId,
} from '@aplos/contract/legacy/ask';
import type { Settings } from '@aplos/contract/legacy/types';
import { invoke, openUrl, uid } from '../bridge';

type Provider = {
  id: AskProviderId;
  label: string;
  env: string;
  description: string;
  available: boolean;
  keyOptional?: boolean;
  models: AskModelInfo[];
  voiceModels?: AskModelInfo[];
  address?: string;
  defaultAddress?: string;
  running?: boolean;
  version?: string;
};
/** A placeholder an earlier build stored for a custom server before a model was typed. */
const UNSET = 'choose-a-model';
const shortDescriptions: Record<AskProviderId, string> = {
  groq: 'Very fast open models, and speech to text.',
  openai: 'GPT models and speech to text on your OpenAI API key.',
  anthropic: 'Claude Opus, Sonnet and Haiku.',
  gemini: 'Gemini models from Google AI Studio.',
  openrouter: 'Hundreds of models on one key.',
  'opencode-go': 'Your OpenCode Go plan’s models.',
  ollama: 'Local models on this Mac. Mail stays here.',
  lmstudio: 'Local models on this Mac. Mail stays here.',
  custom: 'Any OpenAI-compatible server.',
};

/** Settings → AI: the providers the owner has set up, then which model each feature uses. */
export function AiSettings({
  settings,
  groqReady,
  onChange,
}: {
  settings: Settings;
  groqReady: boolean;
  onChange: (patch: Partial<Settings>) => void;
}) {
  const [catalog, setCatalog] = useState<Provider[]>();
  const [round, setRound] = useState(0);
  const { store, update } = useKeyStore();
  // A saved or removed key changes which providers are ready and what they list, so the catalog reloads.
  const keyChanged = (id: AskProviderId, info: KeyInfo) => {
    update(id, info);
    setRound(n => n + 1);
  };
  // Reloaded when a server address changes or on Try again, so a server that just started shows its models.
  useEffect(() => {
    let live = true;
    void invoke<Provider[]>('ai.models')
      .then(list => {
        if (live) setCatalog(list);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [settings.askOllamaUrl, settings.askLmStudioUrl, settings.askCustomUrl, round]);
  const providers: Provider[] =
    catalog ??
    askProviders.map(p => ({
      ...p,
      models: [...p.models],
      ...(voiceProviders[p.id] ? { voiceModels: [...voiceProviders[p.id]!] } : {}),
      available: p.id === 'groq' ? groqReady : false,
    }));
  const ask = parseAskModel(settings.askModel);
  return (
    <div className="ai-settings">
      <Group title="Models">
        {aiFeatures.map(f => (
          <FeatureRow
            key={f.id}
            feature={f}
            providers={providers}
            loading={!catalog}
            value={settings[f.setting]}
            onChange={value =>
              onChange({ [f.setting]: value } as Partial<Record<AiModelSetting, string>>)
            }
          />
        ))}
        <ConnectionCheck
          key={settings.askModel}
          model={settings.askModel}
          ready={
            !!ask && ask.model !== UNSET && !!providers.find(p => p.id === ask.provider)?.available
          }
        />
      </Group>
      <Group title="Providers">
        {providers.map(p => (
          <ProviderRow
            key={p.id}
            provider={p}
            loading={!catalog}
            address={isAskServer(p.id) ? settings[askServerSetting[p.id]] : undefined}
            store={store}
            onKey={info => keyChanged(p.id, info)}
            onAddress={url => isAskServer(p.id) && onChange({ [askServerSetting[p.id]]: url })}
            onRetry={() => setRound(n => n + 1)}
          />
        ))}
      </Group>
      <p className="group-note ai-note">
        <KeyRound size={13} />
        Keys you save are encrypted with your macOS keychain, used only by the app’s backend and
        never shown again. New mail goes to your Summaries model as it arrives, and to your Plans
        model when plans are added automatically; everything else runs only when you use it.
      </p>
    </div>
  );
}

const statusText = (p: Provider, loading: boolean) =>
  loading
    ? 'Checking…'
    : p.running !== undefined
      ? p.running
        ? 'Running'
        : 'Not running'
      : p.available
        ? 'Ready'
        : p.keyOptional
          ? 'Needs an address'
          : 'Needs a key';

/** One provider: its status, and on opening what it needs (a key, an address, a running app) or what it offers. */
function ProviderRow({
  provider: p,
  loading,
  address,
  store,
  onKey,
  onAddress,
  onRetry,
}: {
  provider: Provider;
  loading: boolean;
  address?: string;
  store?: KeyStore;
  onKey: (info: KeyInfo) => void;
  onAddress: (url: string) => void;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [panelId] = useState(() => 'provider-' + uid());
  const server = isAskServer(p.id) ? p.id : undefined,
    local = server === 'ollama' || server === 'lmstudio';
  const count = p.models.length,
    speech = p.voiceModels?.length;
  const summary =
    p.available && (!local || p.running)
      ? [
          count
            ? `${count} model${count === 1 ? '' : 's'}${local ? ' that can use tools' : ''}`
            : local
              ? 'No models that can use tools yet'
              : '',
          speech ? 'speech to text' : '',
          p.version ? `version ${p.version}` : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : '';
  return (
    <div className={cx('ai-provider-row', open && 'is-open')}>
      <button
        type="button"
        className="ai-provider-head"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(o => !o)}
      >
        <span className="ai-provider-name">
          <strong>{p.label}</strong>
          <small>{shortDescriptions[p.id]}</small>
        </span>
        <span
          className={cx(
            'ai-provider-status',
            loading ? 'is-loading' : p.available && p.running !== false ? 'is-ready' : 'is-missing',
          )}
        >
          <i />
          {statusText(p, loading)}
        </span>
        <ChevronDown size={14} className="ai-provider-chevron" />
      </button>
      {open && (
        <div id={panelId} className="ai-provider-panel">
          {summary && <p className="ai-provider-summary">{summary}</p>}
          {server && (
            <ServerAddress
              id={server}
              value={address ?? ''}
              placeholder={askProvider(server).defaultAddress ?? 'http://localhost:11434/v1'}
              onChange={onAddress}
            />
          )}
          {!loading && local && !p.running && (
            <LocalSetup
              id={server as 'ollama' | 'lmstudio'}
              address={p.address ?? ''}
              onRetry={onRetry}
            />
          )}
          {!loading && local && p.running && !count && (
            <p className="ai-provider-summary">{localEmpty[server as 'ollama' | 'lmstudio']}</p>
          )}
          {store && (
            <GroupRow
              className="ai-key-row"
              label={server ? 'API key (optional)' : 'API key'}
              description={server ? 'Only if the server asks for one.' : undefined}
            >
              <ApiKeyField
                provider={p.id}
                info={store.providers[p.id] ?? {}}
                store={store}
                onChange={onKey}
              />
            </GroupRow>
          )}
        </div>
      )}
    </div>
  );
}

const localEmpty = {
  ollama: 'No models that can use tools yet. Pull one in Terminal, e.g. ollama pull qwen3.',
  lmstudio: 'No models that can use tools yet. Download one in LM Studio, e.g. Qwen3.',
};
const addressHelp: Record<AskServerId, string> = {
  ollama:
    'Leave empty for Ollama on this Mac. Another machine works too; the mail you use AI on is sent there.',
  lmstudio:
    'Leave empty for LM Studio on this Mac. Another machine works too; the mail you use AI on is sent there.',
  custom:
    'Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1. The mail you use AI on is sent to this server.',
};
/** A server's address. Saved when leaving the field (Enter leaves it); the engine validates it. Empty means the default. */
function ServerAddress({
  id,
  value,
  placeholder,
  onChange,
}: {
  id: AskServerId;
  value: string;
  placeholder: string;
  onChange: (url: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const save = () => {
    if (text.trim() !== value) onChange(text.trim());
  };
  return (
    <GroupRow label="Server address" description={addressHelp[id]}>
      <input
        className="ai-address"
        aria-label="Server address"
        spellCheck={false}
        placeholder={placeholder}
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={save}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
          e.stopPropagation();
        }}
      />
    </GroupRow>
  );
}

const localApps = {
  ollama: {
    name: 'Ollama',
    download: 'https://ollama.com/download',
    steps: 'Open the Ollama app (or run it in Terminal), then pull a model that can use tools.',
    command: 'ollama pull qwen3',
  },
  lmstudio: {
    name: 'LM Studio',
    download: 'https://lmstudio.ai',
    steps:
      'Open LM Studio and start its local server (Developer → Start server), then download a model that can use tools.',
    command: 'lms server start',
  },
};
/** When a local app isn't answering: what to start, a command to copy, and a way to check again. */
function LocalSetup({
  id,
  address,
  onRetry,
}: {
  id: 'ollama' | 'lmstudio';
  address: string;
  onRetry: () => void;
}) {
  const app = localApps[id];
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(app.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* The command is still on screen. */
    }
  }
  return (
    <div className="ai-setup" role="status">
      <p>
        <strong>
          {app.name} isn’t running
          {address ? (
            <>
              {' '}
              at <code>{address.replace(/^https?:\/\//, '')}</code>
            </>
          ) : (
            ''
          )}
          .
        </strong>{' '}
        {app.steps}
      </p>
      <div className="ai-setup-actions">
        <button
          type="button"
          className={cx('ai-env', copied && 'is-copied')}
          onClick={() => void copy()}
          aria-label={`Copy ${app.command}`}
        >
          <code>{app.command}</code>
          <span>
            {copied ? (
              <>
                <Check size={12} />
                Copied
              </>
            ) : (
              <>
                <Copy size={12} />
                Copy
              </>
            )}
          </span>
        </button>
        <Button
          variant="secondary"
          size="sm"
          loading={checking}
          onClick={() => {
            setChecking(true);
            onRetry();
            setTimeout(() => setChecking(false), 900);
          }}
        >
          Try again
        </Button>
        <Button
          variant="text"
          size="sm"
          iconRight={ArrowUpRight}
          onClick={() => void openUrl(app.download)}
        >
          Get {app.name}
        </Button>
      </div>
    </div>
  );
}

/** One feature's model, chosen from every provider that is set up. Its provider not being ready shows in amber. */
function FeatureRow({
  feature,
  providers,
  loading,
  value,
  onChange,
}: {
  feature: (typeof aiFeatures)[number];
  providers: Provider[];
  loading: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const ref = parseAskModel(value) ?? parseAskModel(feature.fallback)!;
  const provider = providers.find(p => p.id === ref.provider)!;
  const missing = !loading && !(provider.available && provider.running !== false);
  return (
    <GroupRow
      label={feature.label}
      description={
        <>
          {feature.description}
          {missing && (
            <span className="ai-feature-missing">
              {' '}
              {provider.label} isn’t {provider.keyOptional ? 'running' : 'set up'} yet; see
              Providers below.
            </span>
          )}
        </>
      }
    >
      <ModelPicker
        feature={feature.id}
        label={feature.label}
        providers={providers}
        value={ref}
        onChange={onChange}
      />
    </GroupRow>
  );
}

/** Big catalogs (OpenRouter) show their recommended models until the owner searches. */
const COLLAPSE = 12;
type Option = {
  provider: AskProviderId;
  id: string;
  label: string;
  description?: string;
  typed?: boolean;
};
/** A searchable list of models grouped by provider. Arrows move, Enter picks, Esc closes; the selected model is checked. */
function ModelPicker({
  feature,
  label,
  providers,
  value,
  onChange,
}: {
  feature: AiFeature;
  label: string;
  providers: Provider[];
  value: { provider: AskProviderId; model: string };
  onChange: (value: string) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [listId] = useState(() => 'models-' + uid());
  const voice = feature === 'voice';
  const listOf = (p: Provider) => (voice ? (p.voiceModels ?? []) : p.models);
  const curatedOf = (id: AskProviderId) =>
    voice ? (voiceProviders[id] ?? []) : askProvider(id).models;
  const ready = (p: Provider) => p.available && p.running !== false;
  // Providers that are set up, plus the current model's own so a choice made earlier stays visible.
  const usable = providers.filter(
    p =>
      (ready(p) && listOf(p).length) ||
      p.id === value.provider ||
      (!voice && p.id === 'custom' && ready(p)),
  );
  const isCurrent = (o: { provider: AskProviderId; id: string }) =>
    o.provider === value.provider && o.id === value.model;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const groups = usable
    .map(p => {
      let items: Option[] = listOf(p).map(m => ({ provider: p.id, ...m }));
      if (p.id === value.provider && value.model !== UNSET && !items.some(isCurrent))
        items.unshift({ provider: p.id, id: value.model, label: value.model });
      let hidden = 0;
      if (words.length)
        items = items.filter(m =>
          words.every(w =>
            `${m.label} ${m.id} ${m.description ?? ''} ${p.label}`.toLowerCase().includes(w),
          ),
        );
      else if (items.length > COLLAPSE) {
        const curated = new Set(curatedOf(p.id).map(m => m.id));
        const kept = items.filter(m => curated.has(m.id) || isCurrent(m));
        if (kept.length) {
          hidden = items.length - kept.length;
          items = kept;
        }
      }
      return { provider: p, items, hidden };
    })
    .filter(g => g.items.length || g.hidden);
  // A custom server may not list its models, so any typed name can be used there.
  const typed = query.trim(),
    custom = usable.find(p => p.id === 'custom' && ready(p));
  if (
    !voice &&
    custom &&
    typed &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(typed) &&
    !custom.models.some(m => m.id === typed)
  )
    groups.push({
      provider: custom,
      items: [
        {
          provider: 'custom',
          id: typed,
          label: `Use “${typed}”`,
          description: 'A model name your server knows',
          typed: true,
        },
      ],
      hidden: 0,
    });
  const flat = groups.flatMap(g => g.items);
  const provider = providers.find(p => p.id === value.provider);
  const current =
    listOf(provider ?? providers[0]).find(m => m.id === value.model) ??
    (value.model === UNSET ? undefined : { id: value.model, label: value.model });
  const unset = providers
    .filter(p => !ready(p) && (!voice || voiceProviders[p.id]) && p.id !== value.provider)
    .map(p => p.label);
  // Opening starts from the full list with the current model highlighted.
  function show(next: boolean) {
    if (next) {
      setQuery('');
    }
    setOpen(next);
  }
  useEffect(() => {
    if (open && !query) setActive(Math.max(0, flat.findIndex(isCurrent)));
  }, [open]);
  useEffect(() => {
    if (open)
      listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);
  // Focus moves into the search the moment it mounts, so typing searches instead of reaching the app's shortcuts.
  // The surface stays hidden until it is positioned, so focus is retried for a few frames until it takes.
  const openRef = useRef(open);
  openRef.current = open;
  const searchRef = useCallback((el: HTMLInputElement | null) => {
    search.current = el;
    let tries = 0;
    // Stops once the picker closes, so a late retry never pulls focus into a closing list.
    const focus = () => {
      if (!openRef.current || !el?.isConnected || document.activeElement === el) return;
      el.focus({ preventScroll: true });
      if (document.activeElement !== el && ++tries < 10) requestAnimationFrame(focus);
    };
    focus();
  }, []);
  function choose(o: Option) {
    onChange(`${o.provider}:${o.id}`);
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  function keys(event: React.KeyboardEvent) {
    if (!event.metaKey && !event.ctrlKey && event.key !== 'Escape') event.stopPropagation();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!flat.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive(i => (i + step + flat.length) % flat.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = flat[active];
      if (item) choose(item);
    }
  }
  let index = -1;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={cx('ai-model-trigger', open && 'is-open')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label} model: ${current?.label ?? 'none'} on ${provider?.label ?? ''}`}
        onClick={() => show(!open)}
        onKeyDown={event => {
          // Keys pressed while the list is still appearing belong to the picker, not the app's shortcuts.
          if (open && !event.metaKey && !event.ctrlKey && event.key !== 'Escape') {
            event.stopPropagation();
            if (event.key.length === 1) {
              event.preventDefault();
              setQuery(q => q + event.key);
              setActive(0);
            }
          }
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            show(true);
          }
        }}
      >
        <span>
          <strong>{current?.label ?? 'Choose a model'}</strong>
          <small>{provider?.label}</small>
        </span>
        <ChevronsUpDown size={13} />
      </button>
      <Popover
        open={open}
        anchor={trigger.current}
        onClose={() => setOpen(false)}
        placement="bottom-end"
        className="ui-surface ai-model-picker"
        label={`${label} models`}
        onKeyDown={keys}
      >
        <label className="ai-model-search">
          <Search size={14} />
          <input
            ref={searchRef}
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-activedescendant={flat[active] ? `${listId}-${active}` : undefined}
            placeholder={
              custom && !voice
                ? 'Search models or type a name'
                : `Search ${voice ? 'speech ' : ''}models`
            }
            value={query}
            onChange={e => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
        </label>
        <div ref={listRef} id={listId} className="ai-model-list" role="listbox" aria-label="Models">
          {groups.map(group => (
            <div
              key={group.provider.id + (group.items[0]?.typed ? '-typed' : '')}
              role="group"
              aria-label={group.provider.label}
            >
              {!group.items[0]?.typed && (
                <p className="ai-model-group">
                  {group.provider.label}
                  {!ready(group.provider) && (
                    <span className="is-missing">
                      {group.provider.keyOptional ? 'Not running' : 'Not set up'}
                    </span>
                  )}
                </p>
              )}
              {group.items.map(m => {
                index++;
                const i = index;
                const selected = isCurrent(m);
                return (
                  <div
                    key={m.id}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={selected}
                    data-active={i === active}
                    className={cx(
                      'ui-surface-item ai-model',
                      i === active && 'is-active',
                      selected && 'is-selected',
                    )}
                    onPointerMove={() => {
                      if (active !== i) setActive(i);
                    }}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => choose(m)}
                  >
                    <span className="ai-model-check">{selected && <Check size={13} />}</span>
                    <span className="ai-model-text">
                      <strong>{m.label}</strong>
                      <small>{m.description ?? m.id}</small>
                    </span>
                  </div>
                );
              })}
              {group.hidden > 0 && (
                <p className="ai-model-more">
                  {group.hidden} more on {group.provider.label}. Type to search them.
                </p>
              )}
            </div>
          ))}
          {!flat.length && (
            <p className="ai-model-empty">
              {query ? `No models match “${query}”.` : 'No providers with models are set up yet.'}
            </p>
          )}
        </div>
        {unset.length > 0 && (
          <p className="ai-model-foot">
            {voice
              ? `${unset.join(', ')} also ${unset.length === 1 ? 'does' : 'do'} speech to text once set up.`
              : `Also available once set up: ${unset.join(', ')}.`}
          </p>
        )}
      </Popover>
    </>
  );
}

type Check =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'ok'; ms: number; tools: boolean }
  | { state: 'error'; message: string };
/** A real request to Ask's model, so a key or model problem shows here rather than mid-question. */
function ConnectionCheck({ model, ready }: { model: string; ready: boolean }) {
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const request = useRef<string | undefined>(undefined);
  useEffect(
    () => () => {
      if (request.current) void invoke('ai.cancel', { requestId: request.current }).catch(() => {});
    },
    [],
  );
  async function run() {
    const requestId = uid();
    request.current = requestId;
    setCheck({ state: 'running' });
    try {
      const result = await invoke<{ ms: number; tools: boolean }>('ai.test', { model, requestId });
      if (request.current === requestId) setCheck({ state: 'ok', ...result });
    } catch (e) {
      if (request.current === requestId)
        setCheck({ state: 'error', message: (e as Error).message });
    } finally {
      if (request.current === requestId) request.current = undefined;
    }
  }
  const seconds = (ms: number) =>
    ms < 10
      ? 'under 10 ms'
      : ms < 1000
        ? `${Math.round(ms / 10) * 10} ms`
        : `${(ms / 1000).toFixed(1)} s`;
  return (
    <GroupRow
      label="Test Ask"
      description="Sends one tiny request and asks Ask’s model to use a tool, the way Ask does. No mail is included."
    >
      <span
        className={cx(
          'ai-check',
          `is-${check.state === 'ok' && !check.tools ? 'warn' : check.state}`,
        )}
        role="status"
        aria-live="polite"
      >
        {check.state === 'running' && (
          <>
            <Spinner size={13} />
            Testing…
          </>
        )}
        {check.state === 'ok' &&
          (check.tools ? (
            <>
              <span className="ai-check-mark">
                <Check size={11} />
              </span>
              Works · {seconds(check.ms)}
            </>
          ) : (
            <>
              Replied in {seconds(check.ms)}, but didn’t use the tool. Ask may not work well with
              this model.
            </>
          ))}
        {check.state === 'error' && check.message}
      </span>
      <Button
        variant="secondary"
        size="sm"
        disabled={!ready || check.state === 'running'}
        onClick={() => void run()}
      >
        {check.state === 'ok' || check.state === 'error' ? 'Test again' : 'Test'}
      </Button>
    </GroupRow>
  );
}
