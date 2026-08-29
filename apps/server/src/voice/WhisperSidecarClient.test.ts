import { describe, expect, it } from "@effect/vitest";

import { retainRecentWhisperFailures, shouldStopWhisperForIdle } from "./WhisperSidecarClient.ts";

describe("retainRecentWhisperFailures", () => {
  it("keeps only failures inside the rolling window", () => {
    const now = 1_000_000;
    expect(retainRecentWhisperFailures([now - 70_000, now - 60_000, now - 1_000], now)).toEqual([
      now - 60_000,
      now - 1_000,
    ]);
  });

  it("returns an empty list when everything has aged out", () => {
    const now = 1_000_000;
    expect(retainRecentWhisperFailures([now - 61_000], now)).toEqual([]);
  });
});

describe("shouldStopWhisperForIdle", () => {
  const idleMs = 10 * 60_000;

  it("stops only once idle for the full grace period with no sessions", () => {
    expect(shouldStopWhisperForIdle(0, 0, idleMs - 1)).toBe(false);
    expect(shouldStopWhisperForIdle(0, 0, idleMs)).toBe(true);
  });

  it("never stops while a session is open, however stale the activity", () => {
    expect(shouldStopWhisperForIdle(1, 0, idleMs * 10)).toBe(false);
  });
});
