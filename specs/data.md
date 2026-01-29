# Data & Storage

All data in `~/orange/`.

```
~/orange/
├── projects.json           # Project registry
├── orange.log              # Structured log (rotated at 10MB)
├── workspaces/             # Worktree pool (reused)
│   ├── orange--1/
│   ├── orange--2/
│   ├── coffee--1/
│   └── .pool.json          # Pool state
└── tasks/                  # Task folders (source of truth)
    └── <project>/
        └── <branch>/
            ├── TASK.md           # Description, metadata (frontmatter)
            ├── .orange-outcome   # Agent outcome (symlinked to worktree)
            └── history.jsonl     # Event log
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

21-character alphanumeric string (nanoid with `[0-9A-Za-z]` alphabet). No hyphens or special characters — IDs are safe to use as CLI positional arguments.

## TASK.md

Human-readable task file with YAML frontmatter:

```markdown
---
id: abc123
project: orange
branch: dark-mode
harness: pi
status: working
workspace: orange--1
tmux_session: orange/dark-mode
created_at: 2024-01-15T10:00:00Z
updated_at: 2024-01-15T10:30:00Z
---

Task description here.

---

Optional implementation context (separated by `---`).
Piped via `--context -` on task create.
```

## Harness

The `harness` field specifies which coding agent runs the task (`pi`, `opencode`, `claude`, `codex`). See [harness.md](./harness.md) for details.

## history.jsonl

Append-only event log:

```jsonl
{"type":"task.created","timestamp":"...","task_id":"abc123","project":"orange","branch":"dark-mode"}
{"type":"agent.spawned","timestamp":"...","workspace":"orange--1","tmux_session":"orange/dark-mode"}
{"type":"status.changed","timestamp":"...","from":"pending","to":"working"}
{"type":"task.merged","timestamp":"...","commit":"abc123"}
```

## Task Status

| Status | Description |
|--------|-------------|
| `pending` | Created, not yet spawned |
| `working` | Agent actively working (includes self-review) |
| `reviewing` | Self-review passed, awaiting human review |
| `reviewed` | Human approved, ready to merge |
| `stuck` | Agent gave up after max review attempts |
| `done` | Merged/completed |
| `failed` | Agent crashed or errored |
| `cancelled` | User cancelled |
