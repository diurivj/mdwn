/**
 * Browser half of the Import staging protocol (ticket 30).
 *
 * One confirmed plan becomes: create session → upload 1–40 raw binary chunks
 * in order → commit once. Each function issues exactly one request: the
 * execution module owns orchestration and the existing bounded retry, so a
 * retried upload reuses the exact prepared chunk bytes and Import identity.
 * Nothing here writes plaintext anywhere: the session body and chunks are the
 * already-encrypted plan bytes.
 */

import { privateRequest } from "~/shared/device/private-client";
import { ImportError } from "./limits";
import type { ImportPlan, ImportPlanChunk } from "./plan";
import { encodeImportChunkBody, encodeImportSessionBody } from "./staging";

type SessionResponse = { importId?: unknown; error?: unknown };
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
export async function openImportSession(plan: ImportPlan, signal?: AbortSignal): Promise<void> {
  const body = encodeImportSessionBody(plan.manifest.metadata, plan.manifest.envelope);
  const response = await privateRequest("/api/private/imports", { method: "POST", body, signal });
  const parsed = (await response.json().catch(() => ({}))) as SessionResponse;
  if (!response.ok) throw asImportError(response, parsed);
  if (typeof parsed.importId !== "string") throw new ImportError("staging-upload-failed");
}

/** Confirmation step 2: upload one exact chunk; a retry reuses these bytes. */
export async function uploadImportChunk(importId: string, chunk: ImportPlanChunk, signal?: AbortSignal): Promise<void> {
  const body = encodeImportChunkBody(chunk.descriptors, chunk.payload);
  const response = await privateRequest(`/api/private/imports/${importId}/chunks/${chunk.sequence}`, {
    method: "PUT",
    body,
    signal,
  });
  if (!response.ok) {
    const parsed = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw asImportError(response, parsed);
  }
}

/** Confirmation step 3: the atomic visibility commit (idempotent for a session). */
export async function commitImport(importId: string, signal?: AbortSignal): Promise<{ entriesRevision?: number }> {
  const response = await privateRequest(`/api/private/imports/${importId}/commit`, { method: "POST", signal });
  const parsed = (await response.json().catch(() => ({}))) as CommitResponse;
  if (!response.ok) throw asImportError(response, parsed);
  if (parsed.committed !== true) throw new ImportError("staging-upload-failed");
  return typeof parsed.entriesRevision === "number" ? { entriesRevision: parsed.entriesRevision } : {};
}

/** Cancel an open session; the execution module treats this as best effort. */
export async function cancelImport(importId: string): Promise<void> {
  await privateRequest(`/api/private/imports/${importId}`, { method: "DELETE" });
}
