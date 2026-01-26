# CLI Commands

All commands are **CWD-aware** - they infer the project from the current directory when run inside a git repository.

```bash
# Projects
orange project add [path] [--name <name>] [--pool-size <n>]  # path defaults to cwd
orange project list
orange project remove <name>

# Tasks (project inferred from cwd)
orange task create <branch> <description>
orange task list [--status <status>] [--all]
orange task spawn <task_id>
orange task attach <task_id>        # Attach to running session
orange task log <task_id>           # View output log
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

## CWD Detection

Commands detect the current project by:
1. Finding git root of current directory
2. Looking up path in `projects.json`
3. If not found: auto-register (for `orange start`) or error (for other commands)

```bash
cd ~/workspace/coffee
orange task create fix-login "Fix the login bug"
# Equivalent to: orange task create --project coffee fix-login "Fix the login bug"

cd ~/Downloads
orange task create fix-login "Fix the login bug"
# Error: Not in a registered project. Run `orange start` from a project directory.
```

## orange start

Must be run from a project directory (git repository).

```bash
cd ~/workspace/coffee
orange start
```

**What happens:**
1. Checks tmux is available (with helpful install instructions if not)
2. Detects git root, infers project name from folder
3. Auto-registers project in `projects.json` if not exists (pool_size=2)
4. Creates/attaches tmux session `coffee-orchestrator`
   - Pane 0: Claude Code (with orange skill)
   - Pane 1: Dashboard TUI (project-scoped)
5. Working directory is the project repo (orchestrator has full context)

**If session exists:** Just attaches (no duplicate sessions).

## orange (no args) / orange dashboard

**Scoping rules:**
- In a registered project directory → shows only that project's tasks
- Not in a project directory → shows all tasks (global view)
- `--all` flag → always shows all tasks
- `--project <name>` flag → shows specific project's tasks

## Task Commands

### orange task attach <task_id>

Attach to a running task's tmux session. Only works for active tasks (working, needs_human, stuck).

```bash
orange task attach abc123
# Attaches to tmux session, press Ctrl+b d to detach
```

### orange task log <task_id>

View the output log for a task. Works for any task with an output.log file.

```bash
orange task log abc123           # Show full log
orange task log abc123 --lines 50  # Show last 50 lines
```

All terminal output is captured to `~/orange/tasks/<project>/<branch>/output.log` during the session.

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
# 2b. No PR or PR open → local merge:
#     git fetch origin
#     git merge origin/<branch>

# 3. Cleanup:
#     - Release workspace (mark available)
#     - Delete remote branch
#     - tmux kill-session -t "$project/$branch"
#     - status → done
#     - history.jsonl: task.merged event
```

## Skills Installation

```bash
orange install  # Symlinks skills to ~/.claude/skills/
```

Creates symlinks for easy development (changes reflect immediately).
