/**
 * The mail lists as plain data (DESIGN 7.3, 7.4, 7.14): which view each one watches, which row layout it draws, the
 * quick actions that overlay a row's date column, its empty sentence and its key context. One shared list component
 * reads this, so All mail, Drafts, Sent, Trash, Spam, labels, Done and Bookmarks differ only here.
 */
import type { AccountId, ViewSpec } from '../../data';
import type { ContextName } from '../../commands';
import type { CommandId, IconName, RowAction, RowLayout } from '../../ui/props';

/** Which list a `ListScreen` shows. A label is named by its folder id (the `label` view's `folderId`). */
export type ListWhich = 'all' | 'drafts' | 'sent' | 'trash' | 'spam' | { readonly label: string };

/** Every list the shared component draws, including the two other screens' bodies. */
export type ListKind =
  'all' | 'drafts' | 'sent' | 'trash' | 'spam' | 'label' | 'done' | 'later' | 'bookmarks';

/** A list's fixed facts. */
export interface ListConfig {
  readonly kind: ListKind;
  /** The listbox DOM id, and the prefix of every option id in it. */
  readonly id: string;
  /** The listbox's accessible name. */
  readonly name: string;
  /** The hold scope: one gate per list. */
  readonly scope: string;
  readonly layout: RowLayout;
  /** The view it watches, apart from the account. */
  readonly view: ViewShape;
  /** DESIGN 7.14's sentence for an empty list; no trailing period (owner override 2026-11-05). */
  readonly empty: string;
  /** The one muted mark above the empty sentence. */
  readonly emptyIcon: IconName;
  /** A second, quieter line under the empty sentence, only where it helps. */
  readonly emptyDetail?: string;
  /** The one text action under an empty list ("Write a message", C), only where there is something to do. */
  readonly emptyAction?: { readonly label: string; readonly commandId: CommandId };
  /** Date groups ("Today", "Yesterday") use section labels in All mail, Done, Drafts, Sent, Trash and Spam (DESIGN 7.4). */
  readonly dateGroups: boolean;
  /** Which date a date group reads: when the thread last moved, or when it was finished. */
  readonly dateField: 'lastDate' | 'doneAt';
  /** The key contexts under `global` (the registry's stack). */
  readonly contexts: readonly ContextName[];
  readonly hoverActions: readonly RowAction[];
}

type MailboxRole = 'all' | 'sent' | 'trash' | 'spam';

/** The view a list watches, before the account is added. */
export type ViewShape =
  | { readonly kind: 'mailbox'; readonly role: MailboxRole }
  | { readonly kind: 'drafts' }
  | { readonly kind: 'done' }
  | { readonly kind: 'later' }
  | { readonly kind: 'bookmarks' }
  | { readonly kind: 'label'; readonly folderId: string };

const LATER_ACTION: RowAction = { commandId: 'mail.later', icon: 'clock', label: 'Later' };
const DONE_ACTION: RowAction = { commandId: 'mail.done', icon: 'check', label: 'Done' };
const TRIAGE_ACTIONS: readonly RowAction[] = [LATER_ACTION, DONE_ACTION];

const LIST_CONTEXTS: readonly ContextName[] = ['list'];

function config(base: Omit<ListConfig, 'contexts' | 'dateGroups' | 'dateField' | 'layout'>) {
  return {
    layout: 'list',
    dateGroups: false,
    dateField: 'lastDate',
    contexts: LIST_CONTEXTS,
    ...base,
  } satisfies ListConfig;
}

export const ALL_CONFIG: ListConfig = {
  ...config({
    kind: 'all',
    id: 'list-all',
    name: 'All mail',
    scope: 'list:all',
    view: { kind: 'mailbox', role: 'all' },
    empty: 'No mail here yet',
    emptyIcon: 'tray',
    hoverActions: TRIAGE_ACTIONS,
  }),
  dateGroups: true,
};

export const DRAFTS_CONFIG: ListConfig = {
  ...config({
    kind: 'drafts',
    id: 'list-drafts',
    name: 'Drafts',
    scope: 'list:drafts',
    view: { kind: 'drafts' },
    empty: 'No drafts',
    emptyIcon: 'file',
    emptyAction: { label: 'Write a message', commandId: 'mail.compose' },
    hoverActions: [],
  }),
  dateGroups: true,
};

