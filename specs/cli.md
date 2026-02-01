# CLI Commands

All commands are **CWD-aware** — they infer the project from the current directory when run inside a git repository.

```bash
# Dashboard (default command)
orange [--all] [--project <name>] [--exit-on-attach]  # In git repo: auto-register + project-scoped; otherwise: global
orange dashboard [--all] [--project <name>] [--exit-on-attach]

# Projects
orange project add [path] [--name <name>] [--pool-size <n>]  # path defaults to cwd
orange project list
orange project update [name] [--pool-size <n>]  # name inferred from cwd
orange project remove <name>

# Tasks (project inferred from cwd)
orange task create [branch] [summary] [--harness <name>] [--context -] [--no-spawn] [--status pending|clarification|reviewing] [--project <name>]
  # branch: optional, auto-generates from task ID if empty
  # summary: optional, empty = clarification status (agent asks what to work on)
orange task list [--status <status>] [--all]
orange task spawn <task_id>
orange task attach <task_id>
orange task respawn <task_id>
orange task update [task_id] [--branch [name]] [--summary <text>] [--status <status>]
  # task_id: optional if running inside workspace (auto-detected)
  # --branch: if name exists → checkout + delete old; else → rename current
  # --branch (no value): sync task to current git branch
  # --summary: update frontmatter summary field
  # --status: update task status (clarification, working, reviewing, stuck)
orange task merge <task_id> [--strategy ff|merge] [--local]
orange task cancel <task_id> [--yes]
orange task delete <task_id> [--yes] # done/cancelled only
orange task create-pr <task_id>     # Create PR for reviewing task

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
- `--context -` reads implementation context from stdin, stored as `## Context` in body
- `--status` sets initial status: `pending` (default), `clarification`, or `reviewing`
  - `pending`: normal flow, spawns agent
  - `clarification`: for empty/vague summary, spawns agent in clarification mode
  - `reviewing`: for existing work, skips agent spawn, goes to review queue
- Empty summary auto-sets `--status clarification`
- `--project` specifies project explicitly (otherwise inferred from cwd)
- Errors if an orange task already exists for the branch
- If the git branch exists (local or remote), the agent reuses it on spawn

**TASK.md structure:**
- `summary` in frontmatter (CLI-controlled, short one-liner)
- `## Context` in body (orchestrator-controlled, read-only for agent)
- `## Questions`, `## Notes` in body (agent-controlled)

## Task Respawn

Restart a task whose session died. Reuses existing workspace and branch.

Requirements:
- Active task (working/clarification/reviewing/stuck)
- Has assigned workspace
- tmux session no longer exists

## Task Cancel

Requires user confirmation before cancelling. CLI prompts "Cancel task <project>/<branch>? (y/N)". Skip with `--yes`.

## Task Delete

Remove task folder. Only works for done/cancelled tasks. Active tasks must be cancelled first.
Requires user confirmation before deleting. CLI prompts "Delete task <project>/<branch>? (y/N)". Skip with `--yes`.

## Task Merge

Auto-detects workflow:
1. Check if PR exists and is merged
2. PR merged → skip local merge; otherwise → local merge
3. Cleanup: release workspace, kill session, delete remote branch, status → done
4. Push default branch to remote

Use `--local` to bypass PR status check and force local merge.

## Task Create-PR

Create a GitHub PR for a reviewing task. Pushes branch and opens PR on GitHub. Errors if task already has a PR.

## Workspace GC

Release workspaces bound to tasks that no longer exist (e.g., after manual deletion or crashed spawns).

## Install

Installs the Orange orchestrator skill to harness skills directories.

- `--harness <name>` installs only for specified harness (pi, opencode, claude, codex)
- No flags: installs for all detected harnesses

See [harness.md](./harness.md) for skills directories per harness.

## CWD Detection

1. If inside `~/orange/workspaces/<project>--<n>`: map workspace → task → project
2. Otherwise find git root of current directory
3. Look up path in `projects.json`
4. If not found: auto-register (for `orange`) or error (for other commands)
