/**
 * Pieces Composer and InlineReply share so the sentences and the footer exist once. Not manifest components.
 */
import type {
  BlockedSend,
  ComposeCommands,
  DictationState,
  DraftConflict,
  DraftStateKind,
  IconName,
} from '../props';
import { DictationLine } from './DictationLine';
import { DraftState } from './DraftState';
import { Icon } from './icons';
import { Btn, Kbd } from './parts';

/** A blocked send: one plain sentence, an icon and the stamp ink; the field it belongs to is outlined by CSS. No shake. */
export function BlockedLine({ id, blocked }: { id: string; blocked: BlockedSend }) {
  return (
    <p id={id} className="ui-compose-blocked" role="alert" data-field={blocked.field}>
      <Icon name="alert" size="sm" />
      <span dir="auto">{blocked.message}</span>
    </p>
  );
}

/** "This draft changed on another device." with Keep mine · Take theirs · Keep both (plan 30 §4.5 #5). */
export function ConflictBar({ conflict }: { conflict: DraftConflict }) {
  return (
    <div className="ui-compose-conflict" role="group" aria-label="Draft conflict">
      <span>This draft changed on another device.</span>
      <span className="ui-compose-conflict__acts">
        <Btn variant="text" label="Keep mine" onPress={conflict.onKeepMine} />
        <Btn variant="text" label="Take theirs" onPress={conflict.onTakeTheirs} />
        <Btn variant="text" label="Keep both" onPress={conflict.onKeepBoth} />
      </span>
    </div>
  );
}

export interface FooterAction {
  label: string;
  icon: IconName;
  commandId: string;
  hint: string;
  onPress: (anchor: HTMLElement) => void;
}

/**
 * The footer's icon buttons, one anatomy for the compose page and the inline reply: attach, Formatting, Pop out (only
 * where the card can be popped out, so the inline reply), then ⋯. Both menu buttons open the one compose menu.
 */
export function footerActions(parts: {
  commands: ComposeCommands;
  onAttach: () => void;
  onFormat: (anchor: HTMLElement) => void;
  onMore: (anchor: HTMLElement) => void;
  onPopOut?: () => void;
}): readonly FooterAction[] {
  const { commands, onAttach, onFormat, onMore, onPopOut } = parts;
  const popOut: FooterAction[] = onPopOut
    ? [
        {
          label: 'Pop out reply',
          icon: 'pop-out',
          hint: 'Pop out reply',
          commandId: 'compose.popOut',
          onPress: () => onPopOut(),
        },
      ]
    : [];
  return [
    {
      label: 'Attach',
      icon: 'paperclip',
      hint: 'Attach a file',
      commandId: commands.attach,
      onPress: () => onAttach(),
    },
    {
      label: 'Formatting',
      icon: 'type',
      hint: 'Formatting',
      commandId: commands.more,
      onPress: onFormat,
    },
    ...popOut,
    {
      label: 'More',
      icon: 'more',
      hint: 'More: schedule, discard',
      commandId: 'compose.more',
      onPress: onMore,
    },
  ];
}

/** Send (always with its keycap), the draft line or the dictation line, and the trailing icon buttons. */
export function ComposeFooter(props: {
  commands: ComposeCommands;
  draftState: DraftStateKind;
  onRetrySave: () => void;
  dictation?: DictationState;
  onSend: () => void;
  trailing: readonly FooterAction[];
  /** The quiet "Esc closes" line, in the inline reply and the compose page alike: Esc closes and keeps the draft. */
  closeHint?: boolean;
}) {
  const { commands, draftState, onRetrySave, dictation, onSend, trailing, closeHint } = props;
  return (
    <div className="ui-compose-footer">
      <Btn
        variant="filled"
        size="md"
        icon="send"
        label="Send"
        commandId={commands.send}
        keyHint="always"
        onPress={onSend}
      />
      {dictation ? (
        <DictationLine dictation={dictation} />
      ) : (
        <DraftState state={draftState} onRetry={onRetrySave} />
      )}
      <span className="ui-compose-footer__right">
        {closeHint ? (
          <span className="ui-compose-footer__close">
            <Kbd>Esc</Kbd> closes
          </span>
        ) : null}
        {trailing.map(action => (
          <Btn
            key={action.label}
            variant="icon"
            icon={action.icon}
            label={action.label}
            hint={action.hint}
            commandId={action.commandId}
            onPress={action.onPress}
          />
        ))}
      </span>
    </div>
  );
}
