import { describe, expect, it } from "vitest";

import { allocateKeepBothNames } from "../app/namespace-v1";
import { ImportError } from "../app/import/limits";
import { reviewImport, type ImportChoice, type ImportCollisionSibling, type ImportTarget } from "../app/import/review";
import { analyzeImportSelection, type ImportSource } from "../app/import/source";

const encoder = new TextEncoder();

async function sourceOf(paths: readonly string[]): Promise<ImportSource> {
  return analyzeImportSelection(paths.map((path) => ({ path, bytes: encoder.encode("x") })));
}

function target(siblings: readonly ImportCollisionSibling[] = [], overrides: Partial<ImportTarget> = {}): ImportTarget {
  return {
    directoryId: "target-id",
    keyEpoch: 1,
    entriesRevision: 2,
    ownerAccountId: "owner-id",
    actorAccountId: "owner-id",
    label: "Files",
    siblings,
    listing: [],
    ...overrides,
  };
}

function sibling(id: string, kind: "file" | "directory", name: string): ImportCollisionSibling {
  return { nodeId: id, kind, name };
}

function generated(review: ReturnType<typeof reviewImport>): string[] {
  return review.nodes.filter((node) => node.generated).map((node) => node.displayPath.join("/"));
}

describe("import review: deterministic Keep both", () => {
  it("reserves explicit source names before generating suffixes", async () => {
    const review = reviewImport(await sourceOf(["report.md", "report (2).md"]), target([sibling("existing", "file", "report.md")]));
    const byPath = new Map(review.nodes.map((node) => [node.sourcePath, node]));
    expect(byPath.get("report (2).md")!.displayName).toBe("report (2).md");
    expect(byPath.get("report (2).md")!.generated).toBe(false);
    expect(byPath.get("report.md")!.displayName).toBe("report (3).md");
    expect(byPath.get("report.md")!.generated).toBe(true);
    expect(generated(review).sort()).toEqual(["report (3).md"]);
    expect(review.generatedNames).toEqual(["report (3).md"]);
    expect(review.status).toBe("ok");
    expect(review.canConfirm).toBe(true);
  });

  it("treats literal suffixes as ordinary names", async () => {
    const review = reviewImport(await sourceOf(["draft (2).md"]), target([sibling("existing", "file", "draft (2).md")]));
    expect(review.nodes[0]!.displayName).toBe("draft (2) (2).md");
    expect(review.nodes[0]!.generated).toBe(true);
  });

  it("folds case and canonically equivalent Unicode into one collision", async () => {
    const review = reviewImport(await sourceOf(["stra\u00dfe.md"]), target([sibling("existing", "file", "STRASSE.md")]));
    const node = review.nodes[0]!;
    expect(node.displayName).toBe("stra\u00dfe (2).md");
    expect(node.collision?.sameSpelling).toBe(false);

    const decomposed = reviewImport(await sourceOf(["Ame\u0301lie.md"]), target([sibling("existing", "file", "Am\u00e9lie.md")]));
    expect(decomposed.nodes[0]!.displayName).toBe("Am\u00e9lie (2).md");
  });

  it("is independent of source enumeration order", async () => {
    const inputs = ["b.md", "a.md", "b (2).md"];
    const targetSiblings = [sibling("existing", "file", "a.md"), sibling("existing-b", "file", "b.md")];
    const first = reviewImport(await sourceOf(inputs), target(targetSiblings));
    const second = reviewImport(await sourceOf([...inputs].reverse()), target(targetSiblings));
    const names = (review: ReturnType<typeof reviewImport>) =>
      review.nodes.map((node) => `${node.sourcePath}=${node.displayName}`).sort();
    expect(names(first)).toEqual(names(second));
    expect(new Map(first.nodes.map((node) => [node.sourcePath, node.displayName])).get("a.md")).toBe("a (2).md");
    expect(new Map(first.nodes.map((node) => [node.sourcePath, node.displayName])).get("b.md")).toBe("b (3).md");
  });

  it("never merges Directories: a colliding folder keeps both with a generated name", async () => {
    const review = reviewImport(await sourceOf(["notes/draft.md"]), target([sibling("existing", "directory", "notes")]));
    const folder = review.nodes.find((node) => node.kind === "directory")!;
    expect(folder.displayName).toBe("notes (2)");
    expect(folder.generated).toBe(true);
    expect(review.generatedNames).toEqual(["notes (2)"]);
    expect(review.counts.createDirectories).toBe(1);
    expect(review.counts.createFiles).toBe(1);
    expect(review.nodes.find((node) => node.kind === "file")!.displayPath).toEqual(["notes (2)", "draft.md"]);
  });
});

