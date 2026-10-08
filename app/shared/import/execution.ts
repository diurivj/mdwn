/**
 * One confirmed-review Import attempt (tickets 46–48).
 *
 * The Import control settles an Import review; from that boundary this module
 * owns execution: replacement reads, this browser's signing keys, the complete
 * encrypted record/chunk plan, session opening, chunk upload, the atomic
 * commit, and best-effort cleanup. Callers provide the confirmed review and
 * render progress and one outcome; they never assemble staging steps or hold a
 * staging identity.
 *
 * The browser knows the Import ID before the open request, so a lost open
 * acknowledgment can still attempt cleanup using that ID and never reopens the
 * non-idempotent session. Prepared chunk bytes are reused for the existing
 * single automatic retry; the retry lives here so the attempt has one owner.
 */

import type { RootAccess } from "~/shared/tree/client";
import { ImportError } from "./limits";
import {
  prepareImportPlan,
  type ImportPlan,
  type ImportPlanChunk,
  type ImportReplacementDocument,
  type ImportSigners,
} from "./plan";
import type { ImportReview } from "./review";
import type { ImportSource, ImportSourceChild, ImportSourceFile } from "./source";
import type { EligibleImportTarget } from "./targets";

/** Chunk upload progress for one attempt. */
export type ImportUploadProgress = { chunksSent: number; chunksTotal: number };

export type ImportExecutionRequest = {
  /** The settled review the person confirmed; selection and collision choices
   * are already resolved. */
  review: ImportReview;
  source: ImportSource;
  target: EligibleImportTarget;
  access: RootAccess;
  onProgress?: (progress: ImportUploadProgress) => void;
};

/**
 * The single internal operations seam. The production adapter wraps the
 * feature-local browser reads and staging transport; deterministic tests
 * control outcomes here. `openSession` must not retry on its own: a lost open
 * response is cleaned up through the browser-known ID instead.
 */
export type ImportExecutionOperations = {
  loadReplacementDocuments(
    access: RootAccess,
    targetKey: Uint8Array,
    review: ImportReview,
  ): Promise<ReadonlyMap<string, ImportReplacementDocument>>;
  importSigners(access: RootAccess): Promise<ImportSigners>;
  openSession(plan: ImportPlan, signal: AbortSignal): Promise<void>;
  uploadChunk(importId: string, chunk: ImportPlanChunk, signal: AbortSignal): Promise<void>;
  /** Resolve only for an acknowledged commit. Explicit rejections use
   * ImportError; ambiguous HTTP/shape failures use `commit-unconfirmed` (no
   * retry). Lost transport acknowledgments retain the existing single retry. */
  commit(importId: string, signal: AbortSignal): Promise<{ entriesRevision?: number }>;
  cancelSession(importId: string): Promise<void>;
};

/** Evidence-based result of one attempt. Cleanup never changes this outcome.
 * `unconfirmed` means commit may have run without an acknowledgment; neither
 * cleanup nor a refreshed Directory can establish this attempt's outcome.
 * `cancelled` stops client work before commit was attempted, not a staging
 * deletion guarantee. `error` carries a safe local/protocol rejection, or
 * `null` for other failures. */
export type ImportOutcome =
  | { status: "committed"; created: number; comments: number; entriesRevision?: number }
  | { status: "unconfirmed" }
  | { status: "cancelled" }
  | { status: "failed"; error: ImportError | null };

function collectSourceFiles(roots: readonly ImportSourceChild[]): Map<string, ImportSourceFile> {
  const files = new Map<string, ImportSourceFile>();
  const visit = (children: readonly ImportSourceChild[]): void => {
    for (const child of children) {
      if (child.kind === "file") files.set(child.path.join("/"), child);
      else visit(child.children);
    }
  };
  visit(roots);
  return files;
}

export class ImportExecution {
  private readonly controller = new AbortController();

  constructor(
    private readonly request: ImportExecutionRequest,
    private readonly operations: ImportExecutionOperations,
  ) {}

  /** Stop later stages and retries, including after an uninterruptible browser
   * calculation. Route disposal uses the same stop boundary; the adapter also
   * invalidates outcome delivery. Cleanup stays best effort, not rollback. */
  cancel(): void {
    this.controller.abort();
  }

  async run(): Promise<ImportOutcome> {
    const { review, source, target, access, onProgress } = this.request;
    let importId: string | null = null;
    let commitAttempted = false;
    let commitResponseLost = false;
    try {
      this.controller.signal.throwIfAborted();
      const replacements = await this.operations.loadReplacementDocuments(access, target.key, review);
      this.controller.signal.throwIfAborted();
      const signers = await this.operations.importSigners(access);
      this.controller.signal.throwIfAborted();
      const plan = await prepareImportPlan({
        review,
        files: collectSourceFiles(source.roots),
        comments: source.comments,
        targetKey: target.key,
        replacements,
        ...signers,
      });
      this.controller.signal.throwIfAborted();
      onProgress?.({ chunksSent: 0, chunksTotal: plan.chunks.length });
      this.controller.signal.throwIfAborted();
      // Retained before the open request: opening is not idempotent, so a lost
      // acknowledgment can only be cleaned up, never retried.
      importId = plan.importId;
      await this.operations.openSession(plan, this.controller.signal);
      this.controller.signal.throwIfAborted();
      for (const chunk of plan.chunks) {
        await this.retryOnce(() => this.operations.uploadChunk(plan.importId, chunk, this.controller.signal));
        this.controller.signal.throwIfAborted();
        onProgress?.({ chunksSent: chunk.sequence + 1, chunksTotal: plan.chunks.length });
      }
      const { entriesRevision } = await this.retryOnce(async () => {
        commitAttempted = true;
        try {
          return await this.operations.commit(plan.importId, this.controller.signal);
        } catch (error) {
          // A later rejected retry cannot rule out an earlier winning request.
          if (!(error instanceof ImportError) || error.code === "commit-unconfirmed") commitResponseLost = true;
          throw error;
        }
      });
      importId = null;
      return {
        status: "committed",
        created: review.counts.createFiles + review.counts.createDirectories + review.counts.replaces,
        comments: review.counts.comments,
        ...(entriesRevision === undefined ? {} : { entriesRevision }),
      };
    } catch (error) {
      // Classify before cleanup: a later abort or cleanup failure cannot turn
      // the primary rejection into a false cancellation acknowledgment.
      const failure: ImportOutcome = { status: "failed", error: error instanceof ImportError ? error : null };
      const outcome: ImportOutcome = commitAttempted
        ? commitResponseLost
          ? { status: "unconfirmed" }
          : failure
        : this.controller.signal.aborted
          ? { status: "cancelled" }
          : failure;
      if (importId) await this.cleanup(importId);
      return outcome;
    }
  }

  /** Best-effort staging cleanup; it never masks the primary outcome. */
  private async cleanup(importId: string): Promise<void> {
    try {
      await this.operations.cancelSession(importId);
    } catch {
      // The session expires unreachable; a cleanup failure is not evidence of
      // anything about the attempt itself.
    }
  }

  /** The existing bounded retry: one automatic retry at eligible failure
   * points while still active, always with the identical prepared request. */
  private async retryOnce<T>(request: () => Promise<T>): Promise<T> {
    this.controller.signal.throwIfAborted();
    try {
      return await request();
    } catch (error) {
      if (error instanceof ImportError || this.controller.signal.aborted) throw error;
      return await request();
    }
  }
}
