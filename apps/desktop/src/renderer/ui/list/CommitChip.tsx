// CommitChip (DESIGN §4.9, §6). Mockups: home.html, reader.html (commit). Solid hill / dusk / stamp, 26 px,
// --radius-sm, white icon plus the word. Static here; ui-shell's motion runtime draws `commit` on the ghost.

import type { Ref } from 'react';
import type { CommitChipProps, CommitKind, IconName } from '../props';
import { Icon } from './internal/Icon';

const WORD: Record<CommitKind, string> = { done: 'Done', later: 'Later', trash: 'Trash' };
const GLYPH: Record<CommitKind, IconName> = { done: 'check', later: 'clock', trash: 'trash' };

/** The commit chip drawn on a leaving letter's ghost: icon plus word, never a colour flood. */
export function CommitChip({ kind, ref }: CommitChipProps) {
  return (
    <span
      ref={ref as Ref<HTMLSpanElement>}
      className="ui-commit-chip"
      data-kind={kind}
      aria-hidden="true"
    >
      <Icon name={GLYPH[kind]} size="sm" />
      <span className="ui-commit-chip__word">{WORD[kind]}</span>
    </span>
  );
}
