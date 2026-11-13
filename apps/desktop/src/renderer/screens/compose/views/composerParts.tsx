/**
 * The props the inline reply and the compose page share, built once from the session and the controls: the recipient
 * rows, the body editor with its dim suggestion, the suggestion hint, the draft line and Send. Both own the filled
 * button only while open; neither renders at all when closed.
 */
import { useRef, type ReactNode, type RefObject } from 'react';
import { getNow, useAccounts } from '../../../data';
import type {
  ComposeCommands,
  DictationState,
  DraftStateKind,
  BlockedSend,
  SuggestionProps,
} from '../../../ui/props';
import type { ComposeFields } from '../model/fields';
import type { ComposerControls } from '../runtime/useComposerControls';
import type { ComposeBinding } from '../runtime/useComposeSession';
import { BodyEditor } from './BodyEditor';
import { FromRow } from './FromRow';
import { RecipientRows } from './RecipientRows';

/** Registry ids for the footer (DESIGN 8 Compose): ⌘↩, ⌘⇧A, ⌘/, ⌘⇧C. */
export const COMPOSE_COMMANDS: ComposeCommands = {
  send: 'compose.send',
  attach: 'compose.attach',
  more: 'compose.format',
  cc: 'compose.ccBcc',
};

export interface SharedComposerProps {
  readonly recipients: ReactNode;
  readonly editor: ReactNode;
  readonly suggestion: SuggestionProps | undefined;
  readonly draftState: DraftStateKind;
  readonly onRetrySave: () => void;
  readonly dictation: DictationState | undefined;
  readonly blocked: BlockedSend | undefined;
  readonly commands: ComposeCommands;
  readonly onSend: () => void;
  /** Attachments are a later slice's: the button is there and does nothing yet (REQUEST in the lane report). */
  readonly onAttach: () => void;
  readonly editorRef: RefObject<HTMLTextAreaElement | null>;
}

/**
 * From: asks the composer to write in another account. A save that is in flight makes the reducer refuse for the moment
 * (the draft cannot move mid-save), so the choice is asked again once the queue has settled.
 */
function chooseAccount(session: ComposeBinding['session'], accountId: string): void {
  session.dispatch({ type: 'setAccount', accountId, now: getNow() });
  if (session.getState().context.accountId === accountId) return;
  void session.settled().then(() => {
    if (session.getState().context.accountId !== accountId)
      session.dispatch({ type: 'setAccount', accountId, now: getNow() });
  });
}

export function useSharedComposerProps(
  binding: ComposeBinding,
  controls: ComposerControls,
  options: { readonly label: string; readonly focusTo: boolean; readonly from?: boolean },
): SharedComposerProps {
  const { session, state, view } = binding;
  const accounts = useAccounts();
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const edit = (patch: Partial<ComposeFields>) =>
    session.dispatch({ type: 'edit', patch, now: getNow() });
  const suggestion = view.suggestion;
  return {
    recipients: (
      <>
        {options.from ? (
          <FromRow
            accounts={accounts}
            accountId={state.context.accountId}
            canChange={state.context.mode === 'new'}
            onChange={accountId => chooseAccount(session, accountId)}
          />
        ) : null}
        <RecipientRows
          fields={state.fields}
          accountId={state.context.accountId}
          onChange={edit}
          showCc={controls.showCc}
          onShowCc={() => controls.setShowCc(true)}
          invalid={view.invalid}
          autoFocus={options.focusTo}
        />
      </>
    ),
    editor: (
      <BodyEditor
        value={state.fields.body}
        onChange={body => edit({ body })}
        suggestion={suggestion?.text}
        label={options.label}
        autoFocus={!options.focusTo}
        editorRef={editorRef}
      />
    ),
    suggestion: suggestion
      ? {
          kind: suggestion.kind,
          onKeep: () => session.dispatch({ type: 'keepSuggestion', now: getNow() }),
          onDismiss: () => session.dispatch({ type: 'dismissSuggestion' }),
        }
      : undefined,
    draftState: view.draftState,
    onRetrySave: () => session.dispatch({ type: 'retrySave', now: getNow() }),
    dictation: controls.dictation.shown,
    blocked: view.blocked,
    commands: COMPOSE_COMMANDS,
    onSend: () => controls.send(),
    onAttach: () => undefined,
    editorRef,
  };
}
