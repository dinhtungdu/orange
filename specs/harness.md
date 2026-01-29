# Harness Configuration

Orange supports multiple coding agent harnesses. Each task specifies which harness to use.

## Supported Harnesses

| Harness | Binary | Description |
|---------|--------|-------------|
| `pi` | `pi` | Pi coding agent |
| `opencode` | `opencode` | OpenCode |
| `claude` | `claude` | Claude Code |
| `codex` | `codex` | Codex CLI |

## Harness Resolution

When creating a task without explicit `--harness` flag:

1. **CLI**: Fallback to first installed (pi → opencode → claude → codex)
2. **Dashboard**: User selects from installed harnesses in create form
3. **Skill**: Should always pass `--harness <name>` to identify orchestrator

## Spawn Commands

| Harness | Spawn (full permissions) | Respawn (reduced permissions) |
|---------|-------------------------|------------------------------|
| claude | `claude --dangerously-skip-permissions "<prompt>"` | `claude --permission-mode acceptEdits "<prompt>"` |
| pi | `pi -p "<prompt>"` | `pi -p "<prompt>"` |
| codex | `codex exec --dangerously-bypass-approvals-and-sandbox "<prompt>"` | `codex exec --full-auto "<prompt>"` |
| opencode | `opencode run "<prompt>"` | `opencode run "<prompt>"` |

## Workspace Setup

Harness-specific files created at spawn time (in worktree root):

| Harness | Files Created |
|---------|--------------|
| claude | `.claude/settings.local.json` with autonomous permissions |
| pi | (none) |
| codex | (none) |
| opencode | `opencode.json` with `{ "permission": "allow" }` |

## Git Excludes

Added to main repo's `.git/info/exclude`:

```
TASK.md
.orange-outcome
.claude/
.pi/
.codex/
.opencode/
opencode.json
```

## Skills Installation

Orange skill installed to harness-specific directory:

| Harness | Skills Directory |
|---------|-----------------|
| claude | `~/.claude/skills/orange-orchestrator/` |
| pi | `~/.pi/agent/skills/orange-orchestrator/` |
| codex | `~/.codex/skills/orange-orchestrator/` |
| opencode | `~/.config/opencode/skills/orange-orchestrator/` |

The skill template includes `--harness <name>` in commands so spawned agents pass their identity to orange.

## Agent Skills Standard

Skills follow the [Agent Skills standard](https://github.com/vercel-labs/skills) and are portable across harnesses. Each harness reads `SKILL.md` files from its skills directory.
