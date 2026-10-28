import type { DictationState } from '../props';
import { LevelMeter } from './LevelMeter';

/**
 * The dictation line shared by Composer, InlineReply and AskDock: the meter and one sentence (DESIGN §7.6).
 * Not a manifest component; it exists so the sentence is written once.
 */
export function DictationLine({ dictation }: { dictation: DictationState }) {
  return (
    <span className="ui-dictation-line" role="status">
      <LevelMeter level={dictation.level} label="Listening" />
      <span className="ui-dictation-line__text">{`Listening. Release ${dictation.holdKey} to keep, Esc to cancel.`}</span>
    </span>
  );
}
