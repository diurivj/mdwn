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

import { PrivateAccessError, privateRequest } from "~/shared/device/private-client";
import { ImportError } from "./limits";
import type { ImportPlan, ImportPlanChunk } from "./plan";
import { encodeImportChunkBody, encodeImportSessionBody } from "./staging";

type SessionResponse = { importId?: unknown; error?: unknown };

function asImportError(response: Response, body: { error?: unknown }): ImportError {
  if (response.status === 409) return new ImportError("staging-changed");
  if (response.status === 410) return new ImportError("import-expired");
  return new ImportError("staging-upload-failed", { reason: typeof body.error === "string" ? body.error : undefined });
}

/** Confirmation step 1: create the unguessable, Account-bound session. The
 * acknowledgment must echo the plan's own Import ID (the Worker routes on it). */
export async function openImportSession(plan: ImportPlan, signal?: AbortSignal): Promise<void> {
  const body = encodeImportSessionBody(plan.manifest.metadata, plan.manifest.envelope);
  const response = await privateRequest("/api/private/imports", { method: "POST", body, signal });
  const parsed = (await response.json().catch(() => ({}))) as SessionResponse;
  if (!response.ok) throw asImportError(response, parsed);
  if (parsed.importId !== plan.importId) throw new ImportError("staging-upload-failed");
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
  let response: Response;
  try {
    response = await privateRequest(`/api/private/imports/${importId}/commit`, { method: "POST", signal });
  } catch (error) {
    // The private client distinguishes a definite authority rejection from a
    // lost/aborted request (`unavailable`). An earlier lost commit stays uncertain.
    if (error instanceof PrivateAccessError && error.state !== "unavailable") {
      throw new ImportError("staging-changed", { reason: error.state });
    }
    throw error;
  }
  // A server failure or unreadable/missing acknowledgment is not a rejection.
  // Keep HTTP/shape failures non-retryable, as before, without claiming rollback.
  if (response.status >= 500) throw new ImportError("commit-unconfirmed");
  const parsed: unknown = await response.json().catch(() => null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ImportError("commit-unconfirmed");
  if (!response.ok) {
    const protocolError = "error" in parsed ? parsed.error : null;
    const rejected =
      (response.status === 400 && protocolError === "invalid_import_request") ||
      (response.status === 404 && protocolError === "not_found") ||
      (response.status === 409 && (protocolError === "import_changed" || protocolError === "import_incomplete")) ||
      (response.status === 410 && protocolError === "import_expired");
    if (rejected) throw asImportError(response, { error: protocolError });
    throw new ImportError("commit-unconfirmed");
  }
  if (!("committed" in parsed) || parsed.committed !== true) throw new ImportError("commit-unconfirmed");
  return "entriesRevision" in parsed && typeof parsed.entriesRevision === "number"
    ? { entriesRevision: parsed.entriesRevision }
    : {};
}

/** Cancel an open session; the execution module treats this as best effort. */
export async function cancelImport(importId: string): Promise<void> {
  await privateRequest(`/api/private/imports/${importId}`, { method: "DELETE" });
}
