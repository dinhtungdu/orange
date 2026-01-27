# CLI Commands

All commands are **CWD-aware** — they infer the project from the current directory when run inside a git repository.

```bash
# Projects
orange project add [path] [--name <name>] [--pool-size <n>]  # path defaults to cwd
orange project list
orange project remove <name>

# Tasks (project inferred from cwd)
orange task create <branch> <description> [--context -] [--no-spawn] [--project <name>]
orange task list [--status <status>] [--all]
orange task spawn <task_id>
orange task attach <task_id>
orange task log <task_id> [--lines N]
orange task respawn <task_id>
orange task complete <task_id>      # Called by hook → needs_human
orange task stuck <task_id>         # Called by hook → stuck
orange task merge <task_id> [--strategy ff|merge]
orange task cancel <task_id>
orange task delete <task_id>        # done/failed only

# Workspaces (project inferred from cwd)
orange workspace init
orange workspace list [--all]

# Session
orange start                        # Start orchestrator for current project
orange install                      # Install orchestrator skill

# Dashboard
orange                              # In project: project-scoped; otherwise: global
orange dashboard [--all] [--project <name>]

# Logs
orange log [--level <level>] [--component <name>] [--grep <pattern>] [--lines N]
```

## Task Create

- Auto-spawns agent unless `--no-spawn`
- `--context -` reads implementation context from stdin
- `--project` specifies project explicitly (otherwise inferred from cwd)
- Branch deduplication: if branch exists, appends `-2`, `-3`, etc.

## Task Log

View agent conversation log. Reads from snapshotted `log.txt` first, falls back to live Claude session files.

## Task Respawn

Restart a task whose session died. Reuses existing workspace and branch.

Requirements:
- Active task (working/needs_human/stuck)
- Has assigned workspace
- tmux session no longer exists

## Task Delete

Remove task folder. Only works for done/failed tasks. Active tasks must be cancelled first.

## Task Merge

Auto-detects workflow:
1. Check if PR exists and is merged
2. PR merged → skip local merge; otherwise → local merge
3. Snapshot conversation log to task dir
4. Cleanup: release workspace, kill session, status → done
5. Push default branch to remote

## CWD Detection

1. Find git root of current directory
2. Look up path in `projects.json`
3. If not found: auto-register (for `orange start`) or error (for other commands)
