import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isBrowserTraffic } from '../canary';
import { PROBE_REPORTER } from './probe-reporter';

// A local stand-in for the `aplos-mail://` protocol relay (html-4 and html-5 are not built): it serves the SANITIZED
// document the way the real frame will, as a sandboxed iframe's document with the engine-built response headers,
// and answers `img/<n>` and `cid/<n>` from canned image bytes of its own (never from the remote URL a message names).

/** A 1x1 transparent PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export interface FrameHeaderOptions {
  /** The server origin, such as `http://127.0.0.1:5000`. In the app this is `aplos-mail://m`. */
  origin: string;
  token: string;
  /** `false` serves the document with no policy at all, to test the sanitizer without its backstop. */
  csp: boolean;
}

/**
 * Every response header of the frame document, built in one place (ARCHITECTURE 10 and plan 10 E4 item 5). html-4's
 * `Mail/serve` replaces this; keep the two lists in step. The `img-src` form is stricter than ARCHITECTURE's scheme-wide
 * `aplos-mail:`: only paths under this token's `img/` and `cid/`.
 */
export function frameHeaders(options: FrameHeaderOptions): Record<string, string> {
  const base = `${options.origin}/m/${options.token}`;
  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
  if (!options.csp) return headers;
  headers['Content-Security-Policy'] = [
    "default-src 'none'",
    `script-src ${PROBE_REPORTER.cspHash}`,
    "style-src 'unsafe-inline'",
    `img-src ${base}/img/ ${base}/cid/ data:`,
    'font-src data:',
    "media-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    'sandbox allow-scripts allow-popups',
  ].join('; ');
  return headers;
}

/** The sandbox attribute of the iframe that hosts the document: scripts for the reporter, popups for links, never the origin. */
export const FRAME_SANDBOX = 'allow-scripts allow-popups';

export interface FrameDocument {
  html: string;
  csp: boolean;
  /** `img/<n>` answers for n below this (the sanitizer's `remoteImages`; 0 while images are blocked). */
  remoteImages: number;
  /** `cid/<n>` answers for n below this. */
  cids: number;
  /** Markup added to the host page next to the frame (positive controls only). */
  hostHtml?: string;
}

export interface FrameRequest {
  token: string | undefined;
  path: string;
  /** What the harness expected this to be: `host`, `doc`, `img`, `cid`, or `stray`. */
  kind: 'host' | 'doc' | 'img' | 'cid' | 'stray';
  status: number;
  /** False for Node's own instrumentation, which probes every port this process listens on. */
  fromBrowser: boolean;
  /** The request's headers, to name what asked. */
  headers: Record<string, string | string[] | undefined>;
}

export interface FrameServer {
  origin: string;
  requests: FrameRequest[];
  register: (document: FrameDocument) => string;
  hostUrl: (token: string) => string;
  close: () => Promise<void>;
}

function hostPage(token: string, extra: string): string {
  return `<!doctype html><meta charset="utf-8"><title>host</title>
<body style="margin:0">${extra}<iframe id="f" sandbox="${FRAME_SANDBOX}" src="/m/${token}/doc" style="border:0;width:1000px;height:1600px"></iframe>
<script>
window.reports = [];
addEventListener('message', function (e) {
  if (e.source === document.getElementById('f').contentWindow) window.reports.push(e.data);
});
window.collect = function () {
  return new Promise(function (resolve) {
    var n = window.reports.length;
    document.getElementById('f').contentWindow.postMessage('collect', '*');
    var timer = setInterval(function () {
      if (window.reports.length > n) { clearInterval(timer); resolve(window.reports[window.reports.length - 1]); }
    }, 20);
    setTimeout(function () { clearInterval(timer); resolve(null); }, 4000);
  });
};
</script>`;
}

export async function startFrameServer(): Promise<FrameServer> {
  const documents = new Map<string, FrameDocument>();
  const requests: FrameRequest[] = [];
  let origin = '';
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    const match = /^\/(host|m)\/([0-9a-f]{32})(?:\/(doc|img\/(\d+)|cid\/(\d+)))?$/.exec(path);
    const token = match?.[2];
    const document = token === undefined ? undefined : documents.get(token);
    const done = (kind: FrameRequest['kind'], status: number) =>
      requests.push({
        token,
        path,
        kind,
        status,
        fromBrowser: isBrowserTraffic(request.headers),
        headers: request.headers,
      });
    if (!match || !document || !token) {
      done('stray', 404);
      response.writeHead(404).end();
    } else if (match[1] === 'host' && match[3] === undefined) {
      done('host', 200);
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(hostPage(token, document.hostHtml ?? ''));
    } else if (match[1] === 'm' && match[3] === 'doc') {
      done('doc', 200);
      response.writeHead(200, frameHeaders({ origin, token, csp: document.csp }));
      response.end(document.html);
    } else if (
      match[1] === 'm' &&
      match[4] !== undefined &&
      Number(match[4]) < document.remoteImages
    ) {
      done('img', 200);
      response
        .writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
        .end(PNG);
    } else if (match[1] === 'm' && match[5] !== undefined && Number(match[5]) < document.cids) {
      done('cid', 200);
      response
        .writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
        .end(PNG);
    } else {
      done('stray', 404);
      response.writeHead(404).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    requests,
    register(document) {
      const token = randomBytes(16).toString('hex');
      documents.set(token, document);
      return token;
    },
    hostUrl: token => `${origin}/host/${token}`,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
