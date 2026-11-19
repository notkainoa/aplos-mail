/**
 * Shared rig of the draft tests (`drafts.test.ts`, `drafts-lookup.test.ts`): a Gmail emulator behind the upload bridge,
 * MIME builders and the uncertain-create setup.
 */
import assert from 'node:assert/strict';
import { createFaultInjector } from '@aplos/emulators';
import { ProviderError, type DraftUpload } from '@aplos/engine/ports';
import { withDraftToken } from '../../src/host/providers/google/draft-token';
import { DraftBridge } from './draft-bridge';
import { rig, type Rig } from './harness';

let nextId = 0;
/** The next number for a unique Message-ID. */
export const nextNumber = (): number => ++nextId;
const CRLF = '\r\n';

export interface MimeSpec {
  id?: string;
  subject?: string;
  body?: string;
  extra?: string[];
  inReplyTo?: string;
  references?: string;
  to?: string;
  /** An `X-Aplos-Draft` token as the first header: a copy that keeps the token the adapter wrote (a phone edit). */
  token?: string;
}

/** The bytes the adapter uploads for `upload`: the engine's MIME with the `X-Aplos-Draft` token as the first header. */
export const uploadedBytes = (upload: { internetId: string; mime: Uint8Array }): Buffer =>
  Buffer.from(withDraftToken(upload));

export function mimeOf(from: string, spec: MimeSpec = {}): { mime: Buffer; internetId: string } {
  const internetId = spec.id ?? `<draft-${++nextId}@aplos.test>`;
  const head = [
    ...(spec.token ? [`X-Aplos-Draft: ${spec.token}`] : []),
    'Date: Fri, 30 Oct 2026 10:00:00 +0000',
    `From: ${from}`,
    `To: ${spec.to ?? 'friend@example.test'}`,
    `Subject: ${spec.subject ?? 'Draft subject'}`,
    `Message-ID: ${internetId}`,
    ...(spec.inReplyTo ? [`In-Reply-To: ${spec.inReplyTo}`] : []),
    ...(spec.references ? [`References: ${spec.references}`] : []),
    ...(spec.extra ?? []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
  ];
  const body = spec.body ?? 'First text.';
  return { mime: Buffer.from(head.join(CRLF) + CRLF + CRLF + body + CRLF), internetId };
}

export interface Setup {
  r: Rig;
  bridge: DraftBridge;
  upload(spec?: MimeSpec, over?: Partial<DraftUpload>): DraftUpload;
  /** Drafts the emulator holds, newest list order. */
  remoteDrafts(): { id: string; text: string; messageId: string }[];
}

export async function setup(options: Parameters<typeof rig>[0] = {}): Promise<Setup> {
  const bridge = new DraftBridge();
  const r = await rig({
    ...options,
    adapter: { ...options.adapter, fetch: bridge.fetch },
  });
  bridge.attach(r.emu);
  let revision = 0;
  return {
    r,
    bridge,
    upload(spec = {}, over = {}) {
      const { mime, internetId } = mimeOf(r.account.address, spec);
      revision++;
      return {
        draftId: 'local-1',
        revision,
        fingerprint: `fp-${revision}`,
        internetId,
        mime,
        ...over,
      };
    },
    remoteDrafts() {
      return r.emu.mailbox.listDrafts().map(d => ({
        id: d.id,
        messageId: d.message.id,
        text: r.emu.mailbox.rawOf(d.message.id).toString('utf8'),
      }));
    },
  };
}

export const saved = (result: Awaited<ReturnType<Rig['adapter']['saveDraft']>>) => {
  assert.equal(result.kind, 'saved', JSON.stringify(result));
  if (result.kind !== 'saved') throw new Error('unreachable');
  return result;
};

export const apiCalls = (s: Setup, since = 0) => s.r.governor.sentCalls().slice(since);

export async function uncertainCreate(
  s: Setup,
  faults: ReturnType<typeof createFaultInjector>,
  given?: DraftUpload,
) {
  const upload = given ?? s.upload({ body: 'Landed.' });
  faults.dropAfterNext({ apiMethod: 'gmail.users.drafts.create' });
  // The immediate re-check fails too, so the engine only knows the create was uncertain.
  faults.failNext(
    { apiMethod: 'gmail.users.drafts.list', after: 2 },
    { status: 503, reason: 'backendError', message: 'Backend Error' },
  );
  const error = await s.r.adapter.saveDraft(upload, s.r.ctx()).catch((e: unknown) => e);
  assert.ok(error instanceof ProviderError && error.error.uncertain === true);
  assert.equal(s.remoteDrafts().length, 1, 'the create landed');
  return upload;
}
