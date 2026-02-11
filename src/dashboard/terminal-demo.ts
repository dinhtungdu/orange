#!/usr/bin/env bun
/**
 * Demo: Terminal viewer component.
 *
 * Usage:
 *   bun run src/dashboard/terminal-demo.ts <tmux-session-name>
 *
 * This demonstrates rendering a tmux session inside the TUI
 * using plain text rendering with adaptive polling.
 */

import {
  createCliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { TerminalViewer } from "./terminal.js";
import { RealTmux } from "../core/tmux.js";

async function main() {
  const sessionName = process.argv[2];

  if (!sessionName) {
    console.error("Usage: bun run src/dashboard/terminal-demo.ts <tmux-session>");
    console.error("");
    console.error("Example:");
    console.error("  # First create a tmux session:");
    console.error("  tmux new-session -d -s demo");
    console.error("");
    console.error("  # Then run this demo:");
    console.error("  bun run src/dashboard/terminal-demo.ts demo");
    process.exit(1);
  }

  const tmux = new RealTmux();

  // Check if session exists
  const exists = await tmux.sessionExists(sessionName);
  if (!exists) {
    console.error(`Error: tmux session '${sessionName}' does not exist`);
    console.error("");
    console.error("Create it with:");
    console.error(`  tmux new-session -d -s ${sessionName}`);
    process.exit(1);
  }

  // Create renderer
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    useMouse: false,
  });

  // Create terminal viewer
  const viewer = new TerminalViewer(renderer, {
    tmux,
    onExit: () => {
      renderer.destroy();
      process.exit(0);
    },
    onAttach: async () => {
      // Full attach to tmux session
      renderer.destroy();
      await tmux.attachOrCreate(sessionName, process.cwd());
      process.exit(0);
    },
  });

  // Add to root
  renderer.root.add(viewer.getContainer());

  // Enter terminal view
  await viewer.enter(sessionName, renderer.width, renderer.height);

  // Handle keyboard input
  renderer.keyInput.on("keypress", async (key: KeyEvent) => {
    // Exit on Ctrl+C
    if (key.ctrl && key.name === "c") {
      viewer.destroy();
      renderer.destroy();
      process.exit(0);
    }

    // Forward to terminal viewer
    await viewer.handleKey(
      key.name ?? "",
      !!key.ctrl,
      key.sequence
    );
  });

  // Handle resize
  renderer.on("resize", async () => {
    await viewer.resize(renderer.width, renderer.height);
  });

  console.log(`Connected to tmux session: ${sessionName}`);
  console.log("Press Ctrl+\\ to exit, Ctrl+] to attach full tmux");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
