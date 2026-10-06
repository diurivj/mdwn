import { describe, expect, it } from "vitest";

import {
  ARCHIVE_COMMENTS_PATH, ARCHIVE_MANIFEST_PATH, createArchiveManifest, createPrivateCommentsSidecar,
  serializeArchiveManifest, serializePrivateCommentsSidecar, type HistoricalComment,
} from "../app/shared/archive/format";
import { createZip } from "../app/shared/archive/zip";
import { IMPORT_LIMITS, ImportError } from "../app/shared/import/limits";
import { analyzeImportSelection, type RawImportInput } from "../app/shared/import/source";

const encoder = new TextEncoder();
const at = new Date("2026-10-05T12:00:00.000Z");

function loose(path: string, data: string | Uint8Array = "x", directory = false): RawImportInput {
  return { path, directory, bytes: directory ? undefined : (typeof data === "string" ? encoder.encode(data) : data) };
}

async function archive(inputs: { path: string; data?: string | Uint8Array; directory?: boolean }[],
  options: { roots?: { kind: "file" | "directory"; path: string }[] } = {}): Promise<RawImportInput> {
  const files = [
    { path: ARCHIVE_MANIFEST_PATH, data: encoder.encode(serializeArchiveManifest(
      createArchiveManifest(options.roots ?? [{ kind: "directory", path: "" }], at.toISOString()))) },
    ...inputs.map((input) => ({ path: input.path, directory: input.directory,
      data: input.data === undefined ? undefined : (typeof input.data === "string" ? encoder.encode(input.data) : input.data) })),
  ];
  return { path: "vault.zip", bytes: await createZip(files, { at }) };
}

function throwsCode(run: () => Promise<unknown>, code: ImportError["code"]): Promise<void> {
  return run().then(
    () => { throw new Error(`expected mdwn/import: ${code}`); },
    (error) => { expect(error).toBeInstanceOf(ImportError); expect((error as ImportError).code).toBe(code); },
  );
}

