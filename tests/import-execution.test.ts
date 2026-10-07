import { describe, expect, it, vi } from "vitest";

import {
  ImportExecution,
  type ImportExecutionOperations,
  type ImportExecutionRequest,
  type ImportProgress,
  type ImportSigners,
} from "../app/shared/import/execution";
import { ImportError } from "../app/shared/import/limits";
import type { ImportPlan, ImportPlanChunk, ImportReplacementDocument } from "../app/shared/import/plan";
import { reviewImport, type ImportReview, type ImportTarget } from "../app/shared/import/review";
import { analyzeImportSelection } from "../app/shared/import/source";
import type { RootAccess } from "../app/shared/tree/client";
import { encodeTreeBytes } from "../app/shared/tree/wire";

const encoder = new TextEncoder();

const TARGET_ID = "0198c0de-0000-7000-8000-0000000000aa";

function signers(): ImportSigners {
  return {
    signFileHead: async () => ({
      digest: encodeTreeBytes(new Uint8Array(32).fill(1)),
      signature: encodeTreeBytes(new Uint8Array(64).fill(2)),
    }),
    signListingHead: async () => ({
      ciphertext: encodeTreeBytes(encoder.encode("listing")),
      digest: encodeTreeBytes(new Uint8Array(32).fill(3)),
      signature: encodeTreeBytes(new Uint8Array(64).fill(4)),
    }),
  };
}

async function executionRequest(): Promise<ImportExecutionRequest> {
  const source = await analyzeImportSelection([{ path: "draft.md", bytes: encoder.encode("# Draft\n") }]);
  const target: ImportTarget = {
    directoryId: TARGET_ID,
    keyEpoch: 1,
    entriesRevision: 2,
    ownerAccountId: "owner-id",
    actorAccountId: "owner-id",
    label: "Files",
    siblings: [],
    listing: [],
  };
  const review = reviewImport(source, target);
  const access: RootAccess = {
    vaultId: "owner-id",
    rootId: TARGET_ID,
    rootKey: new Uint8Array(32),
    actorAccountId: "owner-id",
    actorVaultRootKey: new Uint8Array(32),
  };
  return { review, source, target: { ...target, key: crypto.getRandomValues(new Uint8Array(32)) }, access };
}

/** Deterministic operations seam: tests replace the handler they control and
 * read the recorded calls, plans and uploads. */
