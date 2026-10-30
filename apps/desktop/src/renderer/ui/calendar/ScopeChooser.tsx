import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { Button } from '../buttons-keys';
import type { ScopeChooserProps } from '../props';

const QUESTION: Record<ScopeChooserProps['action'], string> = {
  move: 'Move this repeating event?',
  change: 'Change this repeating event?',
  delete: 'Delete this repeating event?',
  reply: 'Reply to this repeating event?',
};

/** "This event" (Return) or "All events" (⇧Return) before a change to a repeating event; Esc cancels. Focus starts on "This event". */
export function ScopeChooser({ action, title, onChoose, onCancel }: ScopeChooserProps) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      onChoose('series');
    } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      onChoose('occurrence');
    }
  }

  return (
    <div
      className="ui-scope-chooser"
      role="group"
      aria-label={`${QUESTION[action]} ${title}`}
      onKeyDown={onKeyDown}
    >
      <p className="ui-scope-chooser__question">{QUESTION[action]}</p>
      <div className="ui-scope-chooser__rows">
        <Button
          ref={first}
          variant="filled"
          size="sm"
          label="This event"
          keys="Return"
          keyHint="always"
          onPress={() => onChoose('occurrence')}
        />
        <Button
          variant="text"
          size="sm"
          label="All events"
          keys="⇧Return"
          onPress={() => onChoose('series')}
        />
        <Button variant="text" size="sm" label="Cancel" keys="Esc" onPress={onCancel} />
      </div>
    </div>
  );
}
