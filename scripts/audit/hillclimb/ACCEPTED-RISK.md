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
