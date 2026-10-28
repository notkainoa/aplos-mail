#!/bin/zsh
# Lint a UI-screens lane's WORKING TREE with revamp's ESLint + Prettier config.
# Usage: /tmp/uis-lint.sh <onboard|calendar|settings|ask>
set -e
n=$1; WT=${WT:-$HOME/.t3/worktrees/aplos-mail}
D=$WT/rv-ui-lintcheck; SRC=$WT/rv-ui-$n
case $n in
  onboard) paths=(apps/desktop/src/renderer/onboarding apps/desktop/tests/ui-onboard);;
  calendar) paths=(apps/desktop/src/renderer/screens/calendar apps/desktop/tests/ui-calendar);;
  settings) paths=(apps/desktop/src/renderer/screens/settings apps/desktop/tests/ui-settings);;
  ask) paths=(apps/desktop/src/renderer/screens/ask apps/desktop/src/renderer/screens/today apps/desktop/src/renderer/screens/palette apps/desktop/src/renderer/screens/search apps/desktop/tests/ui-ask);;
esac
cd $D; git checkout -q -f --detach origin/revamp; git clean -qfd -e node_modules >/dev/null
rsync -a --exclude node_modules $SRC/apps/desktop/src/renderer/ $D/apps/desktop/src/renderer/
rsync -a --exclude node_modules $SRC/packages/ $D/packages/
rsync -a $SRC/apps/desktop/tests/ui-$n/ $D/apps/desktop/tests/ui-$n/
echo "== eslint"; npx eslint $paths || true
echo "== prettier (files needing format)"; npx prettier --list-different $paths || true
