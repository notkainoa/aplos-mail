/**
 * Everything Settings opens over the page: the reconnect flow, the add-key dialog, the consent card, confirmations
 * and the diagnostics preview. Each is driven by the view state, so any of them can be drawn on purpose. The page
 * under a dialog keeps its place; the topmost surface owns the filled button (DESIGN 3, principle 6).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../ui/buttons-keys';
import { ConsentCard } from '../../ui/onboarding';
import { TextField } from '../../ui/controls';
import { Confirm, Dialog, Text } from '../../ui/surfaces';
import {
  adminGrantConfirm,
  bundleSections,
  consentView,
  CONSENT_SENT,
  discardConfirm,
  DIAGNOSTICS_NOTE,
  providerName,
  removeAccountConfirm,
  removeKeyConfirm,
  revokeConfirm,
  REMOVE_DEMO_CONFIRM,
  type ConsentView,
} from './settings.model';
import type { SectionProps } from './sections/types';
import type { Confirmation } from './view';
import { FailureLine } from './parts';
import { AddToolDialog } from './toolDialogs';

export function Overlays({ data, view, actions, host, failure }: SectionProps): ReactNode {
  const c = view.confirm;
  const consent = consentView(data.consent, data.settings);
  /* While a confirm is stacked over the Add a tool dialog (the admin ask), the lower dialog goes inert
   * and out of the accessibility tree — two aria-modal dialogs would both answer a virtual cursor.
   * inert drops the focus the dialog held, so when the confirm closes the dialog takes it back if
   * nothing else did. */
  const addToolWrap = useRef<HTMLDivElement | null>(null);
  const confirmWasOpen = useRef(false);
  useEffect(() => {
    const confirmJustClosed = confirmWasOpen.current && c === null;
    confirmWasOpen.current = c !== null;
    if (!confirmJustClosed || !view.addTool) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    addToolWrap.current
      ?.querySelector<HTMLElement>('[role="dialog"]')
      ?.focus({ preventScroll: true });
  });
  return (
    <>
      {view.reconnect
        ? host.renderReconnect?.(view.reconnect.accountId, view.reconnect.mode, () =>
            actions.closeReconnect(),
          )
        : null}
      {view.addAccount ? host.renderAddAccount?.(() => actions.closeAddAccount()) : null}
      {view.addKey ? (
        <AddKeyDialog
          provider={view.addKey.provider}
          mode={view.addKey.mode}
          onSave={key => void actions.submitKey(view.addKey!.provider, key)}
          onCancel={() => actions.cancelAddKey()}
        />
      ) : null}
      {view.consentCard ? <ConsentDialog {...{ data, consent, actions }} /> : null}
      {view.addTool ? (
        <div ref={addToolWrap} inert={c !== null} aria-hidden={c !== null ? true : undefined}>
          <AddToolDialog {...{ actions, failure }} />
        </div>
      ) : null}
      {view.diagnostics ? <DiagnosticsDialog {...{ data, view, actions, failure }} /> : null}
      {/* The confirm is last so it stacks over a dialog it questions (the admin grant). */}
      {c ? (
        <ConfirmDialog
          confirm={c}
          data={data}
          onConfirm={() => void actions.runConfirm(c)}
          onCancel={() => actions.cancelConfirm()}
        />
      ) : null}
    </>
  );
}

/**
 * Add or replace a provider's key. The field's text lives in this component only: it goes to the engine once, on
 * Return or Save, and the field is cleared in the same step. Closing the dialog drops it. It is never shown back,
 * logged or kept in Settings' state (DESIGN 7.10).
 */
export function AddKeyDialog({
  provider,
  mode,
  onSave,
  onCancel,
}: {
  provider: string;
  mode: 'add' | 'replace';
  onSave(key: string): void;
  onCancel(): void;
}) {
  const [key, setKey] = useState('');
  const name = providerName(provider);
  const submit = () => {
    const value = key.trim();
    if (!value) return;
    setKey('');
    onSave(value);
  };
  return (
    <Dialog
      open
      size="sm"
      title={mode === 'replace' ? `Replace the ${name} key` : `Add a ${name} key`}
      description="Paste it here. It is saved in your Keychain and never shown again."
      initialFocusId="set-add-key-field"
      onClose={() => {
        setKey('');
        onCancel();
      }}
      footer={
        <>
          <Button
            variant="text"
            label="Cancel"
            keys="Esc"
            keyHint="always"
            onPress={() => {
              setKey('');
              onCancel();
            }}
          />
          <Button
            variant="filled"
            label="Save key"
            keys="Return"
            keyHint="always"
            disabled={key.trim() === ''}
            onPress={submit}
          />
        </>
      }
    >
      <TextField
        id="set-add-key-field"
        label={`${name} key`}
        type="password"
        icon="key"
        mono
        placeholder="Paste your key"
        value={key}
        onChange={setKey}
        onSubmit={submit}
      />
    </Dialog>
  );
}

