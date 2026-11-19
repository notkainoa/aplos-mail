import type { EngineMethodName } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { Handlers } from '../engine';
import type { Store, Table, Tables } from '../store';

/** A slice of the handler table; contextual typing comes from `satisfies`, completeness from `methods/index.ts`. */
export type Part<K extends EngineMethodName = EngineMethodName> = Partial<Pick<Handlers, K>>;

/** A submission in one of these states is live: its draft is locked and its attachments are kept (FR-7). */
export const live = new Set(['queued', 'scheduled', 'sending', 'uncertain', 'failed', 'suspended']);

export const fail = (type: string, message: string, extra: Record<string, unknown> = {}): never => {
  throw new ContractError({ type, message, ...extra });
};

export function must<T extends Table>(
  store: Store,
  table: T,
  id: string,
  message = 'This item is no longer available.',
): Tables[T] {
  return store.get(table, id) ?? fail('notFound', message);
}

/** JMAP `T/get`: unknown ids come back in `notFound`. */
export function getRows<T extends Table>(store: Store, table: T, ids: string[]) {
  const list: Tables[T][] = [],
    notFound: string[] = [];
  for (const id of ids) {
    const row = store.get(table, id);
    if (row) list.push(row);
    else notFound.push(id);
  }
  return { state: store.state, list, notFound };
}

/** Drops `undefined` values, so optional fields are absent rather than present-and-undefined on the wire. */
export function clean<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export const plainHtml = (text: string) =>
  text
    .split('\n')
    .map(line => `<p>${line.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)}</p>`)
    .join('');
export const textOf = (html: string) =>
  html
    .replace(/<\/p>\s*<p>/g, '\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&');
