#!/usr/bin/env bash
# local-ci.sh — local replacement for the GitHub Actions CI (ci.yml), which has no paid minutes.
#
# Usage: scripts/local-ci.sh [ref] [--package] [--no-e2e] [--no-web] [--keep]
#   ref        any git ref to check out (default: origin/revamp)
#   --package  also run the electron-builder packaging smoke (adds a few minutes)
#   --no-e2e   skip the Playwright browser suite
#   --no-web   skip the apps/web typecheck+build
#   --keep     keep the scratch worktree afterwards (path is printed)
#
# It creates a throwaway `git worktree` under a mktemp dir, runs `npm ci --ignore-scripts`,
# then every job ci.yml ran, in the same order and with the same commands, niced to keep the
# machine usable. It prints a PASS/FAIL/SKIP table and exits 1 on any FAIL. It never writes
# to the checkout it is launched from.
set -u

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
REF=origin/revamp
DO_PACKAGE=0
DO_E2E=1
DO_WEB=1
KEEP=0

for arg in "$@"; do
  case "$arg" in
    --package) DO_PACKAGE=1 ;;
    --no-e2e) DO_E2E=0 ;;
    --no-web) DO_WEB=0 ;;
    --keep) KEEP=1 ;;
    -h|--help) sed -n '1,16p' "$0"; exit 0 ;;
    -*) echo "local-ci: unknown flag $arg" >&2; exit 2 ;;
    *) REF="$arg" ;;
  esac
done

# A throwaway tree per run; nothing outside this dir is written except the git worktree
# metadata, which `git worktree remove` cleans again.
TMP=$(mktemp -d "${TMPDIR:-/tmp}/aplos-local-ci.XXXXXX") || exit 1
TREE="$TMP/tree"
LOGS="$TMP/logs"
mkdir -p "$LOGS"

cleanup() {
  if [ "$KEEP" = 0 ] && [ -n "${TMP:-}" ] && [ "$TMP" != "/" ] && [ -d "$TMP" ]; then
    git -C "$REPO" worktree remove --force "$TREE" >/dev/null 2>&1
    rm -rf -- "$TMP"
    git -C "$REPO" worktree prune >/dev/null 2>&1
  fi
}
trap cleanup EXIT

# One local CI run at a time: two runs would fight for CPU and for Electron's download cache.
LOCK="${TMPDIR:-/tmp}/aplos-local-ci.lock"
# The lock directory holds the owner's pid. A run that was killed (SIGKILL skips the EXIT trap) leaves
# the directory behind, so a lock whose owner is gone is stale and is taken over. A lock with no pid yet
# gets a minute: its owner may be between the mkdir and the pid write.
lock_is_stale() {
  local owner
  owner=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$owner" ]; then
    # kill -0 fails with EPERM for a live process of another user, so ps decides too.
    ! kill -0 "$owner" 2>/dev/null && ! ps -p "$owner" >/dev/null 2>&1
  else
    [ -n "$(find "$LOCK" -maxdepth 0 -mmin +1 2>/dev/null)" ]
  fi
}
# Taking over runs under its own mutex directory and re-checks staleness inside it, so two runs that
# both saw the same stale lock cannot both win. A mutex left by a killed taker expires after a minute.
acquire_lock() {
  local got=1
  if mkdir "$LOCK" 2>/dev/null; then
    echo $$ >"$LOCK/pid"
    return 0
  fi
  lock_is_stale || return 1
  find "$LOCK.takeover" -maxdepth 0 -mmin +1 -exec rmdir {} \; 2>/dev/null
  mkdir "$LOCK.takeover" 2>/dev/null || return 1
  if lock_is_stale; then
    echo "local-ci: taking over a stale lock ($LOCK; its owner is gone)" >&2
    rm -f "$LOCK/pid"
    rmdir "$LOCK" 2>/dev/null
    if mkdir "$LOCK" 2>/dev/null; then
      echo $$ >"$LOCK/pid"
      got=0
    fi
  fi
  rmdir "$LOCK.takeover" 2>/dev/null
  return $got
}
if ! acquire_lock; then
  echo "local-ci: another run is in progress ($LOCK exists, owner pid $(cat "$LOCK/pid" 2>/dev/null))" >&2
  exit 2
fi
trap 'rm -f "$LOCK/pid"; rmdir "$LOCK" 2>/dev/null; cleanup' EXIT

# Terminal agents export this for themselves; it would break npm and Electron spawns.
unset ELECTRON_RUN_AS_NODE

# A free loopback port P with P+1 free too (the preview takes P, its API P+1), so the e2e suite never
# collides with another lane's preview or Electron on the fixed default (4417).
free_e2e_port() {
  node -e '
    const net = require("node:net");
    const free = port => new Promise(resolve => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    (async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const port = 20000 + Math.floor(Math.random() * 20000);
        if ((await free(port)) && (await free(port + 1))) return console.log(port);
      }
      process.exit(1);
    })();
  '
}

declare -a NAMES STATUS SECONDS_TOTAL
run() { # run <name> <cmd...>
  local name="$1" log start code
  shift
  log="$LOGS/$(echo "$name" | tr -cs 'A-Za-z0-9_.-' '-').log"
  start=$(date +%s)
  echo ">>> $name"
  (cd "$TREE" && nice -n 10 "$@") >"$log" 2>&1
  code=$?
  record "$name" "$code" "$(( $(date +%s) - start ))"
  [ "$code" -ne 0 ] && tail -15 "$log" | sed 's/^/    /'
  return 0
}
skip() { NAMES+=("$1"); STATUS+=("SKIP"); SECONDS_TOTAL+=(0); echo "--- $1: SKIP ($2)"; }
record() {
  NAMES+=("$1"); SECONDS_TOTAL+=("$3")
  if [ "$2" = 0 ]; then STATUS+=("PASS"); echo "=== $1: PASS (${3}s)"; else STATUS+=("FAIL"); echo "=== $1: FAIL (${3}s)"; fi
}