function ConsentDialog({
  data,
  consent,
  actions,
}: Pick<SectionProps, 'data' | 'actions'> & { consent: ConsentView }) {
  const target =
    consent.state === 'review'
      ? { provider: consent.provider, model: consent.model }
      : data.settings.ai.features.summaries;
  const local = data.providers?.find(p => p.id === target.provider)?.local === true;
  return (
    <Dialog open size="md" title="Background summaries" onClose={() => actions.closeConsentCard()}>
      <ConsentCard
        provider={providerName(target.provider)}
        model={target.model}
        sent={CONSENT_SENT}
        showLocalNote={!local}
        onAllow={() => void actions.allowBackground()}
        onNotNow={() => actions.closeConsentCard()}
      />
    </Dialog>
  );
}

function confirmText(
  confirm: Confirmation,
  data: SectionProps['data'],
): { question: string; consequence: string } {
  switch (confirm.kind) {
    case 'removeAccount':
      return removeAccountConfirm(confirm.address, confirm.discards);
    case 'removeDemo':
      return REMOVE_DEMO_CONFIRM;
    case 'removeKey':
      return removeKeyConfirm(data.settings, confirm.provider);
    case 'revokeClient':
      return revokeConfirm(confirm.name);
    case 'grantAdmin':
      return adminGrantConfirm(confirm.name);
    case 'discardQueueItem':
      return discardConfirm(confirm.label);
  }
}

function confirmLabel(kind: Confirmation['kind']): string {
  switch (kind) {
    case 'discardQueueItem':
      return 'Discard';
    case 'revokeClient':
      return 'Revoke';
    case 'grantAdmin':
      return 'Give admin access';
    default:
      return 'Remove';
  }
}

function ConfirmDialog({
  confirm,
  data,
  onConfirm,
  onCancel,
}: {
  confirm: Confirmation;
  data: SectionProps['data'];
  onConfirm(): void;
  onCancel(): void;
}) {
  const text = confirmText(confirm, data);
  return (
    <Confirm
      presentation="dialog"
      destructive
      question={text.question}
      consequence={text.consequence}
      confirmLabel={confirmLabel(confirm.kind)}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

/** The content-free report, shown whole before anything is copied. Never uploaded. */
function DiagnosticsDialog({
  data,
  view,
  actions,
  failure,
}: Pick<SectionProps, 'data' | 'view' | 'actions' | 'failure'>) {
  const sections = data.bundle ? bundleSections(data.bundle) : [];
  return (
    <Dialog
      open
      size="md"
      title="Export diagnostics"
      description={DIAGNOSTICS_NOTE}
      initialFocusId="set-diag-save"
      onClose={() => actions.closeDiagnostics()}
      footer={
        <>
          <Button
            variant="text"
            label={view.diagnosticsCopied || view.diagnosticsSaved ? 'Close' : 'Cancel'}
            keys="Esc"
            keyHint="always"
            onPress={() => actions.closeDiagnostics()}
          />
          <Button
            variant="text"
            label="Copy report"
            disabled={!data.bundle}
            busy={view.busy.diagnostics === true}
            onPress={() => void actions.copyDiagnostics()}
          />
          <Button
            variant="filled"
            id="set-diag-save"
            label="Save report"
            keys="Return"
            keyHint="always"
            disabled={!data.bundle}
            busy={view.busy.diagnostics === true}
            onPress={() => void actions.saveDiagnostics()}
          />
        </>
      }
    >
      <div className="settings-report">
        {failure ? <FailureLine failure={failure} /> : null}
        {view.diagnosticsCopied || view.diagnosticsSaved ? (
          <Text variant="small" tone="dim">
            {view.diagnosticsSaved ? 'Saved.' : 'Copied.'}
          </Text>
        ) : null}
        {!data.bundle ? <Text variant="small">Preparing the report.</Text> : null}
        {sections.map(s => (
          <section key={s.title} className="settings-report__section">
            <Text variant="label" tone="ink" as="h3">
              {s.title}
            </Text>
            {s.rows.map(r => (
              <div key={`${s.title}-${r.label}`} className="settings-report__row">
                <Text variant="small" as="span">
                  {r.label}
                </Text>
                <Text variant="small" tone="ink-2" as="span">
                  {r.value}
                </Text>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Dialog>
  );
}
