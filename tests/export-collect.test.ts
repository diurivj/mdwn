import { describe, expect, it } from "vitest";

import {
  ARCHIVE_COMMENTS_PATH, inspectArchive, parseArchiveManifest, parsePrivateCommentsSidecar,
  type HistoricalComment,
} from "../app/archive/format";
import { createZip, readZip, type ZipEntry } from "../app/archive/zip";
import {
  allocateExportPaths, buildArchiveFiles, collectExportFile, collectExportTree, ExportError,
  exportFileName, MAX_EXPORT_DIRECTORY_DEPTH, type ArchiveFile, type ExportEntry, type ExportSource,
} from "../app/export/collect";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const at = new Date("2026-10-04T12:00:00.000Z");
const owned = { vaultId: "account-1", actorAccountId: "account-1" };
const signal = () => new AbortController().signal;

type FakeFile = { kind: "file"; nodeId: string; name: string; markdown: string;
  comments: HistoricalComment[]; commentsComplete: boolean };
type FakeDirectory = { kind: "directory"; nodeId: string; name: string; children: FakeNode[] };
type FakeNode = FakeFile | FakeDirectory;

function folder(nodeId: string, name: string, children: FakeNode[]): FakeDirectory {
  return { kind: "directory", nodeId, name, children };
}

function leaf(nodeId: string, name: string, markdown: string,
  comments: HistoricalComment[] = [], commentsComplete = true): FakeFile {
  return { kind: "file", nodeId, name, markdown, comments, commentsComplete };
}

function sourceFor(root: FakeDirectory, calls: string[] = []): ExportSource<FakeNode> {
  const nodes = new Map<string, FakeNode>();
  const visit = (node: FakeNode): void => {
    nodes.set(node.nodeId, node);
    if (node.kind === "directory") node.children.forEach(visit);
  };
  visit(root);
  return {
    async listDirectory(directoryId, key, abort) {
      calls.push(`list:${directoryId}`);
      abort.throwIfAborted();
      const node = nodes.get(directoryId);
      if (!node || node.kind !== "directory") throw new Error("missing directory");
      return node.children;
    },
    async openDirectory(parentKey, entry) {
      calls.push(`open:${entry.nodeId}`);
      void parentKey;
      return new Uint8Array(32).fill(entry.nodeId.length % 251);
    },
    async readFile(fileId, parentKey, abort) {
      calls.push(`read:${fileId}`);
      abort.throwIfAborted();
      void parentKey;
      const node = nodes.get(fileId);
      if (!node || node.kind !== "file") throw new Error("missing file");
      return { markdown: node.markdown, comments: node.comments, commentsComplete: node.commentsComplete };
    },
  };
}

async function entriesOf(files: ArchiveFile[]) {
  return readZip(await createZip(files, { at }));
}

