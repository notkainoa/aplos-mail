import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { printableMessage, RunnerError } from './errors';
import { clientFromEnv, refreshAccessToken, TokenRefusal, withBearer } from './auth';
import {
  DEFAULT_EVIDENCE_DIR,
  writeEvidence,
  type EvidenceResult,
  type SkipReason,
} from './evidence';
import {
  createGuardedFetch,
  GuardRefusal,
  mergeRequests,
  readOnlyViolations,
  requestsSince,
  type GuardedFetch,
} from './guard';
import { createPacedFetch, UnitPacer } from './pacer';
import { PROBES, probesFor } from './probes';
import {
  TIERS,
  type LiveProvider,
  type ProbeContext,
  type ProbeResult,
  type RequestCount,
  type SmokeProbe,
  type Tier,
} from './types';
import {
  addressMatches,
  keychainReader,
  loadAccounts,
  preflight,
  reconnectBy,
  vaultDir,
  type AccountMeta,
  type SecretReader,
} from './vault';

/**
 * The live-provider runner (plan 20 section 5.4): loads a test account from the vault, checks that
 * its token will outlive the run, builds the guarded fetch, runs the probes of one tier and writes
 * the content-free evidence file. Tier S (sending to others) does not exist here.
 */

/** Tiers that change the mailbox run only on the agent test account, never on another label. */
const MUTATING_ACCOUNTS: readonly string[] = ['agent'];
/** A generous guess per probe plus slack; a token that would expire inside this window is skipped. */
const EXPECTED_MS_PER_PROBE = 2 * 60_000;
const EXPECTED_SLACK_MS = 60_000;

export interface RunArgs {
  provider: LiveProvider;
  tier: Tier;
  account: string;
  dryRun: boolean;
  /** Required for tiers M and S-self. */
  confirmMutating: boolean;
}

export interface RunDeps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  readSecret: SecretReader;
  now(): number;
  sleep?(ms: number): Promise<void>;
  /** Monotonic milliseconds for timings. */
  clock?(): number;
  log(line: string): void;
  evidenceDir: string;
  probes: readonly SmokeProbe[];
}

export interface RunOutcome {
  exitCode: number;
  evidencePath?: string;
  results: ProbeResult[];
  skipped?: SkipReason;
}

export function parseArgs(argv: string[]): RunArgs {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const tier = value('--tier');
  if (tier === 'S')
    throw new RunnerError('Tier S (sending to other people) does not exist in this runner');
  if (!TIERS.includes(tier as Tier)) throw new RunnerError('--tier must be R, M or S-self');
  const provider = value('--provider');
  if (provider !== 'gmail' && provider !== 'gcal')
    throw new RunnerError('--provider must be gmail or gcal');
  const account = value('--account');
  if (!account) throw new RunnerError('--account is required');
  return {
    provider,
    tier: tier as Tier,
    account,
    dryRun: argv.includes('--dry-run'),
    confirmMutating: argv.includes('--confirm-mutating'),
  };
}

/** Loads the vault account the run targets, failing closed when it is missing or mismatched. */
async function accountFor(
  args: RunArgs,
  env: Record<string, string | undefined>,
): Promise<AccountMeta> {
  const accounts = await loadAccounts(vaultDir(env));
  const account = accounts[args.account];
  if (!account)
    throw new RunnerError(`No test account "${args.account}" in the vault; sign it in first`);
  if (account.provider !== args.provider)
    throw new RunnerError(`Test account "${args.account}" is not a ${args.provider} account`);
  return account;
}

/** Runs one probe against the guarded fetch; keeps only content-free counts, timings and classes. */
async function runOneProbe(
  probe: SmokeProbe,
  ctx: ProbeContext,
  pacer: UnitPacer,
  guards: readonly GuardedFetch[],
  sentBefore: RequestCount[],
): Promise<EvidenceResult> {
  const mark = pacer.mark();
  let result: ProbeResult;
  try {
    result = await probe.run(ctx);
  } catch (error) {
    // Only the class of the failure is kept; messages could carry content.
    const errorClass = error instanceof GuardRefusal ? 'guard' : 'other';
    result = {
      status: 'fail',
      counts: {},
      timingsMs: {},
      errorClasses: { [errorClass]: 1 },
      requests: [],
      unitsPerMinute: [],
    };
  }
  return {
    id: probe.id,
    ...result,
    requests: requestsSince(sentBefore, mergeRequests(...guards.map(g => g.requests()))),
    unitsPerMinute: pacer.series(mark),
  };
}

/**
 * The signed-in account's own address, read with a tier R request. Sends are checked against it,
 * and it must hash to the one stored at sign-in: the token could belong to another account (the
 * owner's main one, say), and then nothing is changed.
 */
async function checkedSelfAddress(
  bootstrap: GuardedFetch,
  account: AccountMeta,
  label: string,
): Promise<string> {
  const profile = await bootstrap(
    'https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress',
  );
  const self = ((await profile.json().catch(() => ({}))) as { emailAddress?: unknown })
    .emailAddress;
  if (!profile.ok || typeof self !== 'string')
    throw new RunnerError('Could not read the account profile');
  if (!addressMatches(account, self))
    throw new RunnerError(
      `The signed-in account does not match test account ${label}; nothing was changed`,
    );
  return self;
}

