import { describe, expect, it } from "vitest";

import { PrivateAccessError } from "../app/shared/device/private-client";
import { SharingChangedError } from "../app/shared/sharing/relationships-client";
import {
  MAX_ENVELOPES_PER_PACKET,
  MAX_PASS_REQUESTS,
  packets,
  restartOnce,
  SharePreparationError,
  sameSnapshot,
  uploadSaved,
  WorkBudget,
} from "../app/shared/sharing/share-staging-client";

const snapshot = {
  relationshipId: "0190a6c4-2222-7aaa-8bbb-000000000001",
  targetId: "0190a6c4-2222-7aaa-8bbb-000000000002",
  grantKeyEpoch: 1,
  ownerRegistryEpoch: 3,
  recipientRegistryEpoch: 5,
};

describe("packets", () => {
  it("splits envelopes into packets of at most twenty, preserving order", () => {
    const items = Array.from({ length: 45 }, (_, index) => index);
    const split = packets(items);
    expect(MAX_ENVELOPES_PER_PACKET).toBe(20);
    expect(split.map((packet) => packet.length)).toEqual([20, 20, 5]);
    expect(split.flat()).toEqual(items);
    expect(packets([])).toEqual([]);
  });
});

describe("sameSnapshot", () => {
  it("accepts only the pass's relationship, target, Grant epoch and both registry epochs", () => {
    expect(sameSnapshot(snapshot, { ...snapshot })).toBe(true);
    for (const changed of [
      { relationshipId: "0190a6c4-2222-7aaa-8bbb-000000000009" },
      { targetId: "0190a6c4-2222-7aaa-8bbb-000000000009" },
      { grantKeyEpoch: 2 },
      { ownerRegistryEpoch: 4 },
      { recipientRegistryEpoch: 6 },
    ])
      expect(sameSnapshot(snapshot, { ...snapshot, ...changed })).toBe(false);
  });
});

describe("uploadSaved", () => {
  it("retries a lost response once with the same saved bytes", async () => {
    const sent: string[] = [];
    let calls = 0;
    const response = await uploadSaved(
      "/api/private/shares/x/keys",
      '{"envelopes":["sealed"]}',
      undefined,
      (_, init) => {
        sent.push(init.body as string);
        if (calls++ === 0) return Promise.reject(new PrivateAccessError("unavailable"));
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    );
    expect(response.status).toBe(200);
    expect(sent).toEqual(['{"envelopes":["sealed"]}', '{"envelopes":["sealed"]}']);
  });

  it("does not retry twice, after cancellation, or for a definite failure", async () => {
    let calls = 0;
    const lost = () => {
      calls++;
      return Promise.reject(new PrivateAccessError("unavailable"));
    };
    await expect(uploadSaved("/p", "{}", undefined, lost)).rejects.toBeInstanceOf(PrivateAccessError);
    expect(calls).toBe(2);

    calls = 0;
    const controller = new AbortController();
    controller.abort();
    await expect(uploadSaved("/p", "{}", controller.signal, lost)).rejects.toBeInstanceOf(PrivateAccessError);
    expect(calls).toBe(1);

    calls = 0;
    await expect(
      uploadSaved("/p", "{}", undefined, () => {
        calls++;
        return Promise.reject(new PrivateAccessError("signed-out"));
      }),
    ).rejects.toMatchObject({ state: "signed-out" });
    expect(calls).toBe(1);
  });
});

describe("restartOnce", () => {
  it("restarts a changed pass once with fresh targets, then fails with an actionable reason", async () => {
    let passes = 0;
    expect(
      await restartOnce(async () => {
        if (passes++ === 0) throw new SharingChangedError();
        return "done";
      }),
    ).toBe("done");
    expect(passes).toBe(2);

    passes = 0;
    const failed = restartOnce(async () => {
      passes++;
      throw new SharingChangedError();
    });
    await expect(failed).rejects.toBeInstanceOf(SharePreparationError);
    await expect(failed).rejects.toMatchObject({ reason: "changed" });
    expect(passes).toBe(2);
  });

  it("never restarts other failures", async () => {
    let passes = 0;
    await expect(
      restartOnce(async () => {
        passes++;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(passes).toBe(1);
  });
});

describe("WorkBudget", () => {
  it("bounds the requests one pass may make", () => {
    const budget = new WorkBudget(3);
    budget.spend();
    budget.spend();
    budget.spend();
    expect(() => budget.spend()).toThrow(SharePreparationError);
    expect(MAX_PASS_REQUESTS).toBeGreaterThan(0);
  });
});
