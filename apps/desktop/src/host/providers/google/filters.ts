import {
  ProviderError,
  type AdapterContext,
  type RemoteRule,
  type RulesAdapter,
  type SenderRule,
} from '@aplos/engine/ports';
import { googleScopeManifest, grantedFeatures } from '../oauth/scopes';
import { GmailClient, type GmailDeps } from './client';

/**
 * The `sender_rules` mirror on Gmail `users.settings.filters` (plan 20 PV4 "Filters"), so a block or
 * skip-Inbox rule acts on arriving mail while the Mac sleeps. One `SenderRule` is one filter:
 *
 *   criteria { from: <addressOrDomain> }
 *   block     → action { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] }
 *   skipInbox → action { removeLabelIds: ['INBOX'] }
 *
 * "Block" is the app's own meaning (engine `sender-ops`: the sender's mail goes to Spam and off Home), so
 * the remote copy carries both labels: land in Spam, out of the Inbox. skip-Inbox only leaves the Inbox.
 *
 * `criteria.from` carries the validated `addressOrDomain`: a full address, or a domain written as `@domain`
 * (Gmail's own domain-filter convention; a bare domain is canonicalized to it when WRITING). Ownership is by
 * shape alone, since Gmail filters carry no label of ours: `list` reports only filters whose wire form is
 * exactly what this file writes (a lone, canonical `from` criterion, so a bare-domain `from: example.com` is
 * foreign, and one of the two action sets). Foreign filters, and ours after a Gmail-side edit, are ignored.
 * `delete` re-lists right before deleting and removes only an id that listing reported, so a stale or
 * foreign id is never deleted.
 *
 * Accepted trade-off: a filter the user made by hand with exactly this shape cannot be told apart from ours.
 * `create` therefore adopts such an identical filter's id instead of writing a duplicate (it already does
 * what the rule wants), and a later `delete` of that id removes it (the same effect the owner asked to undo).
 * `create` also re-asks safely after an uncertain write, and a create that loses a race to a matching filter
 * still answers that filter's id. `delete` of a filter already gone is success.
 *
 * TODO(live): whether Gmail's `from:@example.com` also matches subdomains (`a.example.com`) needs a check
 * against a real mailbox; the emulator cannot answer it. The mirror writes the `@domain` form regardless.
 *
 * Capability is the grant, not a flag (D5): only `gmail.settings.basic` (the manifest's `filters` feature)
 * can write filters. Without it the account holds no provider rules: `list` answers [] and `create`
 * answers undefined, nothing sent (the engine keeps the rule local). `delete` cannot answer undefined
 * (the engine reads that as "deleted"), so it THROWS a `permission` error: the engine keeps the row and
 * retries, and the Gmail filter is never silently left hiding mail. A 403 `insufficientPermissions` answer
 * marks the account the same way, remembered against the granted-scope list it was seen under: a re-grant
 * (a changed `grantedScopes`) clears it.
 */

const LANE = 'opFlush' as const;
const LIST_FIELDS = 'filter(id,criteria,action)';
const METHOD = {
  list: 'gmail.settings.filters.list',
  create: 'gmail.settings.filters.create',
  delete: 'gmail.settings.filters.delete',
} as const;

/** Gmail's Filter resource, as far as the mirror reads it. */
interface GmailFilter {
  id?: string;
  criteria?: Record<string, unknown>;
  action?: Record<string, unknown>;
}

// ---- criteria: a plain address or domain, never a query ----

/** A criterion is at most an address long. */
const MAX_CRITERION = 254;
/**
 * An address's local part: letters, digits, `.`, `_`, `-` and `+`, starting with a letter, digit or `_`.
 * Gmail search reads a leading `-` as negation and `{ } | * ~ '` as operators or wildcards, so they are out,
 * as are a leading `+` or `.`, a trailing `.` and `..`.
 */
const LOCAL = /^[a-z0-9_](?:[a-z0-9._+-]*[a-z0-9_+-])?$/i;
/** A dotted hostname: labels of letters, digits and inner hyphens, at least one dot. */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const MAX_DOMAIN = 253;
const MAX_LABEL = 63;
/** The last label: letters (a TLD) or punycode, never all digits (that would be an IP-like string). */
const TLD = /^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/i;

/** A sane domain: a dotted hostname in length limits, ending in a real-looking TLD. */
function saneDomain(domain: string): boolean {
  if (domain.length > MAX_DOMAIN || !HOSTNAME.test(domain)) return false;
  const labels = domain.split('.');
  return labels.every(l => l.length <= MAX_LABEL) && TLD.test(labels[labels.length - 1]);
}

