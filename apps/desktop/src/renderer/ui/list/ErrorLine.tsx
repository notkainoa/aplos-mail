// ErrorLine (DESIGN §6, §7.15, §7.12; plan 30 §4.5 #1). Mockups: errors.html (row-error, send-failed),
// settings-ai.html (testing), onboarding-sync.html (failed). The component writes the copy from the kind:
// what happened, what is safe, what to do. No exclamation marks, no raw provider error.

import type { ErrorLineAction, ErrorLineKind, ErrorLineProps } from '../props';
import { Action, useInListbox } from './internal/Action';
import { useKeycapFor, useTooltipText } from './internal/keys';
import { Icon } from './internal/Icon';

interface Copy {
  text: string;
  actions: readonly { action: ErrorLineAction; label: string; emphasis: 'text' | 'filled' }[];
}

function copyFor(kind: ErrorLineKind, mainAction: boolean): Copy {
  switch (kind.kind) {
    case 'writeRejected':
      return {
        text: `Couldn’t ${kind.op}.`,
        actions: [{ action: 'retry', label: 'Retry', emphasis: 'text' }],
      };
    case 'sendFailed':
      return {
        text: `Couldn’t send to ${kind.recipient}. Your draft is saved.`,
        actions: [
          { action: 'retry', label: 'Try again', emphasis: 'text' },
          { action: 'edit', label: 'Edit', emphasis: 'text' },
        ],
      };
    case 'bodyFailed':
      return {
        text: 'Couldn’t load this email.',
        actions: [{ action: 'retry', label: 'Try again', emphasis: 'text' }],
      };
    case 'listFailed':
      return {
        text: 'Couldn’t load this list.',
        actions: [{ action: 'retry', label: 'Try again', emphasis: 'text' }],
      };
    case 'askFailed':
      return {
        text: `${kind.provider} didn’t answer.`,
        actions: [
          { action: 'retry', label: 'Retry', emphasis: 'text' },
          { action: 'useAnotherProvider', label: 'Use another provider', emphasis: 'text' },
        ],
      };
    case 'consentNeeded':
      return {
        text: 'Background summaries are paused until you agree to the new provider.',
        actions: [{ action: 'review', label: 'Review', emphasis: mainAction ? 'filled' : 'text' }],
      };
    case 'keyRefused': {
      const fresh = kind.keyPage ? ` Copy a fresh one from ${kind.keyPage}.` : '';
      return {
        text: `${kind.provider} refused the saved key, so nothing was sent.${fresh} Your other providers are not affected.`,
        actions: [{ action: 'replaceKey', label: 'Replace key', emphasis: 'text' }],
      };
    }
    case 'sortFailed': {
      const why =
        kind.cause === 'keyRefused'
          ? 'the key was refused'
          : kind.cause === 'unreachable'
            ? `${kind.provider} didn’t answer`
            : 'today’s AI limit is reached';
      return {
        text: `Couldn’t sort with ${kind.provider}: ${why}. Mail is ready; sorting will retry.`,
        actions: [{ action: 'openSettings', label: 'Open Settings', emphasis: 'text' }],
      };
    }
    case 'reason':
      return {
        text: kind.text,
        actions: kind.retryable ? [{ action: 'retry', label: 'Try again', emphasis: 'text' }] : [],
      };
  }
}

/** One inline error line: a --stamp-ink icon, the sentence, and its actions. */
export function ErrorLine(props: ErrorLineProps) {
  const { placement, onAction, editCommandId, mainAction = false } = props;
  const inListbox = useInListbox();
  const { text, actions } = copyFor(props, mainAction);
  // Inside an option the line is read with the row. A button with a registry key is a pointer duplicate of that key
  // (README Accessibility); one without a key (Retry has no command yet) stays reachable with Tab and VoiceOver.
  const editKey = useKeycapFor(editCommandId);
  const tip = useTooltipText();
  const live = placement === 'column' || placement === 'dock' || placement === 'settings';
  return (
    <div
      className="ui-error-line"
      data-placement={placement}
      data-kind={props.kind}
      role={live ? 'alert' : undefined}
    >
      <Icon name="alert" size={placement === 'row' ? 'sm' : 'md'} />
      <span className="ui-error-line__text">{text}</span>
      {actions.length > 0 ? (
        <span className="ui-error-line__actions">
          {actions.map(({ action, label, emphasis }) => (
            <Action
              key={action}
              variant={emphasis}
              size="sm"
              tone={placement === 'row' ? 'danger' : 'default'}
              label={label}
              tooltip={action === 'edit' ? tip('Edit draft', editCommandId) : label}
              hintKey={action === 'edit' ? editKey : undefined}
              keyHint={action === 'edit' ? 'hint' : undefined}
              duplicate={inListbox && action === 'edit' && editKey !== ''}
              onPress={() => onAction(action)}
            />
          ))}
        </span>
      ) : null}
    </div>
  );
}
