/**
 * Dependency injection container factory.
 *
 * Creates the Deps object with all external dependencies wired up.
 * Production uses real implementations; tests use mocks.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { Deps } from "./types.js";
import { createTmux } from "./tmux.js";
import { createGit } from "./git.js";
import { createClock } from "./clock.js";

/**
 * Create production dependencies.
 */
export function createDeps(): Deps {
  return {
    tmux: createTmux(),
    git: createGit(),
    clock: createClock(),
    dataDir: join(homedir(), "orange"),
  };
}

/**
 * Create test dependencies with provided overrides.
 */
export function createTestDeps(overrides: Partial<Deps>): Deps {
  const defaults = createDeps();
  return {
    ...defaults,
    ...overrides,
  };
}
