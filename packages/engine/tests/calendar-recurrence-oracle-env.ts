import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Oracle A needs python-dateutil in a throwaway venv outside the repo. A venv that exists but lacks the package (a
// half-built or cleaned /tmp) used to fail the whole fuzz test with ModuleNotFoundError and an EPIPE: probe the import
// first and let the test skip with the one-line repair instead.
const REPAIR =
  'python3 -m venv /tmp/aplos-rrule-oracle && /tmp/aplos-rrule-oracle/bin/pip install python-dateutil';

/** Why oracle A cannot run (with the repair command), or null when it can. */
export function oracleAUnavailable(python: string, oracleScript: string): string | null {
  if (!existsSync(python) || !existsSync(oracleScript)) {
    return `oracle A venv missing; create it: ${REPAIR}`;
  }
  const probe = spawnSync(python, ['-I', '-c', 'import dateutil'], {
    stdio: 'ignore',
    timeout: 20_000,
  });
  return probe.status === 0
    ? null
    : `oracle A venv at ${python} has no python-dateutil; repair it: ${REPAIR}`;
}
