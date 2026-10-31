/**
 * Dictation against a microphone that answers late (the permission prompt), and the recording cap: Esc, a quick key
 * release or an unmount before `getUserMedia` resolves must not leave the microphone on, and a recording stops by
 * itself at `MAX_DICTATION_MS`. Run: `cd apps/desktop && npx tsx --test src/renderer/screens/compose/runtime/dictation.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDictation, MAX_DICTATION_MS, type DictationDeps } from './dictation';
import { mediaRecorderSource, type DictationSource, type Recording } from './dictationSource';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

interface FakeTrack {
  stopped: number;
  stop(): void;
}

function fakeStream(count = 2): { stream: MediaStream; tracks: FakeTrack[] } {
  const tracks: FakeTrack[] = Array.from({ length: count }, () => {
    const track: FakeTrack = {
      stopped: 0,
      stop() {
        track.stopped++;
      },
    };
    return track;
  });
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, tracks };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  mimeType = 'audio/webm';
  started = 0;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void | Promise<void>) | null = null;
  constructor(readonly stream: MediaStream) {
    FakeRecorder.instances.push(this);
  }
  start() {
    this.started++;
  }
  stop() {
    this.ondataavailable?.({ data: new Blob(['voice']) });
    void this.onstop?.();
  }
}

function lateMicrophone() {
  FakeRecorder.instances = [];
  const answer = deferred<MediaStream>();
  const meters = { started: 0, stopped: 0 };
  const source = mediaRecorderSource({
    getUserMedia: () => answer.promise,
    MediaRecorder: FakeRecorder as unknown as typeof MediaRecorder,
    watchLevel: () => {
      meters.started++;
      return () => {
        meters.stopped++;
      };
    },
  });
  return { source, answer, meters };
}

test('cancel before the microphone answers stops every track and starts nothing', async () => {
  const { source, answer, meters } = lateMicrophone();
  const starting = source.start(() => {});
  source.cancel();
  const { stream, tracks } = fakeStream();
  answer.resolve(stream);
  await starting.catch(() => {});
  await settle();
  assert.deepEqual(
    tracks.map(track => track.stopped),
    [1, 1],
  );
  assert.equal(FakeRecorder.instances.length, 0);
  assert.equal(meters.started, 0);
});

test('stop before the microphone answers resolves null and stops every track', async () => {
  const { source, answer, meters } = lateMicrophone();
  const starting = source.start(() => {});
  const stopped = source.stop();
  assert.equal(await stopped, null);
  const { stream, tracks } = fakeStream();
  answer.resolve(stream);
  await starting.catch(() => {});
  await settle();
  assert.deepEqual(
    tracks.map(track => track.stopped),
    [1, 1],
  );
  assert.equal(FakeRecorder.instances.length, 0);
  assert.equal(meters.started, 0);
});

test('a start after a cancel records again, and the old late stream is still stopped', async () => {
  FakeRecorder.instances = [];
  const answers = [deferred<MediaStream>(), deferred<MediaStream>()];
  let asked = 0;
  const source = mediaRecorderSource({
    getUserMedia: () => answers[asked++]!.promise,
    MediaRecorder: FakeRecorder as unknown as typeof MediaRecorder,
    watchLevel: () => () => {},
  });
  const first = source.start(() => {});
  source.cancel();
  const second = source.start(() => {});
  const late = fakeStream();
  const fresh = fakeStream();
  answers[0]!.resolve(late.stream);
  answers[1]!.resolve(fresh.stream);
  await Promise.allSettled([first, second]);
  assert.deepEqual(
    late.tracks.map(track => track.stopped),
    [1, 1],
  );
  assert.deepEqual(
    fresh.tracks.map(track => track.stopped),
    [0, 0],
  );
  assert.equal(FakeRecorder.instances.length, 1);
  assert.equal(FakeRecorder.instances[0]!.started, 1);
});

test('a recording that finishes is returned and releases the microphone', async () => {
  const { source, answer, meters } = lateMicrophone();
  const starting = source.start(() => {});
  const { stream, tracks } = fakeStream();
  answer.resolve(stream);
  await starting;
  const recording = await source.stop();
  assert.equal(recording?.mime, 'audio/webm');
  assert.equal(recording?.bytes.length, 5);
  assert.deepEqual(
    tracks.map(track => track.stopped),
    [1, 1],
  );
  assert.equal(meters.stopped, 1);
});

test('a recording that cannot be read still settles stop() (null) and dictation leaves "transcribing"', async () => {
  const { source, answer } = lateMicrophone();
  const { stream, tracks } = fakeStream();
  const original = Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer = () => Promise.reject(new Error('unreadable'));
  try {
    const dictation = createDictation({
      source,
      transcribe: async () => 'never',
      onText: () => assert.fail('nothing was heard'),
      now: () => 0,
      setTimeout: () => () => undefined,
    });
    dictation.start('Space');
    answer.resolve(stream);
    await settle();
    assert.equal(FakeRecorder.instances.length, 1, 'recording');
    const released = dictation.release(true);
    const settled = await Promise.race([
      released.then(() => 'settled'),
      new Promise(resolve => setTimeout(() => resolve('stuck'), 200)),
    ]);
    assert.equal(settled, 'settled', 'stop() settled');
    assert.equal(dictation.getPhase().kind, 'idle');
    assert.deepEqual(
      tracks.map(track => track.stopped),
      [1, 1],
      'the microphone is released',
    );
  } finally {
    Blob.prototype.arrayBuffer = original;
  }
});

interface Pending {
  readonly source: DictationSource & { calls: string[] };
  readonly startAnswer: ReturnType<typeof deferred<void>>;
}

function pendingSource(recording: Recording | null = null): Pending {
  const startAnswer = deferred<void>();
  const calls: string[] = [];
  const source = {
    calls,
    start: () => {
      calls.push('start');
      return startAnswer.promise;
    },
    stop: async () => {
      calls.push('stop');
      return recording;
    },
    cancel: () => {
      calls.push('cancel');
    },
  };
  return { source, startAnswer };
}

function fakeTimers() {
  let now = 0;
  const scheduled: { at: number; cb: () => void; cleared: boolean }[] = [];
  return {
    delays: () => scheduled.map(entry => entry.at),
    setTimeout(cb: () => void, ms: number) {
      const entry = { at: now + ms, cb, cleared: false };
      scheduled.push(entry);
      return () => {
        entry.cleared = true;
      };
    },
    advance(ms: number) {
      now += ms;
      for (const entry of scheduled) {
        if (!entry.cleared && entry.at <= now) {
          entry.cleared = true;
          entry.cb();
        }
      }
    },
  };
}

function controllerWith(source: DictationSource, extra: Partial<DictationDeps> = {}) {
  const heard: string[] = [];
  const transcribed: Recording[] = [];
  const controller = createDictation({
    source,
    transcribe: async recording => {
      transcribed.push(recording);
      return 'hello there';
    },
    onText: text => heard.push(text),
    now: () => 0,
    ...extra,
  });
  return { controller, heard, transcribed };
}

test('cancel while the microphone prompt is pending cancels the source and goes idle', async () => {
  const { source } = pendingSource();
  const { controller } = controllerWith(source);
  controller.start('R');
  assert.equal(controller.getPhase().kind, 'listening');
  controller.cancel();
  assert.equal(controller.getPhase().kind, 'idle');
  assert.ok(source.calls.includes('cancel'));
});

test('a non-keeping release while the prompt is pending cancels the source and goes idle', async () => {
  const { source } = pendingSource();
  const { controller } = controllerWith(source);
  controller.start('R');
  await controller.release(false);
  assert.equal(controller.getPhase().kind, 'idle');
  assert.ok(source.calls.includes('cancel'));
});

test('a keeping release while the prompt is pending ends idle with nothing transcribed', async () => {
  const { source } = pendingSource(null);
  const { controller, heard, transcribed } = controllerWith(source);
  controller.start('R');
  await controller.release(true);
  assert.equal(controller.getPhase().kind, 'idle');
  assert.deepEqual(source.calls, ['start', 'stop']);
  assert.equal(transcribed.length, 0);
  assert.deepEqual(heard, []);
});

test('a refused microphone leaves the controller idle', async () => {
  const { source, startAnswer } = pendingSource();
  const refusing: DictationSource = {
    ...source,
    start: () => startAnswer.promise.then(() => Promise.reject(new Error('refused'))),
  };
  const { controller } = controllerWith(refusing);
  controller.start('R');
  startAnswer.resolve();
  await settle();
  assert.equal(controller.getPhase().kind, 'idle');
});

test('dispose cancels the source in every phase', async () => {
  const idle = pendingSource();
  controllerWith(idle.source).controller.dispose();
  assert.deepEqual(idle.source.calls, ['cancel']);

  const transcribing = pendingSource({ bytes: new Uint8Array([1]), mime: 'audio/webm' });
  const { controller } = controllerWith(transcribing.source, {
    transcribe: () => new Promise<string>(() => {}),
  });
  controller.start('R');
  transcribing.startAnswer.resolve();
  await settle();
  void controller.release(true);
  await settle();
  assert.equal(controller.getPhase().kind, 'transcribing');
  controller.dispose();
  assert.ok(transcribing.source.calls.includes('cancel'));
});

test('a recording stops by itself at the cap and is kept', async () => {
  const timers = fakeTimers();
  const recording: Recording = { bytes: new Uint8Array([1, 2]), mime: 'audio/webm' };
  const { source, startAnswer } = pendingSource(recording);
  const { controller, heard, transcribed } = controllerWith(source, {
    setTimeout: timers.setTimeout,
  });
  controller.start('R');
  startAnswer.resolve();
  await settle();
  assert.deepEqual(timers.delays(), [MAX_DICTATION_MS]);
  assert.equal(MAX_DICTATION_MS, 120_000);
  timers.advance(MAX_DICTATION_MS);
  await settle();
  assert.equal(source.calls.filter(call => call === 'stop').length, 1);
  assert.deepEqual(transcribed, [recording]);
  assert.deepEqual(heard, ['hello there']);
  assert.equal(controller.getPhase().kind, 'idle');
});

test('releasing before the cap clears the timer', async () => {
  const timers = fakeTimers();
  const recording: Recording = { bytes: new Uint8Array([1]), mime: 'audio/webm' };
  const { source, startAnswer } = pendingSource(recording);
  const { controller } = controllerWith(source, { setTimeout: timers.setTimeout });
  controller.start('R');
  startAnswer.resolve();
  await settle();
  timers.advance(10_000);
  await controller.release(true);
  timers.advance(MAX_DICTATION_MS * 2);
  await settle();
  assert.equal(source.calls.filter(call => call === 'stop').length, 1);
});

test('cancel and dispose clear the timer', async () => {
  for (const end of ['cancel', 'dispose'] as const) {
    const timers = fakeTimers();
    const { source } = pendingSource();
    const { controller } = controllerWith(source, { setTimeout: timers.setTimeout });
    controller.start('R');
    controller[end]();
    timers.advance(MAX_DICTATION_MS * 2);
    await settle();
    assert.equal(source.calls.filter(call => call === 'stop').length, 0, end);
  }
});
