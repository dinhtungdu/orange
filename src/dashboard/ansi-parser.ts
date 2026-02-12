/**
 * Parse ANSI escape sequences into opentui StyledText chunks.
 *
 * Converts tmux capture-pane -e output (with \x1b[...m sequences)
 * into StyledText that TextRenderable can render with colors.
 */

import { StyledText, RGBA } from "@opentui/core";

interface TextChunk {
  __isChunk: true;
  text: string;
  fg?: RGBA;
  bg?: RGBA;
  attributes?: number;
}

// Standard 256-color palette (first 16 colors)
const ANSI_COLORS_16: [number, number, number][] = [
  [0, 0, 0],       // 0 black
  [205, 0, 0],     // 1 red
  [0, 205, 0],     // 2 green
  [205, 205, 0],   // 3 yellow
  [0, 0, 238],     // 4 blue
  [205, 0, 205],   // 5 magenta
  [0, 205, 205],   // 6 cyan
  [229, 229, 229], // 7 white
  [127, 127, 127], // 8 bright black
  [255, 0, 0],     // 9 bright red
  [0, 255, 0],     // 10 bright green
  [255, 255, 0],   // 11 bright yellow
  [92, 92, 255],   // 12 bright blue
  [255, 0, 255],   // 13 bright magenta
  [0, 255, 255],   // 14 bright cyan
  [255, 255, 255], // 15 bright white
];

interface AnsiState {
  fg: RGBA | undefined;
  bg: RGBA | undefined;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  reverse: boolean;
}

function makeAttributes(state: AnsiState): number {
  // Match opentui's TextAttributes bit layout
  let attrs = 0;
  if (state.bold) attrs |= 1;
  if (state.italic) attrs |= 2;
  if (state.underline) attrs |= 4;
  if (state.dim) attrs |= 32;
  if (state.reverse) attrs |= 64;
  return attrs;
}

function color256ToRgba(n: number): RGBA {
  if (n < 16) {
    const [r, g, b] = ANSI_COLORS_16[n];
    return RGBA.fromValues(r / 255, g / 255, b / 255, 1);
  }
  if (n < 232) {
    // 6x6x6 color cube
    const idx = n - 16;
    const r = Math.floor(idx / 36);
    const g = Math.floor((idx % 36) / 6);
    const b = idx % 6;
    return RGBA.fromValues(
      (r ? r * 40 + 55 : 0) / 255,
      (g ? g * 40 + 55 : 0) / 255,
      (b ? b * 40 + 55 : 0) / 255,
      1
    );
  }
  // Grayscale ramp
  const v = (n - 232) * 10 + 8;
  return RGBA.fromValues(v / 255, v / 255, v / 255, 1);
}

function processParams(params: number[], state: AnsiState): void {
  let i = 0;
  while (i < params.length) {
    const p = params[i];
    switch (p) {
      case 0: // Reset
        state.fg = undefined;
        state.bg = undefined;
        state.bold = false;
        state.dim = false;
        state.italic = false;
        state.underline = false;
        state.reverse = false;
        break;
      case 1: state.bold = true; break;
      case 2: state.dim = true; break;
      case 3: state.italic = true; break;
      case 4: state.underline = true; break;
      case 7: state.reverse = true; break;
      case 22: state.bold = false; state.dim = false; break;
      case 23: state.italic = false; break;
      case 24: state.underline = false; break;
      case 27: state.reverse = false; break;
      // Standard foreground colors (30-37)
      case 30: case 31: case 32: case 33:
      case 34: case 35: case 36: case 37:
        state.fg = color256ToRgba(p - 30);
        break;
      // Default foreground
      case 39: state.fg = undefined; break;
      // Standard background colors (40-47)
      case 40: case 41: case 42: case 43:
      case 44: case 45: case 46: case 47:
        state.bg = color256ToRgba(p - 40);
        break;
      // Default background
      case 49: state.bg = undefined; break;
      // Bright foreground (90-97)
      case 90: case 91: case 92: case 93:
      case 94: case 95: case 96: case 97:
        state.fg = color256ToRgba(p - 90 + 8);
        break;
      // Bright background (100-107)
      case 100: case 101: case 102: case 103:
      case 104: case 105: case 106: case 107:
        state.bg = color256ToRgba(p - 100 + 8);
        break;
      // Extended colors
      case 38: // Foreground
        if (params[i + 1] === 5 && i + 2 < params.length) {
          state.fg = color256ToRgba(params[i + 2]);
          i += 2;
        } else if (params[i + 1] === 2 && i + 4 < params.length) {
          state.fg = RGBA.fromValues(
            params[i + 2] / 255,
            params[i + 3] / 255,
            params[i + 4] / 255,
            1
          );
          i += 4;
        }
        break;
      case 48: // Background
        if (params[i + 1] === 5 && i + 2 < params.length) {
          state.bg = color256ToRgba(params[i + 2]);
          i += 2;
        } else if (params[i + 1] === 2 && i + 4 < params.length) {
          state.bg = RGBA.fromValues(
            params[i + 2] / 255,
            params[i + 3] / 255,
            params[i + 4] / 255,
            1
          );
          i += 4;
        }
        break;
    }
    i++;
  }
}

/**
 * Parse a string with ANSI escape sequences into a StyledText.
 */
export function ansiToStyledText(input: string): StyledText {
  const chunks: TextChunk[] = [];
  const state: AnsiState = {
    fg: undefined,
    bg: undefined,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    reverse: false,
  };

  // Match ESC[ ... m sequences
  const regex = /\x1b\[([\d;]*)m/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(input)) !== null) {
    // Text before this escape sequence
    if (match.index > lastIndex) {
      const text = input.slice(lastIndex, match.index);
      if (text) {
        chunks.push({
          __isChunk: true,
          text,
          fg: state.fg,
          bg: state.bg,
          attributes: makeAttributes(state),
        });
      }
    }

    // Parse SGR parameters
    const paramStr = match[1];
    if (!paramStr || paramStr === "") {
      // ESC[m is same as ESC[0m (reset)
      processParams([0], state);
    } else {
      const params = paramStr.split(";").map(Number);
      processParams(params, state);
    }

    lastIndex = regex.lastIndex;
  }

  // Remaining text after last escape
  if (lastIndex < input.length) {
    const text = input.slice(lastIndex);
    if (text) {
      chunks.push({
        __isChunk: true,
        text,
        fg: state.fg,
        bg: state.bg,
        attributes: makeAttributes(state),
      });
    }
  }

  // If no chunks, add empty
  if (chunks.length === 0) {
    chunks.push({ __isChunk: true, text: "" });
  }

  return new StyledText(chunks);
}
