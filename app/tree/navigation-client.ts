import { privateRequest } from "~/device/private-client";
import { getDevice } from "~/device/store";
import { openGrantKeyEnvelope, type GrantKeyContext } from "~/sharing/grant-keys";
import {
  loadAncestors, loadDirectory, loadFile, openChildDirectory, openRoot, TreeNotFoundError,
  type DirectoryListing, type RootAccess, type TreeKind,
} from "./client";

export type Crumb = { id: string; name: string };
export type FilesSnapshot = {
  access: RootAccess;
  listings: Record<string, DirectoryListing>;
  keys: Record<string, Uint8Array>;
  crumbs: Crumb[];
  file: Awaited<ReturnType<typeof loadFile>> | null;
};
export type FilesPageData = { status: "ready"; snapshot: FilesSnapshot } |
  { status: "not-found" | "unavailable" | "provisioning"; snapshot: null };

export class SharedContentProvisioningError extends Error {
  constructor() { super("Shared content is being securely provisioned"); }
}
type ReceivedGrant = { grantId: string; ownerId: string; recipientId: string; targetId: string;
  targetKind: TreeKind; permission: string; revision: number; keyEpoch: number };

/** Current proof-guarded relationship reads precede HPKE; old signed registry epochs remain valid. */
export async function openReceivedGrantRoot(owned: RootAccess, targetId: string, signal: AbortSignal): Promise<RootAccess> {
  const actorAccountId = owned.actorAccountId;
  const device = await getDevice(actorAccountId);
  if (!device) throw new Error("private tree unavailable");
  let cursor: string | null = null;
  const seen = new Set<string>();
  let provisioning = false;
  do {
    const response = await privateRequest(`/api/private/grants${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      { method: "POST", signal });
    if (!response.ok) throw new Error("private tree unavailable");
    const page = await response.json() as { received: ReceivedGrant[]; nextCursor: string | null };
    if (!Array.isArray(page.received) || page.received.length > 100) throw new Error("invalid Grants page");
    for (const grant of page.received) {
      if (grant.targetId !== targetId || grant.recipientId !== actorAccountId) continue;
      const keys = await privateRequest(`/api/private/grants/${grant.grantId}/keys`, { method: "POST", signal });
      if (keys.status === 409) { provisioning = true; continue; }
      if (keys.status === 404) continue;
      if (!keys.ok) throw new Error("private tree unavailable");
      const envelope = await keys.json() as GrantKeyContext & { deviceId: string; signerDeviceId: string;
        signerPublicKey: string; ciphertext: string; signature: string };
      if (envelope.relationshipId !== grant.grantId || envelope.ownerId !== grant.ownerId ||
          envelope.recipientId !== actorAccountId || envelope.targetId !== targetId ||
          envelope.targetKind !== grant.targetKind || envelope.grantKeyEpoch !== grant.keyEpoch ||
          envelope.deviceId !== device.deviceId || (grant.targetKind === "directory" &&
            (envelope.capabilityId !== targetId || envelope.capabilityEpoch !== 1))) throw new Error("invalid Grant scope");
      const rootKey = await openGrantKeyEnvelope({ ...envelope, recipient: device.transportKeyPair });
      return { actorAccountId, vaultId: grant.ownerId, rootId: targetId, rootKind: grant.targetKind, rootKey,
        capability: { id: envelope.capabilityId, epoch: envelope.capabilityEpoch } };
    }
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (typeof cursor !== "string" || seen.has(cursor)) throw new Error("invalid Grants cursor");
      seen.add(cursor);
    }
  } while (cursor);
  if (provisioning) throw new SharedContentProvisioningError();
  throw new TreeNotFoundError();
}

export const expandedPreferenceKey = (accountId: string) => `mdwn:files-expanded:${accountId}`;
export function savedExpanded(accountId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(expandedPreferenceKey(accountId)) ?? "[]");
    return Array.isArray(parsed) ? parsed.slice(0, 200).filter((value): value is string => typeof value === "string") : [];
  } catch { return []; }
}

async function selectedPath(nodeId: string, kind: TreeKind, signal: AbortSignal): Promise<FilesSnapshot> {
  let access = await openRoot(signal);
  const path = await loadAncestors(nodeId, signal);
  if (path[0] !== access.rootId) access = await openReceivedGrantRoot(access, path[0]!, signal);
  if (access.rootKind === "file" && (kind !== "file" || path.length !== 1)) throw new TreeNotFoundError();
  const listings: Record<string, DirectoryListing> = {};
  const keys: Record<string, Uint8Array> = { [access.rootId]: access.rootKey };
  const crumbs: Crumb[] = [{ id: access.rootId, name: access.rootKind === "file" ? "Shared File" : "Files" }];
  let file: FilesSnapshot["file"] = null;
  for (let index = 0; index < path.length; index++) {
    const parent = path[index]!;
    // A File is the final path member, not a Directory with a capability.
    if (index === path.length - 1 && kind === "file") break;
    const key = keys[parent];
    if (!key) throw new TreeNotFoundError();
    const listing = await loadDirectory(access, parent, key, signal);
    listings[parent] = listing;
    const next = path[index + 1];
    if (!next) continue;
    const entry = listing.entries.find((child) => child.nodeId === next);
    if (!entry || (index < path.length - 2 && entry.kind !== "directory") ||
        (index === path.length - 2 && entry.kind !== kind)) throw new TreeNotFoundError();
    crumbs.push({ id: next, name: entry.name });
    if (entry.kind === "directory") keys[next] = await openChildDirectory(access, key, entry);
  }
  if (kind === "file") {
    const parent = path.at(-2);
    if (access.rootKind === "file") {
      file = await loadFile(access, nodeId, access.rootKey, signal);
    } else {
      if (!parent || !keys[parent]) throw new TreeNotFoundError();
      file = await loadFile(access, nodeId, keys[parent], signal);
      if (file.parentId !== parent) throw new TreeNotFoundError();
    }
  }
  // Preferences are browser-only, never encoded in a deep link. Restore only
  // descendants discoverable through a decrypted Directory in this Account.
  const pending = new Set(savedExpanded(access.actorAccountId));
  for (let pass = 0; pass < 201 && pending.size; pass++) {
    let progressed = false;
    for (const id of pending) {
      if (listings[id]) { pending.delete(id); continue; }
      const parent = Object.values(listings).find((listing) => listing.entries.some((entry) => entry.nodeId === id));
      const entry = parent?.entries.find((item) => item.nodeId === id);
      if (!parent || !entry || entry.kind !== "directory" || !keys[parent.directoryId]) continue;
      pending.delete(id);
      try {
        const key = await openChildDirectory(access, keys[parent.directoryId], entry);
        keys[id] = key;
        listings[id] = await loadDirectory(access, id, key, signal);
        progressed = true;
      } catch { /* An old local preference must not block opening the selected object. */ }
    }
    if (!progressed) break;
  }
  return { access, listings, keys, crumbs, file };
}

/** Browser-only clientLoader data; SSR renders a public HydrateFallback instead. */
export async function loadFilesPage(nodeId: string, kind: TreeKind, signal: AbortSignal): Promise<FilesPageData> {
  try { return { status: "ready", snapshot: await selectedPath(nodeId, kind, signal) }; }
  catch (error) {
    if (signal.aborted) throw error;
    return { status: error instanceof SharedContentProvisioningError ? "provisioning" :
      error instanceof TreeNotFoundError ? "not-found" : "unavailable", snapshot: null };
  }
}
