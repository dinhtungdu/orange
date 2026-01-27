# CLI Commands

All commands are **CWD-aware** - they infer the project from the current directory when run inside a git repository.

```bash
# Projects
orange project add [path] [--name <name>] [--pool-size <n>]  # path defaults to cwd
orange project list
orange project remove <name>

# Tasks (project inferred from cwd)
orange task create <branch> <description> [--context -] [--no-spawn] [--project <name>]
orange task list [--status <status>] [--all]
orange task spawn <task_id>
orange task attach <task_id>        # Attach to running session
orange task log <task_id> [--lines N]  # View conversation log
orange task respawn <task_id>       # Restart dead session
orange task complete <task_id>      # Called by hook → needs_human
orange task stuck <task_id>         # Called by hook → stuck
orange task merge <task_id> [--strategy ff|merge]
orange task cancel <task_id>
orange task delete <task_id>        # Delete task folder (done/failed only)

# Workspaces (project inferred from cwd)
orange workspace init               # Create worktrees for current project
orange workspace list [--all]       # Show pool status

# Session
orange start                        # Start orchestrator for current project
orange install                      # Install orchestrator skill to ~/.claude/skills/

# Dashboard
orange                              # In project: project-scoped dashboard
                                    # Not in project: global dashboard
orange dashboard [--all] [--project <name>]
```

## Task Commands

### orange task attach <task_id>

Attach to a running task's tmux session. Only works for active tasks with live sessions.

```bash
orange task attach abc123
# Attaches to tmux session, press Ctrl+b d to detach
```

### orange task create <branch> <description>

Creates a task and auto-spawns an agent (unless `--no-spawn`).

```bash
orange task create login-fix "Fix OAuth redirect loop"
orange task create login-fix "Fix OAuth" --no-spawn       # Create without spawning
echo "detailed context" | orange task create login-fix "Fix OAuth" --context -  # Pipe context from stdin
orange task create login-fix "Fix OAuth" --project coffee  # Explicit project
```

Branch auto-deduplication: if `login-fix` exists, uses `login-fix-2`, etc.

### orange task log <task_id>

View agent conversation log. Reads from snapshotted `log.txt` first, falls back to live Claude session files.

```bash
orange task log abc123           # Show full log
orange task log abc123 --lines 50  # Show last 50 lines
```

### orange task respawn <task_id>

Restart a task whose session died unexpectedly. Reuses the existing workspace and branch.

```bash
orange task respawn abc123
# Creates new tmux session, starts agent with same context
```

Only works for:
- Active tasks (working/needs_human/stuck)
- With an assigned workspace
- Where the tmux session no longer exists

### orange task delete <task_id>

Delete a completed task's folder and database entry. Only works for done/failed tasks.

```bash
orange task delete abc123
# Removes ~/orange/tasks/<project>/<branch>/ and db entry
```

Active tasks must be cancelled first (to release workspace/session).

## Task Merge Flow

`orange task merge <id>` auto-detects workflow:

```bash
# 1. Check if PR exists and merged:
gh pr view <branch> --json state,mergedAt

# 2a. PR merged → skip local merge
# 2b. No PR or PR open → local merge

# 3. Cleanup:
#     - Release workspace
#     - Kill tmux session
#     - status → done
```

## CWD Detection

Commands detect the current project by:
1. Finding git root of current directory
2. Looking up path in `projects.json`
3. If not found: auto-register (for `orange start`) or error (for other commands)