describe("import source: loose selection", () => {
  it("accepts UTF-8 Markdown files and folders and preserves the hierarchy", async () => {
    const source = await analyzeImportSelection([
      loose("notes", undefined, true),
      loose("notes/Draft.md", "# Héllo\n"),
      loose("notes/sub/More.markdown", "more"),
      loose("README.md", "# Readme\n"),
      loose("notes/sub/empty", undefined, true),
    ]);
    expect(source.kind).toBe("loose");
    expect(source.nodeCount).toBe(6);
    expect(source.maxDepth).toBe(3);
    expect(source.expandedBytes).toBe(encoder.encode("# Héllo\n").length + 4 + encoder.encode("# Readme\n").length);
    expect(source.nodes.map((node) => `${node.kind}:${node.path}`)).toEqual([
      "file:README.md",
      "directory:notes", "file:notes/Draft.md", "directory:notes/sub",
      "file:notes/sub/More.markdown", "directory:notes/sub/empty",
    ]);
    const notes = source.roots.find((child) => child.name === "notes")!;
    expect(notes.kind).toBe("directory");
    expect(notes.path).toEqual(["notes"]);
    if (notes.kind === "directory") {
      expect(notes.children.map((child) => child.name)).toEqual(["Draft.md", "sub"]);
    }
  });

  it("rejects unsupported extensions, non-UTF-8 bytes, and unsafe paths", async () => {
    await throwsCode(() => analyzeImportSelection([loose("image.png", new Uint8Array([1, 2, 3]))]), "unsupported-input");
    await throwsCode(() => analyzeImportSelection([loose("bad.md", new Uint8Array([0xff, 0xfe]))]), "not-utf8");
    for (const path of ["../escape.md", "/absolute.md", "a//b.md", "a/./b.md", "a/../b.md", "CON.md", "bad\u202e.md",
      "bad:name.md", "draft.", "trailing .md ", `${"x".repeat(253)}.md`]) {
      await throwsCode(() => analyzeImportSelection([loose(path)]), "invalid-path");
    }
    await throwsCode(() => analyzeImportSelection([]), "empty-selection");
  });

  it("accepts the exact 255-byte segment profile and rejects one byte over", async () => {
    const atLimit = `${"y".repeat(252)}.md`; // 255 UTF-8 bytes
    const source = await analyzeImportSelection([loose(atLimit)]);
    expect(source.nodes[0]!.name).toBe(atLimit);
    await throwsCode(() => analyzeImportSelection([loose(`${"y".repeat(253)}.md`)]), "invalid-path");
  });

  it("rejects duplicate normalized paths including folded case and equivalent Unicode", async () => {
    await throwsCode(() => analyzeImportSelection([loose("A.md"), loose("a.md")]), "duplicate-source-path");
    await throwsCode(() => analyzeImportSelection([loose("Am\u00e9lie.md"), loose("Ame\u0301lie.md")]), "duplicate-source-path");
    await throwsCode(() => analyzeImportSelection([loose("notes", undefined, true), loose("NOTES", undefined, true)]), "duplicate-source-path");
    await throwsCode(() => analyzeImportSelection([loose("report.md"), loose("STRASSE.md"), loose("stra\u00dfe.md")]),
      "duplicate-source-path");
  });

  it("enforces the settled node and depth bounds at the limit and one over", async () => {
    const files = Array.from({ length: 100 }, (_, index) => loose(`f${String(index).padStart(3, "0")}.md`, "x"));
    const atLimit = await analyzeImportSelection(files);
    expect(atLimit.nodeCount).toBe(100);
    await throwsCode(() => analyzeImportSelection([...files, loose("f100.md", "x")]), "too-many-nodes");

    const depth32 = Array.from({ length: 32 }, (_, index) => `d${index}`).join("/");
    const ok = await analyzeImportSelection([loose(`${depth32}/x.md`, "x")]);
    expect(ok.maxDepth).toBe(32);
    const depth33 = Array.from({ length: 33 }, (_, index) => `d${index}`).join("/");
    await throwsCode(() => analyzeImportSelection([loose(`${depth33}/x.md`, "x")]), "too-deep");
  });

  it("enforces the settled source and expanded bounds at the limit and one over", async () => {
    const maxSource = new Uint8Array(IMPORT_LIMITS.maxSourceBytes).fill(0x61);
    const accepted = await analyzeImportSelection([loose("a.md", maxSource)]);
    expect(accepted.sourceBytes).toBe(IMPORT_LIMITS.maxSourceBytes);
    await throwsCode(() => analyzeImportSelection([loose("a.md", new Uint8Array(IMPORT_LIMITS.maxSourceBytes + 1))]),
      "source-too-large");

    // The expanded bound is easier to pin with a smaller override; the default
    // 16 MiB constant is asserted below.
    const expandedAtLimit = await analyzeImportSelection([
      loose("a.md", "1234"), loose("b.md", "5678"),
    ], { limits: { maxExpandedBytes: 8, maxSourceBytes: 8 } });
    expect(expandedAtLimit.expandedBytes).toBe(8);
    await throwsCode(() => analyzeImportSelection([
      loose("a.md", "1234"), loose("b.md", "5678"),
    ], { limits: { maxExpandedBytes: 7, maxSourceBytes: 8 } }), "expanded-too-large");
    expect(IMPORT_LIMITS.maxExpandedBytes).toBe(16_777_216);
  });

  it("accepts a folder-only selection but rejects an empty one", async () => {
    const source = await analyzeImportSelection([loose("empty", undefined, true)]);
    expect(source.nodeCount).toBe(1);
    expect(source.roots[0]?.kind).toBe("directory");
  });
});

