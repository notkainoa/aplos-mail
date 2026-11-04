import type { CommitExtension } from '../store/port';
import type { LaneModule } from '../runtime/services';
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

export function createModule(): LaneModule {
  return { services: { mailFrames: createMailFrames() } };
}
