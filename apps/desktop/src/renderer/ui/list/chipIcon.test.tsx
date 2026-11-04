// The attachment chip's kind icon (additive `icon` prop): the chip wears the icon it is given, `file-text` when none
// is, and `alert` once a download failed whatever the kind. The three file icons are drawn by every icon map.
// Run: cd apps/desktop && npx tsx --test src/renderer/ui/list/chipIcon.test.tsx

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LUCIDE_ICONS } from '../buttons-keys/Icon';
import { Chip } from './index';
import { noop, render } from './fixtures.test';

const iconOf = (markup: string) => /data-icon="([^"]+)"/.exec(markup)?.[1];

describe('attachment chip icon', () => {
  test('wears its kind, defaults to file-text, and failed is always alert', () => {
    const chip = (icon?: 'file-image' | 'file-archive' | 'file-sheet' | 'calendar') =>
      render(
        <Chip
          kind="attachment"
          name="a"
          sizeBytes={1}
          state="ready"
          onOpen={noop}
          {...(icon ? { icon } : {})}
        />,
      );
    assert.equal(iconOf(chip()), 'file-text');
    assert.equal(iconOf(chip('file-image')), 'file-image');
    assert.equal(iconOf(chip('file-archive')), 'file-archive');
    assert.equal(iconOf(chip('file-sheet')), 'file-sheet');
    assert.equal(iconOf(chip('calendar')), 'calendar');
    const failed = render(
      <Chip
        kind="attachment"
        name="a.zip"
        sizeBytes={1}
        state="failed"
        icon="file-archive"
        onOpen={noop}
      />,
    );
    assert.equal(iconOf(failed), 'alert');
  });

  test('the shared icon map draws the three file kinds', () => {
    for (const name of ['file-image', 'file-archive', 'file-sheet'] as const)
      assert.ok(LUCIDE_ICONS[name], name);
  });
});
