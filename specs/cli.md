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
orange task peek <task_id> [--lines N]
orange task complete <task_id>      # Called by hook → needs_human
orange task stuck <task_id>         # Called by hook → stuck
orange task merge <task_id> [--strategy ff|merge]
orange task cancel <task_id>

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

**Dashboard pane setup:**
- Uses `process.argv[1]` to find the orange script path dynamically
- Works with both alias (`bun run ~/workspace/orange/src/index.ts`) and compiled binary

**If session exists:** Just attaches (no duplicate sessions).

**If not in git repo:**
```bash
cd ~/Downloads
orange start
# Error: Not a git repository. Run from a project directory.
```

## orange (no args) / orange dashboard

**Scoping rules:**
- In a registered project directory → shows only that project's tasks
- Not in a project directory → shows all tasks (global view)
- `--all` flag → always shows all tasks
- `--project <name>` flag → shows specific project's tasks

```bash
cd ~/workspace/coffee
orange                    # Shows coffee/* tasks only

cd ~
orange                    # Shows all tasks (global)
orange dashboard --all    # Shows all tasks (explicit)
orange dashboard --project coffee  # Shows coffee/* tasks
```

## Task Commands

### orange task create <branch> <description>

Creates a task for the current project.

```bash
cd ~/workspace/coffee
orange task create fix-login "Fix OAuth redirect loop on mobile"
# Output: Created task abc123 (coffee/fix-login)
```

### orange task list

Lists tasks for current project (or all with `--all`).

```bash
orange task list                    # Current project only
orange task list --all              # All projects
orange task list --status working   # Filter by status
```

### orange task spawn <task_id>

Spawns an agent for the task. Creates worktree on-demand if needed.

```bash
orange task spawn abc123
# 1. Creates worktree if none available (lazy init)
# 2. Acquires workspace from pool
# 3. Creates branch, starts tmux session with Claude
```

**Lazy workspace initialization:**
- First spawn for a project creates worktrees on-demand
- Progress shown: "Creating workspace coffee--1..."
- Subsequent spawns use existing pool

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

## Orchestrator Skill

Installed globally via symlink.

```bash
orange install  # Symlinks skills/ → ~/.claude/skills/orange
```

The skill file reflects the CWD-aware design - orchestrator doesn't need to specify project:

```markdown
## CLI Commands

- `orange task create <branch> "<description>"` - Create task (project from cwd)
- `orange task spawn <task_id>` - Spawn agent
- `orange task list` - List tasks for current project
- `orange task peek <task_id>` - See agent's terminal output

## Example

User: "Add dark mode and fix the settings page"

```bash
orange task create add-dark-mode "Add dark mode with system preference detection"
# Output: Created task abc123

orange task create fix-settings "Fix settings page layout on mobile"
# Output: Created task def456

orange task spawn abc123
orange task spawn def456
```

"I've spawned two agents for this project. Check the dashboard pane or attach to their sessions."
```
