import { describe, test, expect } from "bun:test";
import { ansiToStyledText } from "./ansi-parser.js";

describe("ansiToStyledText", () => {
  test("plain text without ANSI", () => {
    const result = ansiToStyledText("hello world");
    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0].text).toBe("hello world");
    expect(result.chunks[0].fg).toBeUndefined();
  });

  test("reset sequence", () => {
    const result = ansiToStyledText("\x1b[31mred\x1b[0m normal");
    expect(result.chunks.length).toBe(2);
    expect(result.chunks[0].text).toBe("red");
    expect(result.chunks[0].fg).toBeDefined();
    expect(result.chunks[1].text).toBe(" normal");
    expect(result.chunks[1].fg).toBeUndefined();
  });

  test("24-bit RGB foreground", () => {
    const result = ansiToStyledText("\x1b[38;2;102;102;102mtext\x1b[39m");
    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0].text).toBe("text");
    const fg = result.chunks[0].fg!;
    expect(fg).toBeDefined();
    // 102/255 ≈ 0.4
    expect(fg.r).toBeCloseTo(102 / 255, 2);
    expect(fg.g).toBeCloseTo(102 / 255, 2);
    expect(fg.b).toBeCloseTo(102 / 255, 2);
  });

  test("background colors are stripped (opentui bleed workaround)", () => {
    const result = ansiToStyledText("\x1b[48;2;255;0;0mtext\x1b[0m");
    expect(result.chunks[0].bg).toBeUndefined();
  });

  test("bold attribute", () => {
    const result = ansiToStyledText("\x1b[1mbold\x1b[0m");
    expect(result.chunks[0].text).toBe("bold");
    expect(result.chunks[0].attributes! & 1).toBe(1); // bold bit
  });

  test("multiple sequences in one line", () => {
    const result = ansiToStyledText("\x1b[31mred\x1b[32mgreen\x1b[0m");
    expect(result.chunks.length).toBe(2);
    expect(result.chunks[0].text).toBe("red");
    expect(result.chunks[1].text).toBe("green");
    // Different fg colors
    expect(result.chunks[0].fg).not.toEqual(result.chunks[1].fg);
  });

  test("empty input", () => {
    const result = ansiToStyledText("");
    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0].text).toBe("");
  });

  test("256-color foreground", () => {
    const result = ansiToStyledText("\x1b[38;5;9mtext\x1b[0m");
    expect(result.chunks[0].fg).toBeDefined();
    // Color 9 = bright red
    expect(result.chunks[0].fg!.r).toBeCloseTo(1, 2);
  });
});
