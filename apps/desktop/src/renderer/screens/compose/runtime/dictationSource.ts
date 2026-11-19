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

/** The browser pieces `mediaRecorderSource` uses; tests pass fakes, the app takes the globals. */
export interface MediaRecorderDeps {
  readonly getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  readonly MediaRecorder?: typeof MediaRecorder;
  readonly watchLevel?: (stream: MediaStream, onLevel: (level: number) => void) => () => void;
}

function stopTracks(stream: MediaStream): void {
  stream.getTracks().forEach(track => track.stop());
}

/**
 * The browser source: `getUserMedia` plus `MediaRecorder`. Call only where `canRecord()` is true. A `cancel()` or
 * `stop()` while the permission prompt is still open bumps `generation`; when the stream finally arrives for an older
 * generation every track is stopped at once and nothing records, so the microphone never stays on.
 */
export function mediaRecorderSource(deps: MediaRecorderDeps = {}): DictationSource {
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let stopLevel: (() => void) | null = null;
  let generation = 0;
  let chunks: Blob[] = [];
  const getUserMedia =
    deps.getUserMedia ?? (constraints => navigator.mediaDevices.getUserMedia(constraints));
  const watch = deps.watchLevel ?? watchLevel;
  const release = () => {
    stopLevel?.();
    stopLevel = null;
    if (stream) stopTracks(stream);
    stream = null;
  };
  const begin = (opened: MediaStream, onLevel: (level: number) => void) => {
    const Recorder = deps.MediaRecorder ?? MediaRecorder;
    stream = opened;
    chunks = [];
    const created = new Recorder(opened);
    created.ondataavailable = event => chunks.push(event.data);
    recorder = created;
    created.start();
    stopLevel = watch(opened, onLevel);
  };
  const finish = async (current: MediaRecorder): Promise<Recording | null> => {
    const blob = new Blob(chunks, { type: current.mimeType });
    chunks = [];
    if (blob.size === 0) return null;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: current.mimeType };
  };
  /** What a stop hands back: the recording, or null when nothing was heard or reading it failed. Always settles. */
  const settleStop = async (current: MediaRecorder, stopped: number): Promise<Recording | null> => {
    try {
      return stopped === generation ? await finish(current) : null;
    } catch {
      return null;
    } finally {
      chunks = [];
    }
  };
  return {
    async start(onLevel) {
      const mine = ++generation;
      const opened = await getUserMedia({ audio: true });
      if (mine !== generation) {
        stopTracks(opened);
        return;
      }
      try {
        begin(opened, onLevel);
      } catch (error) {
        recorder = null;
        release();
        stopTracks(opened);
        throw error;
      }
    },
    stop() {
      const stopped = ++generation;
      const current = recorder;
      recorder = null;
      if (!current) return Promise.resolve(null);
      return new Promise(resolve => {
        current.onstop = () => {
          release();
          void settleStop(current, stopped).then(resolve);
        };
        current.stop();
      });
    },
    cancel() {
      generation++;
      if (recorder) recorder.ondataavailable = null;
      recorder?.stop();
      recorder = null;
      chunks = [];
      release();
    },
  };
}