describe("import review: explicit choices", () => {
  it("Skip omits the candidate and its subtree", async () => {
    const choices: Record<string, ImportChoice> = { notes: { action: "skip" } };
    const review = reviewImport(await sourceOf(["notes/draft.md", "keep.md"]),
      target([sibling("existing", "directory", "notes")]), choices);
    expect(review.nodes.find((node) => node.sourcePath === "notes")!.action).toBe("skip");
    expect(review.nodes.find((node) => node.sourcePath === "notes/draft.md")!.action).toBe("skip");
    expect(review.counts.skips).toBe(2);
    expect(review.counts.createFiles).toBe(1);
    expect(review.canConfirm).toBe(true);
  });

  it("Replace targets an existing File and keeps its identity", async () => {
    const choices: Record<string, ImportChoice> = { "draft.md": { action: "replace" } };
    const review = reviewImport(await sourceOf(["draft.md"]),
      target([sibling("existing-file", "file", "DRAFT.md")]), choices);
    const node = review.nodes[0]!;
    expect(node.action).toBe("replace");
    expect(node.existingNodeId).toBe("existing-file");
    expect(node.displayName).toBe("DRAFT.md");
    expect(review.counts.replaces).toBe(1);
    expect(review.counts.createFiles).toBe(0);
  });

  it("never replaces a Directory and never merges it", async () => {
    const choices: Record<string, ImportChoice> = { notes: { action: "replace" } };
    const review = reviewImport(await sourceOf(["notes/draft.md"]),
      target([sibling("existing", "directory", "notes")]), choices);
    const folder = review.nodes.find((node) => node.kind === "directory")!;
    expect(folder.action).toBe("create");
    expect(folder.blocked).toBe("cannot_replace");
    expect(review.status).toBe("blocked");
    expect(review.canConfirm).toBe(false);
  });

  it("never lets a source Directory Replace an existing File, and excludes its children from create counts", async () => {
    const choices: Record<string, ImportChoice> = { notes: { action: "replace" } };
    const review = reviewImport(await sourceOf(["notes/draft.md"]),
      target([sibling("existing-file", "file", "notes")]), choices);
    const folder = review.nodes.find((node) => node.kind === "directory")!;
    const child = review.nodes.find((node) => node.kind === "file")!;
    expect(folder.blocked).toBe("cannot_replace");
    expect(child.blocked).toBe("parent_blocked");
    expect(review.counts.createFiles).toBe(0);
    expect(review.counts.createDirectories).toBe(0);
    expect(review.canConfirm).toBe(false);
  });

  it("matches the vendored Keep-both allocation for unblocked collisions", async () => {
    const requests = [
      { sourcePath: "report.md", requestedName: "report.md" },
      { sourcePath: "report (2).md", requestedName: "report (2).md" },
      { sourcePath: "other.md", requestedName: "other.md" },
    ];
    const review = reviewImport(await sourceOf(requests.map((request) => request.sourcePath)),
      target([sibling("existing", "file", "report.md")]));
    const vendored = allocateKeepBothNames(["report.md"], requests);
    const vendoredByPath = new Map(vendored.map((allocation) => [allocation.sourcePath, allocation.display]));
    for (const node of review.nodes) {
      expect(node.displayName).toBe(vendoredByPath.get(node.sourcePath));
    }
  });

  it("requires a valid, unused Rename", async () => {
    const used = reviewImport(await sourceOf(["draft.md"]),
      target([sibling("existing", "file", "draft.md")]), { "draft.md": { action: "rename", name: "other.md" } });
    expect(used.nodes[0]!.displayName).toBe("other.md");
    expect(used.nodes[0]!.blocked).toBeNull();

    const inUse = reviewImport(await sourceOf(["draft.md"]),
      target([sibling("existing", "file", "draft.md")]), { "draft.md": { action: "rename", name: "draft.md" } });
    expect(inUse.nodes[0]!.blocked).toBe("name_in_use");

    const invalid = reviewImport(await sourceOf(["draft.md"]),
      target([sibling("existing", "file", "draft.md")]), { "draft.md": { action: "rename", name: "../escape.md" } });
    expect(invalid.nodes[0]!.blocked).toBe("invalid_name");
  });

  it("never truncates an over-limit generated name and offers Rename, Skip, or File Replace", async () => {
    const long = `${"x".repeat(252)}.md`; // 255 bytes, the segment profile limit
    const review = reviewImport(await sourceOf([long]), target([sibling("existing", "file", long)]));
    const node = review.nodes[0]!;
    expect(node.displayName).toBe(long);
    expect(node.collision).not.toBeNull();
    expect(node.blocked).toBe("over_limit");
    expect(review.status).toBe("blocked");
    expect(review.canConfirm).toBe(false);

    const renamed = reviewImport(await sourceOf([long]), target([sibling("existing", "file", long)]),
      { [long]: { action: "rename", name: "short.md" } });
    expect(renamed.nodes[0]!.displayName).toBe("short.md");
    expect(renamed.canConfirm).toBe(true);

    const replaced = reviewImport(await sourceOf([long]), target([sibling("existing", "file", long)]),
      { [long]: { action: "replace" } });
    expect(replaced.nodes[0]!.action).toBe("replace");
    expect(replaced.canConfirm).toBe(true);
  });
});

