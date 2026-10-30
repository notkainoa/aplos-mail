/**
 * The dictation controller without React (`useDictation` wraps it): it drives `dictationReducer`, starts and stops the
 * `DictationSource`, and sends a kept recording through the engine (`Blob/put`, then `Ai/transcribe` on the Voice
 * provider). The level reaches the reducer at most ten times a second, so the meter never re-renders per frame.
 */
import type { DataApi } from '../../../data';
import {
  dictationReducer,
  IDLE,
  type DictationEvent,
  type DictationPhase,
  type HoldKey,
} from '../model/dictationModel';
import type { DictationSource, Recording } from './dictationSource';

/** Recording to text. */
export type Transcribe = (recording: Recording) => Promise<string>;

export interface DictationDeps {
  /** Null where nothing can record: holding the key then does nothing beyond the tap. */
  readonly source: DictationSource | null;
  readonly transcribe: Transcribe;
  /** The words heard, to add to the body. */
  readonly onText: (text: string) => void;
  readonly now: () => number;
}

export interface DictationController {
  getPhase(): DictationPhase;
  subscribe(listener: () => void): () => void;
  start(holdKey: HoldKey): void;
  /** The held key came up (`keep`), or the hold ended another way. */
  release(keep: boolean): Promise<void>;
  /** Esc. */
  cancel(): void;
}

const LEVEL_EVERY_MS = 100;

/** Transcription through the engine: upload the audio, then `Ai/transcribe`. */
export function engineTranscribe(api: Pick<DataApi, 'blob' | 'ai'>): Transcribe {
  return async recording => {
    const { blobId } = await api.blob.put({
      bytes: recording.bytes,
      mime: recording.mime,
      name: 'dictation',
    });
    const { text } = await api.ai.transcribe({ blobId });
    return text;
  };
}

export function createDictation(deps: DictationDeps): DictationController {
  let phase: DictationPhase = IDLE;
  let lastLevelAt = Number.NEGATIVE_INFINITY;
  const listeners = new Set<() => void>();

  const step = (event: DictationEvent) => {
    const next = dictationReducer(phase, event);
    if (next === phase) return;
    phase = next;
    listeners.forEach(listener => listener());
  };

  const onLevel = (level: number) => {
    const now = deps.now();
    if (now - lastLevelAt < LEVEL_EVERY_MS) return;
    lastLevelAt = now;
    step({ type: 'level', level });
  };

  async function keep(source: DictationSource): Promise<void> {
    try {
      const recording = await source.stop();
      const text = recording ? await deps.transcribe(recording) : '';
      if (text.trim()) deps.onText(text);
    } catch {
      // No voice provider, or it failed: absence is quiet on the mail surface (DESIGN 9 rule 7).
    } finally {
      step({ type: 'done' });
    }
  }

  return {
    getPhase: () => phase,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(holdKey) {
      const source = deps.source;
      if (!source || phase.kind !== 'idle') return;
      step({ type: 'start', holdKey });
      source.start(onLevel).catch(() => step({ type: 'cancel' }));
    },
    async release(keepIt) {
      const source = deps.source;
      if (!source || phase.kind !== 'listening') return;
      step({ type: 'release', keep: keepIt });
      if (keepIt) return keep(source);
      source.cancel();
    },
    cancel() {
      if (phase.kind !== 'listening') return;
      deps.source?.cancel();
      step({ type: 'cancel' });
    },
  };
}