SHA=$(git -C "$REPO" rev-parse --verify "$REF^{commit}" 2>/dev/null) || { echo "local-ci: bad ref $REF" >&2; exit 2; }
echo "local-ci: $REF = $SHA"

git -C "$REPO" worktree add --detach "$TREE" "$SHA" >"$LOGS/worktree.log" 2>&1 || {
  cat "$LOGS/worktree.log" >&2; exit 2; }

# ---- install (all jobs) -------------------------------------------------------
run "npm ci" npm ci --ignore-scripts
if [ "${STATUS[${#STATUS[@]}-1]}" = FAIL ]; then
  echo "local-ci: npm ci failed; nothing else can run"
else
  ELECTRON=1
  run "electron install" node node_modules/electron/install.js
  [ "${STATUS[${#STATUS[@]}-1]}" = FAIL ] && ELECTRON=0

  # ---- job: static (format, lint, types, audit) --------------------------------
  run "format:check" node scripts/audit/run-if-present.mjs format:check
  run "lint" npm run lint
  run "test:lint" npm run test:lint
  run "test:audit" npm run test:audit
  run "lint:css" npm run lint:css
  run "lint:design" npm run lint:design
  run "owners-check --validate" node scripts/audit/owners-check.mjs --validate
  run "typecheck" npm run typecheck
  # npm audit needs the registry: a network failure is a SKIP, a finding is a FAIL.
  AUDIT_LOG="$LOGS/npm-audit.log" AUDIT_CODE=0
  (cd "$TREE" && nice -n 10 npm audit --omit=dev --audit-level=high) >"$AUDIT_LOG" 2>&1 || AUDIT_CODE=$?
  if [ "$AUDIT_CODE" -eq 0 ]; then record "npm audit" 0 0
  elif grep -qiE "ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network" "$AUDIT_LOG"; then skip "npm audit" "registry unreachable"
  else record "npm audit" 1 0; tail -15 "$AUDIT_LOG" | sed 's/^/    /'; fi

  # ---- job: slots ---------------------------------------------------------------
  for s in check:openapi check:tokens check:contrast check:identity test:visual; do
    run "slot $s" node scripts/audit/slot.mjs "$s"
  done
  run "check:budgets" npm run check:budgets

  # ---- job: unit-engine (Electron's own Node) -----------------------------------
  if [ "$ELECTRON" = 1 ]; then
    run "check:sqlite" npm run check:sqlite
    # CI shards this 4 ways for wall-clock; the same file set runs here in one pass.
    run "test:engine" npm run test:engine
  else
    skip "check:sqlite" "Electron binary unavailable"
    skip "test:engine" "Electron binary unavailable"
  fi

  # ---- job: unit-desktop (system Node) ------------------------------------------
  run "test desktop" npm test -w @aplos/desktop

  # ---- job: unit-packages -------------------------------------------------------
  run "test engine (system node)" npm test -w @aplos/engine
  run "test other packages" npm test -w @aplos/contract -w @aplos/contract-fixture -w @aplos/emulators -w @aplos/mail-html

  # ---- job: e2e-browser ---------------------------------------------------------
  if [ "$DO_E2E" = 1 ]; then
    if (cd "$TREE" && npx playwright install chromium >"$LOGS/playwright-install.log" 2>&1); then
      E2E_PORT=$(free_e2e_port) || E2E_PORT=""
      case "$E2E_PORT" in
        '' | *[!0-9]*) E2E_PORT="" ;;
      esac
      if [ -n "$E2E_PORT" ]; then
        echo "local-ci: e2e preview on port $E2E_PORT (API $((E2E_PORT + 1)))"
        run "e2e browser" env APLOS_E2E_PORT="$E2E_PORT" npm run test:e2e:browser
      else
        # Never fall back to the shared default port: that is the collision this step avoids.
        echo "local-ci: could not pick a free e2e port" >&2
        record "e2e browser" 1 0
      fi
    else
      skip "e2e browser" "playwright chromium install failed ($LOGS/playwright-install.log)"
    fi
  else
    skip "e2e browser" "--no-e2e"
  fi

  # ---- job: web -----------------------------------------------------------------
  if [ "$DO_WEB" = 1 ]; then
    run "web typecheck" npm run typecheck -w @aplos/web
    run "web build" npm run build -w @aplos/web
  else
    skip "web typecheck" "--no-web"; skip "web build" "--no-web"
  fi

  # ---- job: desktop-macos (the local-Mac half) ----------------------------------
  run "desktop build" npm run build -w @aplos/desktop

  # ---- packaging smoke (opt-in) -------------------------------------------------
  if [ "$DO_PACKAGE" = 1 ]; then
    if [ "$ELECTRON" = 1 ]; then
      run "package" npm run package -w @aplos/desktop
    else
      skip "package" "Electron binary unavailable"
    fi
  fi
fi

# ---- table --------------------------------------------------------------------
echo
echo "== local-ci $SHA =="
FAILS=0
for i in "${!NAMES[@]}"; do
  printf '%-28s %-5s %ss\n' "${NAMES[$i]}" "${STATUS[$i]}" "${SECONDS_TOTAL[$i]}"
  [ "${STATUS[$i]}" = FAIL ] && FAILS=$((FAILS + 1))
done
echo "logs: $LOGS"
[ "$KEEP" = 1 ] && echo "worktree kept: $TREE"
if [ "$FAILS" -gt 0 ]; then echo "local-ci: $FAILS FAILED"; exit 1; fi
echo "local-ci: all green"
