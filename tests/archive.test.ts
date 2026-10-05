import { describe, expect, it } from "vitest";

import {
  ARCHIVE_COMMENTS_PATH, ARCHIVE_MANIFEST_PATH, ArchiveError, checkArchiveCompressedSize,
  createArchiveManifest, createPrivateCommentsSidecar, inspectArchive, parseArchiveManifest,
  parsePrivateCommentsSidecar, serializeArchiveManifest, serializePrivateCommentsSidecar,
  type ArchiveErrorCode, type HistoricalComment,
} from "../app/archive/format";
import { createZip, crc32, readZip, ZipError, type ZipEntry } from "../app/archive/zip";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const at = new Date("2026-10-04T12:00:00.000Z");

function entry(path: string, data: string | Uint8Array = "", directory = false): ZipEntry {
  return { path, directory, data: typeof data === "string" ? encoder.encode(data) : data };
}

function manifestEntry(paths: readonly { kind: "file" | "directory"; path: string }[] = []): ZipEntry {
  return entry(ARCHIVE_MANIFEST_PATH, serializeArchiveManifest(createArchiveManifest(paths, at.toISOString())));
}

function throwsCode(run: () => unknown, code: ArchiveErrorCode): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveError);
    expect((error as ArchiveError).code).toBe(code);
    return;
  }
  throw new Error(`expected mdwn/archive: ${code}`);
}

const comment: HistoricalComment = { sequence: 0, text: "First comment", pseudonym: "Member Quiet Pine",
  createdAt: 1_759_000_000_000, updatedAt: 1_759_000_000_500 };

describe("mdwn/zip", () => {
  it("round-trips files, folders, empty entries, and Unicode names byte-exactly", async () => {
    const files = [
      { path: "Amélie/notes", data: encoder.encode("# Héllo\n\nStraße Ａ\n") },
      { path: "Amélie/empty.md", data: new Uint8Array() },
      { path: "Amélie", directory: true },
      { path: "data.bin", data: new Uint8Array([0, 1, 2, 253, 254, 255]) },
    ];
    const bytes = await createZip(files, { at });
    const entries = await readZip(bytes);
    expect(entries.map((item) => `${item.directory ? "dir:" : "file:"}${item.path}`)).toEqual([
      "file:Amélie/notes", "file:Amélie/empty.md", "dir:Amélie", "file:data.bin",
    ]);
    expect(decoder.decode(entries[0]!.data)).toBe("# Héllo\n\nStraße Ａ\n");
    expect(entries[1]!.data.length).toBe(0);
    expect(entries[2]!.data.length).toBe(0);
    expect(Array.from(entries[3]!.data)).toEqual([0, 1, 2, 253, 254, 255]);
  });

  it("deflates repetitive Markdown while returning the exact source", async () => {
    const markdown = `${"# Repeated heading\n\n".repeat(400)}end\n`;
    const archive = await createZip([{ path: "notes.md", data: encoder.encode(markdown) }], { at });
    expect(archive.length).toBeLessThan(encoder.encode(markdown).length / 4);
    const [restored] = await readZip(archive);
    expect(decoder.decode(restored!.data)).toBe(markdown);
    expect(crc32(encoder.encode(markdown))).toBe(crc32(restored!.data));
  });

  it("returns an empty list for an archive with no members", async () => {
    expect(await readZip(await createZip([], { at }))).toEqual([]);
  });

  it("rejects duplicate, absolute, and traversing member paths", async () => {
    await expect(createZip([{ path: "a.md", data: new Uint8Array() }, { path: "a.md", data: new Uint8Array() }]))
      .rejects.toMatchObject({ code: "duplicate-path" });
    for (const path of ["/etc/passwd", "../escape.md", "a/../../b.md", "a//b.md", "a\\b.md", "C:/x.md"]) {
      await expect(createZip([{ path, data: new Uint8Array() }])).rejects.toBeInstanceOf(ZipError);
    }
  });

  it("detects corrupted data and truncated archives", async () => {
    const archive = await createZip([{ path: "notes.md", data: encoder.encode("content") }], { at });
    const corrupted = archive.slice();
    corrupted[40] = corrupted[40]! ^ 0x20;
    await expect(readZip(corrupted)).rejects.toBeInstanceOf(ZipError);
    await expect(readZip(archive.subarray(0, archive.length - 10))).rejects.toBeInstanceOf(ZipError);
  });

  it("refuses encrypted members", async () => {
    const archive = await createZip([{ path: "notes.md", data: encoder.encode("content") }], { at });
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    for (let offset = 0; offset + 4 <= archive.length; offset++) {
      if (view.getUint32(offset, true) !== 0x02014b50) continue;
      const mutated = archive.slice();
      new DataView(mutated.buffer).setUint16(offset + 8, view.getUint16(offset + 8, true) | 0x0001, true);
      await expect(readZip(mutated)).rejects.toMatchObject({ code: "unsupported" });
      return;
    }
    throw new Error("central directory record not found");
  });
});

