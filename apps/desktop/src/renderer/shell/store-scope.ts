/**
 * The account scope the sidebar's switcher selects: one account's id, or null for All accounts. Screens and the sidebar
 * counts read it, so choosing an account in the switcher narrows everything at once.
 */
import { createStore } from './store-core';
import type { AccountId } from '../data';

const scopeStore = createStore<AccountId | null>(null);

/** Selects one account, or null for All accounts. */
export function setScope(accountId: AccountId | null): void {
  scopeStore.set(accountId);
}

export const getScope = scopeStore.get;
export const subscribeScope = scopeStore.subscribe;
