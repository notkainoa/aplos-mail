import { useEffect, useRef, useState } from 'react';
import { invoke, uid } from './bridge';

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing';
export function useVoice(
  deviceId: string,
  onText: (text: string) => void | Promise<void>,
  onError: (message: string) => void,
) {
  const [phase, setPhase] = useState<Phase>('idle');
  const status = useRef<Phase>('idle');
  const mounted = useRef(true);
  const generation = useRef(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requestId = useRef<string | undefined>(undefined);
  const callbacks = useRef({ onText, onError });
  callbacks.current = { onText, onError };
  const analyser = useRef<AnalyserNode | null>(null);
  const audio = useRef<AudioContext | null>(null);
  function update(next: Phase) {
    status.current = next;
    if (mounted.current) setPhase(next);
  }
  function release() {
    clearTimeout(timer.current);
    timer.current = undefined;
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    recorder.current = null;
    void audio.current?.close().catch(() => {});
    audio.current = null;
    analyser.current = null;
  }
  function level() {
    const node = analyser.current;
    if (!node) return 0;
    const data = new Uint8Array(node.fftSize);
    node.getByteTimeDomainData(data);
    let sum = 0;
    for (const value of data) {
      const x = (value - 128) / 128;
      sum += x * x;
    }
    return Math.min(1, Math.sqrt(sum / data.length) * 5);
  }
  function cancel() {
    generation.current++;
    if (requestId.current)
      void invoke('ai.cancel', { requestId: requestId.current }).catch(() => {});
    requestId.current = undefined;
    const active = recorder.current;
    release();
    if (active?.state === 'recording') active.stop();
    update('idle');
  }
  function stop() {
    if (status.current === 'starting') {
      cancel();
      return;
    }
    if (recorder.current?.state === 'recording') {
      update('transcribing');
      recorder.current.stop();
    }
  }
  async function start() {
    if (status.current !== 'idle') return;
    const session = ++generation.current;
    update('starting');
    const active = () => mounted.current && generation.current === session;
    let localStream: MediaStream | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined')
        throw new Error('Audio recording is unavailable in this window.');
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      // Permission prompts may finish after a key release, cancellation or window close.
      if (!active()) {
        localStream.getTracks().forEach(track => track.stop());
        return;
      }
      stream.current = localStream;
      try {
        const context = new AudioContext();
        const node = context.createAnalyser();
        node.fftSize = 256;
        context.createMediaStreamSource(localStream).connect(node);
        audio.current = context;
        analyser.current = node;
      } catch {
        /* the level meter is optional */
      }
      const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type =>
        MediaRecorder.isTypeSupported(type),
      );
      const recording = new MediaRecorder(
        localStream,
        preferred ? { mimeType: preferred } : undefined,
      );
      recorder.current = recording;
      const parts: BlobPart[] = [];
      let size = 0;
      recording.ondataavailable = event => {
        if (event.data.size) {
          parts.push(event.data);
          size += event.data.size;
          if (size > 25 * 1024 * 1024 && active()) stop();
        }
      };
      recording.onstop = async () => {
        localStream?.getTracks().forEach(track => track.stop());
        if (!active()) return;
        release();
        const blob = new Blob(parts, { type: recording.mimeType });
        if (blob.size < 100 || blob.size > 25 * 1024 * 1024) {
          update('idle');
          callbacks.current.onError(
            blob.size < 100
              ? 'No audio recorded. Try speaking a little longer.'
              : 'Audio must be smaller than 25 MB.',
          );
          return;
        }
        update('transcribing');
        const id = uid();
        requestId.current = id;
        try {
          const audio = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.onerror = () => reject(new Error('Recorded audio could not be read.'));
            reader.readAsDataURL(blob);
          });
          if (!active()) return;
          const result = await invoke<{ text: string }>('ai.transcribe', {
            audio,
            mimeType: recording.mimeType,
            requestId: id,
          });
          if (active()) await callbacks.current.onText(result.text);
        } catch (error) {
          if (active())
            callbacks.current.onError(
              error instanceof Error ? error.message : 'Transcription failed.',
            );
        } finally {
          if (active()) {
            requestId.current = undefined;
            update('idle');
          }
        }
      };
      recording.onerror = () => {
        if (active()) {
          cancel();
          callbacks.current.onError('Recording failed. Check your microphone.');
        }
      };
      recording.start(250);
      update('recording');
      timer.current = setTimeout(stop, 120000);
    } catch (error) {
      localStream?.getTracks().forEach(track => track.stop());
      if (active()) {
        release();
        update('idle');
        const name = (error as { name?: string })?.name;
        callbacks.current.onError(
          name === 'NotAllowedError' || name === 'SecurityError'
            ? 'Microphone access is off. Allow Aplos Mail in System Settings › Privacy & Security › Microphone, then try again.'
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? 'No microphone found. Connect one or choose another in Settings.'
              : name === 'NotReadableError'
                ? 'The microphone is busy in another app.'
                : error instanceof Error
                  ? error.message
                  : 'Microphone access is required.',
        );
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel();
    };
  }, []);
  return {
    recording: phase === 'recording',
    busy: phase === 'starting' || phase === 'transcribing',
    preparing: phase === 'starting',
    start,
    stop,
    cancel,
    isActive: () => status.current !== 'idle',
    level,
    toggle: () => (status.current === 'recording' ? stop() : start()),
  };
}
