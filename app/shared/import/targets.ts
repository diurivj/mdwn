/**
 * Import target eligibility (ticket 29).
 *
 * An Import target is a Directory the initiating Account owns, or one reached
 * through a current read/write Directory Grant. The server's decrypted
 * `canCreate` flag is the same effective read/write authority the tree's
 * create path uses, so eligibility is decided from the already-decrypted
 * browser snapshot — never by inferring a parent from a direct File Grant.
 */

import type { ImportCollisionSibling, ImportListingEntry, ImportTarget } from "./review";

/** The subset of the decrypted Files snapshot that target eligibility reads. */
export type ImportScopeSnapshot = {
  access: {
    rootId: string;
    rootKind?: "file" | "directory";
    vaultId: string;
    actorAccountId: string;
  };
  listings: Record<
    string,
    {
      directoryId: string;
      keyEpoch?: number;
      entriesRevision: number;
      canCreate?: boolean;
      entries: readonly {
        nodeId: string;
        kind: "file" | "directory";
        name: string;
        nameCiphertext: string;
        orderCiphertext: string;
        keyEnvelope: string;
      }[];
    }
  >;
  keys: Record<string, Uint8Array>;
  file?: { parentId: string | null } | null;
};

export type EligibleImportTarget = ImportTarget & { key: Uint8Array };

function rootLabel(snapshot: ImportScopeSnapshot): string {
  return snapshot.access.rootKind === "file" ? "Shared File" : "Files";
}

/** Browser-local display labels for every Directory reachable in this snapshot. */
function labels(snapshot: ImportScopeSnapshot): Map<string, string> {
  const result = new Map<string, string>([[snapshot.access.rootId, rootLabel(snapshot)]]);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const listing of Object.values(snapshot.listings)) {
      const parent = result.get(listing.directoryId);
      if (parent === undefined) continue;
      for (const entry of listing.entries) {
        if (entry.kind !== "directory" || result.has(entry.nodeId)) continue;
        result.set(entry.nodeId, `${parent}/${entry.name}`);
        progressed = true;
      }
    }
  }
  return result;
}

/**
 * Every Directory in the current snapshot that the actor may add children to.
 * A direct File Grant exposes no parent Directory and a read-only Grant has
 * `canCreate: false`, so both are excluded without naming or inferring either.
 */
export function eligibleImportTargets(snapshot: ImportScopeSnapshot): EligibleImportTarget[] {
  const labelsById = labels(snapshot);
  const targets: EligibleImportTarget[] = [];
  for (const [directoryId, key] of Object.entries(snapshot.keys)) {
    const listing = snapshot.listings[directoryId];
    if (!listing || listing.canCreate !== true) continue;
    targets.push({
      directoryId,
      keyEpoch: listing.keyEpoch ?? 1,
      entriesRevision: listing.entriesRevision,
      ownerAccountId: snapshot.access.vaultId,
      actorAccountId: snapshot.access.actorAccountId,
      label: labelsById.get(directoryId) ?? directoryId,
      siblings: listing.entries.map(
        (entry): ImportCollisionSibling => ({
          nodeId: entry.nodeId,
          kind: entry.kind,
          name: entry.name,
        }),
      ),
      listing: listing.entries.map(
        (entry): ImportListingEntry => ({
          nodeId: entry.nodeId,
          kind: entry.kind,
          nameCiphertext: entry.nameCiphertext,
          orderCiphertext: entry.orderCiphertext,
          keyEnvelope: entry.keyEnvelope,
        }),
      ),
      key,
    });
  }
  targets.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.directoryId < b.directoryId ? -1 : 1));
  return targets;
}

/** The current context's target when it is eligible; never inferred from a File Grant. */
export function preferredImportTarget(
  snapshot: ImportScopeSnapshot,
  nodeId: string,
  kind: "file" | "directory",
): EligibleImportTarget | null {
  const targets = eligibleImportTargets(snapshot);
  const candidateId = kind === "directory" ? nodeId : (snapshot.file?.parentId ?? null);
  if (!candidateId) return null;
  return targets.find((target) => target.directoryId === candidateId) ?? null;
}

/** True when this snapshot is a direct File Grant with no parent Directory shown. */
