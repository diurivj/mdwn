import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SENSITIVE_FILE_MODE, withSensitiveOutput, writeSensitive } from "../scripts/lib/restore-cli-support.mjs";

const umasks = [
  { name: "000", mode: 0o000 },
  { name: "077", mode: 0o077 },
  { name: "777", mode: 0o777 },
];

let directory: string;
let originalUmask: number;

beforeEach(() => {
  originalUmask = process.umask();
  directory = mkdtempSync(join(tmpdir(), "mdwn-sensitive-artifacts-"));
});

afterEach(() => {
  process.umask(originalUmask);
  rmSync(directory, { recursive: true, force: true });
});

describe("writeSensitive", () => {
  it.each(umasks)("creates mode 0600 artifacts with intact data under umask $name", ({ mode }) => {
    const path = join(directory, "prepared.sql");
    process.umask(mode);

    writeSensitive(path, "synthetic prepared SQL: café\n");

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("synthetic prepared SQL: café\n");
    expect(process.umask()).toBe(mode);
  });

  it.each(umasks)("protects and replaces an existing permissive artifact under umask $name", ({ mode }) => {
    const path = join(directory, "status.json");
    writeFileSync(path, "existing synthetic status with a much longer payload\n");
    chmodSync(path, 0o666);
    process.umask(mode);

    writeSensitive(path, "new café\n", SENSITIVE_FILE_MODE);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("new café\n");
    expect(process.umask()).toBe(mode);
  });

  it("rejects a symlink without overwriting or changing its target", () => {
    const target = join(directory, "target.sql");
    const path = join(directory, "export.sql");
    writeFileSync(target, "existing synthetic export");
    chmodSync(target, 0o666);
    symlinkSync(target, path);
    process.umask(0o000);

    expect(() => writeSensitive(path, "replacement synthetic export")).toThrow();
    expect(readFileSync(target, "utf8")).toBe("existing synthetic export");
    expect(statSync(target).mode & 0o777).toBe(0o666);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });

  it("rejects a dangling symlink without creating its target", () => {
    const target = join(directory, "missing.sql");
    const path = join(directory, "export.sql");
    symlinkSync(target, path);
    process.umask(0o000);

    expect(() => writeSensitive(path, "synthetic export")).toThrow();
    expect(existsSync(target)).toBe(false);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });

  it.each([0o000, 0o400, 0o644, 0o666])("rejects mode %i before creating or overwriting artifacts", (mode) => {
    const path = join(directory, "manifest.json");
    const newPath = join(directory, "new-manifest.json");
    writeFileSync(path, "existing synthetic manifest");
    chmodSync(path, 0o600);
    process.umask(0o000);

    expect(() => writeSensitive(path, "replacement synthetic manifest", mode)).toThrow(/0600/);
    expect(readFileSync(path, "utf8")).toBe("existing synthetic manifest");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => writeSensitive(newPath, "new synthetic manifest", mode)).toThrow(/0600/);
    expect(existsSync(newPath)).toBe(false);
  });
});

