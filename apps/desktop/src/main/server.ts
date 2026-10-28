import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDevEnv } from './env';
import { createServer as createViteServer } from 'vite';
import { createService } from './service';
import { appVersion } from '../shared/version';
import type { Listener } from '@aplos/contract/legacy/types';
import { legacyDesktopMethods, legacyEngineMethods } from '@aplos/contract/allowlists';

export const serviceMethods = new Set<string>(legacyEngineMethods);
const webMethods = new Set<string>(legacyDesktopMethods);
// Ports can move (APLOS_API_PORT / APLOS_VITE_PORT) so several checkouts can preview side by side.
const apiPort = Number(process.env.APLOS_API_PORT) || 4317,
  vitePort = Number(process.env.APLOS_VITE_PORT) || 5173;
const origins = new Set([
  `http://127.0.0.1:${vitePort}`,
  `http://localhost:${vitePort}`,
  `http://127.0.0.1:${apiPort}`,
]);
export function isTrustedRequest(req: Pick<IncomingMessage, 'headers'>, port = apiPort): boolean {
  return (
    (req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`) &&
    (!req.headers.origin || origins.has(req.headers.origin))
  );
}
async function readBody(req: IncomingMessage): Promise<{ method: string; payload?: unknown }> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const part of req) {
    size += part.length;
    if (size > 36 * 1024 * 1024) throw new Error('Request exceeds the 25 MB attachment limit.');
    parts.push(part);
  }
  const input = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (!input || typeof input.method !== 'string') throw new Error('A method is required.');
  return input;
}
export async function startServer(
  options: {
    service?: Awaited<ReturnType<typeof createService>>;
    onClose?: () => Promise<void>;
    loadEnv?: boolean;
    port?: number;
    vite?: boolean;
  } = {},
) {
  if (options.loadEnv !== false) loadDevEnv();
  const service =
    options.service ??
    (await createService({
      dataDir:
        process.env.APLOS_DATA_DIR ||
        join(homedir(), 'Library', 'Application Support', 'Aplos Mail Preview'),
      desktop: false,
      symbolTool: join(process.cwd(), 'dist', 'bin', 'aplos-symbols'),
      openExternal: async () => {
        throw new Error('Open Aplos Mail desktop to connect a Google account.');
      },
    }));
  const streams = new Set<ServerResponse>();
  const unsubscribe = service.subscribe((event: Parameters<Listener>[0]) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const stream of streams) stream.write(frame);
  });
  const server = createServer(async (req, res) => {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (!isTrustedRequest(req, (server.address() as { port: number }).port)) {
      json(403, { error: 'Untrusted request origin.' });
      return;
    }
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/invoke') {
      try {
        if (!req.headers['content-type']?.startsWith('application/json')) {
          json(415, { error: 'Use application/json.' });
          return;
        }
        const { method, payload } = await readBody(req);
        if (method === 'app.info') {
          json(200, { result: { name: 'Aplos Mail', version: appVersion, desktop: false } });
          return;
        }
        if (method === 'update.status' || method === 'update.check') {
          json(200, {
            result: {
              currentVersion: appVersion,
              status: { state: 'disabled', reason: 'Updates are off in the browser preview.' },
            },
          });
          return;
        }
        if (method === 'window.claim') {
          json(200, { result: true });
          return;
        }
        if (method === 'window.release') {
          json(200, { result: true });
          return;
        }
        if (webMethods.has(method))
          throw new Error('This action requires the Aplos Mail desktop app.');
        if (!serviceMethods.has(method)) throw new Error('Unsupported application method.');
        json(200, { result: await service.invoke(method, payload) });
      } catch (error) {
        json(400, { error: error instanceof Error ? error.message : 'Request failed.' });
      }
      return;
    }
    json(404, { error: 'Endpoint not found.' });
  });
  const heartbeat = setInterval(() => {
    for (const stream of streams) stream.write(': keepalive\n\n');
  }, 20000);
  heartbeat.unref();
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  let stopping = false;
  const close = async () => {
    if (stopping) return;
    stopping = true;
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    clearInterval(heartbeat);
    unsubscribe();
    for (const stream of streams) stream.end();
    await vite?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await service.close();
    await options.onClose?.();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? apiPort, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (options.vite !== false) {
      process.env.VITE_APLOS_API_PORT = String((server.address() as { port: number }).port);
      vite = await createViteServer();
      await vite.listen();
    }
  } catch (error) {
    await close();
    throw error;
  }
  if (options.vite !== false)
    console.log(
      `Aplos Mail: http://127.0.0.1:${vitePort} (loopback API :${(server.address() as { port: number }).port})`,
    );
  function shutdown() {
    void close().finally(() => process.exit(0));
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { server, service, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  startServer().catch(error => {
    console.error(error instanceof Error ? error.message : 'Development server failed.');
    process.exitCode = 1;
  });