describe("mdwn archive format", () => {
  it("round-trips a versioned manifest and rejects foreign or malformed manifests", () => {
    const manifest = createArchiveManifest([{ kind: "directory", path: "" }], at.toISOString());
    expect(parseArchiveManifest(serializeArchiveManifest(manifest))).toEqual(manifest);
    expect(() => parseArchiveManifest(JSON.stringify({ ...manifest, format: "other" }))).toThrow();
    expect(() => parseArchiveManifest(JSON.stringify({ ...manifest, version: 2 }))).toThrow();
    expect(() => parseArchiveManifest(JSON.stringify({ ...manifest, extra: true }))).toThrow();
    expect(() => parseArchiveManifest(JSON.stringify({ ...manifest, createdAt: "not-a-date" }))).toThrow();
    expect(() => parseArchiveManifest("{}")).toThrow();
    try { parseArchiveManifest(JSON.stringify({ ...manifest, format: "other" })); }
    catch (error) { expect((error as ArchiveError).code).toBe("not-mdwn-archive"); }
  });

  it("round-trips the Private-Comment sidecar and enforces its record bounds", () => {
    const sidecar = createPrivateCommentsSidecar([{ path: "notes.md", comments: [comment] }]);
    expect(parsePrivateCommentsSidecar(serializePrivateCommentsSidecar(sidecar))).toEqual(sidecar);
    const malformed = (files: unknown[]): string => JSON.stringify({ ...sidecar, files });
    for (const files of [
      [{ path: "notes.md", comments: [{ ...comment, text: "a".repeat(2_001) }] }],
      [{ path: "notes.md", comments: [{ ...comment, text: "line\r\nbreak" }] }],
      [{ path: "notes.md", comments: [{ ...comment, pseudonym: "" }] }],
      [{ path: "notes.md", comments: [{ ...comment, sequence: -1 }] }],
      [{ path: "notes.md", comments: [{ ...comment, createdAt: 1.5 }] }],
      [{ path: "notes.md", comments: [] }],
      [{ path: "notes.md", comments: [comment, { ...comment }] }],
      [{ path: "a.md", comments: Array.from({ length: 1_000 }, (_, index) => ({ ...comment, sequence: index })) },
        { path: "b.md", comments: [{ ...comment, sequence: 1_000 }] }],
    ]) expect(() => parsePrivateCommentsSidecar(malformed(files))).toThrow();
  });

  it("accepts a conforming archive and resolves its roots, normalized paths, and comments", () => {
    const inspection = inspectArchive([
      entry(".mdwn", "", true), manifestEntry([{ kind: "directory", path: "notes" }]),
      entry("notes", "", true), entry("notes/draft.md", "# Draft\n"),
      entry("README.md", "# Readme\n"),
      entry(ARCHIVE_COMMENTS_PATH, serializePrivateCommentsSidecar(
        createPrivateCommentsSidecar([{ path: "notes/draft.md", comments: [comment] }]))),
    ]);
    expect(inspection.roots).toEqual([{ kind: "directory", path: "notes" }]);
    expect(inspection.entries.map((item) => item.path)).toEqual(["notes", "notes/draft.md", "README.md"]);
    expect(inspection.nodeCount).toBe(3);
    expect(inspection.maxDepth).toBe(1);
    expect(inspection.comments.get("notes/draft.md")).toEqual([comment]);
    expect(inspection.expandedBytes).toBeGreaterThan(0);
  });

  it("recognizes only mdwn archives with the exact metadata set", () => {
    throwsCode(() => inspectArchive([entry("notes.md", "text")]), "not-mdwn-archive");
    throwsCode(() => inspectArchive([manifestEntry(), entry(".mdwn/extra.txt", "x")]), "unexpected-metadata");
    throwsCode(() => inspectArchive([manifestEntry(), entry(".mdwn", "x")]), "unexpected-metadata");
    throwsCode(() => inspectArchive([manifestEntry(), entry(ARCHIVE_COMMENTS_PATH, "none", ), entry(ARCHIVE_COMMENTS_PATH, "none")]),
      "malformed-comments");
    expect(() => inspectArchive([manifestEntry(), entry("notes/.mdwn/hidden.md", "x")])).not.toThrow();
  });

  it("rejects duplicate normalized paths, including folded case and Unicode spellings", () => {
    const duplicate = (paths: string[]) => inspectArchive([manifestEntry(), ...paths.map((path) => entry(path, "x"))]);
    expect(() => duplicate(["A.md", "a.md"])).toThrow();
    expect(() => duplicate(["Am\u00e9lie.md", "Ame\u0301lie.md"])).toThrow();
    expect(() => duplicate(["notes", "notes/file.md", "NOTES"])).toThrow();
    expect(() => duplicate(["report.md", "STRASSE.md", "stra\u00dfe.md"])).toThrow();
  });

  it("normalizes display paths while preserving case and exact spelling", () => {
    const inspection = inspectArchive([manifestEntry(), entry("Ame\u0301lie/Notes.MD", "x")]);
    expect(inspection.entries[0]!.path).toBe("Am\u00e9lie/Notes.MD");
    expect(inspection.entries[0]!.segments).toEqual(["Am\u00e9lie", "Notes.MD"]);
  });

  it("rejects unsafe or non-canonical namespace segments", () => {
    const reject = (path: string) => throwsCode(() => inspectArchive([manifestEntry(), entry(path, "x")]), "invalid-path");
    reject("../escape.md");
    reject("/absolute.md");
    reject("a//b.md");
    reject("a/../b.md");
    reject("bad\u0001control.md");
    reject("bidi\u202e.md");
    reject("CON.md");
    reject("trailing .md ");
    reject(`${"x".repeat(253)}.md`);
  });

  it("enforces node, depth, source, and expanded bounds with one-over rejection", () => {
    expect(inspectArchive([manifestEntry(), entry("a.md", "12345678"), entry("b", "", true)],
      { limits: { maxNodes: 2, maxDepth: 1, maxSourceBytes: 8, maxExpandedBytes: 4_096 } }).nodeCount).toBe(2);
    throwsCode(() => inspectArchive([manifestEntry(), entry("a.md", "1"), entry("b.md", "2"), entry("c.md", "3")],
      { limits: { maxNodes: 2, maxDepth: 99, maxSourceBytes: 1_024, maxExpandedBytes: 4_096 } }), "too-many-nodes");
    throwsCode(() => inspectArchive([manifestEntry(), entry("a/b/c.md", "1")],
      { limits: { maxNodes: 10, maxDepth: 1, maxSourceBytes: 1_024, maxExpandedBytes: 4_096 } }), "too-deep");
    throwsCode(() => inspectArchive([manifestEntry(), entry("a.md", "123456789")],
      { limits: { maxNodes: 10, maxDepth: 99, maxSourceBytes: 8, maxExpandedBytes: 4_096 } }), "source-too-large");
    throwsCode(() => inspectArchive([manifestEntry(), entry("a.md", "x".repeat(2_000))],
      { limits: { maxNodes: 10, maxDepth: 99, maxSourceBytes: 4_096, maxExpandedBytes: 512 } }), "expanded-too-large");
    // The settled defaults accept a maximum-size source and reject one byte over.
    const maxSource = new Uint8Array(262_144).fill(0x61);
    expect(inspectArchive([manifestEntry(), { path: "a.md", directory: false, data: maxSource }]).sourceBytes).toBe(262_144);
    throwsCode(() => inspectArchive([manifestEntry(), { path: "a.md", directory: false, data: new Uint8Array(262_145) }]),
      "source-too-large");
  });

  it("requires manifest roots and sidecar references to name real archive entries", () => {
    throwsCode(() => inspectArchive([manifestEntry([{ kind: "directory", path: "missing" }])]), "missing-root");
    throwsCode(() => inspectArchive([manifestEntry([{ kind: "file", path: "notes" }]), entry("notes", "", true)]), "missing-root");
    expect(() => inspectArchive([manifestEntry([{ kind: "file", path: "notes.md" }]), entry("notes.md", "x")])).not.toThrow();
    throwsCode(() => inspectArchive([manifestEntry(), entry("notes.md", "x"),
      entry(ARCHIVE_COMMENTS_PATH, serializePrivateCommentsSidecar(createPrivateCommentsSidecar(
        [{ path: "absent.md", comments: [comment] }])))]), "malformed-comments");
  });

  it("enforces the recognized-archive input bound at the ZIP boundary", () => {
    checkArchiveCompressedSize(new Uint8Array(8_388_608));
    expect(() => checkArchiveCompressedSize(new Uint8Array(8_388_609))).toThrow();
    throwsCode(() => checkArchiveCompressedSize(new Uint8Array(129), 128), "archive-too-large");
  });
});
