# GitHub Integration

Automate PR creation and merge detection via GitHub CLI (`gh`).

## Dependency

- GitHub CLI (`gh`) — must be installed and authenticated
- Graceful degradation: all PR features disabled when `gh` unavailable

## PR Lifecycle

### Auto-detect Existing PR

On task creation, Orange checks if the branch already has a PR on GitHub. If found, `pr_url` is populated automatically. This enables:

- Creating tasks for existing PRs (e.g., review tasks)
- Adopting branches with PRs created outside Orange

Best-effort: errors are ignored silently.

### Manual PR Refresh

`R` key in dashboard refreshes PR status for selected task. Useful when:

- PR was created outside Orange after task creation
- PR URL needs updating

### Create PR

`orange task create-pr <id>` (or `p` key in dashboard) for reviewing tasks:

1. Push branch to remote from workspace
2. Create PR with:
   - Title: task summary
   - Body: summary + context, followed by repo's PR template if it exists
   - Base: project's default branch
3. Store PR URL in task metadata
4. Log `pr.created` history event

PR template lookup order:
1. `.github/pull_request_template.md`
2. `.github/PULL_REQUEST_TEMPLATE.md`
3. `pull_request_template.md` (repo root)
4. `PULL_REQUEST_TEMPLATE.md` (repo root)

Errors if `gh` is not available or task already has a PR.

### Merge with PR Awareness

`orange task merge <id>` behavior depends on whether the task has a PR:

**Task has PR:**

| PR State | Behavior |
|----------|----------|
| Merged | Fetch latest default branch, skip local merge, cleanup |
| Open | Error: "PR is still open. Merge on GitHub or use `--local`." |
| Closed | Error: "PR was closed without merging." |

**Task has no PR:**
- Local merge + push + cleanup

**Flag:** `--local` — force local merge, bypass PR status check.

Cleanup is always: release workspace, kill tmux session, delete remote branch, status → `done`.

### Dashboard PR Polling

Dashboard polls PR statuses every 30s. When a PR is detected as merged for any active task (`working`, `reviewing`, `stuck`), it auto-triggers merge cleanup. When a PR is detected as closed without merge, it auto-cancels the task (kills tmux session, releases workspace, status → `cancelled`).

### Task Metadata

Tasks gain a `pr_url` field in TASK.md frontmatter:

```yaml
---
id: abc123
project: orange
branch: dark-mode
status: reviewing
pr_url: https://github.com/user/orange/pull/42
# ...
---
```

Null when no PR was created.

### History Events

```jsonl
{"type":"pr.created","timestamp":"...","url":"https://github.com/user/repo/pull/42"}
{"type":"pr.merged","timestamp":"...","url":"https://github.com/user/repo/pull/42","merge_commit":"abc123"}
```

## CLI Commands

```bash
orange task create-pr <task_id>                  # Push + create PR for reviewing task
orange task merge <task_id> [--strategy ff|merge] [--local]  # --local: bypass PR check
```

## Future Work

- Webhook-based detection (currently polling-only)

## Edge Cases

- **No remote** — push fails, PR creation errors
- **`gh` not installed** — all PR features disabled, local workflow works
- **PR closed without merge** — dashboard auto-cancels task; `orange task merge` errors
- **PR merge conflicts** — user resolves on GitHub, orange detects the merge
- **Auth expired** — treated as `gh` unavailable for that call
