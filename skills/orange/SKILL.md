---
name: orange
description: Orange agent orchestration. Use when TASK.md present (worker) OR user wants parallel tasks (orchestrator).
---

# Orange

## Modes

- **TASK.md exists** → Worker: implement the task
- **No TASK.md** → Orchestrator: create/manage tasks

## Worker

Read `TASK.md` for description (frontmatter) and context (body).

If resuming (`working`/`stuck`/`clarification`), check `## Notes` for prior state.

If task is unclear, add questions to body, set `--status clarification`, wait.

Before stopping, update `## Notes` with progress and set appropriate status.

**Don't** push or merge — human handles that.

## Orchestrator

Break work into independent, parallel tasks. Create with `orange task create`.

Monitor with `orange task list`. Respawn crashed sessions.

## Commands

```
orange task create [branch] [description] [--context -]
orange task list [--status <status>]
orange task update [--status <status>] [--branch <name>] [--description <text>]
orange task spawn|respawn|cancel|merge <task_id>
```

## Statuses

```
pending → working → reviewing → done
                 ↘ stuck
         ↘ clarification (needs input)
cancelled (any time)
```
