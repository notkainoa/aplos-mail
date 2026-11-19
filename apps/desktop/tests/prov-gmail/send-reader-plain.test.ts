/**
 * An inline reply written in the composer, sent through the real engine and the Gmail emulator, then opened by the
 * reader: the Sent copy's html part must read as a plain letter, so the dark theme draws it on the card and not on a white
 * sheet. The draft's html is the composer's own (`textToHtml`: one `<p>` per line); the reply carries the thread and the
 * message it answers, as the inline reply card's draft does.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { render } from '@aplos/mail-html';
import { fields, inWorld, T0, SEC } from '../../../../packages/engine/tests/outbox/helpers';
import { textToHtml } from '../../src/renderer/screens/compose/model/fields';
import { sendWorld } from './send-rig';

async function until(done: () => boolean) {
  for (let i = 0; i < 2000 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(done(), 'the engine got there');
}

/** The decoded text/html part of a sent message's bytes. */
function htmlPart(raw: Buffer): string {
  const text = raw.toString('latin1');
  const part =
    /Content-Type: text\/html[^\r]*\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n([\s\S]*?)(?:\r\n--|$)/i.exec(
      text,
    );
  assert.ok(part, 'the sent message has an html part');
  return Buffer.from(
    part[1]
      .replace(/=\r\n/g, '')
      .replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
    'latin1',
  ).toString('utf8');
}

test('an inline reply sent through the engine reads as a plain letter in the reader', async () => {
  const gmail = await sendWorld({
    user: { sub: 'e2e-owner', email: 'owner@mail.example', name: 'Owner' },
    clockStart: T0,
  });
  await inWorld(
    async w => {
      w.draft(
        'd1',
        fields({
          mode: 'reply',
          threadId: 'thread-1',
          replyToMessageId: 'msg-1',
          subject: 'Re: Lunch',
          html: textToHtml('Sounds good, see you at noon.\n\nThanks,\nOwner'),
        }),
      );
      const submitted = await w.send(w.first, 'd1');
      await w.clock.advance(10 * SEC);
      await until(() => w.get(submitted.id).state === 'sent');
      const [sent] = gmail.sentMessages();
      const html = htmlPart(sent.raw);
      const result = render({ html, cids: [], imagePolicy: 'block' });
      assert.equal(result.bodyKind, 'html');
      assert.match(/<html[^>]*>/.exec(result.document)?.[0] ?? '', /data-aplos-plain/);
    },
    { send: gmail.port },
  );
});
