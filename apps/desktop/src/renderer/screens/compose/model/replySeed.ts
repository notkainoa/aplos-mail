/**
 * A fresh reply's starting fields (DESIGN 7.6 Inline reply): To is the sender (or, on your own message, the people you
 * wrote to); reply all adds everyone else on To and Cc except you; the subject gains one "Re: ".
 */
import type { Address, Message } from '../../../data';
import type { ComposeContext, ComposeFields } from './fields';
import { recipientOf } from './fields';

function others(addresses: readonly Address[], exclude: ReadonlySet<string>): readonly Address[] {
  const seen = new Set(exclude);
  return addresses.filter(address => {
    const key = address.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** "Re: Launch plan", never "Re: Re: Launch plan". */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/** The context and fields of a reply to `message`. `me` holds the owner's lower-cased addresses. */
export function replySeed(
  message: Message,
  me: ReadonlySet<string>,
  replyAll: boolean,
): { readonly context: ComposeContext; readonly fields: ComposeFields } {
  const to = message.fromMe || !message.from ? others(message.to, me) : [message.from];
  const toKeys = new Set([...me, ...to.map(a => a.address.toLowerCase())]);
  const cc = replyAll ? others([...message.to, ...message.cc], toKeys) : [];
  return {
    context: {
      accountId: message.accountId,
      mode: replyAll ? 'replyAll' : 'reply',
      threadId: message.threadId,
      replyToMessageId: message.id,
    },
    fields: {
      to: to.map(recipientOf),
      cc: cc.map(recipientOf),
      bcc: [],
      subject: replySubject(message.subject),
      body: '',
    },
  };
}
