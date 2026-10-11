/** Ownership, cleanup and identifier-only reporting shared by operational commands. */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSensitive } from "./restore-cli-support.mjs";
import { privateErrorDetails, publicErrorMessage, PublicOperationalError } from "./script-errors.mjs";

/**
 * @param {{ label: string, keep?: boolean, report?: (message: string) => void }} options
 */
export function createScriptLifecycle({ label, keep = false, report = console.log }) {
  /** @type {Array<{ kind: string, name: string, id: string | null, ownership: "pending" | "owned" | "borrowed", remove: () => void }>} */
  const resources = [];
  /** @type {Array<{ path: string, retain: boolean, retainOnFailure: boolean }>} */
  const artifacts = [];
  return {
    /** Register BEFORE creation: uncertain outcomes are never deletion authority.
     * @param {{ kind: string, name: string, remove: () => void }} resource
     */
    pendingResource(resource) {
      /** @type {(typeof resources)[number]} */
      const entry = { ...resource, id: null, ownership: "pending" };
      resources.push(entry);
      return {
        /** @param {string} id */
        created(id) {
          if (!id) throw new Error("A created resource requires a confirmed identifier");
          entry.id = id;
          entry.ownership = "owned";
        },
      };
    },
    /** @param {{ kind: string, name: string, id: string }} resource */
    borrowedResource(resource) {
      resources.push({ ...resource, ownership: "borrowed", remove() {} });
    },
    /** @param {string} path @param {{ retain?: boolean, retainOnFailure?: boolean }} [options] */
    artifact(path, { retain = false, retainOnFailure = true } = {}) {
      artifacts.push({ path, retain, retainOnFailure });
    },
    /** Finish every cleanup attempt before the command chooses its exit code.
     * @param {unknown} [operationalError]
     */
    finish(operationalError = null) {
      /** @type {Array<{ identity: string, error: unknown }>} */
      const cleanupErrors = [];
      let unresolved = false;
      // Helpers aggregate a primary failure (cause) with cleanup/reporting errors.
      // Keep the primary error visible rather than replacing it with a summary.
      const primary =
        operationalError instanceof AggregateError && "cause" in operationalError
          ? operationalError.cause
          : operationalError;
      if (operationalError) {
        report(`✘ ${label} failed: ${publicErrorMessage(primary)}`);
      }
      if (operationalError instanceof AggregateError && "cause" in operationalError) {
        for (const error of operationalError.errors.filter((error) => error !== primary)) {
          cleanupErrors.push({ identity: `${label} helper cleanup/reporting`, error });
          report(`✘ Cleanup/reporting failed: ${publicErrorMessage(error)}`);
        }
      }
      for (const resource of [...resources].reverse()) {
        const identity = `${resource.kind} ${resource.name}${resource.id ? ` (${resource.id})` : " (identifier unresolved)"}`;
        if (resource.ownership === "pending") {
          unresolved = true;
          report(
            `Unresolved creation: ${identity}; inspect the provider before any manual deletion. No deletion attempted.`,
          );
        } else if (resource.ownership === "borrowed") {
          report(`Borrowed resource left untouched: ${identity} (not owned by this run).`);
        } else if (keep) {
          report(`Kept resource by explicit request: ${identity}.`);
        } else {
          try {
            resource.remove();
            report(`✓ Deleted ${identity}`);
          } catch (error) {
            cleanupErrors.push({ identity, error });
            report(`✘ Cleanup failed: ${identity}; ${publicErrorMessage(error)}`);
            report(`Surviving resource: ${identity}; manual cleanup required.`);
          }
        }
      }
      // Decide retention once; a failed removal must not skip remaining removals.
      const failed = Boolean(operationalError) || unresolved || cleanupErrors.length > 0;
      for (const artifact of [...artifacts].reverse()) {
        if (!existsSync(artifact.path)) continue;
        if (artifact.retain || keep || (failed && artifact.retainOnFailure)) {
          report(
            `Retained sensitive artifact: ${artifact.path} (${artifact.retain ? "operator output" : keep ? "explicit request" : "failure diagnosis"}); trash it when finished: trash '${artifact.path.replaceAll("'", "'\\''")}'`,
          );
          continue;
        }
        try {
          rmSync(artifact.path, { recursive: true, force: true });
          report(`✓ Removed temporary artifact: ${artifact.path}`);
        } catch (error) {
          cleanupErrors.push({ identity: artifact.path, error });
          report(`✘ Cleanup failed: ${artifact.path}; ${publicErrorMessage(error)}`);
          report(
            `Retained sensitive artifact: ${artifact.path} (cleanup failure); trash it when finished: trash '${artifact.path.replaceAll("'", "'\\''")}'`,
          );
        }
      }
      if (
        (operationalError && !(primary instanceof PublicOperationalError)) ||
        cleanupErrors.some(({ error }) => !(error instanceof PublicOperationalError))
      ) {
        let directory = null;
        try {
          directory = mkdtempSync(join(tmpdir(), "mdwn-operation-diagnostics-"));
          const path = join(directory, "lifecycle-diagnostics.json");
          writeSensitive(
            path,
            JSON.stringify(
              {
                operation: label,
                operationalError: operationalError ? privateErrorDetails(operationalError) : null,
                cleanupErrors: cleanupErrors.map(({ identity, error }) => ({
                  identity,
                  error: privateErrorDetails(error),
                })),
              },
              null,
              2,
            ),
          );
          report(
            `Retained sensitive artifact: ${path} (failure diagnosis); trash it when finished: trash '${directory.replaceAll("'", "'\\''")}'`,
          );
        } catch (error) {
          cleanupErrors.push({ identity: "private failure diagnostics", error });
          report("✘ Cleanup/reporting failed: could not write private failure diagnostics.");
          if (directory)
            report(
              `Retained sensitive artifact: ${directory}; trash it when finished: trash '${directory.replaceAll("'", "'\\''")}'`,
            );
        }
      }
      return {
        ok: !operationalError && !unresolved && cleanupErrors.length === 0,
        operationalError: primary,
        cleanupErrors,
      };
    },
  };
}
