import type { Page } from '@playwright/test';

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Requests that do not leave the machine: loopback hosts and non-network schemes. */
export function isLocalRequest(url: string): boolean {
  const { protocol, hostname } = new URL(url);
  if (['data:', 'blob:', 'about:'].includes(protocol)) return true;
  return loopbackHosts.has(hostname);
}

/** Records every request the page makes, from the moment it is called. */
export function trackRequests(page: Page) {
  const urls: string[] = [];
  page.on('request', request => urls.push(request.url()));
  return {
    urls,
    /** Requests that would leave 127.0.0.1 / localhost. */
    external: () => urls.filter(url => !isLocalRequest(url)),
  };
}
