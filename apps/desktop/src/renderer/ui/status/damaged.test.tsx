// FatalScreen's damaged-database variant (plan 10 Decision 6): static render checks of copy, buttons and the one ask.
// Run: npx tsx --tsconfig apps/desktop/tsconfig.json --test apps/desktop/src/renderer/ui/status/damaged.test.tsx
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { copyProblem } from '../../commands/internal';
import { FatalScreen } from './FatalScreen';

const noop = () => {};
const render = (el: ReactElement) => renderToStaticMarkup(el);
const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
const textOf = (html: string) =>
  decode(html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
function assertClean(html: string) {
  assert.equal(copyProblem(textOf(html)), null, `banned copy in: ${textOf(html)}`);
  assert.doesNotMatch(html, /lucide-(sparkle|star|wand|brain|bot)|✨|⭐|🪄|🤖|🧠/i);
}

describe('FatalScreen damaged database', () => {
  const base = {
    localOnly: { drafts: 2, scheduled: 1, workflow: 0, changes: null },
    onExport: noop,
    onRestore: noop,
    onRebuild: noop,
    onCancel: noop,
  };
  it('says nothing was deleted, lists what is only on this Mac, then Export report · Restore · Rebuild', () => {
    const html = render(
      <FatalScreen
        kind="damaged"
        damaged={{ ...base, backup: { at: Date.UTC(2026, 10, 2, 12) } }}
        restarting={false}
        onRestart={noop}
        onDiagnostics={noop}
      />,
    );
    const text = textOf(html);
    assert.match(html, /data-kind="damaged"/);
    assert.match(text, /Aplos found a problem with its mail database\./);
    assert.match(text, /Nothing was deleted\. A copy of the damaged file is kept on this Mac\./);
    assert.match(text, /Only on this Mac/);
    assert.match(text, /2 drafts not yet saved to Google/);
    assert.match(text, /1 scheduled send(?!s)/);
    assert.doesNotMatch(text, /Done, Later/, 'a zero count is not listed');
    assert.match(text, /Some of it could not be read/);
    assert.match(
      html,
      /data-variant="filled"[^>]*><span class="ui-part-button__label">Export report</,
    );
    assert.match(text, /Restore backup from /);
    assert.match(text, /Rebuild from Google/);
    assert.doesNotMatch(text, /Try again|Restart engine/);
    assertClean(html);
  });
  it('without a backup there is no Restore; nothing local says so plainly', () => {
    const text = textOf(
      render(
        <FatalScreen
          kind="damaged"
          damaged={{ ...base, localOnly: { drafts: 0, scheduled: 0, workflow: 0, changes: 0 } }}
          restarting={false}
          onRestart={noop}
          onDiagnostics={noop}
        />,
      ),
    );
    assert.doesNotMatch(text, /Restore/);
    assert.match(text, /Nothing\. All of your mail is on Google\./);
  });
  it('Rebuild asks once and names what it cannot bring back', () => {
    const html = render(
      <FatalScreen
        kind="damaged"
        damaged={{ ...base, confirm: 'rebuild' }}
        restarting={false}
        onRestart={noop}
        onDiagnostics={noop}
      />,
    );
    const text = textOf(html);
    assert.match(text, /you sign in to Google again/);
    assert.match(text, /kept in the report, not brought back/);
    assert.match(
      html,
      /data-variant="filled"[^>]*><span class="ui-part-button__label">Rebuild from Google</,
    );
    assert.match(text, /Cancel/);
    assert.doesNotMatch(text, /Only on this Mac/);
  });
  it('while main reads the damaged file, only the title and the safe line show', () => {
    const text = textOf(
      render(
        <FatalScreen kind="damaged" restarting={false} onRestart={noop} onDiagnostics={noop} />,
      ),
    );
    assert.match(text, /Nothing was deleted/);
    assert.doesNotMatch(text, /Export report/);
  });
});
