# Pi Extension

Optional pi extension that wraps the `orange` CLI with a structured tool and slash command. Gives pi users richer UX without changing core Orange.

## Principles

- **Thin wrapper** — calls `orange` CLI under the hood, no direct access to Orange internals
- **No core changes** — extension is additive, existing CLI/skill/dashboard unchanged
- **Agent-friendly** — structured JSON input/output instead of bash + parsing

## Tool: `tasks`

Single tool with `action` parameter, similar to mitsuhiko's todo extension pattern.

### Actions

| Action | Params | Description |
|--------|--------|-------------|
| `list` | `status?` | List tasks (default: active only) |
| `list-all` | | List all tasks including done/cancelled |
| `get` | `id` | Get task details (summary + body) |
| `create` | `summary?`, `branch?`, `harness?` | Create a task |
| `update` | `id`, `summary?`, `status?` | Update task summary or status |

### CLI Mapping

| Action | CLI Command |
|--------|------------|
| `list` | `orange task list [--status <s>]` |
| `list-all` | `orange task list --all` |
| `get` | `orange task show <id>` |
| `create` | `orange task create [branch] [summary] [--harness <h>]` |
| `update` | `orange task update <id> [--summary <s>] [--status <s>]` |

### Schema

```typescript
parameters: Type.Object({
  action: StringEnum(["list", "list-all", "get", "create", "update"] as const),
  id: Type.Optional(Type.String({ description: "Task ID" })),
  summary: Type.Optional(Type.String({ description: "Task summary" })),
  branch: Type.Optional(Type.String({ description: "Git branch name" })),
  harness: Type.Optional(Type.String({ description: "Agent harness (pi/claude/opencode/codex)" })),
  status: Type.Optional(Type.String({ description: "Task status filter or new status" })),
})
```

### Output

Tool returns JSON parsed from CLI stdout. Each action returns structured data so `renderResult` can display it nicely.

```typescript
// list / list-all
{ action: "list", tasks: Task[] }

// get
{ action: "get", task: Task }

// create
{ action: "create", task: Task, message: string }

// update
{ action: "update", task: Task, message: string }
```

### Rendering

**renderCall:**
```
tasks list
tasks get abc123
tasks create "Fix auth redirect"
tasks update abc123 --status reviewing
```

**renderResult:**
- `list`: Table of tasks with colored status
- `get`: Task details (summary, status, body preview)
- `create` / `update`: Success message with task summary

## Command: `/tasks`

Slash command for interactive task browsing.

### Behavior

1. `/tasks` — list active tasks inline (non-interactive, text output)
2. Shows task ID, branch, status, summary for each task
3. Agent can read the output and act on it

### Why not interactive TUI?

The dashboard (`orange`) already provides the full interactive experience. The slash command is just a quick peek without leaving the conversation.

## Installation

The extension lives in `extensions/pi/` within the Orange repo. Installed via:

```bash
orange install  # existing command, symlinks skill + extension
```

Symlinks to `~/.pi/agent/extensions/orange/index.ts` (or similar).

## Execution

The extension calls the `orange` CLI via `pi.exec()`:

```typescript
const result = await pi.exec("orange", ["task", "list", "--json"], { signal });
```

### JSON Output

Requires `--json` flag support on CLI commands that the extension calls. If not yet supported, the extension parses the existing human-readable output.

**Preferred approach:** Add `--json` to relevant CLI commands (`task list`, `task show`, `task create`, `task update`) so the extension gets clean structured data.

## What This Does NOT Do

- Spawn/attach/respawn agents (dashboard handles this)
- Merge/PR management (dashboard handles this)
- Replace the skill (behavioral guidance still comes from SKILL.md)
- Work with non-pi agents (they use the skill + CLI as before)
