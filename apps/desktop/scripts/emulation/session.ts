import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createService } from '../../src/main/service';
import { createGoogle } from '../../src/main/google';
import { createMicrosoft } from '../../src/main/microsoft';
import { createGroq } from '../../src/main/groq';
import { startProviderEmulator } from './providers';
import type { MailProvider, ProviderKind } from '@aplos/engine/legacy/provider';

function disabledProvider(kind: ProviderKind): MailProvider {
  const reject = async (): Promise<never> => {
    throw new Error('Only local Google and Outlook emulators are available in this session.');
  };
  return {
    kind,
    available: false,
    unavailableReason: 'Only local Google and Outlook emulators are enabled.',
    capabilities: () => ({
      labels: false,
      importance: false,
      aliases: false,
      signatures: false,
      calendar: false,
      serverSearch: false,
    }),
    connect: reject,
    disconnect: reject,
    sync: reject,
    search: reject,
    updateThread: reject,
    findSent: reject,
    send: reject,
    attachment: reject,
    close() {},
  };
}

/** All tokens and mail are synthetic; the temporary encryption key dies with this session. */
export async function createEmulatedSession(liveAI = false) {
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-emulated-')),
    key = randomBytes(32);
  const emulator = await startProviderEmulator();
  const encrypt = (text: string) => {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
  };
  const decrypt = (bytes: Buffer) => {
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString();
  };
  return {
    dataDir,
    emulator,
    createService: () =>
      createService({
        dataDir,
        encrypt,
        decrypt,
        openExternal: emulator.authorize,
        fetch: emulator.fetch,
        autoSyncMs: 0,
        groq: createGroq(liveAI ? {} : { apiKey: '' }),
        // Every provider request uses the emulator, including OAuth and token refresh.
        providers: {
          google: env =>
            createGoogle({
              ...env,
              fetch: emulator.fetch,
              clientId: 'emulated-aplos',
              clientSecret: '',
              oauthTimeoutMs: 5000,
            }),
          microsoft: env =>
            createMicrosoft({
              ...env,
              fetch: emulator.fetch,
              clientId: 'emulated-aplos',
              oauthTimeoutMs: 5000,
            }),
          imap: disabledProvider('imap'),
          jmap: disabledProvider('jmap'),
        },
      }),
    async close() {
      await emulator.close();
      key.fill(0);
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
