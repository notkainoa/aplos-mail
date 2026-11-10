/**
 * "Add a tool": name it, pick its kind and what it may do, then see where its key file is, once. The path is this
 * component's own state: it is dropped when the dialog closes and is never written to Settings' state, a log or the
 * clipboard unless the owner presses Copy path (DESIGN 7.10; ARCH 12.3).
 */
import { useState } from 'react';
import { Button } from '../../ui/buttons-keys';
import { Checkbox, TextField } from '../../ui/controls';
import { Dialog, Puck, Text } from '../../ui/surfaces';
import { FailureLine } from './parts';
import type { SectionProps } from './sections/types';
import {
  EMPTY_TOOL_DRAFT,
  scopeWarnings,
  TOOL_KEY_NOTE,
  TOOL_KIND_ITEMS,
  TOOL_SCOPES,
  toggleScope,
  toolDraftReady,
  type ToolDraft,
  type ToolKind,
} from './settings.model';

export function AddToolDialog({ actions, failure }: Pick<SectionProps, 'actions' | 'failure'>) {
  const [draft, setDraft] = useState<ToolDraft>(EMPTY_TOOL_DRAFT);
  const [granted, setGranted] = useState<{ name: string; path: string | undefined } | null>(null);
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setGranted(null);
    actions.closeAddTool();
  };
  const submit = async () => {
    if (!toolDraftReady(draft) || busy) return;
    setBusy(true);
    const client = await actions.grantClient(draft);
    setBusy(false);
    if (client) setGranted({ name: client.name, path: client.tokenPath });
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(granted?.path ?? '');
      setCopied('yes');
    } catch {
      setCopied('no');
    }
  };

  if (granted)
    return (
      <Dialog
        open
        size="md"
        title={`“${granted.name}” is allowed`}
        initialFocusId="set-tool-done"
        onClose={close}
        footer={
          <>
            {granted.path ? (
              <Button variant="text" label="Copy path" onPress={() => void copy()} />
            ) : null}
            <Button
              id="set-tool-done"
              variant="filled"
              label="Done"
              keys="Return"
              keyHint="always"
              onPress={close}
            />
          </>
        }
      >
        <div className="settings-tool-key">
          {granted.path ? (
            <TextField
              id="set-tool-path"
              label="Key file"
              labelVisible
              mono
              readOnly
              value={granted.path}
              onChange={() => {}}
            />
          ) : (
            <Text variant="small">
              The key file was not reported. Allow the tool again to get one.
            </Text>
          )}
          <Text variant="small" tone="ink">
            {TOOL_KEY_NOTE}
          </Text>
          {copied ? (
            <Text variant="small" tone="dim">
              {copied === 'yes' ? 'Copied.' : 'Could not copy. Select the path and copy it.'}
            </Text>
          ) : null}
        </div>
      </Dialog>
    );

  return (
    <Dialog
      open
      size="md"
      title="Add a tool"
      description="A script or assistant on this Mac. It gets only what you tick."
      initialFocusId="set-tool-name"
      onClose={close}
      footer={
        <>
          <Button variant="text" label="Cancel" keys="Esc" keyHint="always" onPress={close} />
          <Button
            variant="filled"
            label="Allow tool"
            keys="Return"
            keyHint="always"
            disabled={!toolDraftReady(draft)}
            busy={busy}
            onPress={() => void submit()}
          />
        </>
      }
    >
      <div className="settings-tool-form">
        {failure ? <FailureLine failure={failure} /> : null}
        <TextField
          id="set-tool-name"
          label="Name"
          labelVisible
          placeholder="Terminal assistant"
          value={draft.name}
          onChange={name => setDraft({ ...draft, name })}
          onSubmit={() => void submit()}
        />
        <Puck
          kind="segmented"
          role="radio"
          label="Kind"
          items={TOOL_KIND_ITEMS}
          selectedId={draft.kind}
          onSelect={kind => setDraft({ ...draft, kind: kind as ToolKind })}
        />
        <fieldset className="settings-tool-scopes">
          <legend>
            <Text variant="label" tone="ink" as="span">
              It may
            </Text>
          </legend>
          {TOOL_SCOPES.map(s => (
            <Checkbox
              key={s.id}
              label={s.label}
              checked={draft.scopes.includes(s.id)}
              onChange={on => setDraft({ ...draft, scopes: toggleScope(draft.scopes, s.id, on) })}
            />
          ))}
        </fieldset>
        {scopeWarnings(draft.scopes).map(w => (
          <Text key={w} variant="small" tone="ink">
            {w}
          </Text>
        ))}
      </div>
    </Dialog>
  );
}
