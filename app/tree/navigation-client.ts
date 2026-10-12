import { privateRequest } from "~/shared/device/private-client";
import { getDevice } from "~/shared/device/store";
import { openGrantKeyEnvelope, type GrantKeyContext } from "~/shared/sharing/grant-keys";
import {
  fetchDirectory,
  fetchFile,
  loadAncestors,
  loadDirectory,
  type loadFile,
  openChildDirectory,
  openDirectory,
  openFile,
  openRoot,
  TreeNotFoundError,
  type DirectoryListing,
  type RootAccess,
  type TreeKind,
} from "../shared/tree/client";

export type Crumb = { id: string; name: string };
export type FilesSnapshot = {
  access: RootAccess;
  listings: Record<string, DirectoryListing>;
  keys: Record<string, Uint8Array>;
  crumbs: Crumb[];
  file: Awaited<ReturnType<typeof loadFile>> | null;
};
export type FilesPageData =
  | { status: "ready"; snapshot: FilesSnapshot }
  | { status: "not-found" | "unavailable" | "provisioning"; snapshot: null };

export class SharedContentProvisioningError extends Error {
  constructor() {
    super("Shared content is being securely provisioned");
  }
}
type ReceivedGrant = {
  grantId: string;
  ownerId: string;
  recipientId: string;
  targetId: string;
  targetKind: TreeKind;
  permission: string;
  revision: number;
  keyEpoch: number;
};

