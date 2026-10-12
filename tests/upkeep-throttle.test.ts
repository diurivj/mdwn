import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearPrivateTabMemory } from "../app/shared/device/private-tab-memory";
import { createUpkeepThrottle } from "../app/shared/device/upkeep-throttle";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("background upkeep throttle (ticket 57)", () => {
  it("starts at most once a minute and remembers the last status in between", () => {
    const throttle = createUpkeepThrottle<string>();
    expect(throttle.due()).toBe(true);
    throttle.start();
    throttle.remember("pending");
    vi.mocked(Date.now).mockReturnValue(NOW + MINUTE - 1);
    expect(throttle.due()).toBe(false);
    expect(throttle.status()).toBe("pending");
    vi.mocked(Date.now).mockReturnValue(NOW + MINUTE);
    expect(throttle.due()).toBe(true);
  });

  it("resets the interval and the remembered status when private tab memory is cleared", () => {
    const throttle = createUpkeepThrottle<string>();
    throttle.start();
    throttle.remember("complete");
    // Sign-out, sign-in, recovery, a 401 or an Account change all clear tab memory.
    clearPrivateTabMemory();
    expect(throttle.due()).toBe(true);
    expect(throttle.status()).toBeUndefined();
  });

  it("drops a status from an upkeep started before the clear", () => {
    const throttle = createUpkeepThrottle<string>();
    throttle.start();
    clearPrivateTabMemory();
    throttle.remember("from the previous Session");
    expect(throttle.status()).toBeUndefined();
    expect(throttle.due()).toBe(true);
  });

  it("forgets the previous status when a new upkeep starts", () => {
    const throttle = createUpkeepThrottle<string>();
    throttle.start();
    throttle.remember("old");
    vi.mocked(Date.now).mockReturnValue(NOW + MINUTE);
    throttle.start();
    expect(throttle.status()).toBeUndefined();
  });
});
