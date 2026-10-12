import { describe, expect, it } from "vitest";

import { coalescedRunner } from "../app/shared/tree/coalesced-runner";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("coalescedRunner", () => {
  it("runs a pass requested during a pass that ended early, as after a navigation abort", async () => {
    const passes: ReturnType<typeof deferred>[] = [];
    const run = coalescedRunner(async () => {
      const pass = deferred();
      passes.push(pass);
      await pass.promise;
    });
    const first = run();
    expect(passes).toHaveLength(1);
    void run(); // the next page asks while the aborted pass is still in flight
    void run(); // requests coalesce
    passes[0]!.resolve(); // the aborted pass returns without its result
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(passes).toHaveLength(2);
    passes[1]!.resolve();
    await first;
    expect(passes).toHaveLength(2);
  });

  it("keeps running after a pass throws", async () => {
    let calls = 0;
    const run = coalescedRunner(async () => {
      calls++;
      if (calls === 1) throw new Error("pass failed");
    });
    await run();
    await run();
    expect(calls).toBe(2);
  });
});
