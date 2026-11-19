import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DRAFTS_CONFIG, SENT_CONFIG } from './listKinds';
import { ListEmpty } from './ListStates';

const calm = { settling: false };

test('an empty Drafts list keeps its one line and offers Write a message as a quiet text action', () => {
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
  assert.doesNotMatch(markup, /ui-empty-line__detail/, 'no hint line, as before');
  assert.match(markup, /data-quiet="true"[\s\S]*data-variant="text"[\s\S]*Write a message/);
  assert.equal(SENT_CONFIG.emptyAction, undefined, 'other places stay one plain sentence');
});
