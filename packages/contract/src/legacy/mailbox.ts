import type { SuggestedAction, Thread, View } from './types';

export type LaterTab = 'todos' | 'bookmarks';

/** Important new mail that still belongs on Home’s New stack. */
export function isHomeNew(thread: Thread) {
  return (
    thread.status === 'new' &&
    thread.importance === 'important' &&
    !thread.hiddenFromHome &&
    !thread.bookmarked
  );
}

/** Low-importance new mail shown as the Home bundle, not the New stack. */
export function isHomeLow(thread: Thread) {
  return thread.status === 'new' && thread.importance === 'low' && !thread.bookmarked;
}

/** Done mail that still needs your reply comes back to Home's "Waiting on you". */
export function isReplyDue(thread: Thread) {
  return thread.replyStatus === 'needs-reply' && thread.status === 'done' && !thread.hiddenFromHome;
}

/** Days without an answer before a thread you're waiting on shows on Home as a follow-up. */
export const FOLLOW_UP_DAYS = 3;

/** Mail you sent that nobody has answered for a few days, so Home can nudge a follow-up. */
export function isFollowUp(thread: Thread, now = Date.now()) {
  return (
    thread.replyStatus === 'awaiting-reply' &&
    thread.status === 'done' &&
    !thread.hiddenFromHome &&
    now - Date.parse(thread.date) >= FOLLOW_UP_DAYS * 86400000
  );
}

export function isLaterTodo(thread: Thread) {
  return thread.status === 'later';
}

export function isBookmark(thread: Thread) {
  return thread.bookmarked && thread.status !== 'trash' && thread.status !== 'spam';
}

export function threadInView(thread: Thread, view: View, laterTab: LaterTab = 'todos') {
  switch (view) {
    case 'home':
      return isHomeNew(thread);
    case 'later':
      return laterTab === 'bookmarks' ? isBookmark(thread) : isLaterTodo(thread);
    case 'low':
      return isHomeLow(thread);
    case 'needs-reply':
    case 'awaiting-reply':
      return thread.replyStatus === view && thread.status !== 'trash' && thread.status !== 'spam';
    case 'all':
      return thread.status !== 'trash' && thread.status !== 'spam';
    case 'sent':
      return thread.messages.some(message => message.sent);
    case 'trash':
    case 'spam':
      return thread.status === view;
    default:
      return false;
  }
}

/** Bookmarking files New/low mail off the current list; unbookmarking files it out of Bookmarks. */
export function bookmarkLeavesList(
  thread: Thread,
  nextBookmarked: boolean,
  view: View,
  laterTab: LaterTab,
) {
  if (nextBookmarked) {
    if (view === 'home') return isHomeNew(thread);
    if (view === 'low') return isHomeLow(thread);
    return false;
  }
  return view === 'later' && laterTab === 'bookmarks' && isBookmark(thread);
}

/** A person's first name ("Jordan" for Jordan Park <jordan@…>); organizations and unclear names stay whole. */
export function shortSender(name: string, address: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const local = ((/<([^>]+)>/.exec(address)?.[1] || address).split('@')[0] || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (!words.length) return local || address;
  const person =
    words.length >= 2 &&
    words.length <= 3 &&
    words.every(w => /^\p{Lu}[\p{Ll}'’-]+$/u.test(w)) &&
    words.some(w => local.includes(w.toLowerCase().replace(/[^a-z]/g, '')));
  return person ? words[0] : name.trim();
}
/** Short due chip text: "today", "by tomorrow", "by Fri", "by Oct 22", "overdue". */
export function shortDue(value: string, now = new Date()) {
  const date = new Date(value.slice(0, 10) + 'T12:00:00');
  const today = new Date(now);
  today.setHours(12, 0, 0, 0);
  const days = Math.round((+date - +today) / 86400000);
  if (Number.isNaN(days)) return '';
  return days < 0
    ? 'overdue'
    : days === 0
      ? 'today'
      : days === 1
        ? 'by tomorrow'
        : 'by ' +
          date.toLocaleDateString(
            [],
            days < 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' },
          );
}

// Unsubscribe pages, preference centers, click-tracking redirects and pixels are never offered as the one-click action.
const unwantedLink =
  /unsubscribe|opt-?out|manage[-_ ]?(your[-_ ]?)?(preferences|subscription)|email[-_]?preferences|\/wf\/click|\/ls\/click|\/click\b|^https?:\/\/(click|clicks|links?|lnk|email|e|mg|t|r|go|trk)\.[^/]*\/|redirect|pixel|beacon|open\.gif|list-manage\.|sendgrid\.net|mailchi\.mp/i;
// Anchors styled out of sight are not links the reader saw.
const hiddenAnchor =
  /\bhidden\b|display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d])|opacity\s*:\s*0(?![.\d])|max-height\s*:\s*0(?![.\d])/i;
/** The http(s) links a reader can actually see: visible <a href> anchors of the HTML part (plain text only when there is no HTML),
 * never comments, head/style/script content, <link>/<base>/data-href, hidden anchors, unsubscribe or tracking links. */
export function threadLinks(thread: Thread) {
  const found = new Set<string>();
  const add = (raw: string) => {
    const url = raw
      .replace(/&amp;/g, '&')
      .replace(/[.,;:!?)\]]+$/, '')
      .trim();
    if (url.length > 500 || !/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(url) || unwantedLink.test(url))
      return;
    try {
      const parsed = new URL(url);
      if (parsed.username || parsed.password) return;
    } catch {
      return;
    }
    found.add(url);
  };
  for (const m of thread.messages) {
    if (m.html?.trim()) {
      const visible = m.html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(head|style|script|title|template|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, '');
      for (const anchor of visible.matchAll(/<a\b([^>]*)>/gi)) {
        const attributes = ' ' + anchor[1];
        if (hiddenAnchor.test(attributes)) continue;
        const href = /\shref\s*=\s*(?:"(https?:\/\/[^"]+)"|'(https?:\/\/[^']+)')/i.exec(attributes);
        if (href) add(href[1] ?? href[2]);
      }
    } else for (const match of m.text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) add(match[0]);
  }
  return [...found].slice(-20);
}

/** The suggested action if it is still safe to offer: never on Spam or Trash, and links/attachments must still be in the thread.
 * Checked again when rendering, running and syncing, because a stored action can outlive the mail it was made from. */
export function liveAction(thread: Thread): SuggestedAction | undefined {
  const action = thread.action;
  if (!action || thread.status === 'spam' || thread.status === 'trash') return;
  if (action.kind === 'link')
    return action.url && threadLinks(thread).includes(action.url) ? action : undefined;
  if (action.kind === 'attachment')
    return thread.messages.some(m => m.attachments.some(a => a.id === action.attachmentId))
      ? action
      : undefined;
  return action;
}