describe("owned Files export collection", () => {
  it("mirrors the Directory hierarchy with exact UTF-8 Markdown and a versioned manifest", async () => {
    const markdown = "---\ntitle: T\n---\n\n# Body 🚀\n";
    const root = folder("root", "Files", [
      folder("notes", "notes", [leaf("draft", "draft", markdown)]),
      leaf("readme", "README.md", "# Readme\n"),
    ]);
    const calls: string[] = [];
    const collected = await collectExportTree(owned, sourceFor(root, calls),
      { directoryId: "root", key: new Uint8Array(32), path: [], includeRoot: false }, { signal: signal() });
    expect(calls).toEqual(["list:root", "open:notes", "list:notes", "read:draft", "read:readme"]);
    expect(collected.directories.map((path) => path.join("/"))).toEqual(["notes"]);
    expect(collected.files.map((file) => file.path.join("/"))).toEqual(["notes/draft.md", "README.md"]);
    expect(collected.files[0]!.markdown).toBe(markdown);

    const archive = buildArchiveFiles(collected, { createdAt: at.toISOString(), roots: [{ kind: "directory", path: "" }] });
    const entries = await entriesOf(archive);
    const inspection = inspectArchive(entries);
    expect(inspection.roots).toEqual([{ kind: "directory", path: "" }]);
    expect(inspection.entries.map((item) => item.path)).toEqual(["README.md", "notes", "notes/draft.md"]);
    expect(parseArchiveManifest(decoder.decode(entries.find((item) => item.path.endsWith("manifest.json"))!.data)))
      .toEqual({ format: "mdwn-export", version: 1, createdAt: at.toISOString(), roots: [{ kind: "directory", path: "" }] });
    expect(decoder.decode(entries.find((item) => item.path === "notes/draft.md")!.data)).toBe(markdown);
  });

  it("preserves Private Comment text, order, timestamps, and displayed pseudonyms in the sidecar", async () => {
    const comments: HistoricalComment[] = [
      { sequence: 0, text: "First", pseudonym: "Member Quiet Pine", createdAt: 1_759_000_000_000, updatedAt: 1_759_000_000_000 },
      { sequence: 3, text: "Second\n\nline", pseudonym: "Member Bright Fern", createdAt: 1_759_000_100_000, updatedAt: 1_759_000_200_000 },
    ];
    const root = folder("root", "Files", [leaf("draft", "Draft", "# D", comments)]);
    const collected = await collectExportTree(owned, sourceFor(root),
      { directoryId: "root", key: new Uint8Array(32), path: [], includeRoot: false }, { signal: signal() });
    const entries = await entriesOf(buildArchiveFiles(collected, { createdAt: at.toISOString(), roots: [] }));
    const sidecarEntry = entries.find((item) => item.path === ARCHIVE_COMMENTS_PATH)!;
    const sidecar = parsePrivateCommentsSidecar(decoder.decode(sidecarEntry.data));
    expect(sidecar.files).toEqual([{ path: "Draft.md", comments }]);
    expect(inspectArchive(entries).comments.get("Draft.md")).toEqual(comments);
    expect(sidecar.files[0]!.comments.map((comment) => comment.sequence)).toEqual([0, 3]);
  });

  it("appends .md only when needed and resolves mapping collisions deterministically", async () => {
    expect(exportFileName("notes")).toBe("notes.md");
    expect(exportFileName("notes.md")).toBe("notes.md");
    expect(exportFileName("notes.markdown")).toBe("notes.markdown");
    expect(exportFileName(".env")).toBe(".env.md");
    const children: ExportEntry[] = [
      { kind: "directory", nodeId: "dir", name: "b.md" },
      { kind: "file", nodeId: "a", name: "b" },
      { kind: "file", nodeId: "upper", name: "A.MD" },
      { kind: "file", nodeId: "lower", name: "a" },
      { kind: "file", nodeId: "tarball", name: "archive.tar" },
      { kind: "file", nodeId: "targz", name: "archive.tar.gz" },
    ];
    const allocation = new Map(allocateExportPaths([], children)
      .map((item) => [item.nodeId, item.segments.join("/")]));
    expect(allocation.get("upper")).toBe("A.MD");
    expect(allocation.get("lower")).toBe("a (2).md");
    expect(allocation.get("dir")).toBe("b.md");
    expect(allocation.get("a")).toBe("b (2).md");
    expect(allocation.get("tarball")).toBe("archive.tar.md");
    expect(allocation.get("targz")).toBe("archive.tar.gz.md");
    // The allocation is stable regardless of enumeration order.
    const reversed = new Map(allocateExportPaths([], children.slice().reverse())
      .map((item) => [item.nodeId, item.segments.join("/")]));
    expect(reversed).toEqual(allocation);
    // And the resulting plan has no duplicate paths under the import preflight.
    const root = folder("root", "Files", [
      folder("dir", "b.md", []),
      leaf("a", "b", ""), leaf("upper", "A.MD", ""), leaf("lower", "a", ""),
      leaf("tarball", "archive.tar", ""), leaf("targz", "archive.tar.gz", ""),
    ]);
    const collected = await collectExportTree(owned, sourceFor(root),
      { directoryId: "root", key: new Uint8Array(32), path: [], includeRoot: false }, { signal: signal() });
    const entries = await entriesOf(buildArchiveFiles(collected, { createdAt: at.toISOString(), roots: [] }));
    expect(() => inspectArchive(entries)).not.toThrow();
  });

  it("keeps a selected Directory as an archive child and reports a file root for a selected File", async () => {
    const root = folder("root", "Files", [
      folder("notes", "notes", [leaf("draft", "draft", "# D")]),
    ]);
    const selected = await collectExportTree(owned, sourceFor(root),
      { directoryId: "notes", key: new Uint8Array(32), path: ["notes"], includeRoot: true }, { signal: signal() });
    expect(selected.directories.map((path) => path.join("/"))).toEqual(["notes"]);
    const directoryArchive = await entriesOf(buildArchiveFiles(selected,
      { createdAt: at.toISOString(), roots: [{ kind: "directory", path: "notes" }] }));
    expect(inspectArchive(directoryArchive).roots).toEqual([{ kind: "directory", path: "notes" }]);

    const single = await collectExportFile(owned, sourceFor(root),
      { fileId: "draft", parentKey: new Uint8Array(32), name: "draft" }, { signal: signal() });
    expect(single.files[0]!.path).toEqual(["draft.md"]);
    const fileArchive = await entriesOf(buildArchiveFiles(single,
      { createdAt: at.toISOString(), roots: [{ kind: "file", path: "draft.md" }] }));
    const inspection = inspectArchive(fileArchive);
    expect(inspection.roots).toEqual([{ kind: "file", path: "draft.md" }]);
    expect(inspection.entries).toEqual([
      { path: "draft.md", segments: ["draft.md"], directory: false, bytes: 3 },
    ]);
  });

  it("refuses a shared-only scope before reading anything", async () => {
    const calls: string[] = [];
    const root = folder("shared", "Shared", [leaf("secret", "secret", "shared-only")]);
    await expect(collectExportTree({ vaultId: "owner", actorAccountId: "collaborator" }, sourceFor(root, calls),
      { directoryId: "shared", key: new Uint8Array(32), path: [], includeRoot: false }, { signal: signal() }))
      .rejects.toMatchObject({ code: "not_owned" });
    await expect(collectExportFile({ vaultId: "owner", actorAccountId: "collaborator" }, sourceFor(root, calls),
      { fileId: "secret", parentKey: new Uint8Array(32), name: "secret" }, { signal: signal() }))
      .rejects.toMatchObject({ code: "not_owned" });
    expect(calls).toEqual([]);
  });

  it("refuses a Directory named .mdwn at the archive root", async () => {
    await expect(collectExportTree(owned, sourceFor(folder("root", "Files", [])),
      { directoryId: "root", key: new Uint8Array(32), path: [".mdwn"], includeRoot: true }, { signal: signal() }))
      .rejects.toMatchObject({ code: "reserved_name" });
    await expect(collectExportTree(owned, sourceFor(folder("root", "Files", [
      folder("meta", ".mdwn", []),
    ])), { directoryId: "root", key: new Uint8Array(32), path: [], includeRoot: false }, { signal: signal() }))
      .rejects.toMatchObject({ code: "reserved_name" });
    await expect(collectExportTree(owned, sourceFor(folder("root", "Files", [
      leaf("meta-file", ".mdwn", "x"),
    ])), { directoryId: "root", key: new Uint8Array(32), path: [], includeRoot: false }, { signal: signal() }))
      .resolves.toMatchObject({ files: [{ path: [".mdwn.md"] }] });
  });

  it("reports unreadable Comment history instead of dropping it silently", async () => {
    const root = folder("root", "Files", [
      leaf("a", "A", "# A", [], false),
      leaf("b", "B", "# B", [{ sequence: 0, text: "kept", pseudonym: "Member", createdAt: 1, updatedAt: 1 }]),
    ]);
    const collected = await collectExportTree(owned, sourceFor(root),
      { directoryId: "root", key: new Uint8Array(32), path: [], includeRoot: false }, { signal: signal() });
    expect(collected.incompleteCommentFiles).toBe(1);
    const entries = await entriesOf(buildArchiveFiles(collected, { createdAt: at.toISOString(), roots: [] }));
    expect(entries.some((item) => item.path === ARCHIVE_COMMENTS_PATH)).toBe(true);
    expect(parsePrivateCommentsSidecar(decoder.decode(entries.find((item) => item.path === ARCHIVE_COMMENTS_PATH)!.data)).files)
      .toHaveLength(1);
  });

  it("exports a legacy oversized source without the Import source bound blocking the download", async () => {
    const oversized = `# legacy\n${"x".repeat(300_000)}\n`;
    const root = folder("root", "Files", [leaf("legacy", "legacy", oversized)]);
    const collected = await collectExportTree(owned, sourceFor(root),
      { directoryId: "root", key: new Uint8Array(32), path: [], includeRoot: false }, { signal: signal() });
    expect(collected.files[0]!.markdown).toBe(oversized);
    const entries = await entriesOf(buildArchiveFiles(collected, { createdAt: at.toISOString(), roots: [] }));
    expect(decoder.decode(entries.find((item) => item.path === "legacy.md")!.data)).toBe(oversized);
    // Import preflight still rejects it as over the settled source bound.
    expect(() => inspectArchive(entries)).toThrow(/source-too-large/);
  });

  it("bounds runaway Directory depth instead of overflowing", async () => {
    let node = folder("leaf", "leaf", []);
    for (let index = 0; index <= MAX_EXPORT_DIRECTORY_DEPTH + 1; index++) node = folder(`d${index}`, `d${index}`, [node]);
    await expect(collectExportTree(owned, sourceFor(node),
      { directoryId: node.nodeId, key: new Uint8Array(32), path: [], includeRoot: false }, { signal: signal() }))
      .rejects.toMatchObject({ code: "too_deep" });
  });

  it("stops before reading when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: string[] = [];
    await expect(collectExportTree(owned, sourceFor(folder("root", "Files", [leaf("a", "A", "x")]), calls),
      { directoryId: "root", key: new Uint8Array(32), path: [], includeRoot: false }, { signal: controller.signal }))
      .rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
