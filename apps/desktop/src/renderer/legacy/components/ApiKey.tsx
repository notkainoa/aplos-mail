import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ClipboardPaste, KeyRound } from '../icons';
import { Button, Spinner, cx } from '../ui';
import { askProvider, type AskProviderId } from '@aplos/contract/legacy/ask';
import { invoke, openUrl, uid } from '../bridge';

/** What the renderer may know about a key: where the active one comes from and its last four characters. Never the key. */
export type KeyInfo = { source?: 'saved' | 'environment'; last4?: string };
export type KeyStore = {
  secure: boolean;
  error?: string;
  providers: Partial<Record<AskProviderId, KeyInfo>>;
};

export const keyPages: Record<AskProviderId, string> = {
  groq: 'https://console.groq.com/keys',
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://platform.claude.com/settings/keys',
  gemini: 'https://aistudio.google.com/apikey',
  openrouter: 'https://openrouter.ai/settings/keys',
  'opencode-go': 'https://opencode.ai/console',
  ollama: '',
  lmstudio: '',
  custom: '',
};

/** The key store's state, loaded once; `update` records the result of a save or remove. */
export function useKeyStore() {
  const [store, setStore] = useState<KeyStore>();
  useEffect(() => {
    let live = true;
    void invoke<KeyStore>('ai.keys')
      .then(value => {
        if (live) setStore(value);
      })
      .catch(() => {
        if (live) setStore({ secure: false, providers: {} });
      });
    return () => {
      live = false;
    };
  }, []);
  const update = useCallback(
    (id: AskProviderId, info: KeyInfo) =>
      setStore(s => s && { ...s, providers: { ...s.providers, [id]: info } }),
    [],
  );
  return { store, update };
}

type Check =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'ok'; ms: number }
  | { state: 'error'; message: string };
const seconds = (ms: number) =>
  ms < 1000 ? `${Math.max(10, Math.round(ms / 10) * 10)} ms` : `${(ms / 1000).toFixed(1)} s`;

/**
 * One provider's API key: a masked field with Paste and Save, or, once a key is active, its last four characters,
 * where it comes from, Test, Replace and Remove. What is typed is cleared from the field as soon as it is saved.
 */
