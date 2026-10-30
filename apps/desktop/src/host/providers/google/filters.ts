import {
  ProviderError,
  type AdapterContext,
  type RemoteRule,
  type RulesAdapter,
  type SenderRule,
} from '@aplos/engine/ports';
import { grantedFeatures } from '../oauth/scopes';
import { GmailClient, type GmailDeps, type GmailRequest } from './client';

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
 * (Gmail's own domain-filter convention; a bare domain is canonicalized to it). `list` reads back only
 * filters of exactly this shape — a lone `from` criterion and one of the two action sets — so foreign
 * filters, and ours after a Gmail-side edit, are ignored and never deleted. `create` lists first and
 * returns an identical filter's id rather than writing a duplicate (an edit is the engine's
 * delete-and-recreate, and the engine may re-ask after an uncertain write); a create that loses a race to
 * a matching filter still answers that filter's id. `delete` of a filter already gone is success.
 *
 * Capability is the grant, not a flag (D5): only `gmail.settings.basic` (the manifest's `filters` feature)
 * can write filters. Without it the account holds no provider rules — `list` answers [] and `create`
 * answers undefined, and nothing is sent — and a 403 `insufficientPermissions` answer marks the account
 * the same way for the adapter's lifetime, so the refusal is never repeated.
 */

const LANE = 'opFlush' as const;
const LIST_FIELDS = 'filter(id,criteria,action)';
const METHOD = {
  list: 'gmail.settings.filters.list',
  create: 'gmail.settings.filters.create',
  delete: 'gmail.settings.filters.delete',
} as const;

/**
 * `GmailRequest.httpMethod` names only GET and POST today (widening it is prov-gmail's `client.ts`); the
 * string is passed to fetch as-is, so this still sends a real HTTP DELETE.
 */
const HTTP_DELETE = 'DELETE' as unknown as GmailRequest['httpMethod'];

/** Gmail's Filter resource, as far as the mirror reads it. */
interface GmailFilter {
  id?: string;
  criteria?: Record<string, unknown>;
  action?: Record<string, unknown>;
}

// ---- criteria: a plain address or domain, never a query ----

/** A criterion is at most an address long. */
const MAX_CRITERION = 254;
/** RFC 5322 atom characters: an address's local part, without quoted strings. */
const LOCAL = /^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+$/i;
/** A dotted hostname: labels of letters, digits and inner hyphens, at least one dot. */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * The value `criteria.from` carries, or undefined when `addressOrDomain` is not one address or one domain.
 * A whitelist on purpose: whitespace, quotes, braces, parentheses and colons can never appear, so a sender
 * string cannot smuggle a Gmail search operator (`x@a.test OR y@b.test` would widen a block to a second
 * sender, and `has:attachment` would change what it matches). An address is lower-cased; a domain comes
 * back in the `@domain` form Gmail's own filter UI uses.
 */
export function filterCriterion(addressOrDomain: string): string | undefined {
  const value = addressOrDomain.trim().toLowerCase();
  if (!value || value.length > MAX_CRITERION || /\s/.test(value)) return undefined;
  const at = value.indexOf('@');
  if (at > 0)
    return LOCAL.test(value.slice(0, at)) && HOSTNAME.test(value.slice(at + 1)) ? value : undefined;
  const domain = at === 0 ? value.slice(1) : value;
  return HOSTNAME.test(domain) ? `@${domain}` : undefined;
}

// ---- the remote shape ----

/** Fields beyond `known` that are actually set: `false` is "unset" for Google's echoed booleans. */
function extraFields(body: Record<string, unknown>, known: readonly string[]): [string, unknown][] {
  return Object.entries(body).filter(
    ([k, v]) => !known.includes(k) && v !== undefined && v !== false,
  );
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
  try {
    await client.call({
      method: METHOD.delete,
      path: `/settings/filters/${encodeURIComponent(remoteId)}`,
      httpMethod: HTTP_DELETE,
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

/**
 * The adapter's `rules`. Capability and the one-time `permission` refusal live in the closure: once Google
 * has said the token lacks the settings scope, nothing is sent again for this account's adapter lifetime
 * (a re-grant rebuilds the adapter). The idempotence of `create` and `delete` is in the calls themselves,
 * so the whole operation can be re-asked after an uncertain answer.
 */
export function gmailRules(deps: GmailDeps): RulesAdapter {
  let denied = false;
  const capable = (ctx: AdapterContext): boolean =>
    !denied && grantedFeatures(ctx.account.grantedScopes).has('filters');

  /** Answers `none` when the account cannot hold provider rules; a `permission` refusal is remembered. */
  async function guarded<T>(ctx: AdapterContext, none: T, run: () => Promise<T>): Promise<T> {
    if (!capable(ctx)) return none;
    try {
      return await run();
    } catch (error) {
      if (error instanceof ProviderError && error.error.class === 'permission') {
        denied = true;
        return none;
      }
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
    delete: (remoteId, ctx) =>
      guarded(ctx, undefined, () => deleteRemote(new GmailClient(deps, ctx), remoteId)),
  };
}
