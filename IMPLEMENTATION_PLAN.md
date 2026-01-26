# Matcha Implementation Plan

## Status: Phase 15 Complete

**Goal**: Zellij-native workspace manager with PR integration

**Legend**: 🔴 Not started | 🟡 In progress | 🟢 Complete

**Last verified**: 2026-01-23

**Specs**: See `specs/*.md` for detailed specifications

---

## Remaining Work (Prioritized)

### P2 - Medium Priority (Documented Future Features)

- 🔴 **Continuous stats refresh** (currently one-shot on startup)
  - Options: periodic polling (30-60s) or file watcher for `.git/` changes
  - **Decision**: Intentionally one-shot for simplicity (see Key Decisions)
  - Implement only if users report stale stats as pain point

- 🔴 **Custom tab layouts per workspace** (`_tabs_config` parameter)
  - `TabsConfig` loaded but hardcoded to `workspace.kdl`
  - `workspace_overrides` in `tabs.json` defined but not used
  - `_tabs_config` parameter passed through `main.rs` (3 locations) but unused
  - Would allow per-workspace pane configurations

### P3 - Low Priority (Long-term Architecture)

- 🔴 **Container backend** - `Backend::Container` defined in `types.rs` but not implemented
  - Would allow workspaces in Docker/Podman containers
  - Keep reserved for future implementation

- 🔴 **Remote backend** - `Backend::Remote` defined in `types.rs` but not implemented
  - Would allow workspaces on remote machines via SSH
  - Keep reserved for future implementation

### P5 - Test Coverage Improvements (Optional)

- 🔴 **UI rendering tests** - `ui.rs` not tested
  - Could use `ratatui` test utilities for snapshot testing

- 🔴 **Event handling tests** - `main.rs` event loop not tested
  - Would require mocking terminal events

- 🔴 **Background thread tests** - Stats collection thread not tested
  - Complex to test async behavior

---

## Completed Phases (1-15)

### Phase 1-7: Foundation
- 🟢 Original tmux architecture (tabs-tui, IPC, worktree backend)
- 🟢 CLI commands: `matcha project add/list/delete`, `matcha workspace add/list/delete`
- 🟢 State management: `state.json`, `tabs.json`, `stats_cache.json`
- 🟢 Git worktree isolation backend

### Phase 8: Zellij Migration
- 🟢 Migrated from tmux to Zellij (~1000 lines deleted)
- 🟢 Zellij abstraction layer (`ZellijExecutor` trait)
- 🟢 Tab/pane management via `zellij action` commands

### Phase 9: Code Quality
- 🟢 Clippy fixes
- 🟢 Tab existence checking before operations

### Phase 10: Workspace Merge
- 🟢 `matcha workspace merge` command
- 🟢 `m` keybinding in TUI for merge with strategy selection (ff/merge)
- 🟢 Pre-checks for uncommitted changes and commits ahead

### Phase 11: Workspace Templates
- 🟢 Template system for workspace creation

### Phase 12: App Layout Keybindings
- 🟢 Number keys 1-9 for tab switching
- 🟢 Lock mode with Ctrl+g unlock (see `specs/layout.md`)

### Phase 13: PR Integration
- 🟢 PR number display (`pr_number: Option<u32>` in `WorkspaceStats`)
- 🟢 PR detection via `gh pr list --head <branch> --json number`
- 🟢 `o` keybinding to open PR in browser (`gh pr view --web`)
- 🟢 Code cleanup (consolidated `create_workspace_panes`)
- 🟢 Stats cache invalidation after workspace operations
  - `invalidate_stats()` and `invalidate_project_stats()` methods in App
  - Cache refresh triggered after workspace create/delete/merge
  - Optimistic invalidation on merge (stats refresh even if merge fails)

### Phase 14: Logging
- 🟢 File-based logging per `specs/logging.md`
- 🟢 `tracing` + `tracing-subscriber` + `tracing-appender` dependencies added
- 🟢 Log location: `~/matcha/logs/` with daily rotation (7 days retention)
- 🟢 Logging modules in `workspace-tui/src/logging.rs` and `matcha-cli/src/logging.rs`
- 🟢 Default level: `info` (configurable via `MATCHA_LOG` env var)
- 🟢 Instrumented: state.rs, zellij.rs, worktree.rs, config.rs, main.rs (both binaries)

### Phase 15: Notification Feature
- 🟢 **Add `notifications` field to `AppState`** (`matcha-common/src/state.rs`)
  - Added `notifications: HashSet<String>` field (key format: "project/workspace")
  - Added serde attributes: `#[serde(default, skip_serializing_if = "HashSet::is_empty")]`
  - Added `notify(project, workspace)` method
  - Added `clear_notification(project, workspace)` method
  - Added `is_notified(project, workspace)` method
  - Added 9 unit tests for notification state management

