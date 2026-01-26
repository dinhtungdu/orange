# Data & Storage

All data in `~/orange/`.

```
~/orange/
├── projects.json           # Project registry
├── workspaces/             # Worktree pool (reused)
│   ├── orange--1/
│   ├── orange--2/
│   └── coffee--1/
├── tasks/
│   └── <project>/
│       └── <branch>/
│           ├── TASK.md         # Description, metadata
│           └── history.jsonl   # Event log (source of truth)
└── index.db                # SQLite cache (derived, rebuildable)
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

## Task Folder (`tasks/<project>/<branch>/`)

**TASK.md** - Human-readable task description with frontmatter:
```markdown
---
id: abc123
project: orange
branch: dark-mode
status: working
workspace: orange--1
tmux_session: orange/dark-mode
created_at: 2024-01-15T10:00:00Z
---

Add dark mode support with system preference detection.

- Toggle in settings
- Persist preference
- Match system theme by default
```

**history.jsonl** - Append-only event log (source of truth):
```jsonl
{"type":"task.created","at":"2024-01-15T10:00:00Z","by":"orchestrator"}
{"type":"agent.spawned","at":"2024-01-15T10:00:05Z","workspace":"orange--1","session":"orange/dark-mode"}
{"type":"message","at":"2024-01-15T10:01:00Z","role":"agent","content":"Reading CLAUDE.md..."}
{"type":"review.started","at":"2024-01-15T10:25:00Z","attempt":1}
{"type":"review.passed","at":"2024-01-15T10:28:00Z","attempt":1}
{"type":"agent.stopped","at":"2024-01-15T10:30:00Z","outcome":"completed"}
{"type":"status.changed","at":"2024-01-15T10:30:01Z","from":"working","to":"needs_human"}
{"type":"task.merged","at":"2024-01-15T11:00:00Z","commit":"abc123"}
```

## index.db (derived cache)

SQLite cache for fast dashboard queries. Rebuilt from task folders if missing/corrupted.

```sql
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    branch TEXT NOT NULL,
    status TEXT NOT NULL,
    workspace TEXT,
    tmux_session TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_project ON tasks(project);
```

**Rebuild logic:**
```
for each ~/orange/tasks/<project>/<branch>/TASK.md:
    parse frontmatter → upsert into index.db
```

## Task Status

| Status | Description |
|--------|-------------|
| `pending` | Created, not yet spawned |
| `working` | Agent actively working (includes self-review) |
| `needs_human` | Self-review passed, ready for human review |
| `stuck` | Agent gave up after max review attempts, needs help |
| `done` | Merged/completed |
| `failed` | Agent crashed or errored |
