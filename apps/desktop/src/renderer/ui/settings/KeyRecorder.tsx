import { Fragment, useEffect, useId, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { formatChord } from '../../commands';
import { chordFromEvent, chordId, parseChord } from '../../commands/internal';
import type { KeyRecorderProps } from '../props';
import { ChordText, displayChord } from '../buttons-keys/keyHints';
import { SetIcon } from './icons';

/** A chord as a keycap ("shift+r" to "⇧R", Return as ↩). Text that is not a chord (already a display form) is shown as it came. */
export function chordText(chord: string): string {
  try {
    return displayChord(formatChord(parseChord(chord)));
  } catch {
    return chord;
  }
}

/**
 * What a key does while recording. In the conflict state Return replaces and Tab (with or without Shift) is not
 * recorded, so focus can move on to Replace and Cancel; everywhere else every key is the new chord.
 */
export function recorderKeyAction(
  state: 'recording' | 'conflict',
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean },
): 'replace' | 'move' | 'record' {
  if (state !== 'conflict' || e.metaKey || e.ctrlKey || e.altKey) return 'record';
  if (e.key === 'Enter') return 'replace';
  if (e.key === 'Tab') return 'move';
  return 'record';
}

/**
 * One remappable shortcut (DESIGN 6 KeyRecorder, 7.10 Keyboard, 11.4): the command's keycaps with a conflict mark
 * and Reset when changed. Click the keys to record; the row then swallows every key (IME-safe, `event.key`,
 * modifiers alone ignored, DESIGN 5 rule 16). Esc cancels; a taken chord shows "Already used by …" with Replace
 * (Return replaces, Tab reaches Replace and Cancel).
 */
export function KeyRecorder({
  commandId,
  label,
  chords,
  changed,
  state,
  pendingChord,
  conflictWith,
  onStart,
  onChord,
  onReplace,
  onCancel,
  onReset,
  announce,
}: KeyRecorderProps) {
  const uid = useId();
  const labelId = `${uid}-label`;
  const captureRef = useRef<HTMLButtonElement>(null);
  const keysRef = useRef<HTMLButtonElement>(null);
  const was = useRef(state);
  const shown = chords.map(chordText);
  const pending = pendingChord ? chordText(pendingChord) : undefined;

  // Recording takes focus so the next key is ours; ending it gives focus back to the keys.
  useEffect(() => {
    if (state !== 'idle') captureRef.current?.focus({ preventScroll: true });
    else if (was.current !== 'idle') keysRef.current?.focus({ preventScroll: true });
    was.current = state;
  }, [state]);

  useEffect(() => {
    if (state === 'recording') announce?.(`Press the new keys for ${label}. Escape cancels.`);
    if (state === 'conflict' && pending && conflictWith) {
      announce?.(
        `${pending} is already used by ${conflictWith.label}. Press Return or choose Replace, or press other keys.`,
      );
    }
  }, [state, pending, conflictWith, label, announce]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
      return;
    }
    const action = recorderKeyAction(
      state === 'conflict' ? 'conflict' : 'recording',
      e.nativeEvent,
    );
    if (action === 'move') return; // Tab and Shift+Tab leave the capture button for Replace and Cancel
    if (action === 'replace') {
      e.preventDefault();
      e.stopPropagation();
      onReplace();
      return;
    }
    const chord = chordFromEvent(e.nativeEvent);
    if (!chord) {
      // A lone modifier is ignored; Tab and the like are still ours while recording.
      if (
        e.key === 'Shift' ||
        e.key === 'Control' ||
        e.key === 'Alt' ||
        e.key === 'Meta' ||
        e.key === 'CapsLock'
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    onChord(chordId(chord));
  };

  if (state === 'idle') {
    const spoken = shown.length > 0 ? shown.join(' or ') : 'not set';
    return (
      <div
        className="ui-key-recorder"
        data-state="idle"
        data-changed={changed ? 'true' : undefined}
        data-command={commandId}
      >
        <span className="ui-key-recorder__label" id={labelId} dir="auto" title={label}>
          {label}
        </span>
        <span className="ui-key-recorder__controls">
          {conflictWith ? (
            <span
              className="ui-key-recorder__conflict"
              title={`Same keys as ${conflictWith.label}`}
            >
              <SetIcon name="alert" />
              <span className="ui-key-recorder__conflict-text">{`Same keys as ${conflictWith.label}`}</span>
            </span>
          ) : null}
          {changed ? (
            <button
              type="button"
              className="ui-key-recorder__reset"
              aria-label={`Reset ${label} to its default`}
              onClick={onReset}
            >
              Reset
            </button>
          ) : null}
          <button
            ref={keysRef}
            type="button"
            className="ui-key-recorder__keys"
            aria-label={`Change the shortcut for ${label}. Now ${spoken}`}
            title="Click to change"
            onClick={onStart}
          >
            {shown.length > 0 ? (
              shown.map((k, i) => (
                <Fragment key={k}>
                  {i > 0 ? <span className="ui-key-recorder__or">or</span> : null}
                  <kbd className="ui-key-recorder__kbd">
                    <ChordText chord={k} />
                  </kbd>
                </Fragment>
              ))
            ) : (
              <span className="ui-key-recorder__none">None</span>
            )}
          </button>
        </span>
      </div>
    );
  }

  return (
    <div
      className="ui-key-recorder"
      data-state={state}
      data-command={commandId}
      onKeyDown={e => {
        // Esc cancels from Replace and Cancel too (the capture button handles its own).
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <span className="ui-key-recorder__text">
        <span className="ui-key-recorder__label" id={labelId} dir="auto">
          {label}
        </span>
        <span className="ui-key-recorder__hint">Press the new keys · Esc to cancel</span>
      </span>
      <span className="ui-key-recorder__controls">
        <button
          ref={captureRef}
          type="button"
          className="ui-key-recorder__capture"
          aria-label={`Recording a new shortcut for ${label}. Press the new keys, or Escape to cancel.`}
          onKeyDown={onKeyDown}
        >
          {pending ? (
            <kbd className="ui-key-recorder__kbd" data-role="new">
              {pending}
            </kbd>
          ) : (
            <kbd className="ui-key-recorder__kbd" data-role="wait" aria-hidden="true">
              …
            </kbd>
          )}
        </button>
        {state === 'conflict' && conflictWith ? (
          <>
            <span
              className="ui-key-recorder__conflict"
              role="status"
              title={`Already used by ${conflictWith.label}`}
            >
              <SetIcon name="alert" />
              <span className="ui-key-recorder__conflict-text">{`Already used by ${conflictWith.label}`}</span>
            </span>
            <button
              type="button"
              className="ui-key-recorder__action"
              aria-label={`Replace the shortcut of ${conflictWith.label}`}
              onClick={onReplace}
            >
              Replace
            </button>
          </>
        ) : null}
        <button type="button" className="ui-key-recorder__action" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </div>
  );
}
