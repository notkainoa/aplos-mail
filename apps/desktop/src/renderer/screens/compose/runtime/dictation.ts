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
  /** Schedules `callback` after `ms` and returns what cancels it; the global `setTimeout` by default. */
  readonly setTimeout?: (callback: () => void, ms: number) => () => void;
}

export interface DictationController {
  getPhase(): DictationPhase;
  subscribe(listener: () => void): () => void;
  start(holdKey: HoldKey): void;
  /** The held key came up (`keep`), or the hold ended another way. */
  release(keep: boolean): Promise<void>;
  /** Esc. */
  cancel(): void;
  /** The composer is going away: always cancels the source (even while it waits on the microphone prompt). */
  dispose(): void;
}

const LEVEL_EVERY_MS = 100;

/** A recording stops by itself, and is kept, this long after it starts. */
export const MAX_DICTATION_MS = 120_000;

function globalTimer(callback: () => void, ms: number): () => void {
  const id = setTimeout(callback, ms);
  return () => clearTimeout(id);
}

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
  const schedule = deps.setTimeout ?? globalTimer;
  let clearCap: (() => void) | null = null;

  const stopCap = () => {
    clearCap?.();
    clearCap = null;
  };

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
    let recording: Recording | null = null;
    try {
      recording = await source.stop();
      const text = recording ? await deps.transcribe(recording) : '';
      if (text.trim()) deps.onText(text);
    } catch {
      // No voice provider, or it failed: absence is quiet on the mail surface (DESIGN 9 rule 7).
    } finally {
      recording = null;
      step({ type: 'done' });
    }
  }

  async function release(keepIt: boolean): Promise<void> {
    const source = deps.source;
    if (!source || phase.kind !== 'listening') return;
    stopCap();
    step({ type: 'release', keep: keepIt });
    if (keepIt) return keep(source);
    source.cancel();
  }

  function cancel(): void {
    if (phase.kind !== 'listening') return;
    stopCap();
    deps.source?.cancel();
    step({ type: 'cancel' });
  }

  function failed(): void {
    stopCap();
    step({ type: 'cancel' });
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
      clearCap = schedule(() => void release(true), MAX_DICTATION_MS);
      source.start(onLevel).catch(failed);
    },
    release,
    cancel,
    dispose() {
      stopCap();
      deps.source?.cancel();
      step({ type: 'cancel' });
    },
  };
}
