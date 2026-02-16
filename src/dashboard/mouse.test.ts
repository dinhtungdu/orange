import { describe, expect, test } from "bun:test";
import {
  parseMouse,
  isLeftClick,
  isScrollUp,
  isScrollDown,
  isMouseSequence,
} from "./mouse.js";

describe("parseMouse", () => {
  test("parses left click press", () => {
    const e = parseMouse("\x1b[<0;10;5M");
    expect(e).toEqual({
      button: 0,
      col: 10,
      row: 5,
      type: "press",
      shift: false,
      ctrl: false,
      meta: false,
    });
  });

  test("parses left click release", () => {
    const e = parseMouse("\x1b[<0;10;5m");
    expect(e).toEqual({
      button: 0,
      col: 10,
      row: 5,
      type: "release",
      shift: false,
      ctrl: false,
      meta: false,
    });
  });

  test("parses right click", () => {
    const e = parseMouse("\x1b[<2;20;15M");
    expect(e).toEqual({
      button: 2,
      col: 20,
      row: 15,
      type: "press",
      shift: false,
      ctrl: false,
      meta: false,
    });
  });

  test("parses scroll up", () => {
    const e = parseMouse("\x1b[<64;5;3M");
    expect(e).toEqual({
      button: 64,
      col: 5,
      row: 3,
      type: "press",
      shift: false,
      ctrl: false,
      meta: false,
    });
  });

  test("parses scroll down", () => {
    const e = parseMouse("\x1b[<65;5;3M");
    expect(e).toEqual({
      button: 65,
      col: 5,
      row: 3,
      type: "press",
      shift: false,
      ctrl: false,
      meta: false,
    });
  });

  test("parses shift modifier", () => {
    const e = parseMouse("\x1b[<4;1;1M");
    expect(e).toEqual({
      button: 0,
      col: 1,
      row: 1,
      type: "press",
      shift: true,
      ctrl: false,
      meta: false,
    });
  });

  test("parses ctrl modifier", () => {
    const e = parseMouse("\x1b[<16;1;1M");
    expect(e).toEqual({
      button: 0,
      col: 1,
      row: 1,
      type: "press",
      shift: false,
      ctrl: true,
      meta: false,
    });
  });

  test("parses combined modifiers", () => {
    // shift(4) + meta(8) + ctrl(16) + left(0) = 28
    const e = parseMouse("\x1b[<28;1;1M");
    expect(e).toEqual({
      button: 0,
      col: 1,
      row: 1,
      type: "press",
      shift: true,
      ctrl: true,
      meta: true,
    });
  });

  test("parses ctrl+scroll up", () => {
    // ctrl(16) + scroll up(64) = 80
    const e = parseMouse("\x1b[<80;1;1M");
    expect(e).toEqual({
      button: 64,
      col: 1,
      row: 1,
      type: "press",
      shift: false,
      ctrl: true,
      meta: false,
    });
  });

  test("returns null for non-mouse input", () => {
    expect(parseMouse("j")).toBeNull();
    expect(parseMouse("\x1b[A")).toBeNull(); // arrow up
    expect(parseMouse("")).toBeNull();
  });

  test("returns null for malformed mouse sequences", () => {
    expect(parseMouse("\x1b[<0;10M")).toBeNull(); // missing row
    expect(parseMouse("\x1b[<0;10;5")).toBeNull(); // missing terminator
  });
});

describe("helpers", () => {
  test("isLeftClick", () => {
    expect(isLeftClick(parseMouse("\x1b[<0;1;1M")!)).toBe(true);
    expect(isLeftClick(parseMouse("\x1b[<0;1;1m")!)).toBe(false); // release
    expect(isLeftClick(parseMouse("\x1b[<2;1;1M")!)).toBe(false); // right
  });

  test("isScrollUp", () => {
    expect(isScrollUp(parseMouse("\x1b[<64;1;1M")!)).toBe(true);
    expect(isScrollUp(parseMouse("\x1b[<65;1;1M")!)).toBe(false);
  });

  test("isScrollDown", () => {
    expect(isScrollDown(parseMouse("\x1b[<65;1;1M")!)).toBe(true);
    expect(isScrollDown(parseMouse("\x1b[<64;1;1M")!)).toBe(false);
  });
});

describe("isMouseSequence", () => {
  test("detects SGR mouse sequences", () => {
    expect(isMouseSequence("\x1b[<0;10;5M")).toBe(true);
    expect(isMouseSequence("\x1b[<65;1;1m")).toBe(true);
  });

  test("rejects non-mouse input", () => {
    expect(isMouseSequence("j")).toBe(false);
    expect(isMouseSequence("\x1b[A")).toBe(false);
  });
});