export async function runLive(args: RunArgs, deps: RunDeps): Promise<RunOutcome> {
  if (args.tier !== 'R') {
    if (!MUTATING_ACCOUNTS.includes(args.account))
      throw new RunnerError(`Tier ${args.tier} runs only on the agent test account`);
    if (!args.confirmMutating && !args.dryRun)
      throw new RunnerError(`Tier ${args.tier} changes the mailbox: add --confirm-mutating`);
  }
  const account = await accountFor(args, deps.env);
  // The mutating tiers compare the signed-in account with the one that signed in (below).
  if (args.tier !== 'R' && (account.addressHash === undefined || account.addressSalt === undefined))
    throw new RunnerError(
      `Test account ${args.account} has no stored account check; sign it in again before tier ${args.tier}`,
    );

  const probes = probesFor(args.provider, args.tier, deps.probes);
  const expectedRunMs = probes.length * EXPECTED_MS_PER_PROBE + EXPECTED_SLACK_MS;
  const started = deps.now();
  const check = preflight(account, args.account, expectedRunMs, started);
  const startedAt = new Date(started).toISOString();
  const evidenceBase = {
    provider: args.provider,
    tier: args.tier,
    date: startedAt.slice(0, 10),
    startedAt,
    node: process.versions.node,
    daysToExpiry: check.daysLeft,
  };
  const probeIds = deps.probes.map(probe => probe.id);

  if (args.dryRun) {
    deps.log(`Plan: ${args.provider} tier ${args.tier} on test account ${args.account}`);
    deps.log(
      `Probes: ${probes.length ? probes.map(probe => probe.id).join(', ') : 'none registered'}`,
    );
    deps.log(
      `Token reconnect by ${new Date(reconnectBy(account)).toISOString().slice(0, 10)} (${check.daysLeft} days left)`,
    );
    deps.log(check.ok ? 'Preflight: ok' : `Preflight: would skip, ${check.message}`);
    deps.log('Dry run: nothing was read from the keychain and no request was made.');
    return { exitCode: 0, results: [] };
  }

  const skip = async (reason: SkipReason, message: string): Promise<RunOutcome> => {
    deps.log(message);
    const results: EvidenceResult[] = probes.map(probe => ({
      id: probe.id,
      status: 'skip',
      counts: {},
      timingsMs: {},
      errorClasses: {},
      requests: [],
      unitsPerMinute: [],
    }));
    const evidencePath = await writeEvidence(
      deps.evidenceDir,
      { ...evidenceBase, skipReason: reason, results, unitsPerMinute: [], peakUnitsPerWindow: 0 },
      probeIds,
    );
    return { exitCode: 0, evidencePath, results, skipped: reason };
  };

  if (!check.ok) return skip('token-expiry', check.message);
  if (!probes.length) {
    deps.log(`No probes are registered for ${args.provider} tier ${args.tier}.`);
    return { exitCode: 0, results: [], skipped: 'no-probes' };
  }

  // One pipeline: probe -> guard -> pacer -> bearer -> network. The guard is the only fetch a probe gets.
  let accessToken = '';
  const pacer = new UnitPacer({ now: deps.now, sleep: deps.sleep });
  // Run-scoped calendar writes are tier M only (orchestrator decision 2026-10-28).
  const runId = `run-${randomUUID()}`;
  const pipeline = (guardTier: Tier, selfAddress?: string): GuardedFetch =>
    createGuardedFetch(
      createPacedFetch(
        withBearer(deps.fetch, () => accessToken),
        pacer,
      ),
      {
        tier: guardTier,
        selfAddress,
        ...(guardTier === 'M' ? { calendarRunId: runId } : {}),
      },
    );

  const bootstrap = pipeline('R');
  try {
    accessToken = await refreshAccessToken(
      bootstrap,
      clientFromEnv(deps.env),
      await deps.readSecret(account.keychainService),
    );
  } catch (error) {
    if (error instanceof TokenRefusal && error.code === 'invalid_grant') {
      return skip(
        'token-refused',
        `test account ${args.account} was refused by Google, reconnect it first`,
      );
    }
    throw error;
  }

  const guards = [bootstrap];
  let guard = bootstrap;
  if (args.tier !== 'R') {
    guard = pipeline(args.tier, await checkedSelfAddress(bootstrap, account, args.account));
    guards.push(guard);
  }

  const clock = deps.clock ?? (() => performance.now());
  // Frozen: one probe cannot swap the fetch (or anything else) the probes after it get.
  const ctx: ProbeContext = Object.freeze({ fetch: guard, tier: args.tier, now: clock, runId });
  const results: EvidenceResult[] = [];
  for (const probe of probes) {
    const sentBefore = mergeRequests(...guards.map(g => g.requests()));
    results.push(await runOneProbe(probe, ctx, pacer, guards, sentBefore));
  }

  // Defence in depth for tier R: even if the guard had a hole, a write in the log fails the run.
  if (
    args.tier === 'R' &&
    readOnlyViolations(mergeRequests(...guards.map(g => g.requests()))).length
  ) {
    for (const result of results) result.status = 'fail';
  }

  const evidencePath = await writeEvidence(
    deps.evidenceDir,
    {
      ...evidenceBase,
      results,
      unitsPerMinute: pacer.series(),
      peakUnitsPerWindow: pacer.peakWindow(),
    },
    probeIds,
  );
  for (const result of results) deps.log(`${result.id}: ${result.status}`);
  deps.log(`Evidence: ${evidencePath}`);
  return {
    exitCode: results.some(result => result.status === 'fail') ? 1 : 0,
    evidencePath,
    results,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const outcome = await runLive(parseArgs(process.argv.slice(2)), {
      env: process.env,
      fetch,
      readSecret: keychainReader,
      now: Date.now,
      log: line => console.log(line),
      evidenceDir: DEFAULT_EVIDENCE_DIR,
      probes: PROBES,
    });
    process.exitCode = outcome.exitCode;
  } catch (error) {
    console.error(printableMessage(error, 'Run failed'));
    process.exitCode = 1;
  }
}
