/**
 * Clock abstraction for time operations.
 *
 * Provides both real clock and mock implementation for testing.
 * All timestamps are ISO 8601 format.
 */

import type { Clock } from "./types.js";

/**
 * RealClock returns actual system time.
 */
export class RealClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

/**
 * MockClock allows controlling time in tests.
 */
export class MockClock implements Clock {
  private currentTime: Date;

  constructor(initialTime: Date = new Date("2024-01-01T00:00:00.000Z")) {
    this.currentTime = initialTime;
  }

  now(): string {
    return this.currentTime.toISOString();
  }

  /**
   * Set the current time.
   */
  setTime(time: Date): void {
    this.currentTime = time;
  }

  /**
   * Advance time by milliseconds.
   */
  advance(ms: number): void {
    this.currentTime = new Date(this.currentTime.getTime() + ms);
  }

  /**
   * Advance time by seconds.
   */
  advanceSeconds(seconds: number): void {
    this.advance(seconds * 1000);
  }

  /**
   * Advance time by minutes.
   */
  advanceMinutes(minutes: number): void {
    this.advance(minutes * 60 * 1000);
  }
}

/**
 * Create a real clock for production use.
 */
export function createClock(): Clock {
  return new RealClock();
}