export const SENT_CONFIG: ListConfig = {
  ...config({
    kind: 'sent',
    id: 'list-sent',
    name: 'Sent',
    scope: 'list:sent',
    view: { kind: 'mailbox', role: 'sent' },
    empty: 'Nothing sent yet',
    emptyIcon: 'send',
    hoverActions: TRIAGE_ACTIONS,
  }),
  dateGroups: true,
};

export const TRASH_CONFIG: ListConfig = {
  ...config({
    kind: 'trash',
    id: 'list-trash',
    name: 'Trash',
    scope: 'list:trash',
    view: { kind: 'mailbox', role: 'trash' },
    empty: 'Trash is empty',
    emptyIcon: 'trash',
    hoverActions: [{ commandId: 'mail.restore', icon: 'undo', label: 'Restore' }],
  }),
  dateGroups: true,
};

export const SPAM_CONFIG: ListConfig = {
  ...config({
    kind: 'spam',
    id: 'list-spam',
    name: 'Spam',
    scope: 'list:spam',
    view: { kind: 'mailbox', role: 'spam' },
    empty: 'Spam is empty',
    emptyIcon: 'spam',
    hoverActions: [{ commandId: 'mail.restore', icon: 'undo', label: 'Not spam' }],
  }),
  dateGroups: true,
};

/** The Done place (DESIGN 7.4): the stamp column, one icon-only action to its left, E and L inactive. */
export const DONE_CONFIG: ListConfig = {
  ...config({
    kind: 'done',
    id: 'list-done',
    name: 'Done mail',
    scope: 'list:done',
    view: { kind: 'done' },
    empty: 'Nothing done yet',
    emptyIcon: 'check-circle',
    hoverActions: [{ commandId: 'done.moveToHome', icon: 'home', label: 'Move to Home' }],
  }),
  layout: 'done',
  dateGroups: true,
  dateField: 'doneAt',
  contexts: ['list', 'done'],
};

/** Later (DESIGN 7.3): the groups come from the `later` view's sections; the hover actions re-date or finish a row. */
export const LATER_CONFIG: ListConfig = {
  ...config({
    kind: 'later',
    id: 'list-later',
    name: 'Later',
    scope: 'list:later',
    view: { kind: 'later' },
    empty: 'Nothing set aside for later',
    emptyIcon: 'clock',
    hoverActions: [{ commandId: 'mail.setDate', icon: 'clock', label: 'Change date' }, DONE_ACTION],
  }),
  layout: 'later',
};

/** Later's other half (DESIGN 7.3): bookmarked mail as a plain list. */
export const BOOKMARKS_CONFIG: ListConfig = config({
  kind: 'bookmarks',
  id: 'list-bookmarks',
  name: 'Bookmarks',
  scope: 'list:bookmarks',
  view: { kind: 'bookmarks' },
  empty: 'No bookmarks',
  emptyIcon: 'bookmark',
  emptyDetail: 'Press B on any email',
  hoverActions: [DONE_ACTION],
});

/** A label's list; the folder id names the view and the hold scope. */
export function labelConfig(folderId: string): ListConfig {
  return config({
    kind: 'label',
    id: 'list-label',
    name: 'Label',
    scope: `list:label:${folderId}`,
    view: { kind: 'label', folderId },
    empty: 'No mail here yet',
    emptyIcon: 'tag',
    hoverActions: TRIAGE_ACTIONS,
  });
}

/** The config for a `ListScreen`'s `which`. */
export function configFor(which: ListWhich): ListConfig {
  if (typeof which !== 'string') return labelConfig(which.label);
  switch (which) {
    case 'all':
      return ALL_CONFIG;
    case 'drafts':
      return DRAFTS_CONFIG;
    case 'sent':
      return SENT_CONFIG;
    case 'trash':
      return TRASH_CONFIG;
    case 'spam':
      return SPAM_CONFIG;
  }
}

/** The contract view for a list, scoped to one account or to all of them. */
export function viewSpecOf(list: ListConfig, accountId?: AccountId): ViewSpec {
  const view = list.view;
  // A label is one folder, which already belongs to one account.
  if (view.kind === 'label') return { kind: 'label', folderId: view.folderId };
  return { ...view, accountId } as ViewSpec;
}

/** Whether the list shows thread rows (every list but Drafts). */
export function showsThreads(list: ListConfig): boolean {
  return list.kind !== 'drafts';
}