/** Current proof-guarded relationship reads precede HPKE; old signed registry epochs remain valid. */
export async function openReceivedGrantRoot(
  owned: RootAccess,
  targetId: string,
  signal: AbortSignal,
): Promise<RootAccess> {
  const actorAccountId = owned.actorAccountId;
  const device = await getDevice(actorAccountId);
  if (!device) throw new Error("private tree unavailable");
  let cursor: string | null = null;
  const seen = new Set<string>();
  let provisioning = false;
  do {
    const response = await privateRequest(
      `/api/private/grants${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      { method: "POST", signal },
    );
    if (!response.ok) throw new Error("private tree unavailable");
    const page = (await response.json()) as { received: ReceivedGrant[]; nextCursor: string | null };
    if (!Array.isArray(page.received) || page.received.length > 100) throw new Error("invalid Grants page");
    for (const grant of page.received) {
      if (grant.targetId !== targetId || grant.recipientId !== actorAccountId) continue;
      const keys = await privateRequest(`/api/private/grants/${grant.grantId}/keys`, { method: "POST", signal });
      if (keys.status === 409) {
        provisioning = true;
        continue;
      }
      if (keys.status === 404) continue;
      if (!keys.ok) throw new Error("private tree unavailable");
      const envelope = (await keys.json()) as GrantKeyContext & {
        deviceId: string;
        signerDeviceId: string;
        signerPublicKey: string;
        ciphertext: string;
        signature: string;
      };
      if (
        envelope.relationshipId !== grant.grantId ||
        envelope.ownerId !== grant.ownerId ||
        envelope.recipientId !== actorAccountId ||
        envelope.targetId !== targetId ||
        envelope.targetKind !== grant.targetKind ||
        envelope.grantKeyEpoch !== grant.keyEpoch ||
        envelope.deviceId !== device.deviceId ||
        (grant.targetKind === "directory" &&
          (envelope.capabilityId !== targetId ||
            !Number.isSafeInteger(envelope.capabilityEpoch) ||
            envelope.capabilityEpoch < 1))
      )
        throw new Error("invalid Grant scope");
      const rootKey = await openGrantKeyEnvelope({ ...envelope, recipient: device.transportKeyPair });
      return {
        actorAccountId,
        vaultId: grant.ownerId,
        rootId: targetId,
        rootKind: grant.targetKind,
        rootKey,
        actorVaultRootKey: owned.actorVaultRootKey,
        capability: { id: envelope.capabilityId, epoch: envelope.capabilityEpoch },
      };
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
    return Array.isArray(parsed)
      ? parsed.slice(0, 200).filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * The workspace root's name: the person's own library, or the folder or File
 * another Account shared with them.
 */
export function rootName(access: RootAccess): string {
  if (access.rootKind === "file") return "Shared File";
  return access.vaultId === access.actorAccountId ? "Library" : "Shared folder";
}

/** `/files` is the library's own address; shared roots keep their node routes. */
export function nodePath(access: RootAccess, nodeId: string, kind: TreeKind): string {
  if (kind === "directory" && nodeId === access.rootId && access.vaultId === access.actorAccountId) return "/files";
  return `/${kind === "directory" ? "d" : "f"}/${nodeId}`;
}

/** Start a read now and observe its failure only when it is awaited, in the order a sequential walk would. */
function prefetch<T>(read: Promise<T>): Promise<T> {
  read.catch(() => {});
  return read;
}

/** Remembered folders fetched alongside the selected path; any beyond this load level by level. */
const EXPANDED_PREFETCH = 24;

/**
 * Every request is a full network round trip, so the walk sends independent
 * requests together: the root and the path at once, then every Directory
 * listing on the path with the File and the remembered expanded folders.
 * Keys still open strictly down the path, each verified listing yielding the
 * next key, and failures surface in the order the walk reaches them. A null
 * target opens the Account's own library root, which needs no path read.
 */
async function selectedPath(
  target: { nodeId: string; kind: TreeKind } | null,
  signal: AbortSignal,
  root: Promise<RootAccess> = prefetch(openRoot(signal)),
): Promise<FilesSnapshot> {
  let path: string[];
  let access: RootAccess;
  if (target) {
    try {
      path = await loadAncestors(target.nodeId, signal);
    } catch (error) {
      await root; // An unavailable root explains the failure before an unknown path does.
      throw error;
    }
    access = await root;
    if (path[0] !== access.rootId) access = await openReceivedGrantRoot(access, path[0]!, signal);
  } else {
    access = await root;
    path = [access.rootId];
  }
  const nodeId = target?.nodeId ?? access.rootId;
  const kind = target?.kind ?? "directory";
  if (access.rootKind === "file" && (kind !== "file" || path.length !== 1)) throw new TreeNotFoundError();
  const directories = new Map(
    (kind === "file" ? path.slice(0, -1) : path).map((id) => [id, prefetch(fetchDirectory(id, signal))]),
  );
  const fetchedFile = kind === "file" ? prefetch(fetchFile(nodeId, signal)) : null;
  // Fetching ciphertext early opens nothing: the restore below still decrypts
  // only folders that a verified listing reveals.
  const remembered = savedExpanded(access.actorAccountId);
  const early = new Map(
    remembered
      .filter((id) => !directories.has(id))
      .slice(0, EXPANDED_PREFETCH)
      .map((id) => [id, prefetch(fetchDirectory(id, signal))]),
  );
  const listings: Record<string, DirectoryListing> = {};
  const keys: Record<string, Uint8Array> = { [access.rootId]: access.rootKey };
  const crumbs: Crumb[] = [{ id: access.rootId, name: rootName(access) }];
  let file: FilesSnapshot["file"] = null;
  for (let index = 0; index < path.length; index++) {
    const parent = path[index]!;
    // A File is the final path member, not a Directory with a capability.
    if (index === path.length - 1 && kind === "file") break;
    const key = keys[parent];
    if (!key) throw new TreeNotFoundError();
    const listing = await openDirectory(access, parent, key, await directories.get(parent)!);
    listings[parent] = listing;
    const next = path[index + 1];
    if (!next) continue;
    const entry = listing.entries.find((child) => child.nodeId === next);
    if (
      !entry ||
      (index < path.length - 2 && entry.kind !== "directory") ||
      (index === path.length - 2 && entry.kind !== kind)
    )
      throw new TreeNotFoundError();
    crumbs.push({ id: next, name: entry.name });
    if (entry.kind === "directory") keys[next] = await openChildDirectory(access, key, entry);
  }
  if (fetchedFile) {
    const parent = path.at(-2);
    if (access.rootKind === "file") {
      file = await openFile(access, nodeId, access.rootKey, await fetchedFile);
    } else {
      if (!parent || !keys[parent]) throw new TreeNotFoundError();
      file = await openFile(access, nodeId, keys[parent], await fetchedFile);
      if (file.parentId !== parent) throw new TreeNotFoundError();
    }
  }
  // Preferences are browser-only, never encoded in a deep link. Restore only
  // descendants discoverable through a decrypted Directory in this Account,
  // one level per pass, with each level's Directories opened together.
  const pending = new Set(remembered);
  for (let pass = 0; pass < 201 && pending.size; pass++) {
    const level: Promise<boolean>[] = [];
    for (const id of pending) {
      if (listings[id]) {
        pending.delete(id);
        continue;
      }
      const parent = Object.values(listings).find((listing) => listing.entries.some((entry) => entry.nodeId === id));
      const entry = parent?.entries.find((item) => item.nodeId === id);
      const parentKey = parent && keys[parent.directoryId];
      if (!entry || entry.kind !== "directory" || !parentKey) continue;
      pending.delete(id);
      level.push(
        (async () => {
          try {
            const key = await openChildDirectory(access, parentKey, entry);
            keys[id] = key;
            const fetched = early.get(id);
            listings[id] = fetched
              ? await openDirectory(access, id, key, await fetched)
              : await loadDirectory(access, id, key, signal);
            return true;
          } catch {
            return false; // An old local preference must not block opening the selected object.
          }
        })(),
      );
    }
    if (!(await Promise.all(level)).some(Boolean)) break;
  }
  return { access, listings, keys, crumbs, file };
}

/** Browser-only clientLoader data; SSR renders a public HydrateFallback instead. */
export function loadFilesPage(nodeId: string, kind: TreeKind, signal: AbortSignal): Promise<FilesPageData> {
  return settle(selectedPath({ nodeId, kind }, signal), signal);
}

/**
 * The Account's own library root, opened by its bootstrap without a separate
 * path read. A bootstrap that fails is reported as `access`: the Session or
 * this browser's Encryption device needs attention, not the library.
 */
export async function loadLibraryPage(
  signal: AbortSignal,
): Promise<FilesPageData | { status: "access"; snapshot: null }> {
  const root = prefetch(openRoot(signal));
  try {
    await root;
  } catch (error) {
    if (signal.aborted) throw error;
    return { status: "access", snapshot: null };
  }
  return settle(selectedPath(null, signal, root), signal);
}

async function settle(walk: Promise<FilesSnapshot>, signal: AbortSignal): Promise<FilesPageData> {
  try {
    return { status: "ready", snapshot: await walk };
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      status:
        error instanceof SharedContentProvisioningError
          ? "provisioning"
          : error instanceof TreeNotFoundError
            ? "not-found"
            : "unavailable",
      snapshot: null,
    };
  }
}