- 🟢 **Add `notify` CLI command** (`matcha-cli/src/main.rs`)
  - Added `Notify` variant to `Commands` enum
  - Syntax: `matcha notify <workspace> -p <project>`
  - Syntax: `matcha notify --clear <workspace> -p <project>`
  - Added `handle_notify()` function with project/workspace validation
  - Added 3 CLI parsing tests

- 🟢 **Add TUI notification indicator** (`workspace-tui/src/ui.rs`)
  - Renders yellow `●` before tab indicator (◉/○) when notified
  - Works in both normal and Quick Access modes

- 🟢 **Add 5-second polling for state reload** (`workspace-tui/src/main.rs`)
  - Polls every 5 seconds to detect CLI-initiated notifications
  - Reloads `state.json` via `app.reload_state()` method

- 🟢 **Auto-clear notification on Enter** (`workspace-tui/src/main.rs`)
  - When workspace is selected with Enter, clears its notification
  - Saves state after clearing (both normal and search modes)

- 🟢 **Update spec documentation**
  - Updated `specs/cli.md` - documented notify command
  - Updated `specs/data.md` - documented notifications field
  - Updated `specs/workspace-tui.md` - documented notification indicator

### P4 - Code Quality (Tech Debt) - COMPLETE
- 🟢 **PR JSON parsing** - Now uses `serde_json` in `worktree.rs`
  - Replaced manual string parsing with proper JSON deserialization
  - Added 4 additional tests for edge cases

- 🟢 **CLI error handling** - Now uses `MatchaError` in `matcha-cli/src/main.rs`
  - Added `ProjectNotFound`, `WorkspaceNotFound`, `Precondition` variants to `MatchaError`
  - Removed all `.map_err(|e| format!(...))` patterns
  - Added 9 error display tests to `error.rs`

- 🟢 **Integration tests** - Git worktree operations now have integration tests
  - Uses `tempfile` crate to create temporary git repositories
  - 18 new tests in `worktree.rs::integration_tests` module
  - Tests: validate_repo, branch operations, worktree create/remove/list,
    commits ahead/behind, lines changed, merge operations, etc.
  - Old `tests/integration_test.sh` (tmux-based) deprecated

---

## Test Coverage

| Crate | Unit Tests | Notes |
|-------|------------|-------|
| matcha-cli | 20 | CLI parsing (incl. notify command), state formatting |
| matcha-common | 103 | Worktree (unit + integration), zellij commands, types (incl. StatsCache), state (incl. notifications), config, error |
| workspace-tui | 52 | Navigation, actions, input modes, fuzzy search, filtering |
| **Total** | **175** | All passing |

---

## Known Issues

| Issue | Location | Impact | Notes |
|-------|----------|--------|-------|
| None | - | - | All known issues resolved |

---

## Architecture Notes

- **Zellij interaction**: `std::process::Command` via `zellij.rs`
- **State files**: JSON in `~/matcha/` (state.json, tabs.json, stats_cache.json)
- **Session name**: `matcha` (hardcoded)
- **Tab naming**: `{project}-{workspace}` (e.g., `matcha-main`)
- **Pane naming**: `"agent-claude"`, `"lazygit"`, `"shell"`, `"opencode"`
- **PR detection**: `gh pr list --head <branch> --json number`
- **Notifications**: External apps mark workspaces via `matcha notify`, TUI polls every 5s

---

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Tab spawning | Lazy | Fast workspace switch |
| Window lifecycle | Keep all + explicit close | Preserves state |
| Error handling | Show in TUI, auto-clear 3s | UX priority |
| PR creation | Via Claude agent, not `gh` | Better PR descriptions |
| Pane tracking | `dump-layout` + KDL parsing | Find agent pane by name |
| Merge conflicts | Surface error, manual resolution | Keep it simple |
| Lock mode | Default locked + Ctrl+g unlock | Pass keybindings to terminal apps |
| Stats refresh | One-shot on startup | Simple first iteration |
| PR detection | `gh pr list --head` | GitHub CLI integration |
| Backend variants | Reserved for future | Container/Remote planned but not implemented |
| Notification polling | 5-second interval | Balance between responsiveness and CPU usage |

---

## Spec Alignment Summary

| Spec | Status | Notes |
|------|--------|-------|
| `architecture.md` | 🟢 Complete | Zellij abstraction, AppState, crates |
| `cli.md` | 🟢 Complete | All commands including `notify` |
| `data.md` | 🟢 Complete | All fields including `notifications` |
| `layout.md` | 🟢 Complete | workspace.kdl layout correct; complete config options documentation |
| `logging.md` | 🟢 Complete | tracing + file appender with daily rotation |
| `workspace-tui.md` | 🟢 Complete | All features including notification indicator |
| `notification-feature.md` | 🟢 Complete | Phase 15 implementation |
| `quick-access-feature.md` | 🟢 Complete | Toggle with Tab key, flat list view |
