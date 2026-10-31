/**
 * `useDictation`: the dictation controller for one composer. The source defaults to the browser's recorder where it
 * exists (`canRecord`) and to nothing elsewhere; tests and the harness pass a `DictationSource` of their own.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { api, getNow } from '../../../data';
import { dictationShown, type DictationPhase } from '../model/dictationModel';
import type { DictationState } from '../../../ui/props';
import { createDictation, engineTranscribe, type DictationController } from './dictation';
import { canRecord, mediaRecorderSource, type DictationSource } from './dictationSource';

export interface DictationHook {
  readonly controller: DictationController;
  readonly phase: DictationPhase;
  /** The composer's `dictation` prop: set only while listening. */
  readonly shown: DictationState | undefined;
}

function defaultSource(): DictationSource | null {
  return canRecord() ? mediaRecorderSource() : null;
}

export function useDictation(
  onText: (text: string) => void,
  source?: DictationSource | null,
): DictationHook {
  const latest = useRef(onText);
  useEffect(() => {
    latest.current = onText;
  }, [onText]);
  const controller = useMemo(
    () =>
      createDictation({
        source: source === undefined ? defaultSource() : source,
        transcribe: engineTranscribe(api),
        onText: text => latest.current(text),
        now: () => getNow(),
      }),
    [source],
  );
  useEffect(() => () => controller.dispose(), [controller]);
  const phase = useSyncExternalStore(
    controller.subscribe,
    controller.getPhase,
    controller.getPhase,
  );
  return { controller, phase, shown: dictationShown(phase) };
}
