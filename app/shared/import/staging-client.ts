/**
 * Browser half of the Import staging protocol (ticket 30).
 *
 * One confirmed plan becomes: create session → upload 1–40 raw binary chunks
 * in order → commit once. The exact chunk bytes are the retry identity, so a
 * retried upload is safe; any mismatch fails the session and a fresh preflight
 * is required. Nothing here writes plaintext anywhere: the session body and
 * chunks are the already-encrypted plan bytes.
 */

import { privateRequest } from "~/shared/device/private-client";
import { ImportError } from "./limits";
import type { ImportPlan } from "./plan";
import { encodeImportChunkBody, encodeImportSessionBody } from "./staging";

export type ImportUploadProgress = { chunksSent: number; chunksTotal: number };

type SessionResponse = { importId?: unknown; expiresAt?: unknown; error?: unknown };
type CommitResponse = {
  importId?: unknown;
  committed?: unknown;
  alreadyCommitted?: unknown;
  entriesRevision?: unknown;
  error?: unknown;
};

function asImportError(response: Response, body: { error?: unknown }): ImportError {
  if (response.status === 409) return new ImportError("staging-changed");
  if (response.status === 410) return new ImportError("import-expired");
  return new ImportError("staging-upload-failed", { reason: typeof body.error === "string" ? body.error : undefined });
}

/** Confirmation step 1: create the unguessable, Account-bound session. */
export async function openImportSession(plan: ImportPlan, signal?: AbortSignal): Promise<string> {
  const body = encodeImportSessionBody(plan.manifest.metadata, plan.manifest.envelope);
  const response = await privateRequest("/api/private/imports", { method: "POST", body, signal });
  const parsed = (await response.json().catch(() => ({}))) as SessionResponse;
  if (!response.ok) throw asImportError(response, parsed);
  if (typeof parsed.importId !== "string") throw new ImportError("staging-upload-failed");
  return parsed.importId;
}

/** Confirmation step 2: upload every chunk in order; retries reuse exact bytes. */
export async function uploadImportChunks(
  plan: ImportPlan,
  importId: string,
  onProgress?: (progress: ImportUploadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  onProgress?.({ chunksSent: 0, chunksTotal: plan.chunks.length });
  for (const chunk of plan.chunks) {
    const body = encodeImportChunkBody(chunk.descriptors, chunk.payload);
    const path = `/api/private/imports/${importId}/chunks/${chunk.sequence}`;
    // A lost response leaves the chunk stored under the same exact bytes, so
    // one silent retry is safe and never creates a second record.
    const response = await retryOnce(() => privateRequest(path, { method: "PUT", body, signal }));
    if (!response.ok) {
      const parsed = (await response.json().catch(() => ({}))) as { error?: unknown };
      throw asImportError(response, parsed);
    }
    onProgress?.({ chunksSent: chunk.sequence + 1, chunksTotal: plan.chunks.length });
  }
}

async function retryOnce(request: () => Promise<Response>): Promise<Response> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof ImportError) throw error;
    return await request();
  }
}

/** Confirmation step 3: the atomic visibility commit (idempotent for a session). */
export async function commitImport(importId: string, signal?: AbortSignal): Promise<{ entriesRevision?: number }> {
  const response = await retryOnce(() =>
    privateRequest(`/api/private/imports/${importId}/commit`, { method: "POST", signal }),
  );
  const parsed = (await response.json().catch(() => ({}))) as CommitResponse;
  if (!response.ok) throw asImportError(response, parsed);
  if (parsed.committed !== true) throw new ImportError("staging-upload-failed");
  return typeof parsed.entriesRevision === "number" ? { entriesRevision: parsed.entriesRevision } : {};
}

/** Cancel an open session; a failure never masks the original error. */
export async function cancelImport(importId: string): Promise<void> {
  try {
    await privateRequest(`/api/private/imports/${importId}`, { method: "DELETE" });
  } catch {
    /* Cleanup is best effort; the session expires unreachable. */
  }
}