export function ApiKeyField({
  provider: id,
  info,
  store,
  onChange,
  autoFocus,
  link = true,
}: {
  provider: AskProviderId;
  info: KeyInfo;
  store: KeyStore;
  onChange: (info: KeyInfo) => void;
  autoFocus?: boolean;
  link?: boolean;
}) {
  const p = askProvider(id),
    optional = !!p.keyOptional;
  const [editing, setEditing] = useState(!info.source);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'' | 'save' | 'paste' | 'remove'>('');
  const [error, setError] = useState('');
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // The field and its buttons swap places on save and remove; focus follows so the keyboard (and Escape) keeps working.
  const focusLater = (target: 'input' | 'button') =>
    requestAnimationFrame(() =>
      (target === 'input' ? input.current : root.current?.querySelector('button'))?.focus({
        preventScroll: true,
      }),
    );
  const request = useRef<string | undefined>(undefined);
  // A key that appears (saved elsewhere, or found in the environment) closes the field; one that goes away opens it.
  useEffect(() => {
    setEditing(!info.source);
  }, [info.source]);
  useEffect(
    () => () => {
      if (request.current) void invoke('ai.cancel', { requestId: request.current }).catch(() => {});
    },
    [],
  );
  // Picking another provider (a new field) puts the cursor straight in it.
  useEffect(() => {
    if (autoFocus) input.current?.focus({ preventScroll: true });
  }, []);
  async function test() {
    const requestId = uid();
    request.current = requestId;
    setCheck({ state: 'running' });
    try {
      const result = await invoke<{ ms: number }>('ai.key.test', { provider: id, requestId });
      if (request.current === requestId) setCheck({ state: 'ok', ms: result.ms });
    } catch (e) {
      if (request.current === requestId)
        setCheck({ state: 'error', message: (e as Error).message });
    } finally {
      if (request.current === requestId) request.current = undefined;
    }
  }
  async function save(kind: 'save' | 'paste') {
    setBusy(kind);
    setError('');
    setCheck({ state: 'idle' });
    try {
      const next = await invoke<KeyInfo>(
        kind === 'paste' ? 'ai.key.paste' : 'ai.key.set',
        kind === 'paste' ? { provider: id } : { provider: id, key: text },
      );
      setText('');
      onChange(next);
      setEditing(false);
      setBusy('');
      focusLater('button');
      void test();
    } catch (e) {
      setError((e as Error).message);
      setBusy('');
    }
  }
  async function remove() {
    setBusy('remove');
    setError('');
    setCheck({ state: 'idle' });
    try {
      onChange(await invoke<KeyInfo>('ai.key.delete', { provider: id }));
      focusLater('input');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  const whereTitle =
    info.source === 'saved'
      ? 'Encrypted with a key your macOS keychain protects. Never shown again.'
      : 'From the environment Aplos started with. A key saved here takes its place.';
  const where =
    info.source === 'saved' ? (
      'Saved, encrypted'
    ) : (
      <>
        From <code>{p.env}</code>
      </>
    );
  const result = check.state !== 'idle' && (
    <p className={cx('ai-key-check', `is-${check.state}`)} role="status" aria-live="polite">
      {check.state === 'running' && (
        <>
          <Spinner size={12} />
          Checking the key…
        </>
      )}
      {check.state === 'ok' && (
        <>
          <span className="ai-check-mark">
            <Check size={10} />
          </span>
          {p.label} accepted the key · {seconds(check.ms)}
        </>
      )}
      {check.state === 'error' && check.message}
    </p>
  );
  if (!store.secure)
    return (
      <div ref={root} className="ai-key">
        {info.source === 'environment' && (
          <div className="ai-key-active">
            <KeyRound size={13} />
            <span className="ai-key-mask">••••{info.last4 ?? ''}</span>
            <span className="ai-key-where" title={whereTitle}>
              {where}
            </span>
            <Button
              variant="secondary"
              size="sm"
              loading={check.state === 'running'}
              onClick={() => void test()}
            >
              Test
            </Button>
          </div>
        )}
        <p className="ai-key-note">
          {store.error ?? (
            <>
              Keys can only be saved in the Aplos Mail desktop app. In this browser preview, set{' '}
              <code>{p.env}</code> in the backend environment.
            </>
          )}
        </p>
        {result}
      </div>
    );
  if (!editing && info.source)
    return (
      <div ref={root} className="ai-key">
        <div className="ai-key-active">
          <KeyRound size={13} />
          <span
            className="ai-key-mask"
            aria-label={`${p.label} key ending in ${info.last4 ?? '…'}`}
          >
            ••••{info.last4 ?? ''}
          </span>
          <span className="ai-key-where" title={whereTitle}>
            {where}
          </span>
          <span className="ai-key-actions">
            <Button
              variant="secondary"
              size="sm"
              loading={check.state === 'running'}
              onClick={() => void test()}
            >
              Test
            </Button>
            <Button
              variant="text"
              size="sm"
              onClick={() => {
                setEditing(true);
                setCheck({ state: 'idle' });
                requestAnimationFrame(() => input.current?.focus());
              }}
            >
              Replace
            </Button>
            {info.source === 'saved' && (
              <Button
                variant="text"
                size="sm"
                className="danger"
                loading={busy === 'remove'}
                onClick={() => void remove()}
              >
                Remove
              </Button>
            )}
          </span>
        </div>
        {error && (
          <p className="ai-key-check is-error" role="alert">
            {error}
          </p>
        )}
        {result}
      </div>
    );
  return (
    <div ref={root} className="ai-key">
      <form
        className="ai-key-entry"
        onSubmit={e => {
          e.preventDefault();
          if (text.trim()) void save('save');
        }}
      >
        <input
          ref={input}
          className="ai-key-input"
          type="password"
          aria-label={`${p.label} API key${optional ? ' (optional)' : ''}`}
          placeholder={optional ? 'Key, if your server asks for one' : `Paste your ${p.label} key`}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-autofocus={autoFocus || undefined}
          value={text}
          onChange={e => {
            setText(e.target.value);
            setError('');
          }}
          // Escape with nothing typed belongs to the surrounding dialog (it skips a welcome step); otherwise it clears or cancels.
          onKeyDown={e => {
            if (e.key === 'Escape' && (text || info.source)) {
              e.preventDefault();
              e.stopPropagation();
              if (text) setText('');
              else setEditing(false);
            } else if (e.key !== 'Escape') e.stopPropagation();
          }}
        />
        {window.aplos && (
          <Button
            variant="secondary"
            size="sm"
            icon={ClipboardPaste}
            loading={busy === 'paste'}
            disabled={!!busy}
            tooltip={{ content: 'Saves the key on your clipboard without showing it' }}
            onClick={() => void save('paste')}
          >
            Paste
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={busy === 'save'}
          disabled={!text.trim() || !!busy}
        >
          Save
        </Button>
        {info.source && (
          <Button
            variant="text"
            size="sm"
            disabled={!!busy}
            onClick={() => {
              setText('');
              setEditing(false);
              setError('');
            }}
          >
            Cancel
          </Button>
        )}
      </form>
      {error && (
        <p className="ai-key-check is-error" role="alert">
          {error}
        </p>
      )}
      {result}
      {link && keyPages[id] && !info.source && (
        <Button
          variant="text"
          size="sm"
          className="ai-key-link"
          iconRight={ArrowUpRight}
          onClick={() => void openUrl(keyPages[id])}
        >
          Get a {p.label} key
        </Button>
      )}
    </div>
  );
}
