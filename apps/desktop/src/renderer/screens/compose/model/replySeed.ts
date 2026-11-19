/**
 * A fresh reply's starting fields (DESIGN 7.6 Inline reply): To is the Reply-To addresses when the message has them,
 * else the sender (or, on your own message, the people you wrote to); reply all adds everyone else on From, Reply-To,
 * To and Cc except you; the subject gains one "Re: ". "You" is every account address and every send-as alias the
 * accounts list (`Account.identities`). A message with no From is not taken for yours: the reply goes to its Reply-To,
 * else To starts empty for you to fill (no guessing). A reply to your own message is never empty when someone can be
 * named (see `ownReplyTo`).
 */
import type { Account, Address, Message } from '../../../data';
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

/** The owner's lower-cased addresses: each account's own and its send-as aliases. */
export function ownAddresses(
  accounts: readonly Pick<Account, 'address' | 'identities'>[],
): ReadonlySet<string> {
  const own = new Set<string>();
  for (const account of accounts) {
    own.add(account.address.toLowerCase());
    for (const identity of account.identities ?? []) own.add(identity.address.toLowerCase());
  }
  return own;
}

function repliesTo(message: Message): readonly Address[] {
  if (message.replyTo && message.replyTo.length > 0) return message.replyTo;
  return message.from ? [message.from] : [];
}

/** Yours: the engine says so, or its From is one of your addresses (an alias included). */
function isOwn(message: Message, me: ReadonlySet<string>): boolean {
  return message.fromMe || (!!message.from && me.has(message.from.address.toLowerCase()));
}

function senders(message: Message): readonly Address[] {
  return message.from ? [message.from, ...(message.replyTo ?? [])] : [...(message.replyTo ?? [])];
}

/**
 * Who a reply to your own `message` goes to: the people you wrote to; if all of them are you (a note to yourself, or to
 * your other account) them again, as Gmail does; else the Cc; else, when you only used Bcc, the newest earlier sender
 * in the thread who is not you.
 */
function ownReplyTo(
  message: Message,
  me: ReadonlySet<string>,
  thread: readonly Message[],
): readonly Address[] {
  for (const list of [
    others(message.to, me),
    others(message.to, new Set()),
    others(message.cc, me),
  ])
    if (list.length > 0) return list;
  const newestFirst = [...thread].sort((a, b) => b.date - a.date);
  for (const earlier of newestFirst) {
    if (earlier.id === message.id || isOwn(earlier, me)) continue;
    const back = others(repliesTo(earlier), me);
    if (back.length > 0) return back;
  }
  return [];
}

/**
 * The context and fields of a reply to `message`. `me` holds the owner's lower-cased addresses; `thread` is the
 * thread's messages (any order), read only to find someone to write to when your own message names nobody else.
 */
export function replySeed(
  message: Message,
  me: ReadonlySet<string>,
  replyAll: boolean,
  thread: readonly Message[] = [],
): { readonly context: ComposeContext; readonly fields: ComposeFields } {
  const own = isOwn(message, me);
  const to = own ? ownReplyTo(message, me, thread) : others(repliesTo(message), new Set());
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
