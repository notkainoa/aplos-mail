/**
 * Where dictation audio comes from. The composer depends only on `DictationSource`, so the tests use a fake and the app
 * uses the browser's `MediaRecorder` where it exists (`canRecord`). Host-side capture (the Mac's own recorder) is not in
 * the stand-in; it would be one more source behind the same interface.
 */

/** A finished recording, ready for `Blob/put`. */
export interface Recording {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mime: string;
}

export interface DictationSource {
  /** Starts capturing; `onLevel` gets the input level (0 to 1) about once a frame. Rejects when the microphone is refused. */
  start(onLevel: (level: number) => void): Promise<void>;
  /** Stops and returns what was heard, or null when nothing was. */
  stop(): Promise<Recording | null>;
  /** Stops and throws the audio away. */
  cancel(): void;
}

/** A scripted source for tests: plays `levels` on start and hands back `recording` on stop. */
export interface FakeDictationSource extends DictationSource {
  readonly started: number;
  readonly cancelled: number;
}

export function fakeDictationSource(script: {
  readonly levels?: readonly number[];
  readonly recording?: Recording | null;
  readonly refuse?: boolean;
}): FakeDictationSource {
  let started = 0;
  let cancelled = 0;
  return {
    get started() {
      return started;
    },
    get cancelled() {
      return cancelled;
    },
    async start(onLevel) {
      if (script.refuse) throw new Error('microphone refused');
      started++;
      for (const level of script.levels ?? []) onLevel(level);
    },
    async stop() {
      return script.recording ?? null;
    },
    cancel() {
      cancelled++;
    },
  };
}

/** True where the browser can record audio (Electron's renderer and Chromium; not node, not the preview without a mic). */
export function canRecord(scope: typeof globalThis = globalThis): boolean {
  const media = (scope as { navigator?: Navigator }).navigator?.mediaDevices;
  return typeof media?.getUserMedia === 'function' && typeof scope.MediaRecorder === 'function';
}

function rms(samples: Uint8Array): number {
  let sum = 0;
  for (const sample of samples) {
    const centred = (sample - 128) / 128;
    sum += centred * centred;
  }
  return Math.sqrt(sum / Math.max(1, samples.length));
}

/** Watches the stream's level on each animation frame until the returned stop is called. */
function watchLevel(stream: MediaStream, onLevel: (level: number) => void): () => void {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  let frame = 0;
  const tick = () => {
    analyser.getByteTimeDomainData(samples);
    onLevel(Math.min(1, rms(samples) * 4));
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    void context.close();
  };
}

/** The browser source: `getUserMedia` plus `MediaRecorder`. Call only where `canRecord()` is true. */
export function mediaRecorderSource(): DictationSource {
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let stopLevel: (() => void) | null = null;
  const chunks: Blob[] = [];
  const release = () => {
    stopLevel?.();
    stopLevel = null;
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
  };
  return {
    async start(onLevel) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks.length = 0;
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = event => chunks.push(event.data);
      recorder.start();
      stopLevel = watchLevel(stream, onLevel);
    },
    stop() {
      const current = recorder;
      recorder = null;
      if (!current) return Promise.resolve(null);
      return new Promise(resolve => {
        current.onstop = async () => {
          release();
          const blob = new Blob(chunks, { type: current.mimeType });
          resolve(
            blob.size > 0
              ? { bytes: new Uint8Array(await blob.arrayBuffer()), mime: current.mimeType }
              : null,
          );
        };
        current.stop();
      });
    },
    cancel() {
      recorder?.stop();
      recorder = null;
      release();
    },
  };
}
