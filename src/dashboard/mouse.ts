/**
 * SGR mouse event parser.
 *
 * Parses SGR-encoded mouse sequences: \x1b[<button;col;row[Mm]
 * where M=press, m=release.
 *
 * Button encoding:
 *   0=left, 1=middle, 2=right, 64=scroll up, 65=scroll down
 * Modifier bits (ORed into button field):
 *   4=shift, 8=meta, 16=ctrl
 */

const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

export interface MouseEvent {
  /** Raw button number (with modifier bits stripped) */
  button: number;
  /** Column (1-based) */
  col: number;
  /** Row (1-based) */
  row: number;
  /** Press or release */
  type: "press" | "release";
  shift: boolean;
  ctrl: boolean;
  meta: boolean;
}

/**
 * Parse an SGR mouse sequence into a MouseEvent.
 * Returns null if the input is not a valid SGR mouse sequence.
 */
export function parseMouse(data: string): MouseEvent | null {
  const m = SGR_MOUSE_RE.exec(data);
  if (!m) return null;

  const rawButton = parseInt(m[1]!, 10);
  const col = parseInt(m[2]!, 10);
  const row = parseInt(m[3]!, 10);
  const type = m[4] === "M" ? "press" : "release";

  // Extract modifier bits
  const shift = (rawButton & 4) !== 0;
  const meta = (rawButton & 8) !== 0;
  const ctrl = (rawButton & 16) !== 0;

  // Strip modifier bits to get actual button
  const button = rawButton & ~(4 | 8 | 16);

  return { button, col, row, type, shift, ctrl, meta };
}

/** Left button press */
export function isLeftClick(e: MouseEvent): boolean {
  return e.button === 0 && e.type === "press";
}

/** Scroll wheel up */
export function isScrollUp(e: MouseEvent): boolean {
  return e.button === 64;
}

/** Scroll wheel down */
export function isScrollDown(e: MouseEvent): boolean {
  return e.button === 65;
}

/** Check if a raw string looks like an SGR mouse sequence */
export function isMouseSequence(data: string): boolean {
  return SGR_MOUSE_RE.test(data);
}
