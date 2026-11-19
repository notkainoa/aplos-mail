/**
 * ReconnectSheet: the weekly Gmail reconnect (DESIGN 6, 7.1, 7.15). A small sheet (--elev-dialog) while the
 * provider's sign-in page is open in the browser with the address filled in: "Waiting for Google in your
 * browser…" with Cancel. On failure it says why, with Try again. Nothing resyncs and local changes are kept;
 * the shell closes it with a "Reconnected" toast.
 *
 * `mode` 'grant' is the missing-permission case (`needsPermission`): its own title, "Aplos needs permission to
 * read your Gmail.", and "Grant access" in place of "Try again". `mode` 'enableEditing' is the calendar-write
 * ask (Settings → Calendar's "Enable editing"): "Aplos will ask Google for permission to change events." The
 * wait is the same.
 */
import { useId } from 'react';
import type { ComponentPropsMap } from '../props';
import { Dialog } from '../surfaces/Dialog';
import { PartButton, PartIcon } from '../surfaces/parts';
import { Spinner } from './Spinner';

const PROVIDER_NAME = { google: 'Google', microsoft: 'Microsoft' } as const;
const PROVIDER_MAIL = { google: 'Gmail', microsoft: 'Outlook mail' } as const;

export function ReconnectSheet({
  open,
  address,
  provider = 'google',
  state,
  reason,
  mode = 'reconnect',
  onCancel,
  onRetry,
}: ComponentPropsMap['ReconnectSheet']) {
  const retryId = useId();
  const cancelId = useId();
  const name = PROVIDER_NAME[provider];
  const grant = mode === 'grant';
  const editing = mode === 'enableEditing';
  const waiting = `Waiting for ${name} in your browser…`;
  const footer = (
    <>
      <PartButton
        id={cancelId}
        variant="text"
        label="Cancel"
        keys="Esc"
        keyHint="always"
        onPress={() => onCancel()}
      />
      {state === 'failed' ? (
        <PartButton
          id={retryId}
          variant="filled"
          label={grant ? 'Grant access' : editing ? 'Turn on editing' : 'Try again'}
          keys="Return"
          keyHint="always"
          onPress={() => onRetry()}
        />
      ) : null}
    </>
  );
  return (
    <Dialog
      open={open}
      title={
        grant
          ? `Grant access for ${address}`
          : editing
            ? `Turn on editing for ${address}`
            : `Reconnect ${address}`
      }
      description={
        grant
          ? `Aplos needs permission to read your ${PROVIDER_MAIL[provider]}.`
          : editing
            ? `Aplos will ask ${name} for permission to change events. Nothing changes unless you ask.`
            : 'Nothing resyncs, and your changes on this Mac are kept.'
      }
      size="sm"
      footer={footer}
      initialFocusId={state === 'failed' ? retryId : cancelId}
      onClose={onCancel}
    >
      <div
        className="ui-reconnect-sheet"
        data-state={state}
        data-provider={provider}
        data-mode={mode}
      >
        {state === 'waiting' ? (
          <p className="ui-reconnect-sheet__line" role="status">
            {/* The sentence beside it already says it; the spinner stays out of the accessibility tree. */}
            <span className="ui-reconnect-sheet__spinner" aria-hidden="true">
              <Spinner label={waiting} size="sm" />
            </span>
            <span>{waiting}</span>
          </p>
        ) : (
          <p className="ui-reconnect-sheet__line" role="alert">
            <PartIcon name="alert" size="sm" />
            <span>
              {reason ??
                (editing
                  ? `${name} didn’t finish granting access. Your calendar stays as it is.`
                  : `${name} didn’t finish ${grant ? 'granting access' : 'the sign-in'}. Your mail is safe on this Mac.`)}
            </span>
          </p>
        )}
      </div>
    </Dialog>
  );
}
