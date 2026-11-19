import { AiCallError, type AiTranscribeRequest } from '@aplos/engine';
import { callProvider, cancelled, type AiDeps } from './request';
import type { AiKeys } from './keys';
import type { ProviderRow } from './providers';

/**
 * Speech to text through an OpenAI-style `audio/transcriptions` multipart POST (Groq and OpenAI — the rows
 * marked `stt`). The file extension is inferred from the MIME type since some servers route on it.
 */

const FORMATS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'video/webm': 'webm',
};

export async function transcribeAudio(
  deps: AiDeps,
  keys: AiKeys,
  row: ProviderRow,
  req: AiTranscribeRequest,
): Promise<{ text: string }> {
  if (!row.stt) throw new AiCallError('unavailable', `${row.label} does not do speech to text.`);
  const type = req.mimeType.split(';')[0].trim();
  const format = FORMATS[type];
  if (!format)
    throw new AiCallError('invalid', 'Unsupported audio format. Use WebM, MP4, MP3, WAV or Ogg.');
  if (!req.audio.length || req.audio.length > 25 * 1024 * 1024)
    throw new AiCallError('invalid', 'Audio must contain between 1 byte and 25 MB.');
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(req.audio)], { type }), `dictation.${format}`);
  form.append('model', req.model.model);
  form.append('response_format', 'json');
  if (req.language) form.append('language', req.language);
  const response = await callProvider(deps, keys, row, 'audio/transcriptions', {
    body: form,
    json: false,
    signal: req.signal,
  });
  const result = (await response.json().catch(() => {
    if (req.signal?.aborted) throw cancelled();
    throw new AiCallError('unreachable', `${row.label} could not complete the request.`);
  })) as { text?: unknown };
  if (typeof result?.text !== 'string')
    throw new AiCallError('invalid', `${row.label} returned an invalid transcription.`);
  return { text: result.text };
}