function fakeOperations() {
  const calls: string[] = [];
  const plans: ImportPlan[] = [];
  const uploads: { importId: string; chunk: ImportPlanChunk }[] = [];
  const cancels: string[] = [];
  const handlers = {
    loadReplacementDocuments: async (
      _access: RootAccess,
      _targetKey: Uint8Array,
      _review: ImportReview,
    ): Promise<ReadonlyMap<string, ImportReplacementDocument>> => new Map(),
    importSigners: async (_access: RootAccess) => signers(),
    openSession: async (_plan: ImportPlan, _signal: AbortSignal): Promise<void> => {},
    uploadChunk: async (_importId: string, _chunk: ImportPlanChunk, _signal: AbortSignal): Promise<void> => {},
    commit: async (_importId: string, _signal: AbortSignal): Promise<{ entriesRevision?: number }> => ({}),
    cancelSession: async (_importId: string): Promise<void> => {},
  };
  const operations: ImportExecutionOperations = {
    async loadReplacementDocuments(access, targetKey, review) {
      calls.push("replacements");
      return handlers.loadReplacementDocuments(access, targetKey, review);
    },
    async importSigners(access) {
      calls.push("signers");
      return handlers.importSigners(access);
    },
    async openSession(plan, signal) {
      calls.push("open");
      plans.push(plan);
      return handlers.openSession(plan, signal);
    },
    async uploadChunk(importId, chunk, signal) {
      calls.push("upload");
      uploads.push({ importId, chunk });
      return handlers.uploadChunk(importId, chunk, signal);
    },
    async commit(importId, signal) {
      calls.push("commit");
      return handlers.commit(importId, signal);
    },
    async cancelSession(importId) {
      calls.push("cancel");
      cancels.push(importId);
      return handlers.cancelSession(importId);
    },
  };
  return { operations, handlers, calls, plans, uploads, cancels };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ImportExecution", () => {
  it("prepares the complete plan, stages it, and reports the committed counts", async () => {
    const fake = fakeOperations();
    const progress: ImportProgress[] = [];
    const execution = new ImportExecution(
      { ...(await executionRequest()), onProgress: (update) => progress.push(update) },
      fake.operations,
    );
    fake.handlers.commit = async () => ({ entriesRevision: 9 });

    const outcome = await execution.run();

    expect(outcome).toEqual({ status: "committed", created: 1, comments: 0, entriesRevision: 9 });
    expect(fake.calls).toEqual(["replacements", "signers", "open", "upload", "commit"]);
    const plan = fake.plans[0]!;
    expect(fake.uploads.map((upload) => upload.chunk)).toEqual(plan.chunks);
    expect(fake.uploads.every((upload) => upload.importId === plan.importId)).toBe(true);
    expect(progress).toEqual([
      { chunksSent: 0, chunksTotal: plan.chunks.length },
      { chunksSent: plan.chunks.length, chunksTotal: plan.chunks.length },
    ]);
    expect(fake.cancels).toEqual([]);
  });

  it("rejects incomplete preparation before opening any session or uploading", async () => {
    const fake = fakeOperations();
    fake.handlers.loadReplacementDocuments = async () => {
      throw new ImportError("replacement-unavailable", { item: "draft.md", action: "fix" });
    };
    const execution = new ImportExecution(await executionRequest(), fake.operations);

    const outcome = await execution.run();

    expect(outcome).toMatchObject({ status: "failed", error: { code: "replacement-unavailable" } });
    expect(fake.calls).toEqual(["replacements"]);
    expect(fake.cancels).toEqual([]);
  });

  it("cleans up with the browser-known Import ID when the open acknowledgment is lost", async () => {
    const fake = fakeOperations();
    fake.handlers.openSession = async () => {
      throw new TypeError("network lost");
    };
    const execution = new ImportExecution(await executionRequest(), fake.operations);

    const outcome = await execution.run();

    expect(outcome).toMatchObject({ status: "failed", error: null });
    expect(fake.calls).toEqual(["replacements", "signers", "open", "cancel"]);
    expect(fake.cancels).toEqual([fake.plans[0]!.importId]);
    expect(fake.uploads).toEqual([]);
  });

  it("retries an interrupted chunk once with the identical prepared bytes and Import identity", async () => {
    const fake = fakeOperations();
    let attempts = 0;
    fake.handlers.uploadChunk = async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("network lost");
    };
    const execution = new ImportExecution(await executionRequest(), fake.operations);

    const outcome = await execution.run();

    expect(outcome).toMatchObject({ status: "committed" });
    expect(fake.calls).toEqual(["replacements", "signers", "open", "upload", "upload", "commit"]);
    const plan = fake.plans[0]!;
    expect(fake.uploads.map((upload) => upload.chunk)).toEqual([plan.chunks[0], plan.chunks[0]]);
    expect(fake.uploads.every((upload) => upload.importId === plan.importId)).toBe(true);
  });

  it("retries an interrupted commit once before reporting the outcome", async () => {
    const fake = fakeOperations();
    let attempts = 0;
    fake.handlers.commit = async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("network lost");
      return { entriesRevision: 4 };
    };
    const execution = new ImportExecution(await executionRequest(), fake.operations);

    const outcome = await execution.run();

    expect(outcome).toEqual({ status: "committed", created: 1, comments: 0, entriesRevision: 4 });
    expect(fake.calls).toEqual(["replacements", "signers", "open", "upload", "commit", "commit"]);
    expect(fake.cancels).toEqual([]);
  });

  it("does not retry an explicit protocol rejection and still attempts cleanup", async () => {
    const fake = fakeOperations();
    fake.handlers.uploadChunk = async () => {
      throw new ImportError("staging-changed");
    };
    const execution = new ImportExecution(await executionRequest(), fake.operations);

    const outcome = await execution.run();

    expect(outcome).toMatchObject({ status: "failed", error: { code: "staging-changed" } });
    expect(fake.calls).toEqual(["replacements", "signers", "open", "upload", "cancel"]);
    expect(fake.cancels).toEqual([fake.plans[0]!.importId]);
  });

  it("keeps the primary failure when best-effort cleanup also fails", async () => {
    const fake = fakeOperations();
    fake.handlers.commit = async () => {
      throw new ImportError("import-expired");
    };
    fake.handlers.cancelSession = async () => {
      throw new TypeError("cleanup network lost");
    };
    const execution = new ImportExecution(await executionRequest(), fake.operations);

    const outcome = await execution.run();

    expect(outcome).toMatchObject({ status: "failed", error: { code: "import-expired" } });
    expect(fake.cancels).toEqual([fake.plans[0]!.importId]);
  });

  it("stops a cancelled attempt, cleans up, and reports cancellation without an error", async () => {
    const fake = fakeOperations();
    const held = deferred<void>();
    fake.handlers.uploadChunk = async () => {
      await held.promise;
    };
    const execution = new ImportExecution(await executionRequest(), fake.operations);

    const outcome = execution.run();
    await vi.waitFor(() => expect(fake.uploads).toHaveLength(1));
    execution.cancel();
    held.reject(new Error("aborted"));

    expect(await outcome).toEqual({ status: "cancelled" });
    expect(fake.cancels).toEqual([fake.plans[0]!.importId]);
  });

  it("does not attempt cleanup when no session could exist", async () => {
    const fake = fakeOperations();
    fake.handlers.importSigners = async () => {
      throw new ImportError("replacement-unavailable", { reason: "device-unavailable", action: "fix" });
    };
    const execution = new ImportExecution(await executionRequest(), fake.operations);

    const outcome = await execution.run();

    expect(outcome).toMatchObject({ status: "failed", error: { code: "replacement-unavailable" } });
    expect(fake.calls).toEqual(["replacements", "signers"]);
    expect(fake.cancels).toEqual([]);
  });

  it("succeeds without an optional listing revision and does not clean up a committed attempt", async () => {
    const fake = fakeOperations();
    fake.handlers.uploadChunk = async () => {};
    fake.handlers.commit = async () => ({});
    const execution = new ImportExecution(await executionRequest(), fake.operations);

    const outcome = await execution.run();

    expect(outcome).toMatchObject({ status: "committed", created: 1 });
    expect(fake.cancels).toEqual([]);
  });
});
