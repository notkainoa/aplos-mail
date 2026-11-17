/**
 * The reader's Unsubscribe (round 6): what each `Unsubscribe/run` outcome says as a toast, and the link to open when
 * the sender only offers a page to review. The engine does the sending; this file only words the result plainly and
 * never claims more than the engine confirmed.
 */
export interface UnsubscribeResult {
  readonly outcome: string;
  readonly url?: string;
  readonly message: string;
}

export interface UnsubscribeNotice {
  readonly message: string;
  /** An https page to open outside the app (outcome `openLink` only). */
  readonly open?: string;
  /** The prepared email to open in a new composer (outcome `compose` only): the owner reads it and sends it. */
  readonly compose?: UnsubscribeMail;
}

/** The checked fields of a mailto unsubscribe: nothing is sent until the owner presses Send. */
export interface UnsubscribeMail {
  readonly to: readonly string[];
  readonly subject: string;
  readonly body: string;
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function queryField(query: string, name: string): string {
  const pair = query.split('&').find(part => part.split('=')[0]?.toLowerCase() === name);
  return pair ? decoded(pair.slice(pair.indexOf('=') + 1)) : '';
}

/** To, Subject and Body of a `mailto:` URL; Cc and Bcc are never carried. Null when there is no address to write to. */
export function parseMailto(url: string): UnsubscribeMail | null {
  if (!/^mailto:/i.test(url)) return null;
  const [target = '', query = ''] = url.slice('mailto:'.length).split('?');
  const to = decoded(target)
    .split(',')
    .map(address => address.trim())
    .filter(address => address.includes('@'));
  if (to.length === 0) return null;
  return { to, subject: queryField(query, 'subject'), body: queryField(query, 'body') };
}

function composeNotice(url: string | undefined, sender: string): UnsubscribeNotice {
  const mail = url ? parseMailto(url) : null;
  if (!mail) return { message: `${sender} did not offer a way to unsubscribe by email.` };
  return { message: `Review the email to ${sender}, then send it to unsubscribe.`, compose: mail };
}

/** What to tell the owner once `Unsubscribe/run` answered; `sender` names who they unsubscribed from. */
export function unsubscribeNotice(result: UnsubscribeResult, sender: string): UnsubscribeNotice {
  switch (result.outcome) {
    case 'done':
      return { message: `Unsubscribed from ${sender}.` };
    case 'openLink':
      return result.url
        ? { message: `Opened ${sender}’s unsubscribe page.`, open: result.url }
        : { message: `${sender} did not offer a link to unsubscribe.` };
    case 'compose':
      return composeNotice(result.url, sender);
    case 'unsure':
      return { message: `Asked ${sender} to unsubscribe you. They did not confirm.` };
    case 'unavailable':
      return { message: `${sender} does not offer a way to unsubscribe.` };
    default:
      return { message: result.message || `Couldn’t unsubscribe from ${sender}.` };
  }
}

/** The thread's message to the owner when the call itself failed: nothing changed. */
export function unsubscribeFailed(sender: string): UnsubscribeNotice {
  return { message: `Couldn’t unsubscribe from ${sender}. Nothing changed.` };
}
