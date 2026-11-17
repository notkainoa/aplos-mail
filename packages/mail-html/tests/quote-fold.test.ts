import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeBody } from '../src/index';

// Quoted history is folded behind "Quoted text" only when it follows words of the sender's own. A forward, or a message
// that is nothing but quote, is the whole content and stays open (hands-on test 2026-11-16: a forward was one closed fold).

function html(markup: string) {
  const walk = sanitizeBody(markup);
  return { quotedCount: walk.quotedCount, body: walk.body };
}
const bodyOf = (result: { body: string }) => result.body;

describe('folding quoted history', () => {
  it('folds only history that follows words of the sender, never a forward or a body that is all quote', () => {
    const forward = html(
      '<div dir="ltr"><br><br><div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br>From: A</div><div>Body text</div></div></div>',
    );
    assert.equal(forward.quotedCount, 0, 'a forward is the content');
    assert.doesNotMatch(bodyOf(forward), /<details/);
    assert.match(bodyOf(forward), /Body text/);
    const note = html(
      '<div>FYI</div><div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------</div><div>Body text</div></div>',
    );
    assert.equal(note.quotedCount, 0, 'a forwarded message stays open under a note too');
    const allQuote = html('<blockquote type="cite">only the old text</blockquote>');
    assert.equal(allQuote.quotedCount, 0, 'nothing of the sender before it: nothing to fold');
    const afterBlanks = html('<p> </p><br><blockquote type="cite">only the old text</blockquote>');
    assert.equal(afterBlanks.quotedCount, 0, 'blank lines are not words');
    const reply = html('<p>Thanks</p><blockquote type="cite">old text</blockquote>');
    assert.equal(reply.quotedCount, 1, 'a reply still folds its history');
  });

  it('counts only visible words outside a quote as the sender’s own', () => {
    const hidden = html(
      '<span style="display:none">preheader words</span><blockquote type="cite">old text</blockquote>',
    );
    assert.equal(hidden.quotedCount, 0, 'hidden text is not words of the sender');
    const quotedFirst = html(
      '<blockquote type="cite">first old text</blockquote><blockquote type="cite">second old text</blockquote>',
    );
    assert.equal(quotedFirst.quotedCount, 0, 'text inside a quote does not count as own');
    const inCell = html(
      '<blockquote type="cite"><table><tr><td>old text in a cell</td></tr></table></blockquote><blockquote type="cite">more old text</blockquote>',
    );
    assert.equal(inCell.quotedCount, 0, 'a table cell inside a quote is still quoted');
    const ownCell = html(
      '<table><tr><td>my words</td></tr></table><blockquote type="cite">old text</blockquote>',
    );
    assert.equal(ownCell.quotedCount, 1, 'my words in a cell before the quote count');
  });
});
