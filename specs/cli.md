# CLI Commands

```bash
# Projects
orange project add <path> [--name <name>] [--pool-size <n>]
orange project list

# Tasks
orange task create <project> <branch> <description>
orange task list [--project <project>] [--status <status>]
orange task spawn <task_id>
orange task peek <task_id> [--lines N]  # Show agent's recent terminal output
orange task complete <task_id>      # Called by hook → needs_human (review passed)
orange task stuck <task_id>         # Called by hook → stuck (agent gave up)
orange task merge <task_id> [--strategy ff|merge]  # Merge + release workspace
orange task cancel <task_id>        # Cancel + release workspace

# Workspaces (pool management)
orange workspace list               # Show pool status
orange workspace init <project>     # Create worktrees for project pool

# Session
orange start                        # Create tmux session
orange install                      # Install orchestrator skill to ~/.claude/skills/
```

## Task Merge Flow

Two workflows supported:

**Local merge:**
```bash
orange task merge <id>
# 1. In source repo: git fetch, git merge origin/<branch>
# 2. Release workspace (mark available, don't delete)
# 3. Delete remote branch
# 4. tmux kill-session -t "$project/$branch"
# 5. status → done, history.jsonl: task.merged event
```

**PR workflow:**
```bash
# Agent or human creates PR via gh
gh pr create --fill

# After PR merged on GitHub:
orange task merge <id>
# 1. Release workspace (mark available)
# 2. tmux kill-session -t "$project/$branch"
# 3. status → done, history.jsonl: task.merged event
```

Both: workspace released (reused), session killed, status = done.

## Orchestrator Skill

Installed globally for orchestrator context.

```bash
orange install  # Copies skill to ~/.claude/skills/orange/
```

**~/.claude/skills/orange/orchestrator.md:**

```markdown
# Orange Orchestrator

You are an orchestrator managing coding tasks across multiple projects.

## CLI Commands

Use Bash tool to run these commands:

- `orange task create <project> <branch> "<description>"` - Create task
- `orange task spawn <task_id>` - Spawn agent in worktree + tmux session
- `orange task list [--project X] [--status Y]` - List tasks
- `orange task peek <task_id> [--lines N]` - See agent's terminal output

## Workflow

1. **Understand request** - Clarify scope, ask questions
2. **Break down** - Split into independent tasks (one branch each)
3. **Create tasks** - `orange task create` for each
4. **Spawn agents** - `orange task spawn` (can run multiple)
5. **Monitor** - `orange task peek` or check dashboard
6. **Notify user** - When agents stop, tell user to review

## Guidelines

- One task = one branch = one agent
- Keep tasks focused and independent
- Agents self-review before stopping
- You don't need to review - human does final review

## Example

User: "Add dark mode to orange and fix the login bug in coffee app"

```bash
orange task create orange dark-mode "Add dark mode with system preference detection"
# Output: Created task abc123

orange task create coffee fix-login "Fix OAuth redirect loop on mobile"
# Output: Created task def456

orange task spawn abc123
orange task spawn def456
```

"I've spawned two agents. Check the dashboard or attach to their sessions."
```
