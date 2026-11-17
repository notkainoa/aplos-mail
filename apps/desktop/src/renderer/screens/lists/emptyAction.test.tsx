import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DRAFTS_CONFIG, SENT_CONFIG } from './listKinds';
import { ListEmpty } from './ListStates';

const calm = { settling: false };

test('an empty Drafts list has the search no-match hierarchy: the sentence, a quiet hint, one text action', () => {
  const markup = renderToStaticMarkup(
    <ListEmpty
      text={DRAFTS_CONFIG.empty}
      icon={DRAFTS_CONFIG.emptyIcon}
      detail={DRAFTS_CONFIG.emptyDetail}
      action={DRAFTS_CONFIG.emptyAction}
      state={calm}
    />,
  );
  assert.match(markup, /ui-empty-line__text">No drafts</);
  assert.match(markup, /ui-empty-line__detail">Messages you start and leave are saved here</);
  assert.match(markup, /data-variant="text"[\s\S]*Write a message/);
  assert.equal(SENT_CONFIG.emptyAction, undefined, 'other places stay one plain sentence');
});
