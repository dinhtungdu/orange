/**
 * Pi extension for Orange task management.
 *
 * Provides:
 * - `tasks` tool: structured task operations (list, get, create, update)
 * - `/tasks` command: interactive TUI for browsing tasks
 *
 * Wraps the `orange` CLI with --json flag for structured I/O.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import {
  Container,
  Text,
  Input,
  Key,
  type TUI,
  type Focusable,
  fuzzyMatch,
  getEditorKeybindings,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";

// =============================================================================
// Types
// =============================================================================

interface Task {
  id: string;
  project: string;
  branch: string;
  harness: string;
  status: string;
  workspace: string | null;
  tmux_session: string | null;
  summary: string;
  body: string;
  created_at: string;
  updated_at: string;
  pr_url: string | null;
}

interface TaskListResult {
  tasks: Task[];
}

interface TaskResult {
  task: Task;
  message?: string;
}

interface ErrorResult {
  error: string;
}

type ToolDetails =
  | { action: "list" | "list-all"; tasks: Task[]; error?: string }
  | { action: "get" | "create" | "update"; task?: Task; message?: string; error?: string };

// =============================================================================
// Tool Schema
// =============================================================================

const TasksParams = Type.Object({
  action: StringEnum(["list", "list-all", "get", "create", "update"] as const),
  id: Type.Optional(Type.String({ description: "Task ID (for get/update)" })),
  summary: Type.Optional(Type.String({ description: "Task summary" })),
  branch: Type.Optional(Type.String({ description: "Git branch name" })),
  harness: Type.Optional(Type.String({ description: "Agent harness (pi/claude/opencode/codex)" })),
  status: Type.Optional(Type.String({ description: "Task status filter or new status" })),
});

type TasksParamsType = Static<typeof TasksParams>;

// =============================================================================
// CLI Helpers
// =============================================================================

async function execOrange(
  pi: ExtensionAPI,
  args: string[],
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await pi.exec("orange", [...args, "--json"], { signal });
}

function parseResult<T>(stdout: string): T | ErrorResult {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return { error: `Failed to parse output: ${stdout}` };
  }
}

function isError(result: unknown): result is ErrorResult {
  return typeof result === "object" && result !== null && "error" in result;
}

// =============================================================================
// Status Colors
// =============================================================================

const STATUS_COLOR: Record<string, string> = {
  pending: "muted",
  clarification: "warning",
  working: "info",
  reviewing: "accent",
  stuck: "error",
  done: "success",
  cancelled: "dim",
};

function getStatusColor(status: string): string {
  return STATUS_COLOR[status] || "text";
}

// =============================================================================
// Tool Implementation
// =============================================================================

async function executeTool(
  pi: ExtensionAPI,
  params: TasksParamsType,
  signal?: AbortSignal
): Promise<{ content: Array<{ type: "text"; text: string }>; details: ToolDetails }> {
  const { action, id, summary, branch, harness, status } = params;

  switch (action) {
    case "list": {
      const args = ["task", "list"];
      if (status) args.push("--status", status);
      const result = await execOrange(pi, args, signal);
      const parsed = parseResult<TaskListResult>(result.stdout);
      if (isError(parsed)) {
        return {
          content: [{ type: "text", text: parsed.error }],
          details: { action: "list", tasks: [], error: parsed.error },
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
        details: { action: "list", tasks: parsed.tasks },
      };
    }

    case "list-all": {
      const args = ["task", "list", "--all"];
      const result = await execOrange(pi, args, signal);
      const parsed = parseResult<TaskListResult>(result.stdout);
      if (isError(parsed)) {
        return {
          content: [{ type: "text", text: parsed.error }],
          details: { action: "list-all", tasks: [], error: parsed.error },
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
        details: { action: "list-all", tasks: parsed.tasks },
      };
    }

    case "get": {
      if (!id) {
        return {
          content: [{ type: "text", text: "Error: id required for get" }],
          details: { action: "get", error: "id required" },
        };
      }
      const result = await execOrange(pi, ["task", "show", id], signal);
      const parsed = parseResult<TaskResult>(result.stdout);
      if (isError(parsed)) {
        return {
          content: [{ type: "text", text: parsed.error }],
          details: { action: "get", error: parsed.error },
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(parsed.task, null, 2) }],
        details: { action: "get", task: parsed.task },
      };
    }

    case "create": {
      const args = ["task", "create"];
      if (branch) args.push(branch);
      if (summary) args.push(summary);
      if (harness) args.push("--harness", harness);
      const result = await execOrange(pi, args, signal);
      const parsed = parseResult<TaskResult>(result.stdout);
      if (isError(parsed)) {
        return {
          content: [{ type: "text", text: parsed.error }],
          details: { action: "create", error: parsed.error },
        };
      }
      return {
        content: [{ type: "text", text: parsed.message || `Created task ${parsed.task.id}` }],
        details: { action: "create", task: parsed.task, message: parsed.message },
      };
    }

    case "update": {
      if (!id) {
        return {
          content: [{ type: "text", text: "Error: id required for update" }],
          details: { action: "update", error: "id required" },
        };
      }
      const args = ["task", "update", id];
      if (summary) args.push("--summary", summary);
      if (status) args.push("--status", status);
      const result = await execOrange(pi, args, signal);
      const parsed = parseResult<TaskResult>(result.stdout);
      if (isError(parsed)) {
        return {
          content: [{ type: "text", text: parsed.error }],
          details: { action: "update", error: parsed.error },
        };
      }
      return {
        content: [{ type: "text", text: parsed.message || `Updated task ${parsed.task.id}` }],
        details: { action: "update", task: parsed.task, message: parsed.message },
      };
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown action: ${action}` }],
        details: { action: "list", tasks: [], error: `Unknown action: ${action}` },
      };
  }
}

// =============================================================================
// TUI Components
// =============================================================================

function copyToClipboard(text: string): void {
  const proc = Bun.spawn(
    process.platform === "darwin" ? ["pbcopy"] : ["xclip", "-selection", "clipboard"],
    { stdin: "pipe" }
  );
  proc.stdin.write(text);
  proc.stdin.end();
}

class TaskSelectorComponent extends Container implements Focusable {
  private searchInput: Input;
  private listContainer: Container;
  private allTasks: Task[];
  private filteredTasks: Task[];
  private selectedIndex = 0;
  private onSelectCallback: (task: Task) => void;
  private onCancelCallback: () => void;
  private onSpawnCallback: (task: Task) => void;
  private onCopyCallback: (task: Task) => void;
  private tui: TUI;
  private theme: Theme;
  private headerText: Text;
  private hintText: Text;

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(
    tui: TUI,
    theme: Theme,
    tasks: Task[],
    onSelect: (task: Task) => void,
    onCancel: () => void,
    onSpawn: (task: Task) => void,
    onCopy: (task: Task) => void
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.allTasks = tasks;
    this.filteredTasks = tasks;
    this.onSelectCallback = onSelect;
    this.onCancelCallback = onCancel;
    this.onSpawnCallback = onSpawn;
    this.onCopyCallback = onCopy;

    this.headerText = new Text("", 1, 0);
    this.addChild(this.headerText);

    this.searchInput = new Input();
    this.searchInput.onSubmit = () => {
      const selected = this.filteredTasks[this.selectedIndex];
      if (selected) this.onSelectCallback(selected);
    };
    this.addChild(this.searchInput);

    this.listContainer = new Container();
    this.addChild(this.listContainer);

    this.hintText = new Text("", 1, 0);
    this.addChild(this.hintText);

    this.updateHeader();
    this.updateHints();
    this.applyFilter("");
  }

  private updateHeader(): void {
    const activeCount = this.allTasks.filter(
      (t) => !["done", "cancelled"].includes(t.status)
    ).length;
    const title = `Tasks (${activeCount} active, ${this.allTasks.length} total)`;
    this.headerText.setText(this.theme.fg("accent", this.theme.bold(title)));
  }

  private updateHints(): void {
    this.hintText.setText(
      this.theme.fg("dim", "Type to search • ↑↓ navigate • Enter view • s spawn • y copy • Esc close")
    );
  }

  private applyFilter(query: string): void {
    const trimmed = query.trim();
    if (!trimmed) {
      this.filteredTasks = this.allTasks;
    } else {
      this.filteredTasks = this.allTasks.filter((task) => {
        const text = `${task.id} ${task.branch} ${task.summary} ${task.status}`;
        return fuzzyMatch(trimmed, text).matches;
      });
    }
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredTasks.length - 1));
    this.updateList();
  }

  private updateList(): void {
    this.listContainer.clear();

    if (this.filteredTasks.length === 0) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching tasks"), 0, 0));
      return;
    }

    const maxVisible = 10;
    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredTasks.length - maxVisible)
    );
    const endIndex = Math.min(startIndex + maxVisible, this.filteredTasks.length);

    for (let i = startIndex; i < endIndex; i++) {
      const task = this.filteredTasks[i];
      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
      const statusColor = getStatusColor(task.status);
      const titleColor = isSelected ? "accent" : "text";

      const line =
        prefix +
        this.theme.fg("muted", `${task.id.slice(0, 8)} `) +
        this.theme.fg(titleColor, task.branch) +
        " " +
        this.theme.fg(statusColor as any, `[${task.status}]`) +
        this.theme.fg("dim", ` ${task.summary.slice(0, 40)}${task.summary.length > 40 ? "…" : ""}`);

      this.listContainer.addChild(new Text(line, 0, 0));
    }

    if (this.filteredTasks.length > maxVisible) {
      const scrollInfo = this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.filteredTasks.length})`);
      this.listContainer.addChild(new Text(scrollInfo, 0, 0));
    }
  }

  handleInput(keyData: string): void {
    const kb = getEditorKeybindings();
    if (kb.matches(keyData, "selectUp")) {
      if (this.filteredTasks.length === 0) return;
      this.selectedIndex = this.selectedIndex === 0 ? this.filteredTasks.length - 1 : this.selectedIndex - 1;
      this.updateList();
      return;
    }
    if (kb.matches(keyData, "selectDown")) {
      if (this.filteredTasks.length === 0) return;
      this.selectedIndex = this.selectedIndex === this.filteredTasks.length - 1 ? 0 : this.selectedIndex + 1;
      this.updateList();
      return;
    }
    if (kb.matches(keyData, "selectConfirm")) {
      const selected = this.filteredTasks[this.selectedIndex];
      if (selected) this.onSelectCallback(selected);
      return;
    }
    if (kb.matches(keyData, "selectCancel")) {
      this.onCancelCallback();
      return;
    }
    if (keyData === "s") {
      const selected = this.filteredTasks[this.selectedIndex];
      if (selected && selected.status === "pending") {
        this.onSpawnCallback(selected);
      }
      return;
    }
    if (keyData === "y") {
      const selected = this.filteredTasks[this.selectedIndex];
      if (selected) {
        this.onCopyCallback(selected);
      }
      return;
    }
    this.searchInput.handleInput(keyData);
    this.applyFilter(this.searchInput.getValue());
  }

  override invalidate(): void {
    super.invalidate();
    this.updateHeader();
    this.updateHints();
    this.updateList();
  }
}

class TaskDetailOverlay {
  private task: Task;
  private theme: Theme;
  private tui: TUI;
  private scrollOffset = 0;
  private viewHeight = 0;
  private totalLines = 0;
  private onBack: () => void;

  constructor(tui: TUI, theme: Theme, task: Task, onBack: () => void) {
    this.tui = tui;
    this.theme = theme;
    this.task = task;
    this.onBack = onBack;
  }

  handleInput(keyData: string): void {
    const kb = getEditorKeybindings();
    if (kb.matches(keyData, "selectCancel")) {
      this.onBack();
      return;
    }
    if (kb.matches(keyData, "selectUp") || keyData === "k") {
      this.scrollBy(-1);
      return;
    }
    if (kb.matches(keyData, "selectDown") || keyData === "j") {
      this.scrollBy(1);
      return;
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(10, width - 4);
    const maxHeight = Math.max(10, Math.floor(this.tui.terminal.rows * 0.8));
    const headerLines = 4;
    const footerLines = 2;
    const contentHeight = Math.max(1, maxHeight - headerLines - footerLines);

    const bodyText = this.task.body?.trim() || "(no body)";
    const allLines = bodyText.split("\n");
    this.totalLines = allLines.length;
    this.viewHeight = contentHeight;
    const maxScroll = Math.max(0, this.totalLines - contentHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

    const visibleLines = allLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);
    const lines: string[] = [];

    // Header
    lines.push(this.theme.fg("accent", this.theme.bold(` ${this.task.branch}`)));
    lines.push(this.theme.fg("muted", ` ${this.task.id} • ${this.task.status} • ${this.task.project}`));
    lines.push(this.theme.fg("text", ` ${this.task.summary || "(no summary)"}`));
    lines.push(this.theme.fg("dim", "─".repeat(innerWidth)));

    // Body
    for (const line of visibleLines) {
      lines.push(" " + truncateToWidth(line, innerWidth - 1));
    }

    // Padding
    while (lines.length < headerLines + contentHeight) {
      lines.push("");
    }

    // Footer
    lines.push(this.theme.fg("dim", "─".repeat(innerWidth)));
    let footer = this.theme.fg("dim", " Esc back • j/k scroll");
    if (this.totalLines > this.viewHeight) {
      footer += this.theme.fg("dim", ` • ${this.scrollOffset + 1}-${Math.min(this.scrollOffset + this.viewHeight, this.totalLines)}/${this.totalLines}`);
    }
    lines.push(footer);

    return lines.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}

  private scrollBy(delta: number): void {
    const maxScroll = Math.max(0, this.totalLines - this.viewHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta, maxScroll));
  }
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function orangeExtension(pi: ExtensionAPI) {
  // Register the tasks tool
  pi.registerTool({
    name: "tasks",
    label: "Tasks",
    description:
      "Manage Orange tasks (list, list-all, get, create, update). " +
      "Use list for active tasks, list-all for all. " +
      "Create tasks with summary and optional branch. " +
      "Update task summary or status by id.",
    parameters: TasksParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return await executeTool(pi, params as TasksParamsType, signal);
    },

    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "";
      const id = typeof args.id === "string" ? args.id.slice(0, 8) : "";
      const summary = typeof args.summary === "string" ? args.summary : "";
      let text = theme.fg("toolTitle", theme.bold("tasks ")) + theme.fg("muted", action);
      if (id) text += " " + theme.fg("accent", id);
      if (summary) text += " " + theme.fg("dim", `"${summary.slice(0, 30)}${summary.length > 30 ? "…" : ""}"`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as ToolDetails | undefined;
      if (isPartial) {
        return new Text(theme.fg("warning", "Processing..."), 0, 0);
      }
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }

      if (details.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }

      if (details.action === "list" || details.action === "list-all") {
        if (details.tasks.length === 0) {
          return new Text(theme.fg("muted", "No tasks"), 0, 0);
        }
        const lines = details.tasks.slice(0, expanded ? details.tasks.length : 5).map((task) => {
          const statusColor = getStatusColor(task.status);
          return (
            theme.fg("muted", `${task.id.slice(0, 8)} `) +
            theme.fg(statusColor as any, `[${task.status}]`) +
            " " +
            theme.fg("text", task.branch) +
            theme.fg("dim", ` ${task.summary.slice(0, 30)}`)
          );
        });
        if (!expanded && details.tasks.length > 5) {
          lines.push(theme.fg("dim", `... ${details.tasks.length - 5} more`));
        }
        return new Text(lines.join("\n"), 0, 0);
      }

      if (details.task) {
        const task = details.task;
        const statusColor = getStatusColor(task.status);
        let text =
          theme.fg("success", "✓ ") +
          theme.fg("muted", `${task.id.slice(0, 8)} `) +
          theme.fg(statusColor as any, `[${task.status}]`) +
          " " +
          theme.fg("text", task.branch);
        if (details.message) {
          text = theme.fg("success", "✓ ") + theme.fg("muted", details.message);
        }
        return new Text(text, 0, 0);
      }

      const text = result.content[0];
      return new Text(text?.type === "text" ? text.text : "", 0, 0);
    },
  });

  // Register the /tasks command
  pi.registerCommand("tasks", {
    description: "Browse Orange tasks interactively",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        // Non-interactive: just list tasks
        const result = await execOrange(pi, ["task", "list", "--all"]);
        const parsed = parseResult<TaskListResult>(result.stdout);
        if (isError(parsed)) {
          console.log(`Error: ${parsed.error}`);
          return;
        }
        for (const task of parsed.tasks) {
          console.log(`${task.id.slice(0, 8)} [${task.status}] ${task.project}/${task.branch} - ${task.summary}`);
        }
        return;
      }

      // Fetch tasks
      const result = await execOrange(pi, ["task", "list", "--all"]);
      const parsed = parseResult<TaskListResult>(result.stdout);
      if (isError(parsed)) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }

      const tasks = parsed.tasks;
      let selectedTask: Task | null = null;

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        let overlay: TaskDetailOverlay | null = null;
        let selector: TaskSelectorComponent | null = null;

        const showDetail = (task: Task) => {
          selectedTask = task;
          overlay = new TaskDetailOverlay(tui, theme, task, () => {
            overlay = null;
            tui.requestRender();
          });
          tui.requestRender();
        };

        const spawnTask = async (task: Task) => {
          if (task.status !== "pending") {
            ctx.ui.notify("Can only spawn pending tasks", "warning");
            return;
          }
          const spawnResult = await execOrange(pi, ["task", "spawn", task.id]);
          const spawnParsed = parseResult<TaskResult>(spawnResult.stdout);
          if (isError(spawnParsed)) {
            ctx.ui.notify(spawnParsed.error, "error");
          } else {
            ctx.ui.notify(`Spawned ${task.branch}`, "success");
            done();
          }
        };

        const copyId = (task: Task) => {
          copyToClipboard(task.id);
          ctx.ui.notify(`Copied ${task.id}`, "info");
        };

        selector = new TaskSelectorComponent(
          tui,
          theme,
          tasks,
          showDetail,
          done,
          spawnTask,
          copyId
        );

        return {
          get focused() {
            return selector?.focused ?? false;
          },
          set focused(value: boolean) {
            if (selector) selector.focused = value;
          },
          render(width: number) {
            if (overlay) {
              return overlay.render(width);
            }
            return selector ? selector.render(width) : [];
          },
          invalidate() {
            if (overlay) overlay.invalidate();
            if (selector) selector.invalidate();
          },
          handleInput(data: string) {
            if (overlay) {
              overlay.handleInput(data);
            } else if (selector) {
              selector.handleInput(data);
            }
          },
        };
      });
    },
  });
}
