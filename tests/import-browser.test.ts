import { describe, expect, it } from "vitest";

import { ImportError } from "../app/import/limits";
import { inputsFromDataTransfer, inputsFromFiles } from "../app/import/browser";

const encoder = new TextEncoder();

function fakeFile(name: string, text: string, relativePath?: string): File {
  const bytes = encoder.encode(text);
  return {
    name,
    webkitRelativePath: relativePath ?? "",
    arrayBuffer: async () => bytes.slice().buffer,
  } as unknown as File;
}

function fileEntry(name: string, text: string): FileSystemEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (resolve: (file: File) => void) => resolve(fakeFile(name, text)),
  } as unknown as FileSystemFileEntry;
}

function directoryEntry(name: string, children: readonly FileSystemEntry[]): FileSystemEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let delivered = false;
      return {
        readEntries: (resolve: (entries: FileSystemEntry[]) => void) => {
          if (delivered) resolve([]);
          else { delivered = true; resolve([...children]); }
        },
      } as unknown as FileSystemDirectoryReader;
    },
  } as unknown as FileSystemDirectoryEntry;
}

describe("import browser inputs", () => {
  it("reads a File input with webkitRelativePath and plain names", async () => {
    const inputs = await inputsFromFiles([
      fakeFile("draft.md", "# Draft\n", "notes/draft.md"),
      fakeFile("README.md", "# Readme\n"),
    ]);
    expect(inputs.map((input) => input.path)).toEqual(["notes/draft.md", "README.md"]);
    expect(new TextDecoder().decode(inputs[0]!.bytes)).toBe("# Draft\n");
  });

  it("walks a dropped directory tree and preserves empty folders", async () => {
    const item = {
      kind: "file",
      webkitGetAsEntry: () => directoryEntry("notes", [
        fileEntry("draft.md", "# Draft\n"),
        directoryEntry("empty", []),
      ]),
    } as unknown as DataTransferItem;
    const inputs = await inputsFromDataTransfer({ items: [item], files: [] } as unknown as DataTransfer);
    expect(inputs.map((input) => `${input.directory ? "dir:" : "file:"}${input.path}`)).toEqual([
      "dir:notes", "file:notes/draft.md", "dir:notes/empty",
    ]);
  });

  it("falls back to DataTransfer.files when no webkit entry is available", async () => {
    const input = { path: "notes.md", bytes: undefined as Uint8Array | undefined };
    const dataTransfer = { items: [], files: [fakeFile("notes.md", "# Notes\n")] } as unknown as DataTransfer;
    const inputs = await inputsFromDataTransfer(dataTransfer);
    expect(inputs.map((item) => item.path)).toEqual(["notes.md"]);
    void input;
  });

  it("rejects a selection larger than the expanded bound while reading", async () => {
    const big = {
      name: "big.md",
      webkitRelativePath: "",
      arrayBuffer: async () => new Uint8Array(16_777_217).buffer,
    } as unknown as File;
    await expect(inputsFromFiles([big])).rejects.toMatchObject({ code: "expanded-too-large" satisfies ImportError["code"] });
  });
});
