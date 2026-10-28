#!/usr/bin/env bash
# Lint a UI-screens lane's WORKING TREE with revamp's ESLint + Prettier config.
# Usage: uis-lint.sh <onboard|calendar|settings|ask> [lane worktree path] [--write]
# --write formats the lane's own files in place with revamp's Prettier config.
set -e
n=$1; WT=${WT:-$HOME/.t3/worktrees/aplos-mail}
D=$WT/rv-ui-lintcheck; SRC=${2:-$WT/rv-ui-$n}
case $n in
  onboard) paths=(apps/desktop/src/renderer/onboarding apps/desktop/src/main/windows apps/desktop/tests/ui-onboard);;
  calendar) paths=(apps/desktop/src/renderer/screens/calendar apps/desktop/tests/ui-calendar);;
  settings) paths=(apps/desktop/src/renderer/screens/settings apps/desktop/tests/ui-settings);;
  ask) paths=(apps/desktop/src/renderer/screens/ask apps/desktop/src/renderer/screens/today apps/desktop/src/renderer/screens/palette apps/desktop/src/renderer/screens/search apps/desktop/tests/ui-ask);;
  *) echo "unknown lane $n"; exit 2;;
esac
if [ "$3" = "--write" ]; then
  cd "$SRC"; "$D/node_modules/.bin/prettier" --config "$D/.prettierrc" --ignore-path "$D/.prettierignore" --write "${paths[@]}" >/dev/null; echo "formatted"; exit 0
fi
exec 9>/tmp/uis-lint.lock; flock 9  # one lane at a time: the scratch checkout is shared
cd "$D"; git fetch -q origin; git checkout -q -f --detach origin/revamp; git clean -qfd -e node_modules >/dev/null
rsync -a --exclude node_modules "$SRC/apps/desktop/src/" "$D/apps/desktop/src/"
rsync -a --exclude node_modules "$SRC/packages/" "$D/packages/"
rsync -a "$SRC/apps/desktop/tests/ui-$n/" "$D/apps/desktop/tests/ui-$n/"
echo "== eslint"; npx eslint "${paths[@]}" || true
echo "== prettier (files needing format)"; npx prettier --list-different "${paths[@]}" || true
