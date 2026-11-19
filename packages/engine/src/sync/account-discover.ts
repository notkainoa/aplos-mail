import type { Output } from '@aplos/contract';

export type Discovery = Output<'Account/discover'>;

const GOOGLE_DOMAINS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com']);

/**
 * Which provider an address or domain belongs to, offline. Round 1 connects Google only, and only the consumer domains
 * are recognisable without a network lookup: a Google Workspace domain cannot be told from any other by its name.
 */
export function discoverProvider(input: { address?: string; domain?: string }): Discovery {
  const domain = domainOf(input);
  if (GOOGLE_DOMAINS.has(domain)) return { provider: 'google', preset: 'gmail' };
  return {
    provider: 'unsupported',
    reasonCode: 'discover.unsupported',
    message:
      'Aplos can add Gmail accounts for now. Support for other mail providers is coming later.',
  };
}

function domainOf(input: { address?: string; domain?: string }): string {
  const raw = input.address
    ? input.address.slice(input.address.lastIndexOf('@') + 1)
    : input.domain;
  return (raw ?? '').trim().replace(/^@/, '').toLowerCase();
}
