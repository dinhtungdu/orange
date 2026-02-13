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
  BoxRenderable,
  TextRenderable,
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

  // Create container with header and footer chrome
  const container = new BoxRenderable(renderer, {
    id: "terminal-demo",
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });

  const header = new TextRenderable(renderer, {
    id: "terminal-header",
    content: ` Session: ${sessionName}`,
    fg: "#00DDFF",
  });

  // Create terminal viewer
  const viewer = new TerminalViewer(renderer, {
    tmux,
    onSessionDeath: () => {
      footer.content = " [Session ended] Press Ctrl+C to exit";
    },
  });

  const footer = new TextRenderable(renderer, {
    id: "terminal-footer",
    content: " Ctrl+\\:exit  Ctrl+]:attach full  [text mode]",
    fg: "#888888",
  });

  container.add(header);
  container.add(viewer.getRenderable());
  container.add(footer);
  renderer.root.add(container);

  // Terminal dimensions (subtract header/footer)
  const termHeight = Math.max(1, renderer.height - 2);
  const termWidth = Math.max(20, renderer.width);

  // Enter terminal view
  await viewer.start(sessionName, termWidth, termHeight);

  // Handle keyboard input
  renderer.keyInput.on("keypress", async (key: KeyEvent) => {
    // Exit on Ctrl+C
    if (key.ctrl && key.name === "c") {
      viewer.destroy();
      renderer.destroy();
      process.exit(0);
    }

    // Ctrl+\ — exit
    if (key.ctrl && key.name === "\\") {
      viewer.destroy();
      renderer.destroy();
      process.exit(0);
    }

    // Ctrl+] — full-screen attach
    if (key.ctrl && key.name === "]") {
      viewer.destroy();
      renderer.destroy();
      await tmux.attachOrCreate(sessionName, process.cwd());
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
  renderer.on("resize", () => {
    const h = Math.max(1, renderer.height - 2);
    const w = Math.max(20, renderer.width);
    viewer.resize(w, h);
  });

  console.log(`Connected to tmux session: ${sessionName}`);
  console.log("Press Ctrl+\\ to exit, Ctrl+] to attach full tmux");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
