# GitHub Integration

Automate PR creation and merge detection via GitHub CLI (`gh`).

## Dependency

- GitHub CLI (`gh`) — must be installed and authenticated
- Graceful degradation: all PR features disabled when `gh` unavailable

## PR Lifecycle

### Create PR on Approve

When a task is approved (`orange task approve <id>`):

1. Push branch to remote
2. Create PR with:
   - Title: first line of task description
   - Body: task description + context, followed by repo's PR template if it exists
   - Base: project's default branch
3. Store PR URL in task metadata
4. Log `pr.created` history event

PR template lookup order:
1. `.github/pull_request_template.md`
2. `.github/PULL_REQUEST_TEMPLATE.md`
3. `pull_request_template.md` (repo root)
4. `PULL_REQUEST_TEMPLATE.md` (repo root)

If push or PR creation fails → log warning, task still moves to `reviewed`.

### Merge with PR Awareness

`orange task merge <id>` behavior depends on whether the task has a PR:

**Task has PR:**

| PR State | Behavior |
|----------|----------|
| Merged | Fetch latest default branch, skip local merge, cleanup |
| Open | Error: "PR is still open. Merge on GitHub or use `--local`." |
| Closed | Error: "PR was closed without merging." |

**Task has no PR:**
- Local merge + push + cleanup (unchanged from before)

**Flag:** `--local` — force local merge, bypass PR status check.

Cleanup is always: release workspace, kill tmux session, delete remote branch, status → `done`.

### Task Metadata

Tasks gain a `pr_url` field in TASK.md frontmatter:

```yaml
---
id: abc123
project: orange
branch: dark-mode
status: reviewed
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

## CLI Changes

```bash
orange task approve <task_id>                    # Now also pushes + creates PR
orange task merge <task_id> [--strategy ff|merge] [--local]  # --local: bypass PR check
```

## Future Work

- Dashboard: show PR URL, CI check status, review decision
- `orange task sync` command: poll reviewed tasks, auto-cleanup merged PRs
- Webhook-based detection (currently polling-only)

## Edge Cases

- **No remote** — push fails silently, skip PR creation
- **`gh` not installed** — all PR features disabled, local workflow works
- **PR closed without merge** — leave task as-is, user decides
- **PR merge conflicts** — user resolves on GitHub, orange detects the merge
- **Auth expired** — treated as `gh` unavailable for that call
