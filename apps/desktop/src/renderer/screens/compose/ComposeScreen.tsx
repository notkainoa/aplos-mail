/**
 * New message as a page in the pane, non-modal (DESIGN 7.6): a To row, the subject as a `heading`-size field, the text
 * in `read`, and the footer with Send (⌘↩), the draft line, attach and format. C or the palette opens it fresh; Drafts
 * and the inline reply's Pop out open it on a draft. Esc closes it and keeps the draft. On Send the page closes and,
 * with no thread showing the message, the undo tray goes to the shell's toast stack (`useUndoSendNotice`).
 */
import { useEffect, useMemo, useRef } from 'react';
import { getNow, useAccounts, useRow } from '../../data';
import { useAccountScope, useRegisterCommands, type CommandHandlerTable } from '../../shell';
import { Composer } from '../../ui/compose';
import { composeFromDraft, freshCompose, type ComposeState } from './model/composeState';
import { replySeed } from './model/replySeed';
import { schedulePresets } from './model/schedule';
import type { DictationSource } from './runtime/dictationSource';
import { useComposerControls } from './runtime/useComposerControls';
import { handOffIfLive, useComposeSession, type ComposeBinding } from './runtime/useComposeSession';
import { ComposeMenu, DiscardConfirm } from './views/ComposeOverlays';
import { useSharedComposerProps } from './views/composerParts';

export interface ComposeScreenProps {
  /** Open on this draft (Drafts, Pop out). */
  readonly draftId?: string;
  /** A reply popped out before its first save. */
  readonly replyTo?: {
    readonly threadId: string;
    readonly messageId: string;
    readonly replyAll?: boolean;
  };
  /** The page has gone (Esc, discarded, sent): the shell goes back. */
  readonly onClose?: () => void;
  readonly dictationSource?: DictationSource | null;
}

function useInitialCompose(props: ComposeScreenProps): ComposeState | null {
  const draft = useRow('Draft', props.draftId);
  const message = useRow('Message', props.replyTo?.messageId);
  const accounts = useAccounts();
  const scope = useAccountScope();
  const decided = useRef<ComposeState | null>(null);
  if (decided.current) return decided.current;
  if (props.draftId) {
    decided.current = draft ? composeFromDraft(draft) : null;
  } else if (props.replyTo) {
    const me = new Set(accounts.map(a => a.address.toLowerCase()));
    const seed = message ? replySeed(message, me, props.replyTo.replyAll ?? false) : null;
    decided.current = seed ? freshCompose(seed.context, seed.fields) : null;
  } else {
    const accountId = scope ?? accounts[0]?.id;
    decided.current = accountId ? freshCompose({ accountId, mode: 'new' }) : null;
  }
  return decided.current;
}

/** Calls `onClose` once the page has nothing left to show; a send it made goes to the toast stack's one notice. */
function useCloseWhenDone(binding: ComposeBinding | null, onClose: (() => void) | undefined) {
  const done = binding !== null && !binding.view.open && !binding.view.confirming;
  const send = binding?.state.send;
  const tracked = send?.kind === 'tracking' ? send.submissionId : null;
  useEffect(() => {
    if (done) onClose?.();
  }, [done, onClose]);
  const latest = useRef(binding);
  useEffect(() => {
    latest.current = binding;
  });
  useEffect(() => {
    const state = latest.current?.state;
    if (done && tracked && state) handOffIfLive(state);
  }, [done, tracked]);
}

export function ComposePageView({
  binding,
  props,
}: {
  readonly binding: ComposeBinding;
  readonly props: ComposeScreenProps;
}) {
  const controls = useComposerControls(binding, { dictationSource: props.dictationSource });
  const shared = useSharedComposerProps(binding, controls, {
    label: 'Message',
    focusTo: binding.state.fields.to.length === 0,
  });
  const { session, state, view } = binding;
  const presets = useMemo(() => schedulePresets(getNow()), []);
  const { setMenuAnchor } = controls;
  const editor = shared.editorRef;
  const formatTable = useMemo<CommandHandlerTable>(
    () => ({ 'compose.format': { run: () => setMenuAnchor(editor.current) } }),
    [setMenuAnchor, editor],
  );
  useRegisterCommands(view.open ? formatTable : {});
  return (
    <>
      <Composer
        {...shared}
        subject={state.fields.subject}
        onSubjectChange={subject =>
          session.dispatch({ type: 'edit', patch: { subject }, now: getNow() })
        }
        onFormat={anchor => setMenuAnchor(anchor)}
      />
      <ComposeMenu
        anchor={controls.menuAnchor}
        presets={presets}
        onSchedule={notBefore => controls.send(false, notBefore)}
        onDiscard={() => session.dispatch({ type: 'askDiscard' })}
        onClose={() => setMenuAnchor(null)}
      />
      {view.confirming ? (
        <DiscardConfirm
          onConfirm={() => session.dispatch({ type: 'confirmDiscard' })}
          onCancel={() => session.dispatch({ type: 'cancelDiscard' })}
        />
      ) : null}
    </>
  );
}

/** `ComposeScreen({draftId?, replyTo?})`: the compose page. */
export function ComposeScreen(props: ComposeScreenProps) {
  const initial = useInitialCompose(props);
  const binding = useComposeSession(initial);
  useCloseWhenDone(binding, props.onClose);
  if (!binding || !binding.view.open) return null;
  return <ComposePageView binding={binding} props={props} />;
}
