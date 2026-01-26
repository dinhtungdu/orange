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
import { createLogger } from "./logger.js";

/**
 * Create production dependencies.
 */
export function createDeps(): Deps {
  const dataDir = join(homedir(), "orange");
  return {
    tmux: createTmux(),
    git: createGit(),
    clock: createClock(),
    logger: createLogger({ dataDir }),
    dataDir,
  };
}

/**
 * Create test dependencies with provided overrides.
 * Can also pass a string as dataDir shorthand.
 * Uses NullLogger by default to avoid file I/O in tests.
 */
export function createTestDeps(overrides: Partial<Deps> | string): Deps {
  const dataDir = typeof overrides === "string" ? overrides : overrides.dataDir ?? join(homedir(), "orange-test");

  // Import NullLogger lazily to avoid circular deps
  const { NullLogger } = require("./logger.js");

  const defaults: Deps = {
    tmux: createTmux(),
    git: createGit(),
    clock: createClock(),
    logger: new NullLogger(),
    dataDir,
  };

  // Support string shorthand for dataDir
  if (typeof overrides === "string") {
    return defaults;
  }

  return {
    ...defaults,
    ...overrides,
  };
}