describe("import review: summary and guardrails", () => {
  it("reports counts, depth, sizes, comments, and target ownership", async () => {
    const source = await sourceOf(["notes/draft.md", "README.md"]);
    const review = reviewImport(source, target([], {
      ownerAccountId: "owner-id", actorAccountId: "collaborator-id", label: "Shared/notes",
    }));
    expect(review.counts).toEqual({
      sources: 3, createFiles: 2, createDirectories: 1, replaces: 0, skips: 0,
      maxDepth: 1, compressedBytes: null, expandedBytes: 2, comments: 0,
    });
    expect(review.target.ownerAccountId).not.toBe(review.target.actorAccountId);
  });

  it("rejects a duplicate source path rather than repairing it with Keep both", () => {
    const duplicate = {
      kind: "loose",
      roots: [
        { kind: "file", path: ["a.md"], name: "a.md", markdown: "x", bytes: 1 },
        { kind: "file", path: ["a.md"], name: "a.md", markdown: "y", bytes: 1 },
      ],
      nodes: [], comments: new Map(), nodeCount: 2, maxDepth: 0, sourceBytes: 1,
      compressedBytes: null, expandedBytes: 2, commentCount: 0,
    } as ImportSource;
    expect(() => reviewImport(duplicate, target())).toThrow(ImportError);
  });

  it("does not confirm when every candidate is skipped", async () => {
    const review = reviewImport(await sourceOf(["draft.md"]),
      target([sibling("existing", "file", "draft.md")]), { "draft.md": { action: "skip" } });
    expect(review.empty).toBe(true);
    expect(review.canConfirm).toBe(false);
    expect(review.status).toBe("ok");
  });
});
