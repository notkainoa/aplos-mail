import type { CorpusEntry } from './index';
import { substitute } from './index';
import { encodingEntries } from './generated-encoding';
import { nestingEntries } from './generated-nesting';
import { sizeEntries } from './generated-sizes';
import { finishEntry, type GeneratedContext } from './generated-support';
import { textEntries } from './generated-text';
import { truncatedEntries } from './generated-truncated';

// Synthetic entries, built in memory so no multi-megabyte file is committed. They keep the manifest entry shape, with
// the html inline. The builders are deterministic, so every run sees the same bytes.

export function generatedEntries(ctx: GeneratedContext): CorpusEntry[] {
  const drafts = [
    ...nestingEntries(),
    ...sizeEntries(),
    ...encodingEntries(),
    ...textEntries(),
    ...truncatedEntries(39),
  ];
  return drafts.map(draft => finishEntry(draft, ctx, substitute));
}
