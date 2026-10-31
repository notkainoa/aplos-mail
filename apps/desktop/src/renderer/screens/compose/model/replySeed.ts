/**
 * A fresh reply's starting fields (DESIGN 7.6 Inline reply): To is the Reply-To addresses when the message has them,
 * else the sender (or, on your own message, the people you wrote to); reply all adds everyone else on From, Reply-To,
 * To and Cc except you; the subject gains one "Re: ".
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

function repliesTo(message: Message): readonly Address[] {
  return message.replyTo && message.replyTo.length > 0 ? message.replyTo : [message.from!];
}

function senders(message: Message): readonly Address[] {
  return message.from ? [message.from, ...(message.replyTo ?? [])] : [...(message.replyTo ?? [])];
}

/** The context and fields of a reply to `message`. `me` holds the owner's lower-cased addresses. */
export function replySeed(
  message: Message,
  me: ReadonlySet<string>,
  replyAll: boolean,
): { readonly context: ComposeContext; readonly fields: ComposeFields } {
  const own = message.fromMe || !message.from;
  const to = own ? others(message.to, me) : others(repliesTo(message), new Set());
  const toKeys = new Set([...me, ...to.map(a => a.address.toLowerCase())]);
  const everyone = [...(own ? [] : senders(message)), ...message.to, ...message.cc];
  const cc = replyAll ? others(everyone, toKeys) : [];
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
