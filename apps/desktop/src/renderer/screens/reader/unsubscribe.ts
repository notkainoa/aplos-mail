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
