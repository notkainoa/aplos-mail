import type { CommitExtension } from '../store/port';
import type { EngineServices, LaneModule } from '../runtime/services';
import { allowListExtension } from './allow-list';
import { createMailFrames, type MailFrames } from './state';

declare module '../runtime/services' {
  interface EngineServices {
    /** `Mail/*` frame tokens and the render cache (html-4). */
    mailFrames: MailFrames;
  }
}

/** Seam 1: lane `eng-html`'s module, imported by the composition root (`src/index.ts`). */
export const lane = 'eng-html';

/** The image allow-list writer (seam 2): `Mail/allowImages` edits `Settings.mail.imageAllowList`. */
export const extensions: readonly CommitExtension[] = [allowListExtension];

export function createModule(services: EngineServices): LaneModule {
  const mailFrames = createMailFrames();
  return {
    services: { mailFrames },
    start() {
      // The engine is the only fetcher: every `fetching` row at start is stale — a crash or a quit
      // mid-download — and would otherwise say "Downloading..." forever with Open and Retry refused.
      // The half-written file under `.tmp` is already gone (the host clears it at open).
      const stale = services.store.read(q =>
        q.all<{ remote_part: string; account_id: string; remote_id: string }>(
          `SELECT a.remote_part, m.account_id, m.remote_id FROM attachments a
             JOIN messages m ON m.id = a.message_id WHERE a.state = 'fetching'`,
        ),
      );
      if (!stale.length) return;
      services.store.commit({
        opId: `attachment-start-${[...services.randomBytes(4)].map(b => b.toString(16).padStart(2, '0')).join('')}`,
        origin: 'local',
        writes: stale.map(row => ({
          kind: 'attachmentState' as const,
          accountId: row.account_id,
          remoteId: row.remote_id,
          remotePart: row.remote_part,
          state: 'absent' as const,
        })),
      });
    },
    async stop() {
      // Abort every in-flight fetch, then wait for their `absent` reverts to land while the store is
      // still open — a fetch killed after the store closes leaves its row stuck `fetching`.
      mailFrames.aborter.abort();
      await Promise.allSettled([...mailFrames.parts.values(), ...mailFrames.originals.values()]);
    },
    // A closed window's tokens (and any document not yet served) go with it.
    onConnectionClose: connectionId => mailFrames.tokens.releaseWindow(connectionId),
  };
}
