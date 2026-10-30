// The environment a scorer hands to anything it spawns (the Vite server, Chromium, the claude judge).
// Screenshots are written by an attempt and the judge reads on-screen text, so nothing that holds a
// secret may be inherited: this is an ALLOW-list of named variables, never a deny-list.

const NAMED = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TASTE_MODEL',
]);

/**
 * The only CLAUDE_* variable the logged-in `claude -p` can need. Checked on this machine with
 * `env -i PATH HOME claude -p ...`: login works from HOME alone (default config dir ~/.claude), with or
 * without CLAUDE_CONFIG_DIR, which matters only when the owner keeps the config elsewhere. Nothing
 * else is passed (no CLAUDE_CODE_* session, token or settings variables).
 */
const CLAUDE_NAMES = new Set(['CLAUDE_CONFIG_DIR']);

/** Never passed, whatever else matches (so CLAUDE_CODE_OAUTH_TOKEN stays out too). */
const SECRET = /(_API_KEY|_TOKEN|_SECRET)$/i;

export interface ScorerEnvOptions {
  /** Extra variable names to copy from the source, still subject to the secret-suffix rule. */
  names?: readonly string[];
  /** Pass CLAUDE_CONFIG_DIR (default true). Only the claude judge needs it; Vite and Chromium do not. */
  claude?: boolean;
  /** Values the scorer sets itself; they win over the source. */
  set?: Readonly<Record<string, string>>;
}

function allowed(name: string, extra: ReadonlySet<string>, claude: boolean): boolean {
  if (SECRET.test(name)) return false;
  return NAMED.has(name) || extra.has(name) || (claude && CLAUDE_NAMES.has(name));
}

/** A fresh environment holding only allow-listed variables of `source`, plus `options.set`. */
export function scorerEnv(
  source: Readonly<Record<string, string | undefined>>,
  options: ScorerEnvOptions = {},
): Record<string, string> {
  const extra = new Set(options.names ?? []);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source))
    if (value !== undefined && allowed(name, extra, options.claude ?? true)) env[name] = value;
  return { ...env, ...options.set };
}

/** The extra names Vite (through npx) needs: not NODE_OPTIONS, which could inject code. */
export const VITE_NAMES: readonly string[] = ['NODE_ENV', 'npm_config_cache'];

/** True when the scorer must not trust anything already listening: SCORER_ISOLATED is set to 1, true or yes. */
export function isIsolated(env: Readonly<Record<string, string | undefined>>): boolean {
  return /^(1|true|yes)$/i.test((env.SCORER_ISOLATED ?? '').trim());
}

/** The APLOS_VISUAL_PORT to reuse or start on; 0 means "pick a free port" (unset, invalid or isolated). */
export function explicitPort(env: Readonly<Record<string, string | undefined>>): number {
  if (isIsolated(env)) return 0;
  const port = Number(env.APLOS_VISUAL_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
}
