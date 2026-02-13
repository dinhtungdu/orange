# Data

All state in `~/orange/`. TASK.md is the source of truth for each task.

## Storage Layout

```
~/orange/
├── projects.json
├── orange.log              # structured log (rotated 10MB)
├── workspaces/
│   ├── <project>--<n>/     # git worktrees
│   └── .pool.json          # pool state
└── tasks/
    └── <project>/
        └── <task_id>/
            ├── TASK.md
            └── history.jsonl
```

## projects.json

```json
[
  {
    "name": "orange",
    "path": "/Users/tung/workspace/orange",
    "default_branch": "main",
    "pool_size": 2
  }
]
```

## Task ID

21-character nanoid (`[0-9A-Za-z]`). No special characters — safe as CLI arguments and directory names.

## TASK.md

YAML frontmatter + markdown body.

### Frontmatter Schema

| Field | Type | Default | Set by |
|-------|------|---------|--------|
| `id` | string | generated | system |
| `project` | string | — | system |
| `branch` | string | `orange-tasks/<id>` | system / agent |
| `harness` | string | first installed | user |
| `review_harness` | string | `claude` | user |
| `status` | Status | `pending` | workflow engine |
| `review_round` | number | `0` | workflow engine |
| `crash_count` | number | `0` | workflow engine |
| `summary` | string | `""` | user / agent |
| `workspace` | string \| null | `null` | system |
| `tmux_session` | string \| null | `null` | system |
| `pr_url` | string \| null | `null` | system |
| `created_at` | ISO 8601 | now | system |
| `updated_at` | ISO 8601 | now | system |

### Body Sections

All optional. Order by convention:

| Section | Owner | Purpose |
|---------|-------|---------|
| `## Context` | orchestrator | Requirements and constraints, read-only for agent |
| `## Questions` | agent | Clarifying questions for user |
| `## Plan` | agent | Implementation plan (required before coding) |
| `## Handoff` | agent | Structured session state for next session |
| `## Review` | review agent | Review verdict and feedback |

### Plan Format

Written by agent during planning phase. Documents the implementation approach before any code is written.

```markdown
## Plan

APPROACH: Use JWT tokens with httpOnly cookies for session management
TOUCHING: src/auth/login.ts, src/auth/middleware.ts, src/types/auth.ts
RISKS: Token rotation with concurrent requests needs careful error handling
```

Fields (include what's relevant):
- **APPROACH** — how you'll implement this
- **TOUCHING** — files and areas you'll modify
- **RISKS** — anything that could go wrong (optional)

Validation: at least one field (`APPROACH`/`TOUCHING`) with content after the colon.

### Handoff Format

Written by agent before stopping. Structured state for session continuity.

```markdown
## Handoff

DONE: OAuth callback handler, token storage
REMAINING: Refresh token rotation, logout flow
DECISIONS: JWT for stateless auth (avoid DB session lookups)
UNCERTAIN: Should tokens expire on password change?
```

Fields (all optional, include what's relevant):
- **DONE** — completed this session
- **REMAINING** — what's left
- **DECISIONS** — choices made and why (prevents re-deciding)
- **UNCERTAIN** — open questions needing human input

Validation: at least one field (`DONE`/`REMAINING`/`DECISIONS`/`UNCERTAIN`) with content after the colon.

### Review Format

Written by review agent. Must start with verdict line.

```markdown
## Review

Verdict: PASS

[detailed feedback...]
```

First non-empty line in the section must be `Verdict: PASS` or `Verdict: FAIL` (case-insensitive). Parsed by workflow engine to gate transitions.

## Status

Single source of truth. Other specs reference this table.

| Status | Terminal | Description |
|--------|----------|-------------|
| `pending` | no | Created, not spawned |
| `planning` | no | Agent reading task, writing plan |
| `clarification` | no | Agent waiting for user input |
| `working` | no | Agent implementing |
| `agent-review` | no | Review agent evaluating |
| `reviewing` | no | Review passed, awaiting human |
| `stuck` | no | Needs human intervention |
| `done` | yes | Merged/completed |
| `cancelled` | yes | User cancelled |

## Session State

Independent of task status. Tracks whether the tmux session is alive.

| State | Icon | Meaning |
|-------|------|---------|
| active | ● green | tmux session alive |
| crashed | ✗ red | tmux session died, task still active |
| inactive | ○ gray | no session expected |

## history.jsonl

Append-only event log per task.

```jsonl
{"type":"task.created","timestamp":"...","task_id":"abc123","project":"orange","branch":"dark-mode"}
{"type":"agent.spawned","timestamp":"...","workspace":"orange--1","tmux_session":"orange/dark-mode"}
{"type":"status.changed","timestamp":"...","from":"pending","to":"working"}
{"type":"agent.crashed","timestamp":"...","status":"working","crash_count":1,"reason":"no ## Handoff"}
{"type":"auto.advanced","timestamp":"...","from":"working","to":"agent-review","reason":"## Handoff found"}
{"type":"task.merged","timestamp":"...","commit":"abc123"}
```

## .pool.json

```json
{
  "workspaces": {
    "orange--1": {"status": "bound", "task": "orange/dark-mode"},
    "orange--2": {"status": "available"}
  }
}
```
