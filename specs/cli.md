# CLI Commands

All commands are **CWD-aware** — they infer the project from the current directory when run inside a git repository.

```bash
# Dashboard (default command)
orange                              # In git repo: auto-register + project-scoped; otherwise: global

# Projects
orange project add [path] [--name <name>] [--pool-size <n>]  # path defaults to cwd
orange project list
orange project update [name] [--pool-size <n>]  # name inferred from cwd
orange project remove <name>

# Tasks (project inferred from cwd)
orange task create [branch] [description] [--harness <name>] [--context -] [--no-spawn] [--status pending|reviewing] [--project <name>]
  # branch: optional, auto-generates from task ID if empty
  # description: optional, empty = interactive session (no prompt)
orange task list [--status <status>] [--all]
orange task spawn <task_id>
orange task attach <task_id>
orange task respawn <task_id>
orange task complete <task_id>      # Called by hook → reviewing
orange task approve <task_id>       # Human approves → reviewed, pushes + creates PR
orange task stuck <task_id>         # Called by hook → stuck
orange task merge <task_id> [--strategy ff|merge] [--local]
orange task cancel <task_id> [--yes]
orange task delete <task_id> [--yes] # done/failed/cancelled only
orange task create-pr <task_id>     # Create PR for reviewed task (retry/manual)

# Workspaces (project inferred from cwd)
orange workspace init
orange workspace list [--all]
orange workspace gc                 # Release orphaned workspaces

# Other
orange install [--harness <name>]           # Install agent skill

# Logs
orange log [--level <level>] [--component <name>] [--grep <pattern>] [--lines N]
```

## Task Create

- Auto-spawns agent unless `--no-spawn` or `--status=reviewing`
- `--harness` specifies which agent to use: `pi`, `opencode`, `claude`, `codex`
  - If omitted: fallback to first installed (pi → opencode → claude → codex)
  - Skills should pass `--harness <name>` to identify the orchestrator
- `--context -` reads implementation context from stdin
- `--status` sets initial status: `pending` (default) or `reviewing`
  - `pending`: normal flow, spawns agent
  - `reviewing`: for existing work, skips agent spawn, goes to review queue
- `--project` specifies project explicitly (otherwise inferred from cwd)
- Errors if an orange task already exists for the branch
- If the git branch exists (local or remote), the agent reuses it on spawn

## Task Respawn

Restart a task whose session died. Reuses existing workspace and branch.

Requirements:
- Active task (working/reviewing/reviewed/stuck)
- Has assigned workspace
- tmux session no longer exists

## Task Approve

Mark a reviewing task as reviewed (human approved). Also pushes branch and creates a GitHub PR if `gh` is available.

## Task Cancel

Requires user confirmation before cancelling. CLI prompts "Cancel task <project>/<branch>? (y/N)". Skip with `--yes`.

## Task Delete

Remove task folder. Only works for done/failed/cancelled tasks. Active tasks must be cancelled first.
Requires user confirmation before deleting. CLI prompts "Delete task <project>/<branch>? (y/N)". Skip with `--yes`.

## Task Merge

Auto-detects workflow:
1. Check if PR exists and is merged
2. PR merged → skip local merge; otherwise → local merge
3. Cleanup: release workspace, kill session, delete remote branch, status → done
4. Push default branch to remote

Use `--local` to bypass PR status check and force local merge.

## Task Create-PR

Create a GitHub PR for a reviewed task. Useful when `gh` was unavailable during approve, or for manual retry. Errors if task already has a PR.

## Workspace GC

Release workspaces bound to tasks that no longer exist (e.g., after manual deletion or crashed spawns).

## Install

Installs the Orange orchestrator skill to harness skills directories.

- `--harness <name>` installs only for specified harness (pi, opencode, claude, codex)
- No flags: installs for all detected harnesses

See [harness.md](./harness.md) for skills directories per harness.

## CWD Detection

1. Find git root of current directory
2. Look up path in `projects.json`
3. If not found: auto-register (for `orange`) or error (for other commands)
