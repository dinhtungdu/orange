# GitHub Integration

Automate PR creation, status checks, and merge via GitHub CLI (`gh`).

## Goals

1. Auto-create PRs when agent finishes (status → `reviewing`)
2. Auto-detect PR merge on GitHub → complete task cleanup
3. Dashboard shows PR status (URL, checks, review state)
4. Keep local merge as fallback when `gh` is unavailable

## Dependency

- GitHub CLI (`gh`) — already used in `checkPRStatus()`
- No new npm dependencies

## New Module: `src/core/github.ts`

Abstracted behind interface for testability (injected via `Deps`).

```ts
interface GitHubExecutor {
  /** Check if gh CLI is available and authenticated */
  isAvailable(): Promise<boolean>;

  /** Create a PR. Returns PR URL. */
  createPR(cwd: string, opts: {
    branch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<string>;

  /** Get PR status for a branch */
  getPRStatus(cwd: string, branch: string): Promise<PRStatus>;
}

interface PRStatus {
  exists: boolean;
  url?: string;
  state?: "OPEN" | "CLOSED" | "MERGED";
  mergeCommit?: string;
  /** CI check rollup: pending | pass | fail | none */
  checks?: "pending" | "pass" | "fail" | "none";
  /** Review decision: approved | changes_requested | review_required | none */
  reviewDecision?: string;
}
```

### MockGitHub for testing

```ts
class MockGitHub implements GitHubExecutor {
  available = true;
  prs: Map<string, PRStatus> = new Map();
  // ...
}
```

## Changes

### 1. Add `github` to `Deps`

```ts
interface Deps {
  // ... existing
  github: GitHubExecutor;
}
```

Optional at construction — if `gh` is unavailable, methods gracefully degrade (log warning, skip PR creation).

### 2. Create PR on `approve`

When `orange task approve <id>` runs (human approved after review):

1. Push branch to remote: `git push -u origin <branch>`
2. Create PR via `gh pr create`
   - Title: task description (first line)
   - Body: built from repo's `.github/pull_request_template.md` if it exists, with task description and context prepended. If no template, use task description + context as body.
   - Base: project's `default_branch`
3. Store PR URL in task metadata (new `pr_url` field on `Task`)
4. Add `pr.created` history event

If `gh` unavailable or push fails → log warning, continue (task still moves to `reviewed`).

### 3. New Task field: `pr_url`

```ts
interface Task {
  // ... existing
  pr_url: string | null;
}
```

Added to TASK.md frontmatter. Null when no PR created.

### 4. PR status polling in dashboard

Dashboard already watches task files. Add periodic PR status check:

- Poll every 30s for tasks in `reviewing` state that have a `pr_url`
- Show in dashboard: PR URL, check status (✓/✗/⏳), review state
- When PR merged detected → auto-run merge cleanup (same as `orange task merge`)

### 5. Auto-merge on PR merge detection

New command or hook: `orange task sync`

- Scans all `reviewing`/`reviewed` tasks with `pr_url`
- Checks PR status via `gh pr view`
- If merged → run cleanup (release workspace, kill session, status → `done`)
- Called by dashboard poll loop, or manually

### 6. Merge command changes

`orange task merge` already detects PR merges via `checkPRStatus()`. The enhanced flow:

**Current behavior (preserved):**
- Check if PR exists and is merged → skip local merge, fetch latest, cleanup
- No PR or PR not merged → local merge to default branch, push, cleanup

**New behavior with GitHub integration:**

When a task has `pr_url` set (PR was created during approve):
- `orange task merge <id>` checks PR status:
  - **PR merged on GitHub** → skip local merge, fetch + reset to `origin/<default_branch>`, cleanup (release workspace, delete remote branch, kill session). This is the primary happy path.
  - **PR still open** → error with message "PR is still open at <url>. Merge on GitHub or use --local to merge locally."
  - **PR closed (not merged)** → error with message "PR was closed without merging."

When a task has no `pr_url` (no GitHub, or PR creation skipped):
- Same as current: local merge + push + cleanup

**Flags:**
- `--local` — force local merge even if PR exists (bypass PR status check, do local merge + push). Useful when you want to skip the GitHub PR flow.

In all cases, cleanup is the same: release workspace, kill tmux session, delete remote branch, status → `done`.

### 7. New history events

```ts
type HistoryEventType =
  | // ... existing
  | "pr.created"
  | "pr.merged";

interface PRCreatedEvent extends HistoryEventBase {
  type: "pr.created";
  url: string;
}

interface PRMergedEvent extends HistoryEventBase {
  type: "pr.merged";
  url: string;
  merge_commit: string;
}
```

## Implementation Order

1. **`src/core/github.ts`** — `GitHubExecutor` interface, `RealGitHub`, `MockGitHub`
2. **Types** — add `pr_url` to `Task`, new history events, add `github` to `Deps`
3. **`completeTask`** — push + create PR after marking `reviewing`
4. **`mergeTask`** — add `--pr` / `--local` flags, enhance PR detection
5. **`orange task sync`** — new subcommand for PR merge detection
6. **Dashboard** — show PR status, auto-sync loop
7. **Tests** — unit tests with `MockGitHub`

## Edge Cases

- **No remote** — push fails silently, skip PR creation, local-only workflow works
- **`gh` not installed** — detected at startup, all PR features disabled, warn once
- **PR closed without merge** — sync detects `CLOSED` state, leave task as-is (user decides)
- **PR merge conflicts** — user resolves on GitHub, orange just detects the merge
- **Multiple PRs for same branch** — `gh pr view <branch>` returns the latest, which is correct
- **Auth expired** — `gh` returns error, treated as unavailable for that call

## Non-Goals (for now)

- Auto-requesting reviewers
- PR templates
- Label management
- Webhook-based detection (polling is fine for single user)
