import { FakeClock } from '../src/kit/clock';
import {
  createGmailEmulator,
  SCOPE,
  type GmailEmulator,
  type GmailEmulatorOptions,
} from '../src/gmail';

export const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const ALL_SCOPES = [
  'openid',
  'email',
  'profile',
  SCOPE.gmailModify,
  SCOPE.gmailSettingsBasic,
];

export interface ApiResult {
  status: number;
  headers: Headers;
  json: any;
  text: string;
}

export interface Harness {
  clock: FakeClock;
  emu: GmailEmulator;
  /** The current access token (changes after `renew`). */
  readonly token: string;
  refreshToken?: string;
  /** Gets a fresh access token with the refresh token, for tests that let hours pass. */
  renew(): Promise<void>;
  /** Calls a path below /users/me with the signed-in token. JSON bodies are stringified. */
  api(
    path: string,
    init?: { method?: string; body?: unknown; headers?: Record<string, string>; token?: string },
  ): Promise<ApiResult>;
}

export async function result(response: Response): Promise<ApiResult> {
  const text = await response.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, json, text };
}

/** An emulator with one signed-in test user and a fast clock. Latency is zero unless a test asks for it. */
export async function setup(
  options: Partial<GmailEmulatorOptions> & {
    threads?: number;
    scopes?: string[];
    start?: number;
  } = {},
): Promise<Harness> {
  const { threads, scopes, start, ...rest } = options;
  const clock = new FakeClock(start === undefined ? {} : { start });
  const emu = createGmailEmulator({ clock, latencyMs: 0, ...rest });
  emu.oauth.addClient('test-client');
  if (threads) emu.seedMailbox({ threads, seed: 7 });
  const session = await emu.oauth.signIn({
    clientId: 'test-client',
    scopes: scopes ?? ALL_SCOPES,
    fetch: emu.fetch,
  });
  let current = session.accessToken;
  const harness: Harness = {
    clock,
    emu,
    get token() {
      return current;
    },
    refreshToken: session.refreshToken,
    async renew() {
      const response = await emu.fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: session.refreshToken!,
          client_id: 'test-client',
        }),
      });
      current = (await response.json()).access_token;
    },
    async api(path, init = {}) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${init.token ?? current}`,
        ...init.headers,
      };
      let body: string | undefined;
      if (init.body !== undefined) {
        body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
        headers['content-type'] ??= 'application/json';
      }
      return result(
        await emu.fetch(`${BASE}${path}`, { method: init.method ?? 'GET', headers, body }),
      );
    },
  };
  return harness;
}

export const b64 = (text: string): string => Buffer.from(text).toString('base64url');

/** A tiny RFC 822 message as the `raw` field wants it. */
export function rawMessage(fields: {
  to?: string;
  subject?: string;
  body?: string;
  messageId?: string;
  extra?: string[];
}): string {
  const lines = [
    `To: ${fields.to ?? 'friend@example.test'}`,
    `Subject: ${fields.subject ?? 'Test subject'}`,
    ...(fields.messageId ? [`Message-ID: <${fields.messageId}>`] : []),
    ...(fields.extra ?? []),
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    fields.body ?? 'Hello from a test.',
  ];
  return b64(lines.join('\r\n'));
}

export interface BatchCall {
  method?: string;
  path: string;
  body?: unknown;
}

export interface BatchAnswer {
  contentId: string;
  status: number;
  json: any;
}

/** Sends a multipart/mixed batch and parses the multipart answer. */
export async function sendBatch(
  emu: GmailEmulator,
  token: string,
  calls: BatchCall[],
): Promise<{ status: number; answers: BatchAnswer[]; json: any }> {
  const boundary = 'batch_test_boundary';
  const parts = calls.map((call, index) => {
    const body = call.body === undefined ? '' : JSON.stringify(call.body);
    return [
      `--${boundary}`,
      'Content-Type: application/http',
      `Content-ID: <item${index + 1}>`,
      '',
      `${call.method ?? 'GET'} /gmail/v1/users/me${call.path} HTTP/1.1`,
      ...(body ? ['Content-Type: application/json', '', body] : ['']),
      '',
    ].join('\r\n');
  });
  const response = await emu.fetch('https://gmail.googleapis.com/batch/gmail/v1', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/mixed; boundary=${boundary}`,
    },
    body: `${parts.join('')}--${boundary}--\r\n`,
  });
  const text = await response.text();
  if (response.status !== 200)
    return { status: response.status, answers: [], json: text ? JSON.parse(text) : undefined };
  const answerBoundary = /boundary=(\S+)/.exec(response.headers.get('content-type')!)![1];
  const answers = text
    .split(`--${answerBoundary}`)
    .filter(chunk => /Content-ID/i.test(chunk))
    .map(chunk => {
      const contentId = /Content-ID: <response-([^>]*)>/i.exec(chunk)![1];
      const inner = chunk.slice(chunk.indexOf('HTTP/1.1'));
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(inner)![1]);
      const bodyText = inner
        .split(/\r\n\r\n/)
        .slice(1)
        .join('\r\n\r\n')
        .trim();
      return { contentId, status, json: bodyText ? JSON.parse(bodyText) : undefined };
    });
  return { status: 200, answers, json: undefined };
}
