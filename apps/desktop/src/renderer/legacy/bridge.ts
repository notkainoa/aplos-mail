import type { Bridge, Listener } from '@aplos/contract/legacy/types';
const listeners = new Set<Listener>();
const api = `http://127.0.0.1:${import.meta.env.VITE_APLOS_API_PORT || 4317}/api`;
let source: EventSource | undefined;
const web: Bridge = {
  async invoke<T>(method: string, payload?: unknown): Promise<T> {
    const response = await fetch(api + '/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, payload }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    return data.result as T;
  },
  subscribe(listener) {
    listeners.add(listener);
    if (!source) {
      source = new EventSource(api + '/events');
      source.onmessage = e => {
        try {
          const event = JSON.parse(e.data);
          for (const cb of listeners) cb(event);
        } catch {
          /* malformed events cannot break the UI */
        }
      };
    }
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        source?.close();
        source = undefined;
      }
    };
  },
};
export const bridge = window.aplos ?? web;
export const invoke = bridge.invoke.bind(bridge);
export const uid = () => crypto.randomUUID();
export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function avatarColor(seed: string) {
  let hash = 0;
  for (const char of seed.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const hues = [4, 22, 38, 52, 95, 140, 170, 200, 222, 250, 272, 300, 330];
  return `hsl(${hues[Math.abs(hash) % hues.length]} 58% 42%)`;
}
export const plain = (html: string) => {
  const d = new DOMParser().parseFromString(html, 'text/html');
  // textContent glues block elements together ("Hi Jordan,I like…"), so separate them first.
  d.body.querySelectorAll('br').forEach(br => br.replaceWith(' '));
  d.body.querySelectorAll('p,div,li,blockquote,h1,h2,h3,tr').forEach(el => el.append(' '));
  return (d.body.textContent ?? '').replace(/\s+/g, ' ').trim();
};
export { dateLabel, fullDate } from './dateLabel';
export function dueLabel(value?: string) {
  if (!value) return 'No due date';
  const date = new Date(value.slice(0, 10) + 'T12:00:00');
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const days = Math.round((+date - +today) / 86400000);
  return days === 0
    ? 'Due today'
    : days === 1
      ? 'Due tomorrow'
      : days < 0
        ? 'Overdue · ' + date.toLocaleDateString([], { month: 'short', day: 'numeric' })
        : 'Due ' + date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
export async function fileToAttachment(file: File) {
  const data = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('Could not read ' + file.name));
    r.readAsDataURL(file);
  });
  return {
    id: uid(),
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    data,
  };
}
export async function saveFile(name: string, data: string, open = false) {
  if (window.aplos) return invoke(open ? 'file.open' : 'file.save', { name, data });
  const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes]));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function replyRecipients(
  thread: import('@aplos/contract/legacy/types').Thread,
  accountEmail: string,
  mode: 'reply' | 'reply-all',
) {
  const last = thread.messages.at(-1);
  if (!last) return { to: '', cc: '' };
  const self = accountEmail.toLowerCase();
  const to = last.from.toLowerCase() === self ? last.to[0] || '' : last.from;
  const cc =
    mode === 'reply-all'
      ? [...new Set([...last.to, ...(last.cc ?? [])])]
          .filter(e => e.toLowerCase() !== self && e !== to)
          .join(', ')
      : '';
  return { to, cc };
}
/** Local calendar date, `offset` days from today, as YYYY-MM-DD. */
export function isoDay(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export async function openUrl(url: string) {
  if (window.aplos) return invoke('shell.open', { url });
  if (!/^https?:|^mailto:/i.test(url)) throw new Error('Unsupported link');
  window.open(url, '_blank', 'noopener,noreferrer');
}
