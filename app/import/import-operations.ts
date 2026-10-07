import { importSigners, loadReplacementDocuments } from "~/shared/import/browser";
import type { ImportExecutionOperations } from "~/shared/import/execution";
import { cancelImport, commitImport, openImportSession, uploadImportChunk } from "~/shared/import/staging-client";

/**
 * Production implementation of the Import execution module's internal
 * operations seam. It wraps the shared browser reads and the one-request
 * staging transport unchanged; the execution module never imports it.
 */
export function createImportOperations(): ImportExecutionOperations {
  return {
    loadReplacementDocuments,
    importSigners,
    openSession: openImportSession,
    uploadChunk: uploadImportChunk,
    commit: commitImport,
    cancelSession: cancelImport,
  };
}
