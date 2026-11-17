// Home cleared (owner review of #548, 2026-11-17): one small muted line where the "Do now" label sits, then the Low band.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HomeSection, HomeSectionView, HomeView } from '../../data';
import { HomeList } from './HomeList';
import { layoutOf } from './homeModel';

const section = (key: HomeSection, count: number): HomeSectionView => ({
  key,
  ids: [],
  count,
  start: 0,
  visible: count > 0,
  fromLater: null,
  waiting: 0,
});

const cleared: HomeView = {
  sections: [section('do', 4), section('update', 0), section('follow', 0)],
  low: { count: 3, names: ['Weekly Digest'], moreSenders: 0 },
  rows: new Map(),
  failures: new Map(),
  total: 4,
  state: null,
  status: 'live',
  error: null,
  move: () => undefined,
};

function draw(home: HomeView): string {
  const none = () => undefined;
  return renderToStaticMarkup(
    createElement(HomeList, {
      view: home,
      layout: layoutOf(home),
      cursorKey: null,
      density: 'comfortable',
      accounts: [],
      demoted: false,
      picked: new Set<string>(),
      handlers: {
        select: none,
        open: none,
        rowAction: none,
        suggested: none,
        later: none,
        done: none,
        more: none,
        openLow: none,
        oneByOne: none,
        clearFromHome: none,
      },
    }),
  );
}

test('a cleared Home is one muted line in the Do now label’s place, then the Low band, nothing else', () => {
  const html = draw(cleared);
  assert.match(
    html,
    /<p id="home-do" class="ui-section-header aplos-home-cleared__line">Nothing to do right now<\/p>/,
  );
  assert.doesNotMatch(html, />Do now</, 'the line takes the label’s place');
  assert.doesNotMatch(html, /Nothing needs you|Mail that needs you/, 'no headline, no sub-line');
  assert.ok(
    html.indexOf('aplos-home-cleared') < html.indexOf('ui-low-band'),
    'the band stays below it',
  );
  const css = readFileSync(new URL('../../ui/list/list.css', import.meta.url), 'utf8');
  const line = css.match(/\.aplos-home-cleared__line \{[^}]*\}/)?.[0] ?? '';
  assert.match(line, /color: var\(--dim\)/);
  assert.match(line, /font: var\(--type-small\)/);
  assert.doesNotMatch(
    css,
    /--type-summary\);\s*letter-spacing: var\(--track-summary\);\s*\}\s*\.aplos-home-cleared/,
  );
});
