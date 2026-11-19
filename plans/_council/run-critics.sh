#!/bin/zsh
# usage: run-critics.sh <plan-key>   e.g. 20-providers-sync
P=/Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a/plans; W=/Users/knewton/.t3/worktrees/aplos-mail/t3-446a2f0a; k=$1
for m in deepseek-v4.1-flash-free glm-5.3-flash-free; do
  id=${m%%-*}
  (cd $W && opencode run -m opencode/$m "Read $P/_council/task-critic.md and follow it exactly. The plan to critique is $P/$k.md. Your output path is $P/_council/critic-$k-$id.md" > $P/_council/critic-$k-$id.log 2>&1; echo "exit $?" >> $P/_council/critic-$k-$id.log) &
done
wait
for m in deepseek glm; do echo "$k/$m: $(tail -1 $P/_council/critic-$k-$m.log) $( [ -f $P/_council/critic-$k-$m.md ] && wc -w < $P/_council/critic-$k-$m.md || echo NOFILE)"; done
