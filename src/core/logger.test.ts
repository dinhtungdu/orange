/**
 * Tests for the logging system.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLogger, MockLogger, NullLogger, type LogEntry } from "./logger.js";

describe("FileLogger", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "orange-log-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true });
  });

  it("creates log file on first write", () => {
    const logger = new FileLogger({ dataDir });
    const logPath = join(dataDir, "orange.log");

    expect(existsSync(logPath)).toBe(false);

    logger.info("test message");

    expect(existsSync(logPath)).toBe(true);
  });

  it("writes JSON lines", () => {
    const logger = new FileLogger({ dataDir });
    const logPath = join(dataDir, "orange.log");

    logger.info("first message");
    logger.info("second message", { key: "value" });

    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");

    expect(lines.length).toBe(2);

    const entry1 = JSON.parse(lines[0]) as LogEntry;
    expect(entry1.level).toBe("info");
    expect(entry1.msg).toBe("first message");
    expect(entry1.component).toBe("root");

    const entry2 = JSON.parse(lines[1]) as LogEntry;
    expect(entry2.msg).toBe("second message");
    expect(entry2.key).toBe("value");
  });

  it("respects log level", () => {
    const logger = new FileLogger({ dataDir, level: "warn" });
    const logPath = join(dataDir, "orange.log");

    logger.debug("debug message");
    logger.info("info message");
    logger.warn("warn message");
    logger.error("error message");

    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");

    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).level).toBe("warn");
    expect(JSON.parse(lines[1]).level).toBe("error");
  });

  it("creates child logger with component", () => {
    const logger = new FileLogger({ dataDir });
    const child = logger.child("workspace");
    const logPath = join(dataDir, "orange.log");

    child.info("child message");

    const content = readFileSync(logPath, "utf-8");
    const entry = JSON.parse(content.trim()) as LogEntry;

    expect(entry.component).toBe("workspace");
  });

  it("rotates files when exceeding max size", () => {
    // Use tiny max size to trigger rotation
    // Each JSON entry is ~100 bytes
    const logger = new FileLogger({ dataDir, maxSize: 150 });
    const logPath = join(dataDir, "orange.log");
    const rotatedPath = join(dataDir, "orange.log.1");

    // First write creates the file (~100 bytes)
    logger.info("First message");

    // Second write triggers rotation check (100 + 100 > 150)
    logger.info("Second message");

    // Third write should go to new file after rotation
    logger.info("Third message");

    // Should have rotated
    expect(existsSync(rotatedPath)).toBe(true);
    expect(existsSync(logPath)).toBe(true);

    // Verify rotated file has content
    const rotatedContent = readFileSync(rotatedPath, "utf-8");
    expect(rotatedContent.length).toBeGreaterThan(0);
  });
});

describe("MockLogger", () => {
  it("collects entries", () => {
    const logger = new MockLogger();

    logger.info("message 1");
    logger.error("message 2", { code: 42 });

    expect(logger.entries.length).toBe(2);
    expect(logger.entries[0].msg).toBe("message 1");
    expect(logger.entries[1].code).toBe(42);
  });

  it("child loggers share entries", () => {
    const logger = new MockLogger();
    const child = logger.child("workspace");

    logger.info("parent");
    child.info("child");

    expect(logger.entries.length).toBe(2);
    expect(logger.entries[0].component).toBe("test");
    expect(logger.entries[1].component).toBe("workspace");
  });

  it("has() helper works", () => {
    const logger = new MockLogger();

    logger.info("finding the needle");
    logger.error("an error occurred");

    expect(logger.has("info", "needle")).toBe(true);
    expect(logger.has("error", "error")).toBe(true);
    expect(logger.has("info", "nonexistent")).toBe(false);
    expect(logger.has("error", "needle")).toBe(false);
  });

  it("forComponent() filters entries", () => {
    const logger = new MockLogger();
    const child = logger.child("spawn");

    logger.info("root message");
    child.info("spawn message");
    child.error("spawn error");

    const spawnEntries = logger.forComponent("spawn");
    expect(spawnEntries.length).toBe(2);
    expect(spawnEntries[0].msg).toBe("spawn message");
  });

  it("forLevel() filters entries", () => {
    const logger = new MockLogger();

    logger.debug("debug");
    logger.info("info");
    logger.warn("warn");
    logger.error("error");

    expect(logger.forLevel("error").length).toBe(1);
    expect(logger.forLevel("warn").length).toBe(1);
    expect(logger.forLevel("info").length).toBe(1);
  });

  it("clear() removes all entries", () => {
    const logger = new MockLogger();

    logger.info("message");
    expect(logger.entries.length).toBe(1);

    logger.clear();
    expect(logger.entries.length).toBe(0);
  });
});

describe("NullLogger", () => {
  it("discards all messages", () => {
    const logger = new NullLogger();

    // Should not throw
    logger.debug("debug");
    logger.info("info");
    logger.warn("warn");
    logger.error("error");

    const child = logger.child("component");
    child.info("child message");
  });
});
