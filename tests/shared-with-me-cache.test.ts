import { describe, expect, it, vi } from "vitest";

import { createSharedWithMeCache, type SharedWithMe } from "../app/shared/sharing/shared-with-me-cache";

const summary = (accountId: string, invitations = 0): SharedWithMe => ({ accountId, received: [], invitations });

function setup() {
  let now = 1_000;
  const load = vi.fn(async () => summary("account-a"));
  const cache = createSharedWithMeCache({ load, now: () => now, lifetime: 60_000 });
  return { cache, load, advance: (ms: number) => (now += ms) };
}

describe("Shared with me tab memory", () => {
  it("reuses a fresh summary across remounts and reloads once it is stale", async () => {
    const { cache, load, advance } = setup();
    await cache.read("account-a");
    advance(59_000);
    await cache.read("account-a");
    expect(load).toHaveBeenCalledTimes(1);
    advance(2_000);
    await cache.read("account-a");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight read between concurrent callers", async () => {
    const { cache, load } = setup();
    await Promise.all([cache.read("account-a"), cache.read("account-a")]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("refreshes after a sharing action invalidates it, and honours a shorter focus age", async () => {
    const { cache, load, advance } = setup();
    await cache.read("account-a");
    cache.invalidate();
    expect(cache.peek("account-a")).toBeNull();
    await cache.read("account-a");
    expect(load).toHaveBeenCalledTimes(2);
    advance(6_000);
    await cache.read("account-a", { maxAge: 5_000 });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("never serves another Account's summary and rejects a mismatched load", async () => {
    const { cache, load } = setup();
    await cache.read("account-a");
    expect(cache.peek("account-b")).toBeNull();
    await expect(cache.read("account-b")).rejects.toThrow();
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.peek("account-b")).toBeNull();
  });

  it("does not store a read that an invalidation overtook", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = vi.fn(async () => {
      await gate;
      return summary("account-a", 1);
    });
    const cache = createSharedWithMeCache({ load, now: () => 0, lifetime: 60_000 });
    const first = cache.read("account-a");
    cache.invalidate();
    release();
    expect((await first).invitations).toBe(1);
    expect(cache.peek("account-a")).toBeNull();
  });

  it("stores nothing while private tab memory is suspended after the hidden-timeout clear", async () => {
    let suspended = true;
    const load = vi.fn(async () => summary("account-a", 2));
    const cache = createSharedWithMeCache({ load, now: () => 0, lifetime: 60_000, suspended: () => suspended });
    expect((await cache.read("account-a")).invitations).toBe(2);
    cache.prime(summary("account-a", 4));
    expect(cache.peek("account-a")).toBeNull();
    suspended = false;
    await cache.read("account-a");
    expect(cache.peek("account-a")?.invitations).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("accepts a primed summary from a page that already listed relationships", async () => {
    const { cache, load } = setup();
    cache.prime(summary("account-a", 3));
    expect((await cache.read("account-a")).invitations).toBe(3);
    expect(load).not.toHaveBeenCalled();
  });
});