describe("import source: recognized archive", () => {
  it("accepts an archive produced for the whole vault and normalizes its paths", async () => {
    const input = await archive([
      { path: "notes/draft.md", data: "# Draft\n" },
      { path: "README.md", data: "# Readme\n" },
      { path: "notes", directory: true },
    ]);
    const source = await analyzeImportSelection([input]);
    expect(source.kind).toBe("archive");
    expect(source.compressedBytes).toBe(input.bytes!.length);
    expect(source.nodeCount).toBe(3);
    expect(source.maxDepth).toBe(1);
    expect(source.roots.map((child) => child.name)).toEqual(["README.md", "notes"]);
    expect(source.roots.find((child) => child.name === "notes")?.path).toEqual(["notes"]);
  });

  it("resolves a selected-folder root and rejects entries outside the manifest roots", async () => {
    const selected = await archive([
      { path: "notes", directory: true }, { path: "notes/draft.md", data: "x" },
    ], { roots: [{ kind: "directory", path: "notes" }] });
    const source = await analyzeImportSelection([selected]);
    expect(source.roots.map((child) => child.name)).toEqual(["notes"]);

    const stray = await archive([
      { path: "notes", directory: true }, { path: "notes/draft.md", data: "x" }, { path: "stray.md", data: "x" },
    ], { roots: [{ kind: "directory", path: "notes" }] });
    await throwsCode(() => analyzeImportSelection([stray]), "unsupported-input");
  });

  it("rejects a plain zip, a mixed selection, a non-Markdown member, and a malformed archive", async () => {    const plain = await createZip([{ path: "notes.md", data: encoder.encode("x") }], { at });
    await throwsCode(() => analyzeImportSelection([{ path: "plain.zip", bytes: plain }]), "unsupported-input");
    const recognized = await archive([{ path: "notes.md", data: "x" }]);
    await throwsCode(() => analyzeImportSelection([recognized, loose("notes.md", "x")]), "unsupported-input");
    const binary = await archive([{ path: "notes.txt", data: "x" }]);
    await throwsCode(() => analyzeImportSelection([binary]), "unsupported-input");
    await throwsCode(() => analyzeImportSelection([{ path: "broken.zip", bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) }]),
      "unsupported-input");
  });

  it("rejects an empty recognized archive", async () => {
    const empty = await archive([]);
    await throwsCode(() => analyzeImportSelection([empty]), "empty-selection");
  });

  it("enforces the compressed archive bound before reading", async () => {
    const small = await archive([{ path: "notes.md", data: "x" }]);
    const atLimit = await analyzeImportSelection([small], { limits: { maxCompressedBytes: small.bytes!.length } });
    expect(atLimit.compressedBytes).toBe(small.bytes!.length);
    await throwsCode(() => analyzeImportSelection([{ path: "big.zip", bytes: new Uint8Array(IMPORT_LIMITS.maxCompressedBytes + 1) }]),
      "archive-too-large");
    await throwsCode(() => analyzeImportSelection([small], { limits: { maxCompressedBytes: small.bytes!.length - 1 } }),
      "archive-too-large");
  });

  it("counts implicit parent Directories toward the node bound", async () => {
    // No explicit Directory ZIP entries: the tree builder must still count a/b.
    const input = await archive([{ path: "a/b/c.md", data: "x" }]);
    const source = await analyzeImportSelection([input]);
    expect(source.nodeCount).toBe(3);
    expect(source.maxDepth).toBe(2);
    await throwsCode(() => analyzeImportSelection([input], { limits: { maxNodes: 2 } }), "too-many-nodes");
  });

  it("carries Historical Comments and enforces their count at the limit and one over", async () => {
    const comment: HistoricalComment = { sequence: 0, text: "First", pseudonym: "Member Quiet Pine",
      createdAt: 1, updatedAt: 1 };
    const comments = (count: number, path: string) => ({
      path: ARCHIVE_COMMENTS_PATH,
      data: encoder.encode(serializePrivateCommentsSidecar(createPrivateCommentsSidecar([{ path,
        comments: Array.from({ length: count }, (_, index) => ({ ...comment, sequence: index })) }]))),
    });
    const accepted = await archive([{ path: "notes.md", data: "x" }, comments(1_000, "notes.md")]);
    const source = await analyzeImportSelection([accepted]);
    expect(source.commentCount).toBe(1_000);
    expect(source.comments.get("notes.md")).toHaveLength(1_000);

    const over = await archive([{ path: "notes.md", data: "x" }, comments(1_001, "notes.md")]);
    await throwsCode(() => analyzeImportSelection([over]), "too-many-comments");
  });

  it("reports one-over archive depth, node, source, and expanded bounds through the shared limits", async () => {
    const input = await archive([{ path: "a/b.md", data: "1234" }]);
    const source = await analyzeImportSelection([input]);
    expect(source.maxDepth).toBe(1);
    await throwsCode(() => analyzeImportSelection([input], { limits: { maxDepth: 0 } }), "too-deep");
    await throwsCode(() => analyzeImportSelection([input], { limits: { maxNodes: 1 } }), "too-many-nodes");
    await throwsCode(() => analyzeImportSelection([input], { limits: { maxSourceBytes: 3 } }), "source-too-large");
    await throwsCode(() => analyzeImportSelection([input], { limits: { maxExpandedBytes: 1 } }), "expanded-too-large");
  });
});
