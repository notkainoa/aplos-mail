import DOMPurify from 'dompurify';
import type { Attachment, Message } from '@aplos/contract/legacy/types';
import { escapeHtml } from './bridge';

const quoteSelector = 'blockquote,.gmail_quote,.gmail_extra,.yahoo_quoted';
const contentId = (value: string) => {
  try {
    return decodeURIComponent(value.slice(4)).replace(/^<|>$/g, '');
  } catch {
    return value.slice(4);
  }
};

/** Templates stay inert while images, history, and unsafe markup are prepared. */
function template(html: string) {
  const node = document.createElement('template');
  node.innerHTML = html;
  return node;
}
function hideImage(image: HTMLImageElement, label: string) {
  const placeholder = document.createElement('span');
  placeholder.className = 'image-placeholder';
  placeholder.textContent = image.getAttribute('alt') || label;
  image.replaceWith(placeholder);
}
function quotedNodes(node: HTMLTemplateElement) {
  const all = [...node.content.querySelectorAll(quoteSelector)];
  return all.filter(
    candidate => !all.some(parent => parent !== candidate && parent.contains(candidate)),
  );
}
export function inlineAttachments(message: Message): Attachment[] {
  const node = template(message.html ?? '');
  const ids = new Set(
    [...node.content.querySelectorAll('img')]
      .map(image => image.getAttribute('src') ?? '')
      .filter(src => src.startsWith('cid:'))
      .map(contentId),
  );
  return message.attachments.filter(
    attachment => attachment.contentId && ids.has(attachment.contentId) && !attachment.data,
  );
}

export function prepareMessageBody(
  message: Message,
  options: { remote: boolean; spam: boolean; inline: Record<string, Attachment>; query?: string },
) {
  let html = message.html;
  let plainQuote = message.quoted ?? '';
  if (!html) {
    let text = message.text;
    if (!plainQuote) {
      const boundary = /(?:^|\n)(?:On [^\n]+wrote:|[- ]*Original Message[- ]*|>[^\n]*)/m.exec(text);
      if (boundary && boundary.index > 0) {
        plainQuote = text.slice(boundary.index).trim();
        text = text.slice(0, boundary.index).trimEnd();
      }
    }
    html = '<p>' + escapeHtml(text).replace(/\n/g, '<br>') + '</p>';
  }
  const node = template(html);
  for (const image of node.content.querySelectorAll('img')) {
    const source = image.getAttribute('src') ?? '';
    if (options.spam) hideImage(image, 'Image hidden in Spam');
    else if (source.startsWith('cid:')) {
      const attachment = message.attachments.find(item => item.contentId === contentId(source));
      const ready = attachment && (attachment.data ? attachment : options.inline[attachment.id]);
      if (ready?.data && ready.type.startsWith('image/'))
        image.setAttribute('src', `data:${ready.type};base64,${ready.data}`);
      else hideImage(image, 'Inline image unavailable');
    } else if (!options.remote && !source.startsWith('data:'))
      hideImage(image, 'Remote image hidden');
  }
  // Strip background/srcset/style acquisition too, before any content is mounted.
  node.innerHTML = DOMPurify.sanitize(node.innerHTML, {
    FORBID_TAGS: ['style', 'link', 'iframe', 'form', 'input', 'video', 'audio', 'object', 'embed'],
    FORBID_ATTR: ['srcset', 'style', 'background', 'poster'],
  });
  const quote = template('');
  const outlook = node.content.querySelector('#divRplyFwdMsg');
  if (outlook) {
    let current: ChildNode | null = outlook;
    while (current) {
      const next: ChildNode | null = current.nextSibling;
      quote.content.append(current);
      current = next;
    }
  }
  for (const quoted of quotedNodes(node)) quote.content.append(quoted);
  if (plainQuote) {
    const block = document.createElement('blockquote');
    block.textContent = plainQuote;
    quote.content.append(block);
  }
  if (options.query) {
    for (const root of [node.content, quote.content]) {
      const nodes: Text[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      for (const text of nodes) {
        const value = text.data;
        const needle = options.query.toLowerCase();
        let index = value.toLowerCase().indexOf(needle);
        if (index < 0) continue;
        const fragment = document.createDocumentFragment();
        let cursor = 0;
        while (index >= 0) {
          fragment.append(value.slice(cursor, index));
          const mark = document.createElement('mark');
          mark.textContent = value.slice(index, index + needle.length);
          fragment.append(mark);
          cursor = index + needle.length;
          index = value.toLowerCase().indexOf(needle, cursor);
        }
        fragment.append(value.slice(cursor));
        text.replaceWith(fragment);
      }
    }
  }
  const hasRemoteImages = [...template(html).content.querySelectorAll('img')].some(image =>
    /^https?:\/\//i.test(image.getAttribute('src') ?? ''),
  );
  return { body: node.innerHTML, quoted: quote.innerHTML, hasRemoteImages };
}
