import { describe, expect, it } from "vitest";

import { eligibleImportTargets, preferredImportTarget, type ImportScopeSnapshot } from "../app/shared/import/targets";

function withSealed(entries: readonly { nodeId: string; kind: "file" | "directory"; name: string }[]) {
  return entries.map((entry) => ({ ...entry, nameCiphertext: "bmFtZQ", orderCiphertext: "b3JkZXI", keyEnvelope: "a2V5" }));
}

function snapshot(overrides: Partial<ImportScopeSnapshot> = {}): ImportScopeSnapshot {
  const key = new Uint8Array(32).fill(1);
  return {
    access: { rootId: "root", rootKind: "directory", vaultId: "owner", actorAccountId: "owner" },
    keys: { root: key, writable: new Uint8Array(32).fill(2), readonly: new Uint8Array(32).fill(3), direct: key },
    listings: {
      root: { directoryId: "root", entriesRevision: 2, canCreate: true, entries: withSealed([
        { nodeId: "writable", kind: "directory", name: "notes" },
        { nodeId: "readonly", kind: "directory", name: "shared-read" },
        { nodeId: "file1", kind: "file", name: "Draft.md" },
      ]) },
      writable: { directoryId: "writable", entriesRevision: 1, canCreate: true, entries: [] },
      readonly: { directoryId: "readonly", entriesRevision: 1, canCreate: false, entries: [] },
    },
    file: null,
    ...overrides,
  };
}

describe("import target eligibility", () => {
  it("includes owned and read/write Directory targets and excludes read-only ones", () => {
    const targets = eligibleImportTargets(snapshot());
    expect(targets.map((target) => target.directoryId)).toEqual(["root", "writable"]);
    expect(targets.find((target) => target.directoryId === "writable")?.label).toBe("Files/notes");
    expect(targets.every((target) => target.siblings !== undefined)).toBe(true);
  });

  it("offers no target for a direct File Grant scope", () => {
    const direct = snapshot({
      access: { rootId: "direct", rootKind: "file", vaultId: "owner", actorAccountId: "recipient" },
      keys: { direct: new Uint8Array(32).fill(9) },
      listings: {},
      file: { parentId: null },
    });
    expect(eligibleImportTargets(direct)).toEqual([]);
    expect(preferredImportTarget(direct, "direct", "file")).toBeNull();
  });

  it("selects the current Directory, or a File's parent Directory, only when eligible", () => {
    const page = snapshot();
    expect(preferredImportTarget(page, "writable", "directory")?.directoryId).toBe("writable");
    expect(preferredImportTarget(page, "readonly", "directory")).toBeNull();
    expect(preferredImportTarget({ ...page, file: { parentId: "writable" } }, "file1", "file")?.directoryId).toBe("writable");
    expect(preferredImportTarget({ ...page, file: { parentId: "readonly" } }, "file1", "file")).toBeNull();
    expect(preferredImportTarget({ ...page, file: { parentId: null } }, "direct", "file")).toBeNull();
  });

  it("reports the target owner separately from the acting Account", () => {
    const granted = snapshot({ access: { rootId: "root", rootKind: "directory", vaultId: "owner", actorAccountId: "recipient" } });
    const target = eligibleImportTargets(granted)[0]!;
    expect(target.ownerAccountId).toBe("owner");
    expect(target.actorAccountId).toBe("recipient");
  });
});
