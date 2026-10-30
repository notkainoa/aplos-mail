# Accepted risk: the harness is not a sandbox

Attempt agents and gate/scorer commands run with the operator's full privileges,
and nothing stops an agent writing outside its worktree. swe-2 runs with
`--permission-mode dangerous` and claude with `--permission-mode
bypassPermissions`, both under the real `HOME`: an attempt process can reach
other worktrees and the main checkout, `~/.gitconfig` and the rest of global
tooling config, and the credential helper along with whatever logins the CLIs
keep in `HOME`. The protections in this directory — environment allow-lists,
isolated git config, atomic check-slot locks, the diff guard, detached eval
worktrees and the post-attempt sandbox audit — are tripwires that detect and
reject tampering; they are not walls that prevent it. For anything heavier than
a smoke run, use the dedicated Linux machine or wrap the run in `sandbox-exec`.
A full run is the default; `--dry-run` is opt-in.

One specific tripwire to know: file entries inside a worktree's node_modules
are copy-on-write clones (`COPYFILE_FICLONE_FORCE`) wherever the filesystem
supports it — on APFS a worktree write cannot reach the main checkout. Where
cloning is unsupported the harness falls back to *hardlinks*: the worktree file
then shares the main checkout's inode, so an in-place append/truncate/patch
rewrites the main copy too. The write scan reports content writes after the
fact (and directory mtimes report adds/deletes), but chmod/chown/utimes through
a hardlink are not detected — hardlink mode is tripwire-only, which the run
summary line states (`node_modules: hardlinked N files (tripwire only)`).
