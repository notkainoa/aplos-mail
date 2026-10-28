#!/bin/sh
# Cheap pre-check for the integrator's merge-queue sweep: prints "NOTHING NEW" when no STATUS
# entry from another thread and no PR into revamp changed since the last run, else lists what did.
# State lives outside the repo. Usage: sh plans/tools/sweep-check.sh
set -e
state="${APLOS_SWEEP_STATE:-$HOME/.cache/aplos-integrator/sweep-state}"
mkdir -p "$(dirname "$state")"
git fetch -q origin
lines=$(git show origin/revamp:plans/STATUS.md | awk '/^## Log/{f=1;next} f && NF' | grep -v ' | integrator | ' || true)
prs=$(gh pr list --base revamp --state open --json number,headRefOid,updatedAt --jq '.[]|"\(.number) \(.headRefOid) \(.updatedAt)"')
now=$(printf '%s\n--prs--\n%s\n' "$lines" "$prs")
if [ -f "$state" ] && [ "$now" = "$(cat "$state")" ]; then
  echo "NOTHING NEW"
  exit 0
fi
old=$(cat "$state" 2>/dev/null || true)
printf '%s\n' "$now" > "$state"
echo "New STATUS entries from other threads:"
printf '%s\n' "$lines" | while IFS= read -r l; do
  printf '%s\n' "$old" | grep -qxF -- "$l" || printf '  %s\n' "$l"
done
echo "Open PRs into revamp (number head updated):"
printf '%s\n' "$prs" | sed 's/^/  /'