/**
 * The value `criteria.from` carries, or undefined when `addressOrDomain` is not one address or one domain.
 * A whitelist on purpose: whitespace, quotes, braces, pipes, stars, parentheses and colons can never appear, nor a leading `-`, so a sender
 * string cannot smuggle a Gmail search operator (`x@a.test OR y@b.test` would widen a block to a second
 * sender, and `has:attachment` would change what it matches). An address is lower-cased; a domain comes
 * back in the `@domain` form Gmail's own filter UI uses.
 */
export function filterCriterion(addressOrDomain: string): string | undefined {
  const value = addressOrDomain.trim().toLowerCase();
  if (!value || value.length > MAX_CRITERION || /\s/.test(value)) return undefined;
  const at = value.indexOf('@');
  if (at > 0)
    return LOCAL.test(value.slice(0, at)) &&
      !value.slice(0, at).includes('..') &&
      saneDomain(value.slice(at + 1))
      ? value
      : undefined;
  const domain = at === 0 ? value.slice(1) : value;
  return saneDomain(domain) ? `@${domain}` : undefined;
}

// ---- the remote shape ----

/** Google may echo an unset field as a default: `false`, `0`, `''`, `[]`, `'unspecified'` (`sizeComparison`). */
function isUnset(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0) return true;
  if (value === '' || value === 'unspecified') return true;
  return Array.isArray(value) && value.length === 0;
}

/** Fields beyond `known` that are actually set. */
function extraFields(body: Record<string, unknown>, known: readonly string[]): [string, unknown][] {
  return Object.entries(body).filter(([k, v]) => !known.includes(k) && !isUnset(v));
}

const asIds = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every(v => typeof v === 'string') ? (value as string[]) : undefined;

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every(x => b.includes(x));

/** The rule action a filter action means, or undefined when it is not one of the two action sets. */
function ruleAction(action: Record<string, unknown>): SenderRule['action'] | undefined {
  if (extraFields(action, ['addLabelIds', 'removeLabelIds']).length) return undefined;
  const add = action.addLabelIds === undefined ? [] : asIds(action.addLabelIds);
  const remove = action.removeLabelIds === undefined ? [] : asIds(action.removeLabelIds);
  if (!add || !remove) return undefined;
  if (sameIds(add, ['SPAM']) && sameIds(remove, ['INBOX'])) return 'block';
  if (add.length === 0 && sameIds(remove, ['INBOX'])) return 'skipInbox';
  return undefined;
}

/**
 * A filter read back as the rule it mirrors, or undefined when it is not a shape this file writes — the
 * only filters `list` reports and `delete` may target, so foreign filters are never claimed.
 */
export function ruleOfFilter(filter: GmailFilter): RemoteRule | undefined {
  const { criteria, action } = filter;
  if (typeof filter.id !== 'string' || !criteria || !action) return undefined;
  if (typeof criteria.from !== 'string' || extraFields(criteria, ['from']).length) return undefined;
  const addressOrDomain = filterCriterion(criteria.from);
  // The exact wire form only: a bare `example.com` (or a different case) is somebody else's filter.
  if (addressOrDomain !== criteria.from) return undefined;
  const what = ruleAction(action);
  return addressOrDomain && what
    ? { remoteId: filter.id, addressOrDomain, action: what }
    : undefined;
}

const sameRule = (filter: GmailFilter, from: string, action: SenderRule['action']): boolean => {
  const rule = ruleOfFilter(filter);
  return rule?.addressOrDomain === from && rule.action === action;
};

/** The refusal for a sender rule that is not a plain address or domain; permanent, never retried. */
const invalidRule = (): ProviderError =>
  new ProviderError({
    class: 'permanent',
    provider: 'gmail',
    method: METHOD.create,
    reason: 'invalidRule',
    providerMessage: 'A sender rule is a plain address or domain, never a query',
  });

/** Gmail's "Filter already exists" answer to a create of an identical filter. */
const isDuplicate = (error: unknown): boolean =>
  error instanceof ProviderError &&
  error.error.status === 400 &&
  /already exists/i.test(error.error.providerMessage ?? '');

/** The criteria and action one rule writes; the same shape `ruleOfFilter` accepts back. */
function bodyOf(rule: SenderRule): { criteria: { from: string }; action: Record<string, unknown> } {
  const from = filterCriterion(rule.addressOrDomain);
  if (!from) throw invalidRule();
  return {
    criteria: { from },
    action:
      rule.action === 'block'
        ? { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] }
        : { removeLabelIds: ['INBOX'] },
  };
}

// ---- the calls ----

async function listAll(client: GmailClient): Promise<GmailFilter[]> {
  const page = await client.call<{ filter?: GmailFilter[] }>({
    method: METHOD.list,
    path: '/settings/filters',
    fields: LIST_FIELDS,
    lane: LANE,
  });
  return page.filter ?? [];
}

