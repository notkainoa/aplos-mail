import { createHash } from 'node:crypto';
import type { Logger, WorkflowCopy } from '@aplos/engine/ports';
import { isDeviceId } from './workflow-merge';

/**
 * The workflow copy as a Gmail message (`workflow.ts`): a marker header, a device hint and the sealed blob armoured in a
 * plain-text body. Only messages with the marker count as copies; anything else under the label is user mail.
 */

export const APP_LABEL = 'Aplos Mail Data';
export const MARKER_HEADER = 'X-Aplos-Workflow';
export const MARKER_VALUE = '2';
const DEVICE_HEADER = 'X-Aplos-Device';
const BEGIN = '-----BEGIN APLOS WORKFLOW-----';
const END = '-----END APLOS WORKFLOW-----';

/** The copy's Message-ID, derived from its sealed bytes (random IV inside), so a re-sent `put` finds its own copy. */
export function copyMessageId(data: string): string {
  return `<wf-${createHash('sha256').update(data).digest('hex').slice(0, 40)}@aplos-mail.invalid>`;
}

const wrap = (text: string) => text.match(/.{1,76}/g)?.join('\r\n') ?? '';

function checkCopy(copy: WorkflowCopy): void {
  // Everything that reaches a header or the armour is checked, so no value can end the block or add a header.
  if (!isDeviceId(copy.deviceId)) throw new Error('Invalid device id for a workflow copy');
  if (!/^[\w.-]+$/.test(copy.data)) throw new Error('A workflow copy must be sealed');
  if (!Number.isSafeInteger(copy.writtenAt) || copy.writtenAt < 0)
    throw new Error('Invalid write time for a workflow copy');
}

/** RFC 5322 dot-atom text at a plain domain: no space, CR, LF or bracket can reach the From and To headers. */
const ADDRESS_RE = /^[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+$/;

function checkAddress(address: string): void {
  if (!ADDRESS_RE.test(address)) throw new Error('Invalid account address for a workflow copy');
}

/**
 * The cleartext device hint: a hash of the device id, so a device id that happens to be a host or user name never
 * reaches the mailbox in the clear. Nothing reads it back as an id; the sealed payload carries the real one.
 */
export function deviceHint(deviceId: string): string {
  return `d-${createHash('sha256').update(`aplos-wf-device:${deviceId}`).digest('hex').slice(0, 24)}`;
}

/** The RFC 822 copy: only the label, so it never shows as new mail. */
export function buildCopyMessage(copy: WorkflowCopy, address: string): string {
  checkCopy(copy);
  checkAddress(address);
  const lines = [
    `From: Aplos Mail <${address}>`,
    `To: ${address}`,
    'Subject: Aplos sync data - do not edit',
    `Date: ${new Date(copy.writtenAt).toUTCString()}`,
    `Message-ID: ${copyMessageId(copy.data)}`,
    'MIME-Version: 1.0',
    `${MARKER_HEADER}: ${MARKER_VALUE}`,
    `${DEVICE_HEADER}: ${deviceHint(copy.deviceId)}`,
    'Content-Type: text/plain; charset=us-ascii',
    'Content-Transfer-Encoding: 7bit',
    '',
    'Aplos Mail keeps encrypted Done, Later and reminder data for this account here. Please leave it in place.',
    '',
    BEGIN,
    wrap(copy.data),
    END,
    '',
  ];
  return lines.join('\r\n');
}

function headerMap(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) out.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return out;
}

/** The sealed blob and device hint of an Aplos copy, or undefined for anything else (user mail, a foreign format). */
export function parseCopyMessage(raw: string): { data: string; device: string } | undefined {
  const split = /\r?\n\r?\n/.exec(raw);
  if (!split) return undefined;
  const headers = headerMap(raw.slice(0, split.index));
  if (headers.get(MARKER_HEADER.toLowerCase()) !== MARKER_VALUE) return undefined;
  const body = raw.slice(split.index + split[0].length);
  const start = body.indexOf(BEGIN);
  const end = body.indexOf(END, start + BEGIN.length);
  if (start === -1 || end === -1) return undefined;
  const data = body.slice(start + BEGIN.length, end).replace(/\s+/g, '');
  if (!data) return undefined;
  return { data, device: headers.get(DEVICE_HEADER.toLowerCase()) ?? '' };
}

/** A copy that is not usable, logged as a refused read with a reason code: no id, no content, no key material. */
export function logSkipped(log: Logger, reason: string): void {
  log.event('sync.gmail.request_refused', {
    error: {
      class: 'permanent',
      provider: 'gmail',
      method: 'gmail.messages.get',
      reason: `workflowCopy.${reason}`,
    },
  });
}

/** Inserts into a bounded map, dropping the oldest entry past `cap` (insertion order). */
export function remember<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > cap) map.delete(map.keys().next().value as K);
}
