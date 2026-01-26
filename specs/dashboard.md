# Dashboard TUI

TypeScript + pi-tui. Task-centric monitoring.

```
┌─────────────────────────────────────────────────────────┐
│ Orange Dashboard                          3 tasks       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ ● orange/dark-mode                    [working]    2m  │
│   Add dark mode support with system preference...       │
│   > Implementing ThemeContext provider...               │
│                                                         │
│ ● coffee/login-fix                    [working]    5m  │
│   Fix OAuth redirect loop on mobile                     │
│   > Self-review: checking error handling...             │
│                                                         │
│ ◉ app/refactor                        [needs_human] 15m│
│   Refactor auth module to use new token service         │
│   > Ready for human review                              │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ j/k navigate │ Enter attach │ p peek │ m merge │ q quit │
└─────────────────────────────────────────────────────────┘
```

## Legend

- `●` = agent active (working)
- `◉` = review passed, ready for human (needs_human)
- `⚠` = agent stuck, needs help (stuck)
- `○` = idle (done/failed)
- `[status]` = current status
- Last line = recent agent output (via tmux capture-pane)

## Keybindings

| Key | Action |
|-----|--------|
| j/k | Navigate tasks |
| Enter | Attach to task's tmux session |
| p | Peek - show more agent output |
| m | Merge task (local merge + cleanup) |
| x | Cancel task (cleanup) |
| o | Open PR in browser |
| q | Quit dashboard |

## Implementation (pi-tui)

```typescript
import { TUI, Component } from '@mariozechner/pi-tui';

interface Task {
  id: string;
  project: string;
  branch: string;
  status: 'pending' | 'working' | 'needs_human' | 'stuck' | 'done' | 'failed';
  description: string;
  lastOutput?: string;
}

class TaskRow implements Component {
  constructor(private task: Task, private selected: boolean) {}

  render(width: number): string[] {
    const icon = this.task.status === 'needs_human' ? '◉' :
                 this.task.status === 'stuck' ? '⚠' :
                 this.task.status === 'working' ? '●' : '○';
    const status = `[${this.task.status}]`;
    const name = `${this.task.project}/${this.task.branch}`;

    return [
      `${this.selected ? '>' : ' '} ${icon} ${name.padEnd(30)} ${status}`,
      `    ${this.task.description.slice(0, width - 6)}`,
      `    > ${this.task.lastOutput || '...'}`,
      ''
    ];
  }
}

class Dashboard implements Component {
  tasks: Task[] = [];
  cursor = 0;

  render(width: number): string[] {
    const lines = [`Orange Dashboard                    ${this.tasks.length} tasks`, '─'.repeat(width)];
    for (let i = 0; i < this.tasks.length; i++) {
      lines.push(...new TaskRow(this.tasks[i], i === this.cursor).render(width));
    }
    lines.push('─'.repeat(width));
    lines.push('j/k navigate │ Enter attach │ p peek │ m merge │ q quit');
    return lines;
  }

  handleInput(key: string) {
    if (key === 'j') this.cursor = Math.min(this.cursor + 1, this.tasks.length - 1);
    if (key === 'k') this.cursor = Math.max(this.cursor - 1, 0);
    // ... other handlers
  }
}
```

## Polling

```typescript
// Watch task folders for changes
const watcher = chokidar.watch('~/orange/tasks', { persistent: true });
watcher.on('change', () => this.reloadTasks());

// Capture agent output periodically
setInterval(() => {
  for (const task of this.tasks.filter(t => t.status === 'working')) {
    const output = execSync(`tmux capture-pane -t "${task.project}/${task.branch}" -p | tail -1`);
    task.lastOutput = output.toString().trim();
  }
  this.tui.invalidate();
}, 5000);
```
