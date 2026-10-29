import type { Frame } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import type { MethodContext } from '../src/methods/types';
import type { EngineServices } from '../src/runtime/services';
import type {
  AccountActorHost,
  AccountRuntime,
  ConnectRequest,
  ConnectResult,
  DeadlineSource,
} from '../src/ports';
import { openStore, type StorePort } from '../src/store';
import { tempDb, T0 } from './store/helpers';

export const CAPS = {
  labels: true,
  folders: false,
  drafts: true,
  serverSearch: true,
  calendar: true,
  filters: true,
  push: false,
  sendAs: true,
  unsubscribeHeaders: true,
  threading: 'native' as const,
};

export function answer(subject: string, address: string): ConnectResult {
  return {
    identity: { subject, address, displayName: 'Owner' },
    grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'],
    capabilities: CAPS,
    grant: { grantedAt: T0, refreshExpiresAt: T0 + 7 * 86_400_000, client: 'client-1' },
    credentialRef: 'vault:secret-credential-ref',
  };
}

interface Pending {
  account: string;
  kind: string;
  req: ConnectRequest;
  resolve(r: ConnectResult): void;
  reject(e: unknown): void;
}

export function setup() {
  const file = tempDb();
  const store: StorePort = openStore(file.open(), { now: () => T0 });
  const frames: Frame[] = [];
  const calls: string[] = [];
  const pending: Pending[] = [];
  const statuses = new Map<string, AccountRuntime>();
  const flags = { failStart: false, failWaiting: false, failDiscard: false };
  const discards: { account: string; kind: string; ref: string }[] = [];
  const clock = { t: T0, now: () => clock.t };
  const sources: DeadlineSource[] = [];
  const accounts = {
    connect: (account: string, kind: string, req: ConnectRequest) =>
      new Promise<ConnectResult>((resolve, reject) => {
        pending.push({ account, kind, req, resolve, reject });
      }),
    start: async (id: string) => {
      calls.push(`start:${id}`);
      if (flags.failStart) throw new Error('actor did not start');
    },
    stop: async (id: string, why: string) => void calls.push(`stop:${id}:${why}`),
    reconnected: async (id: string) => void calls.push(`reconnected:${id}`),
    discardCredential: async (account: string, kind: string, ref: string) => {
      discards.push({ account, kind, ref });
      if (flags.failDiscard) throw new Error('the vault is read-only');
    },
    claimLease: async (id: string) => void calls.push(`claim:${id}`),
    releaseLease: async (id: string) => void calls.push(`release:${id}`),
    status: (id: string) => statuses.get(id),
  } as unknown as AccountActorHost;
  let n = 0;
  const services = {
    store,
    accounts,
    frames: {
      emit: (f: unknown) => {
        const frame = f as Frame;
        if (flags.failWaiting && frame.frame === 'connect' && frame.state === 'waiting')
          throw new Error('frame bus down');
        frames.push(frame);
      },
      changed() {},
      reset() {},
    },
    clock,
    deadlines: {
      register: (source: DeadlineSource) => {
        sources.push(source);
        return () => void sources.splice(sources.indexOf(source), 1);
      },
      changed() {},
    },
    randomBytes: (len: number) => new Uint8Array(len).fill(++n),
  } as unknown as EngineServices;
  const ctx = {
    caller: { kind: 'window', scopes: ['admin'] },
    signal: new AbortController().signal,
    services,
    connectionId: 'c1',
    redispatch: () => Promise.reject(new Error('unused')),
  } as MethodContext;
  const db = file.open();
  return {
    store,
    frames,
    calls,
    pending,
    statuses,
    flags,
    discards,
    accounts,
    clock,
    sources,
    ctx,
    db,
    connectFrames: () => frames.filter(f => f.frame === 'connect'),
    cleanup() {
      store.close();
      db.close();
      file.cleanup();
    },
  };
}

export function seed(
  store: StorePort,
  id = 'acct-1',
  subject = 'sub-1',
  address = 'owner@gmail.com',
) {
  store.commit({
    opId: `seed-${id}`,
    origin: 'system',
    writes: [
      {
        kind: 'account',
        id,
        provider: 'google',
        address,
        displayName: 'Owner',
        capabilities: { ...CAPS },
        grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'],
        status: { state: 'ok' },
        remoteSubject: subject,
        refreshExpiresAt: T0 + 1000,
      },
    ],
  });
}

export const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));
export const sentence = (e: unknown) => (e instanceof ContractError ? e.body.message : String(e));