async function createRemote(client: GmailClient, body: ReturnType<typeof bodyOf>): Promise<string> {
  const created = await client.call<{ id?: string }>({
    method: METHOD.create,
    path: '/settings/filters',
    httpMethod: 'POST',
    body,
    fields: 'id',
    lane: LANE,
    kind: 'write',
  });
  if (!created?.id) throw new Error('filters.create returned no filter id');
  return created.id;
}

async function deleteRemote(client: GmailClient, remoteId: string): Promise<void> {
  // Only an id the listing reports as ours: re-list right before deleting, so a stale id, or one that
  // became a foreign filter, is left alone. Absent is success (the port's delete is idempotent).
  const ours = (await listAll(client)).some(f => f.id === remoteId && ruleOfFilter(f));
  if (!ours) return;
  try {
    await client.call({
      method: METHOD.delete,
      path: `/settings/filters/${encodeURIComponent(remoteId)}`,
      httpMethod: 'DELETE',
      lane: LANE,
      kind: 'idempotentWrite',
      item: remoteId,
    });
  } catch (error) {
    // Already gone is success: the port's delete is idempotent.
    if (error instanceof ProviderError && error.error.status === 404) return;
    throw error;
  }
}

/** The refusal of a `delete` the account cannot perform; the engine keeps the row and retries. */
const noFiltersScope = (): ProviderError =>
  new ProviderError({
    class: 'permission',
    provider: 'gmail',
    method: METHOD.delete,
    reason: 'insufficientPermissions',
    providerMessage: 'The account has not granted gmail.settings.basic',
    missingScopes: googleScopeManifest.filter(e => e.feature === 'filters').map(e => e.scope),
  });

const isPermission = (error: unknown): boolean =>
  error instanceof ProviderError && error.error.class === 'permission';

/**
 * The adapter's `rules`. Capability and the `permission` refusal live in the closure: once Google has said
 * the token lacks the settings scope, nothing is sent again while the granted-scope list is the one it was
 * seen under (a re-grant changes it and clears the refusal). The idempotence of `create` and `delete` is
 * in the calls themselves, so the whole operation can be re-asked after an uncertain answer.
 */
export function gmailRules(deps: GmailDeps): RulesAdapter {
  /** The granted-scope list under which Google refused, or undefined. */
  let deniedUnder: string | undefined;
  const scopesKey = (ctx: AdapterContext): string =>
    [...ctx.account.grantedScopes].sort().join(' ');
  const capable = (ctx: AdapterContext): boolean =>
    deniedUnder !== scopesKey(ctx) && grantedFeatures(ctx.account.grantedScopes).has('filters');

  /** Answers `none` when the account cannot hold provider rules; a `permission` refusal is remembered. */
  async function guarded<T>(ctx: AdapterContext, none: T, run: () => Promise<T>): Promise<T> {
    if (!capable(ctx)) return none;
    try {
      return await run();
    } catch (error) {
      if (!isPermission(error)) throw error;
      deniedUnder = scopesKey(ctx);
      return none;
    }
  }

  /** A delete cannot answer `none` (the engine reads that as done): it throws when it cannot be performed. */
  async function deleteGuarded(remoteId: string, ctx: AdapterContext): Promise<void> {
    if (!capable(ctx)) throw noFiltersScope();
    try {
      await deleteRemote(new GmailClient(deps, ctx), remoteId);
    } catch (error) {
      if (isPermission(error)) deniedUnder = scopesKey(ctx);
      throw error;
    }
  }

  return {
    list: ctx =>
      guarded(ctx, [] as RemoteRule[], async () =>
        (await listAll(new GmailClient(deps, ctx))).flatMap(f => ruleOfFilter(f) ?? []),
      ),
    create: async (rule, ctx) => {
      // Validation before the capability check: a bad rule is refused, not silently local.
      const body = bodyOf(rule);
      return guarded(
        ctx,
        // The engine's RulesPort answers `undefined` when the account cannot hold provider rules.
        undefined as unknown as string,
        async () => {
          const client = new GmailClient(deps, ctx);
          // Adopting an identical existing filter is the documented trade-off (file header).
          const seen = (await listAll(client)).find(f =>
            sameRule(f, body.criteria.from, rule.action),
          );
          if (seen?.id) return seen.id;
          try {
            return await createRemote(client, body);
          } catch (error) {
            // A writer elsewhere (a phone's Gmail) can win between the list and the create.
            if (!isDuplicate(error)) throw error;
            const again = (await listAll(client)).find(f =>
              sameRule(f, body.criteria.from, rule.action),
            );
            if (again?.id) return again.id;
            throw error;
          }
        },
      );
    },
    delete: deleteGuarded,
  };
}
