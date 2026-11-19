/**
 * How an account is named in the UI. The address is the one name every surface agrees on (the account switcher shows
 * it), so two accounts whose display names look alike ("Kainoa Newton", "Kainoa") are never confused. The display
 * name never replaces it.
 */
export interface AccountNaming {
  readonly name?: string;
  readonly address: string;
}

/** The label for an account: its address, or its name for an account that somehow has none. */
export function accountLabel(account: AccountNaming): string {
  return account.address.trim() || account.name?.trim() || '';
}
