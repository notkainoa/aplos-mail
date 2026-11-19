# TRANSPORT-AUTH-1: merge gate for the listener transport PR

Trigger: any PR that adds a socket, HTTP or MCP listener and calls `verify()` in `apps/desktop/src/host/transports/auth.ts`.
Owner: the integrator thread (an Opus review is mandatory; nothing in this area merges on a local check alone).
Source: eng-admin's brief (STATUS 2026-11-10) plus the integrator's additions. `verify()` itself merged in #424.

Opus must check, on `verify()` and its caller:

1. `sha256(token)` is compared with `timingSafeEqual` against `clients.token_hash`, equal-length check first, so there is no prefix timing oracle.
2. `WHERE revoked_at IS NULL` is evaluated on EVERY request: no caching, and a revoke takes effect on the very next call (open connections included: a revoked client's live socket is closed or refused within about 1 s).
3. The caller identity comes from the STORED row (clientId, kind, scopes), never from the hello frame (freeze R2B-3). An MCP kind gets `via: 'mcp'` and the mcpMethods limit regardless of transport.
4. The token shape gate `^[0-9a-f]{64}$` runs before any lookup.
5. A scopes JSON parse failure yields `[]` (least privilege), not a throw.
6. The plaintext token is never logged or stored; only the hash is.
7. Pins (tests that fail when the check is removed): a real-SQLite revoked row answers undefined; a non-hex-64 input is rejected; a wrong token is refused; bad scopes JSON still authenticates the row with `[]`.

Integrator additions:

8. Listener binds loopback or a 0700 socket path only; no network interface; the token file path is the only way a client learns its token.
9. The Origin/Host of an HTTP listener is checked (DNS rebinding); the request body size and the number of unauthenticated connections are bounded; a failed verify is not an oracle (same answer for unknown, revoked and malformed tokens).
10. Every call goes through the existing dispatch table's scope, uiOnly, secret and MCP checks; the transport adds no method.
11. Audit rows for denied attempts are written (or the gap is recorded as a ticket), and never contain the token.
