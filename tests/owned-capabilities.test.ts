import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const id = (n: number) => `0190a6c4-3333-7aaa-8bbb-${n.toString().padStart(12, "0")}`;
const [owner, root, folder, file] = [id(1), id(2), id(3), id(4)];

// The owned walk's network seam: each function below is one private request,
// except openChildDirectory, which decrypts locally.
vi.mock("~/shared/tree/client", () => ({
  openRoot: async () => {
    calls.push("bootstrap");
    return { actorAccountId: owner, rootId: root, rootKey: new Uint8Array(32), capability: { epoch: 1 } };
  },
  loadAncestors: async () => {
    calls.push("ancestors");
    return [root, folder, file];
  },
  loadDirectory: async (_access: unknown, directoryId: string) => {
    calls.push(`directory ${directoryId}`);
    return {
      entries: [
        directoryId === root ? { nodeId: folder, kind: "directory", keyEpoch: 1 } : { nodeId: file, kind: "file" },
      ],
    };
  },
  openChildDirectory: async () => new Uint8Array(32).fill(1),
  loadFile: async () => {
    calls.push("file");
    return { capability: { id: id(9), epoch: 1 }, capabilityKey: new Uint8Array(32).fill(7) };
  },
}));

const { ownedFileCapabilityKey } = await import("../app/shared/sharing/owned-capabilities");

beforeEach(() => {
  calls.length = 0;
});

describe("owned walk accounting", () => {
  it("reports every private request the walk makes to the caller's budget", async () => {
    let spent = 0;
    const key = await ownedFileCapabilityKey(owner, file, undefined, () => {
      spent++;
    });
    expect(key).toEqual(new Uint8Array(32).fill(7));
    expect(calls).toEqual(["bootstrap", "ancestors", `directory ${root}`, `directory ${folder}`, "file"]);
    expect(spent).toBe(calls.length);
  });

  it("stops before a request the budget refuses", async () => {
    let spent = 0;
    await expect(
      ownedFileCapabilityKey(owner, file, undefined, () => {
        if (++spent > 2) throw new Error("over budget");
      }),
    ).rejects.toThrow("over budget");
    expect(calls).toEqual(["bootstrap", "ancestors"]);
  });
});
