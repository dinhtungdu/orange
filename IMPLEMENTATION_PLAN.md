# Implementation Plan: Multi-Harness Support

## Phase 1: Core Types & Data
**Files:** `src/core/types.ts`, `src/core/state.ts`

1. Add `Harness` type: `"pi" | "opencode" | "claude" | "codex"`
2. Add `harness` field to `Task` interface
3. Update `parseTask` / `saveTask` to handle `harness` field
4. Default to `"claude"` for existing tasks (backward compat)

## Phase 2: Harness Module
**File:** `src/core/harness.ts` (new)

```ts
interface HarnessConfig {
  binary: string;
  spawnCommand: (prompt: string) => string;
  respawnCommand: (prompt: string) => string;
  workspaceSetup?: (path: string) => Promise<void>;
  gitExcludes: string[];
  skillsDir: string;
}

const HARNESSES: Record<Harness, HarnessConfig>;

function getInstalledHarnesses(): Promise<Harness[]>;
function resolveHarness(explicit?: string): Promise<Harness>;
```

## Phase 3: Spawn & Respawn
**Files:** `src/core/spawn.ts`, `src/cli/commands/task.ts`

1. `spawnTaskById`: Use `HARNESSES[task.harness].spawnCommand(prompt)`
2. `respawnTask`: Use `HARNESSES[task.harness].respawnCommand(prompt)`
3. Remove hardcoded `claude` commands

## Phase 4: Workspace Setup
**File:** `src/core/workspace.ts`

1. Replace hardcoded `.claude/settings.local.json` → call `harness.workspaceSetup?.(path)`
2. Update `addGitExcludes` to include all harness dirs

## Phase 5: Task Create (CLI)
**File:** `src/cli/commands/task.ts`

1. Add `--harness` flag parsing
2. Call `resolveHarness(args.harness)` to get harness
3. Store in task on create

## Phase 6: Dashboard Create Form
**File:** `src/dashboard/` (create form component)

1. Add harness field to create form
2. Default to first installed
3. Tab cycles through installed harnesses
4. Pass harness to task creation

## Phase 7: Install Command
**File:** `src/cli/commands/install.ts`

1. Add `--harness` and `--all` flags
2. Detect installed harnesses
3. Install skill to correct dir per harness
4. Template skill with `--harness <name>` in commands

## Phase 8: Tests
- Unit tests for `harness.ts`
- Update spawn tests for multi-harness
- Integration test: create task with each harness

---

## Order & Dependencies

```
Phase 1 (types)
    ↓
Phase 2 (harness module)
    ↓
Phase 3 (spawn) ←── depends on 1, 2
Phase 4 (workspace) ←── depends on 2
    ↓
Phase 5 (CLI) ←── depends on 1, 2, 3
Phase 6 (dashboard) ←── depends on 1, 2, 5
Phase 7 (install) ←── depends on 2
    ↓
Phase 8 (tests)
```

## Estimated Scope

| Phase | Files | Complexity |
|-------|-------|------------|
| 1 | 2 | Low |
| 2 | 1 (new) | Medium |
| 3 | 2 | Medium |
| 4 | 1 | Low |
| 5 | 1 | Low |
| 6 | 1-2 | Medium |
| 7 | 1 | Medium |
| 8 | 2-3 | Medium |
