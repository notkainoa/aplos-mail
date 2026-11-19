import type { Page } from '@playwright/test';

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** True for a URL that stays on the machine: loopback hosts and non-network schemes. */
export function isLocalRequest(url: string): boolean {
  const { protocol, hostname } = new URL(url);
  if (['data:', 'blob:', 'about:'].includes(protocol)) return true;
  return loopbackHosts.has(hostname);
}

/** Violation `blockedURI` values are URLs for network loads, but also "inline", "eval", "data" ... */
function externalTarget(blockedUri: string): string | undefined {
  try {
    return isLocalRequest(blockedUri) ? undefined : blockedUri;
  } catch {
    return undefined;
  }
}

let counter = 0;

/**
 * Watches everything a page tries to send off the machine, from the moment it is called:
 *  - requests and WebSockets that were sent (`external()`),
 *  - attempts the page's Content Security Policy blocked before they were sent (`blocked()`).
 * Chromium emits no request event for a CSP-blocked load, so `securitypolicyviolation` events are
 * recorded too; a page that tried to reach an outside host fails the check even when the policy
 * stopped it. `attempts()` is both lists, `violations` is every CSP violation (inline, eval too).
 */
export async function trackRequests(page: Page) {
  const urls: string[] = [];
  const sockets: string[] = [];
  const violations: { blockedURI: string; directive: string }[] = [];

  page.on('request', request => urls.push(request.url()));
  page.on('websocket', socket => sockets.push(socket.url()));

  const report = `__aplosReportViolation${counter++}`;
  await page.exposeFunction(report, (blockedURI: string, directive: string) => {
    violations.push({ blockedURI, directive });
  });
  await page.addInitScript(name => {
    document.addEventListener('securitypolicyviolation', event => {
      (window as unknown as Record<string, (a: string, b: string) => void>)[name](
        event.blockedURI,
        event.effectiveDirective,
      );
    });
  }, report);

  const outside = (list: string[]) => list.filter(url => !isLocalRequest(url));
  return {
    urls,
    sockets,
    violations,
    /** Requests and WebSockets that were sent to a host other than 127.0.0.1 / localhost. */
    external: () => [...outside(urls), ...outside(sockets)],
    /** Outside hosts the page tried to reach but its Content Security Policy blocked. */
    blocked: () =>
      violations.map(v => externalTarget(v.blockedURI)).filter((url): url is string => !!url),
    /** Everything the page attempted to send off the machine, sent or blocked. */
    attempts() {
      return [...this.external(), ...this.blocked()];
    },
  };
}
