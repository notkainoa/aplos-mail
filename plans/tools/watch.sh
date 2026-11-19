#!/bin/sh
# Shell-only change detector for the revamp (roadmap 5.1a "Polling").
# Prints NOTHING NEW when nothing changed since the last run; otherwise prints
# the new STATUS lines and the open PR list so a fresh, small agent can act.
# State lives in ~/.cache/aplos-watch so each machine keeps its own.

set -eu
STATE="${HOME}/.cache/aplos-watch"
mkdir -p "$STATE"
REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"

git fetch -q origin revamp
git show origin/revamp:plans/STATUS.md > "$STATE/status.now"
gh pr list --base revamp --state open --json number,title,headRefOid \
  -q '.[] | "\(.number) \(.headRefOid[0:7]) \(.title)"' > "$STATE/prs.now"

touch "$STATE/status.last" "$STATE/prs.last"
NEW_STATUS="$(diff "$STATE/status.last" "$STATE/status.now" | sed -n 's/^> //p' || true)"
PR_CHANGES="$(diff "$STATE/prs.last" "$STATE/prs.now" || true)"

mv "$STATE/status.now" "$STATE/status.last"
mv "$STATE/prs.now" "$STATE/prs.last"

if [ -z "$NEW_STATUS" ] && [ -z "$PR_CHANGES" ]; then
  echo "NOTHING NEW"
  exit 0
fi

echo "== New STATUS lines"
printf '%s\n' "$NEW_STATUS"
echo "== PR changes (< gone, > new or updated)"
printf '%s\n' "$PR_CHANGES"
