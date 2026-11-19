import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroq, threadLinks } from '../src/main/groq';
import { createDemo } from '../src/main/demo';
import type { Thread } from '@aplos/contract/legacy/types';

const thread: Thread = {
  id: 'parcel',
  accountId: 'personal',
  subject: 'Your parcel and invoice',
  summary: '',
  date: '2026-10-14T10:00:00Z',
  unread: true,
  status: 'new',
  importance: 'important',
  bookmarked: false,
  replyStatus: 'none',
  messages: [
    {
      id: 'm1',
      from: 'updates@parcel.example',
      fromName: 'Parcel Trail',
      to: ['me@example.test'],
      date: '2026-10-14T10:00:00Z',
      text: 'Your parcel arrives Friday at 2 pm. Track it at https://parcel.example/track/DEMO-1. Unsubscribe: https://parcel.example/unsubscribe?u=1',
      html: '<p>Track it <a href="https://parcel.example/track/DEMO-1">here</a>. <a href="https://click.mailer.example/ls/click?x=1">Shop</a></p>',
      attachments: [{ id: 'att-1', name: 'invoice.pdf', type: 'application/pdf', size: 10 }],
    },
  ],
};

function fake(actions: unknown[]) {
  const sent: Record<string, unknown>[] = [];
  const groq = createGroq({
    apiKey: 'synthetic-test-key',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      sent.push({ system: body.messages[0].content, ...JSON.parse(body.messages[1].content) });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: 'Parcel arrives Friday',
                  importance: 'important',
                  replyStatus: 'none',
                  todo: '',
                  dueDate: '',
                  action: actions.shift(),
                }),
              },
            },
          ],
        }),
      );
    },
  });
  return { groq, sent };
}

test('summaries suggest one preset action that must point at something in the thread', async () => {
  // Only real, non-tracking links from the thread are offered to the model.
  assert.deepEqual(threadLinks(thread), ['https://parcel.example/track/DEMO-1']);
  const { groq, sent } = fake([
    { kind: 'link', label: 'Track parcel', url: 'https://parcel.example/track/DEMO-1' },
    { kind: 'link', label: 'Track parcel', url: 'https://evil.example/track/DEMO-1' },
    { kind: 'link', label: 'Unsubscribe', url: 'https://parcel.example/unsubscribe?u=1' },
    { kind: 'attachment', label: 'View invoice', attachmentId: 'att-1' },
    { kind: 'attachment', label: 'View invoice', attachmentId: 'att-404' },
    { kind: 'reply', label: 'Reply', prompt: 'Say Friday works for the delivery' },
    { kind: 'reply', label: 'Reply' },
    { kind: 'calendar', label: 'Add to calendar' },
    { kind: 'read', label: 'Mark as done' },
    { kind: 'read', label: 'Open this very long label now' },
    { kind: 'script', label: 'Run', code: 'alert(1)' },
    null,
  ]);
  const results = [];
  for (let i = 0; i < 12; i++) results.push((await groq.summarize(thread)).action);
  assert.deepEqual(results[0], {
    kind: 'link',
    label: 'Track parcel',
    url: 'https://parcel.example/track/DEMO-1',
  });
  assert.equal(results[1], undefined, 'a hallucinated URL is dropped');
  assert.equal(results[2], undefined, 'unsubscribe links are never the action');
  assert.deepEqual(results[3], {
    kind: 'attachment',
    label: 'View invoice',
    attachmentId: 'att-1',
  });
  assert.equal(results[4], undefined, 'an attachment that is not in the thread is dropped');
  assert.deepEqual(results[5], {
    kind: 'reply',
    label: 'Reply',
    prompt: 'Say Friday works for the delivery',
  });
  assert.equal(results[6], undefined, 'reply needs a drafting prompt');
  assert.deepEqual(results[7], { kind: 'calendar', label: 'Add to calendar' });
  assert.equal(results[8], undefined, 'triage actions are not suggestions');
  assert.equal(results[9], undefined, 'labels stay at three words');
  assert.equal(results[10], undefined, 'unknown kinds are dropped');
  assert.equal(results[11], undefined);
  // The model sees the thread's links and attachments, never the tracking ones.
  assert.deepEqual(sent[0].links, ['https://parcel.example/track/DEMO-1']);
  assert.deepEqual(sent[0].attachments, [
    { id: 'att-1', name: 'invoice.pdf', type: 'application/pdf' },
  ]);
  // A calendar action needs a concrete time in the thread.
  const vague = {
    ...thread,
    messages: [{ ...thread.messages[0], text: 'Let us meet sometime.', html: '' }],
  };
  const { groq: other } = fake([{ kind: 'calendar', label: 'Add to calendar' }]);
  assert.equal((await other.summarize(vague)).action, undefined);
});

test('demo actions point at links and files that exist in their threads', () => {
  const demo = createDemo(new Date(2026, 9, 15, 12));
  const withActions = demo.threads.filter(t => t.action);
  assert.ok(withActions.length >= 6);
  for (const t of withActions) {
    const a = t.action!;
    if (a.kind === 'link') assert.ok(threadLinks(t).includes(a.url!), t.id);
    if (a.kind === 'attachment')
      assert.ok(
        t.messages.some(m => m.attachments.some(f => f.id === a.attachmentId)),
        t.id,
      );
    if (a.kind === 'reply') assert.ok(a.prompt && a.prompt.length > 8, t.id);
  }
});

test('one-key actions only use links a reader can see and are withdrawn from Spam and Trash', async () => {
  const { liveAction } = await import('@aplos/contract/legacy/mailbox');
  const message = thread.messages[0];
  const hidden: Thread = {
    ...thread,
    messages: [
      {
        ...message,
        text: 'Plain part: https://plain-only.example/login',
        html:
          '<head><link href="https://head.example/x"></head><!-- <a href="https://comment.example/verify">Verify</a> --><p><a href="https://seen.example/ok">Open</a>' +
          '<a style="display:none" href="https://hidden.example/login">x</a><a hidden href="https://hidden2.example/x">y</a><span data-href="https://data.example/x"></span></p>',
      },
    ],
  };
  // Only the visible anchor counts; comments, head links, hidden anchors, data-href and an unseen plain-text part do not.
  assert.deepEqual(threadLinks(hidden), ['https://seen.example/ok']);
  const link = {
    kind: 'link' as const,
    label: 'Open order',
    url: 'https://parcel.example/track/DEMO-1',
  };
  assert.deepEqual(liveAction({ ...thread, action: link }), link);
  assert.equal(liveAction({ ...thread, status: 'spam', action: link }), undefined);
  assert.equal(
    liveAction({
      ...thread,
      status: 'trash',
      action: { kind: 'reply', label: 'Reply', prompt: 'Say thanks for the update' },
    }),
    undefined,
  );
  // A stored action is re-checked against the thread it is shown with.
  assert.equal(liveAction({ ...hidden, action: link }), undefined);
  assert.equal(
    liveAction({
      ...thread,
      action: { kind: 'attachment', label: 'View invoice', attachmentId: 'gone' },
    }),
    undefined,
  );
});