describe("withSensitiveOutput", () => {
  it.each([
    { name: "existing", hasTarget: true },
    { name: "missing", hasTarget: false },
  ])("rejects symlink output to an $name target before invoking the producer", ({ hasTarget }) => {
    const path = join(directory, "raw-export.sql");
    const target = join(directory, "target.sql");
    if (hasTarget) {
      writeFileSync(target, "untouched synthetic export");
      chmodSync(target, 0o666);
    }
    symlinkSync(target, path);
    process.umask(0o000);
    let produced = false;

    expect(() =>
      withSensitiveOutput(path, () => {
        produced = true;
        writeFileSync(path, "replacement synthetic export");
      }),
    ).toThrow();

    expect(produced).toBe(false);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    if (hasTarget) {
      expect(readFileSync(target, "utf8")).toBe("untouched synthetic export");
      expect(statSync(target).mode & 0o777).toBe(0o666);
    } else {
      expect(existsSync(target)).toBe(false);
    }
    expect(process.umask()).toBe(0o000);
  });

  it.each(umasks)("pre-protects new output and restores umask $name after a successful producer", ({ mode }) => {
    const path = join(directory, "raw-export.sql");
    const produced = { complete: true };
    process.umask(mode);

    const result = withSensitiveOutput(path, () => {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8")).toBe("");
      expect(process.umask()).toBe(0o077);
      writeFileSync(path, "synthetic raw export: café\n");
      return produced;
    });

    expect(result).toBe(produced);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("synthetic raw export: café\n");
    expect(process.umask()).toBe(mode);
  });

  it.each(umasks)("protects an existing permissive output before its producer runs under umask $name", ({ mode }) => {
    const path = join(directory, "raw-export.sql");
    writeFileSync(path, "existing synthetic export with a much longer payload\n");
    chmodSync(path, 0o666);
    process.umask(mode);

    const result = withSensitiveOutput(path, () => {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8")).toBe("existing synthetic export with a much longer payload\n");
      expect(process.umask()).toBe(0o077);
      writeFileSync(path, "new café\n");
      return 42;
    });

    expect(result).toBe(42);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("new café\n");
    expect(process.umask()).toBe(mode);
  });

  it.each(umasks)("restricts recreated output and repairs producer permissions under umask $name", ({ mode }) => {
    const path = join(directory, "raw-export.sql");
    process.umask(mode);

    withSensitiveOutput(path, () => {
      rmSync(path);
      writeFileSync(path, "synthetic recreated export\n", { mode: 0o666 });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      chmodSync(path, 0o666);
    });

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("synthetic recreated export\n");
    expect(process.umask()).toBe(mode);
  });

  it.each(umasks)("protects partial output and restores umask $name when a producer fails", ({ mode }) => {
    const path = join(directory, "partial-export.sql");
    const original = new Error("synthetic producer failure");
    process.umask(mode);
    let caught: unknown;

    try {
      withSensitiveOutput(path, () => {
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(process.umask()).toBe(0o077);
        writeFileSync(path, "synthetic partial export: café\n");
        chmodSync(path, 0o666);
        throw original;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(original);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("synthetic partial export: café\n");
    expect(process.umask()).toBe(mode);
  });

  it.each(umasks)("fails and restores umask $name when successful output cannot be protected", ({ mode }) => {
    const path = join(directory, "raw-export.sql");
    const target = join(directory, "target.sql");
    writeFileSync(target, "untouched synthetic export");
    chmodSync(target, 0o666);
    process.umask(mode);
    let caught: unknown;

    try {
      withSensitiveOutput(path, () => {
        rmSync(path);
        symlinkSync(target, path);
        return 42;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "ELOOP" });
    expect(caught).not.toBeInstanceOf(AggregateError);
    expect(readFileSync(target, "utf8")).toBe("untouched synthetic export");
    expect(statSync(target).mode & 0o777).toBe(0o666);
    expect(process.umask()).toBe(mode);
  });

  it.each(umasks)("preserves producer and permission-cleanup errors and restores umask $name", ({ mode }) => {
    const path = join(directory, "raw-export.sql");
    const partialPath = join(directory, "partial-export.sql");
    const target = join(directory, "untouched.sql");
    const original = new Error("synthetic producer failure");
    writeFileSync(target, "untouched synthetic data");
    chmodSync(target, 0o666);
    process.umask(mode);
    let caught: unknown;

    try {
      withSensitiveOutput(path, () => {
        writeFileSync(path, "synthetic partial export\n");
        renameSync(path, partialPath);
        symlinkSync(target, path);
        throw original;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    if (!(caught instanceof AggregateError)) throw caught;
    expect(caught.cause).toBe(original);
    expect(caught.errors).toHaveLength(2);
    expect(caught.errors[0]).toBe(original);
    expect(caught.errors[1]).toMatchObject({ code: "ELOOP" });
    expect(statSync(partialPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(partialPath, "utf8")).toBe("synthetic partial export\n");
    expect(statSync(target).mode & 0o777).toBe(0o666);
    expect(readFileSync(target, "utf8")).toBe("untouched synthetic data");
    expect(process.umask()).toBe(mode);
  });

  it("preserves even an undefined producer failure when permission cleanup also fails", () => {
    const path = join(directory, "raw-export.sql");
    const target = join(directory, "missing.sql");
    const original = undefined;
    process.umask(0o000);
    let caught: unknown;

    try {
      withSensitiveOutput(path, () => {
        rmSync(path);
        symlinkSync(target, path);
        throw original;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    if (!(caught instanceof AggregateError)) throw caught;
    expect(caught.cause).toBeUndefined();
    expect(caught.errors).toHaveLength(2);
    expect(caught.errors[0]).toBeUndefined();
    expect(caught.errors[1]).toMatchObject({ code: "ELOOP" });
    expect(existsSync(target)).toBe(false);
    expect(process.umask()).toBe(0o000);
  });
});
