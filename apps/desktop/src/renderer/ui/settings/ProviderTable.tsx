import { useId } from 'react';
import type { ReactNode } from 'react';
import type {
  AiFeature,
  KeySource,
  ProviderAction,
  ProviderId,
  ProviderStatus,
  ProviderTableProps,
} from '../props';
import { SetIcon } from './icons';
import { envKeyReason, FEATURE_COPY, keySourceText, PROVIDER_NAMES } from './names';
import { SettingRow } from './SettingRow';

type LocalId = 'ollama' | 'lmstudio' | 'custom';

/** "Works · 0.4 s" */
export function latencyText(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

interface StatusView {
  text: string;
  tone: 'ok' | 'neutral' | 'quiet' | 'busy' | 'bad';
  icon?: 'check' | 'alert';
}

function statusView(status: ProviderStatus): StatusView {
  switch (status.kind) {
    case 'ready':
      return { text: 'Ready', tone: 'ok' };
    case 'needsKey':
      return { text: 'Needs a key', tone: 'neutral' };
    case 'notRunning':
      return { text: 'Not running', tone: 'quiet' };
    case 'testing':
      return { text: 'Testing…', tone: 'busy' };
    case 'works':
      return { text: `Works · ${latencyText(status.latencyMs)}`, tone: 'ok', icon: 'check' };
    case 'refused':
      return { text: 'Key refused', tone: 'bad', icon: 'alert' };
    case 'unreachable':
      return { text: 'Not reachable', tone: 'bad', icon: 'alert' };
  }
}

function StatusCell({ status }: { status: ProviderStatus }) {
  const view = statusView(status);
  return (
    <span
      className="ui-provider-table__status"
      data-tone={view.tone}
      aria-live="polite"
      aria-busy={status.kind === 'testing' ? true : undefined}
    >
      {view.icon ? (
        <SetIcon name={view.icon} />
      ) : (
        <span className="ui-provider-table__dot" aria-hidden="true" />
      )}
      <span className="ui-provider-table__status-text">{view.text}</span>
    </span>
  );
}

/** A quiet text button for a row action. A disabled one keeps its tooltip and says why, for screen readers too. */
function RowButton({
  label,
  onClick,
  disabled,
  reason,
  aria,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  reason?: string;
  aria?: string;
}) {
  const reasonId = useId();
  return (
    <>
      <button
        type="button"
        className="ui-provider-table__button"
        aria-disabled={disabled ? true : undefined}
        aria-label={aria}
        aria-describedby={disabled && reason ? reasonId : undefined}
        title={disabled ? reason : undefined}
        onClick={disabled ? undefined : onClick}
      >
        {label}
      </button>
      {disabled && reason ? (
        <span className="ui-provider-table__sr" id={reasonId}>
          {reason}
        </span>
      ) : null}
    </>
  );
}

function removeReason(source: KeySource): string | undefined {
  return source.kind === 'environment' ? envKeyReason(source.variable) : undefined;
}

/** The actions of a keyed row: Test, then Replace key and Remove, or Add key when no key is set. */
function Actions({
  name,
  source,
  status,
  onAction,
  replace,
  testWithoutKey,
}: {
  name: string;
  source: KeySource;
  status?: ProviderStatus;
  onAction: (action: ProviderAction) => void;
  replace?: boolean;
  /** A local server works without a key, so Test stays next to Add key. */
  testWithoutKey?: boolean;
}) {
  if (source.kind === 'none') {
    return (
      <>
        {testWithoutKey ? (
          <RowButton
            label="Test"
            aria={`Test ${name}`}
            disabled={status?.kind === 'testing'}
            onClick={() => onAction('test')}
          />
        ) : null}
        <RowButton
          label="Add key"
          aria={`Add key for ${name}`}
          onClick={() => onAction('addKey')}
        />
      </>
    );
  }
  const reason = removeReason(source);
  return (
    <>
      <RowButton
        label="Test"
        aria={`Test ${name}`}
        disabled={status?.kind === 'testing'}
        onClick={() => onAction('test')}
      />
      {replace && source.kind === 'keychain' ? (
        <RowButton
          label="Replace key"
          aria={`Replace key for ${name}`}
          onClick={() => onAction('replaceKey')}
        />
      ) : null}
      {source.kind === 'local' ? null : (
        <RowButton
          label="Remove"
          aria={`Remove key for ${name}`}
          disabled={Boolean(reason)}
          reason={reason}
          onClick={() => onAction('remove')}
        />
      )}
    </>
  );
}

/** The ErrorLine under a row whose key was refused or whose server did not answer (DESIGN 7.15 voice). */
function Fix({
  name,
  source,
  status,
  onAction,
}: {
  name: string;
  source: KeySource;
  status: ProviderStatus;
  onAction: (a: ProviderAction) => void;
}) {
  if (status.kind === 'refused') {
    const env = source.kind === 'environment';
    return (
      <div className="ui-provider-table__fix" role="status">
        <SetIcon name="alert" />
        <span>
          {env
            ? `${name} refused the key set on this Mac, so nothing was sent. Fix it where it was set${source.variable ? ` (${source.variable})` : ''}. Your other providers are not affected.`
            : `${name} refused the saved key, so nothing was sent. Replace it with a fresh one. Your other providers are not affected.`}
        </span>
        {env ? null : (
          <button
            type="button"
            className="ui-provider-table__button"
            onClick={() => onAction('replaceKey')}
          >
            Replace key
          </button>
        )}
      </div>
    );
  }
  if (status.kind === 'unreachable') {
    return (
      <div className="ui-provider-table__fix" role="status">
        <SetIcon name="alert" />
        <span>{`Couldn't reach ${name}. Nothing was sent. Check the connection and test again.`}</span>
      </div>
    );
  }
  return null;
}

function Select({
  label,
  value,
  options,
  names,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  /** Display names for option values (provider ids to "OpenCode Go", model ids to "GPT-OSS 120B"). */
  names?: Readonly<Record<string, string>>;
  onChange: (value: string) => void;
}) {
  const list = options.includes(value) ? options : [value, ...options];
  return (
    <span className="ui-provider-table__select">
      <select aria-label={label} value={value} onChange={e => onChange(e.target.value)}>
        {list.map(o => (
          <option key={o} value={o}>
            {names?.[o] ?? o}
          </option>
        ))}
      </select>
      <SetIcon name="chevron-down" />
    </span>
  );
}

function localDescription(
  row: Extract<ProviderTableProps, { kind: 'local' }>['rows'][number],
): string {
  const where =
    row.provider === 'custom'
      ? 'Any OpenAI-compatible server'
      : row.status?.kind === 'notRunning'
        ? 'On this Mac'
        : `On this Mac · ${row.running ? 'running' : 'not running'}`;
  const source = row.keySource;
  if (!source || source.kind === 'local')
    return row.provider === 'custom' ? `${where} · key optional` : `${where} · no key needed`;
  if (source.kind === 'none') return `${where} · key optional`;
  return `${where} · ${keySourceText(source)}`;
}

/**
 * The Settings → AI tables (DESIGN 6 ProviderTable, 7.10): Features first, then hosted providers with status and
 * key source, then "On this Mac and custom". Key characters are never shown. A key from the environment shows
 * Remove disabled with the reason in its tooltip. Provider and model pickers are native lists for now; the
 * Menu-based pickers replace them behind the same props.
 */
export function ProviderTable(props: ProviderTableProps): ReactNode {
  const uid = useId();

  if (props.kind === 'features') {
    const { rows, onChange } = props;
    return (
      <div className="ui-provider-table" data-kind="features">
        {rows.map(row => {
          const copy = FEATURE_COPY[row.feature as AiFeature];
          const id = `${uid}-${row.feature}`;
          return (
            <SettingRow
              key={row.feature}
              id={id}
              label={copy.label}
              description={copy.description}
              control={
                <span className="ui-provider-table__pair">
                  <Select
                    label={`${copy.label} provider`}
                    value={row.provider}
                    options={row.providerOptions}
                    names={PROVIDER_NAMES}
                    onChange={provider =>
                      onChange(row.feature, { provider: provider as ProviderId, model: row.model })
                    }
                  />
                  <Select
                    label={`${copy.label} model`}
                    value={row.model}
                    options={row.modelOptions}
                    names={row.modelNames}
                    onChange={model => onChange(row.feature, { provider: row.provider, model })}
                  />
                </span>
              }
            />
          );
        })}
      </div>
    );
  }

  if (props.kind === 'hosted') {
    const { rows, onAction } = props;
    return (
      <div className="ui-provider-table" data-kind="hosted">
        {rows.map(row => {
          const name = PROVIDER_NAMES[row.provider];
          const id = `${uid}-${row.provider}`;
          return (
            <div className="ui-provider-table__item" key={row.provider}>
              <div className="ui-provider-table__row" data-provider={row.provider}>
                <span className="ui-provider-table__text">
                  <span className="ui-provider-table__line">
                    <b className="ui-provider-table__name" id={id}>
                      {name}
                    </b>
                    {row.isDefault ? <span className="ui-provider-table__tag">Default</span> : null}
                  </span>
                  <span className="ui-provider-table__source">{keySourceText(row.keySource)}</span>
                </span>
                <StatusCell status={row.status} />
                <span className="ui-provider-table__actions">
                  <Actions
                    name={name}
                    source={row.keySource}
                    status={row.status}
                    onAction={action => onAction(row.provider, action)}
                  />
                </span>
              </div>
              <Fix
                name={name}
                source={row.keySource}
                status={row.status}
                onAction={action => onAction(row.provider, action)}
              />
            </div>
          );
        })}
      </div>
    );
  }

  const { rows, onAddressChange, onAction } = props;
  return (
    <div className="ui-provider-table" data-kind="local">
      {rows.map(row => {
        const name = PROVIDER_NAMES[row.provider as LocalId];
        const id = `${uid}-${row.provider}`;
        const source = row.keySource ?? { kind: 'local' as const };
        const actions =
          onAction && source.kind !== 'local' ? (
            <div className="ui-provider-table__local-actions">
              {row.status ? <StatusCell status={row.status} /> : null}
              <Actions
                name={name}
                source={source}
                status={row.status}
                replace
                testWithoutKey
                onAction={action => onAction(row.provider, action)}
              />
            </div>
          ) : onAction ? (
            <div className="ui-provider-table__local-actions">
              {row.status ? <StatusCell status={row.status} /> : null}
              <RowButton
                label="Test"
                aria={`Test ${name}`}
                disabled={row.status?.kind === 'testing'}
                onClick={() => onAction(row.provider, 'test')}
              />
            </div>
          ) : undefined;
        return (
          <SettingRow
            key={row.provider}
            id={id}
            label={name}
            description={localDescription(row)}
            control={
              <span className="ui-provider-table__local-control">
                <input
                  className="ui-provider-table__address"
                  type="text"
                  value={row.address}
                  placeholder={row.defaultAddress || 'https://your-server.example/v1'}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={`${name} address`}
                  aria-describedby={`${id}-description`}
                  onChange={e => onAddressChange(row.provider, e.target.value)}
                />
                {actions}
              </span>
            }
            below={
              onAction && row.status ? (
                <Fix
                  name={name}
                  source={source}
                  status={row.status}
                  onAction={action => onAction(row.provider, action)}
                />
              ) : undefined
            }
          />
        );
      })}
    </div>
  );
}
