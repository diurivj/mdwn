import { ownedProvisioningUpkeep } from "~/shared/device/owned-provision-client";
import { deviceStateGeneration, privateRequest } from "~/shared/device/private-client";
import { getDevice } from "~/shared/device/store";
import { openGrantKeyEnvelope, type GrantKeyContext } from "~/shared/sharing/grant-keys";
import {
  type Crumb,
  EXPANDED_CHECKED,
  keyOpenedFrom,
  kindName,
  mergeListings,
  pathCrumbs,
  pathStep,
  restorableFolders,
  rootAccepts,
  rootName,
  sharedRootName,
} from "~/shared/tree/path-rules";
import { treeCache } from "~/shared/tree/tab-tree-cache";
import type { OpenedKey, VerifiedListing } from "~/shared/tree/verified-tree-cache";
import {
  fetchDirectory,
  fetchFile,
  loadAncestors,
  type FetchedDirectory,
  type loadFile,
  openChildDirectory,
  openDirectory,
  openFile,
  openRoot,
  rememberListing,
  TreeNotFoundError,
  type DirectoryListing,
  type RootAccess,
  type TreeKind,
} from "../shared/tree/client";

export { kindName, rootName, sharedRootName, type Crumb };
export type FilesSnapshot = {
  access: RootAccess;
  listings: Record<string, DirectoryListing>;
  keys: Record<string, Uint8Array>;
  crumbs: Crumb[];
  file: Awaited<ReturnType<typeof loadFile>> | null;
};
export type FilesPageData =
  /** `fromMemory`: rebuilt from this tab's verified tree memory; the page revalidates it in the background. */
  | { status: "ready"; snapshot: FilesSnapshot; fromMemory?: boolean }
  | { status: "not-found" | "unavailable" | "provisioning"; snapshot: null };
/** The library root's page: `handOff`, on a memory render, says whether to leave for device access. */
export type LibraryPageData = (FilesPageData & { handOff?: Promise<boolean> }) | { status: "access"; snapshot: null };

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

/** `/files` is the library's own address; shared roots keep their node routes. */
export function nodePath(access: RootAccess, nodeId: string, kind: TreeKind): string {
  if (kind === "directory" && nodeId === access.rootId && access.vaultId === access.actorAccountId) return "/files";
  return sharedTargetPath(nodeId, kind);
}

/** A node's own route, as used for a shared target from either side of a Share or Grant. */
export function sharedTargetPath(nodeId: string, kind: TreeKind): string {
  return `/${kind === "directory" ? "d" : "f"}/${nodeId}`;
}

/** Start a read now and observe its failure only when it is awaited, in the order a sequential walk would. */
function prefetch<T>(read: Promise<T>): Promise<T> {
  read.catch(() => {});
  return read;
}

type Target = { nodeId: string; kind: TreeKind } | null;
/** What a walk has verified and opened: each listing with its head digest, and the keys down to it. */
type Opened = { verified: Record<string, VerifiedListing>; keys: Record<string, Uint8Array> };

function listingsOf(verified: Readonly<Record<string, VerifiedListing>>): Record<string, DirectoryListing> {
  return Object.fromEntries(Object.entries(verified).map(([id, item]) => [id, item.listing]));
}

/** The keys a walk records, each with the epoch of the entry it was opened from in that walk's own listings. */
function recordedKeys(access: RootAccess, opened: Opened): Record<string, OpenedKey> {
  const listings = listingsOf(opened.verified);
  const keys: Record<string, OpenedKey> = {};
  for (const [id, key] of Object.entries(opened.keys)) {
    const source = id === access.rootId ? null : keyOpenedFrom(listings, id);
    if (source) keys[id] = { key, epoch: source.epoch };
  }
  return keys;
}

/**
 * Every request is a full network round trip, so the walk sends independent
 * requests together: the root and the path at once, then every Directory
 * listing on the path with the File and the remembered expanded folders.
 * Keys still open strictly down the path, each verified listing yielding the
 * next key, and failures surface in the order the walk reaches them. A null
 * target opens the Account's own library root, which needs no path read.
 */
async function selectedPath(
  target: Target,
  signal: AbortSignal,
  root: Promise<RootAccess> = prefetch(openRoot(signal)),
): Promise<{ snapshot: FilesSnapshot; verified: Record<string, VerifiedListing> }> {
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
  if (!rootAccepts(access, path, kind)) throw new TreeNotFoundError();
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
      .slice(0, EXPANDED_CHECKED)
      .map((id) => [id, prefetch(fetchDirectory(id, signal))]),
  );
  const opened: Opened = { verified: {}, keys: { [access.rootId]: access.rootKey } };
  for (const [index, parent] of (kind === "file" ? path.slice(0, -1) : path).entries()) {
    const key = opened.keys[parent];
    if (!key) throw new TreeNotFoundError();
    opened.verified[parent] = await verify(access, parent, key, await directories.get(parent)!);
    if (index === path.length - 1) continue;
    const entry = pathStep(opened.verified[parent].listing, path, index, kind);
    if (!entry) throw new TreeNotFoundError();
    if (entry.kind === "directory") opened.keys[entry.nodeId] = await openChildDirectory(access, key, entry);
  }
  const crumbs = pathCrumbs(access, path, listingsOf(opened.verified), kind);
  if (!crumbs) throw new TreeNotFoundError();
  let file: FilesSnapshot["file"] = null;
  if (fetchedFile) {
    const parent = path.at(-2);
    if (access.rootKind === "file") {
      file = await openFile(access, nodeId, access.rootKey, await fetchedFile);
    } else {
      if (!parent || !opened.keys[parent]) throw new TreeNotFoundError();
      file = await openFile(access, nodeId, opened.keys[parent], await fetchedFile);
      if (file.parentId !== parent) throw new TreeNotFoundError();
    }
  }
  await restoreExpanded(access, opened, remembered, early, signal);
  return {
    snapshot: { access, listings: listingsOf(opened.verified), keys: opened.keys, crumbs, file },
    verified: opened.verified,
  };
}

/** Verify and open a fetched listing, keeping the head digest it was verified against. */
async function verify(
  access: RootAccess,
  directoryId: string,
  key: Uint8Array,
  fetched: FetchedDirectory,
): Promise<VerifiedListing> {
  return { listing: await openDirectory(access, directoryId, key, fetched), digest: fetched.listingHead?.digest ?? "" };
}

/** Open remembered expanded folders level by level, each level together, by the shared restore rule. */
async function restoreExpanded(
  access: RootAccess,
  opened: Opened,
  remembered: readonly string[],
  early: ReadonlyMap<string, Promise<FetchedDirectory>>,
  signal: AbortSignal,
): Promise<void> {
  const pending = new Set(remembered);
  for (let pass = 0; pass < 201 && pending.size; pass++) {
    const level = restorableFolders(pending, listingsOf(opened.verified), opened.keys);
    const results = await Promise.all(
      level.map(async ({ id, entry, parentId }) => {
        try {
          const key = await openChildDirectory(access, opened.keys[parentId]!, entry);
          opened.verified[id] = await verify(access, id, key, await (early.get(id) ?? fetchDirectory(id, signal)));
          opened.keys[id] = key;
          return true;
        } catch {
          return false; // An old local preference must not block opening the selected object.
        }
      }),
    );
    if (!results.some(Boolean)) break;
  }
}

/** A cold walk, kept in this tab's memory when device state has not changed since it started. */
async function walk(target: Target, signal: AbortSignal, root?: Promise<RootAccess>) {
  const since = deviceStateGeneration();
  const { snapshot, verified } = await selectedPath(target, signal, root);
  treeCache.record(
    {
      access: snapshot.access,
      listings: verified,
      keys: recordedKeys(snapshot.access, { verified, keys: snapshot.keys }),
    },
    since,
  );
  return snapshot;
}

/**
 * The page from this tab's verified tree memory, or null when the root and
 * the target's path are not all remembered. A Directory needs no request; a
 * File's content is still fetched and opened with the remembered parent key.
 * A File that no longer opens there falls back to the cold walk.
 */
async function fromMemory(target: Target, signal: AbortSignal): Promise<FilesPageData | null> {
  const hit = treeCache.pathSnapshot(target, savedExpanded);
  if (!hit) return null;
  const { access, path, listings, keys } = hit;
  const crumbs = pathCrumbs(access, path, listings, target?.kind ?? "directory");
  if (!crumbs) return null;
  let file: FilesSnapshot["file"] = null;
  if (target?.kind === "file") {
    const parent = path.at(-2);
    // A private-access error has already cleared tab memory (`loseAccess`);
    // any other failure only drops the parent listing that led here.
    try {
      const parentKey = access.rootKind === "file" ? access.rootKey : keys[parent!]!;
      file = await openFile(access, target.nodeId, parentKey, await fetchFile(target.nodeId, signal));
      if (access.rootKind !== "file" && file.parentId !== parent) throw new TreeNotFoundError();
    } catch (error) {
      if (signal.aborted) throw error;
      if (parent) treeCache.invalidate(access.actorAccountId, [parent], "local");
      return null;
    }
  }
  return { status: "ready", snapshot: { access, listings, keys, crumbs, file }, fromMemory: true };
}

/** Browser-only clientLoader data; SSR renders a public HydrateFallback instead. */
export async function loadFilesPage(nodeId: string, kind: TreeKind, signal: AbortSignal): Promise<FilesPageData> {
  const target = { nodeId, kind };
  return (await fromMemory(target, signal)) ?? settle(walk(target, signal), signal);
}

/**
 * Whether owned-key upkeep hands the library over to device access: a job in
 * progress, or an unreadable answer, which device access then resumes rather
 * than assume finished. The one place this decision is made.
 */
function libraryHandOff(signal: AbortSignal): Promise<boolean> {
  return ownedProvisioningUpkeep(signal).then(
    (job) => job !== null,
    () => true,
  );
}

/**
 * The Account's own library root, opened by its bootstrap without a separate
 * path read. A bootstrap that fails, or an owned-key job (`libraryHandOff`),
 * is reported as `access`: the Session or this browser's Encryption device
 * needs attention, not the library. A library this tab remembers renders
 * without waiting, and carries the hand-off for the page to follow (ticket 57).
 */
export async function loadLibraryPage(signal: AbortSignal): Promise<LibraryPageData> {
  const handOff = libraryHandOff(signal);
  const remembered = await fromMemory(null, signal);
  if (remembered) return { ...remembered, handOff };
  const root = prefetch(openRoot(signal));
  try {
    await root;
  } catch (error) {
    if (signal.aborted) throw error;
    return { status: "access", snapshot: null };
  }
  const page = await settle(walk(null, signal, root), signal);
  return (await handOff) ? { status: "access", snapshot: null } : page;
}

async function settle(opening: Promise<FilesSnapshot>, signal: AbortSignal): Promise<FilesPageData> {
  try {
    return { status: "ready", snapshot: await opening };
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

/**
 * Open a Directory for the page (an expanded folder, a move destination) and
 * remember it. `keyEpoch` is the epoch of the entry `key` was opened from;
 * without one the listing is remembered but the key is not.
 */
export async function loadVerifiedDirectory(
  access: RootAccess,
  directoryId: string,
  key: Uint8Array,
  keyEpoch: number | null,
  signal: AbortSignal,
): Promise<DirectoryListing> {
  const since = deviceStateGeneration();
  const verified = await verify(access, directoryId, key, await fetchDirectory(directoryId, signal));
  const keys: Record<string, OpenedKey> = keyEpoch === null ? {} : { [directoryId]: { key, epoch: keyEpoch } };
  treeCache.record({ access, listings: { [directoryId]: verified }, keys }, since);
  return verified.listing;
}

export type Revalidation =
  /** The shown listings are current: merge them with `mergeRevalidated`. */
  | {
      status: "current";
      listings: Record<string, DirectoryListing>;
      keys: Record<string, Uint8Array>;
      removed: string[];
    }
  /** The selected node left its remembered path, or a listing failed verification: reload through the cold walk. */
  | { status: "changed" }
  /** Private access failed: tab memory is cleared; reload to show the access state. */
  | { status: "access" }
  /** A temporary failure (network, server, provisioning): keep showing what the page has. */
  | { status: "temporary" };

function sameListing(known: VerifiedListing, fetched: FetchedDirectory): boolean {
  return (
    known.listing.entriesRevision === fetched.entriesRevision &&
    (known.listing.keyEpoch ?? 1) === (fetched.keyEpoch ?? 1) &&
    known.digest === (fetched.listingHead?.digest ?? "")
  );
}

/**
 * Background revalidation of what a Files page shows (ticket 57): fetch the
 * listings on its path and its shown expanded folders together, keep each
 * remembered listing whose revision, key epoch and head digest are unchanged
 * and that this browser's rollback checkpoint still accepts, and verify and
 * open any other exactly as a cold walk would, with keys re-derived down the
 * path from the verified parents. File content is never touched.
 */
export async function revalidateFilesPage(
  snapshot: FilesSnapshot,
  kind: TreeKind,
  signal: AbortSignal,
): Promise<Revalidation> {
  const since = deviceStateGeneration();
  const { access } = snapshot;
  const path = snapshot.crumbs.map((crumb) => crumb.id);
  const directories = kind === "file" ? path.slice(0, -1) : path;
  if (!directories.length) return { status: "current", listings: {}, keys: {}, removed: [] };
  const remembered = savedExpanded(access.actorAccountId);
  // A memory render serves at most EXPANDED_CHECKED remembered folders, so every one is checked here.
  const shown = new Set([
    ...directories,
    ...remembered.filter((id) => snapshot.listings[id] && !directories.includes(id)).slice(0, EXPANDED_CHECKED),
  ]);
  const changed = (): Revalidation => {
    // The next load must not rebuild this path from memory again.
    treeCache.invalidate(access.actorAccountId, directories, "local");
    treeCache.forgetRoot(access.rootId);
    return { status: "changed" };
  };
  let fetched: Map<string, FetchedDirectory>;
  try {
    fetched = new Map(await Promise.all([...shown].map(async (id) => [id, await fetchDirectory(id, signal)] as const)));
  } catch (error) {
    if (signal.aborted) throw error;
    // Only the private client clears tab memory, and exactly on a private-access
    // error (`loseAccess`); a moved generation is how this view learns it did.
    if (deviceStateGeneration() !== since) return { status: "access" };
    return error instanceof TreeNotFoundError ? changed() : { status: "temporary" };
  }
  try {
    const opened: Opened = { verified: {}, keys: { [access.rootId]: access.rootKey } };
    // Root first, then each shown folder its verified parent still contains.
    const order = [directories[0]!];
    for (let index = 0; index < order.length; index++) {
      const id = order[index]!;
      const response = fetched.get(id)!;
      const known = treeCache.cached(id);
      if (known && sameListing(known, response)) {
        // The rollback checkpoint guards a remembered head too: one this
        // browser has moved past (another tab, a Key rotation) is a replay.
        rememberListing(access.vaultId, id, response.entriesRevision, known.digest);
        opened.verified[id] = {
          listing: { ...known.listing, canCreate: response.canCreate ?? true },
          digest: known.digest,
        };
      } else opened.verified[id] = await verify(access, id, opened.keys[id]!, response);
      for (const entry of opened.verified[id].listing.entries) {
        if (entry.kind !== "directory" || !fetched.has(entry.nodeId) || opened.keys[entry.nodeId]) continue;
        opened.keys[entry.nodeId] = await openChildDirectory(access, opened.keys[id]!, entry);
        order.push(entry.nodeId);
      }
    }
    if (!pathCrumbs(access, path, listingsOf(opened.verified), kind)) return changed();
    // Remembered folders the page shows open but has no listing for yet load the cold way.
    await restoreExpanded(
      access,
      opened,
      remembered.filter((id) => !snapshot.listings[id]),
      new Map(),
      signal,
    );
    signal.throwIfAborted();
    treeCache.record({ access, listings: opened.verified, keys: recordedKeys(access, opened) }, since);
    return {
      status: "current",
      listings: listingsOf(opened.verified),
      keys: opened.keys,
      removed: [...shown].filter((id) => !opened.verified[id]),
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return changed();
  }
}

/**
 * A page's snapshot with a current revalidation merged in, never going back
 * to an older listing (a revalidation fetched before this page's own change
 * committed, for example). The File and its draft are untouched; breadcrumbs
 * follow renamed ancestors.
 */
export function mergeRevalidated(
  previous: FilesSnapshot,
  outcome: Extract<Revalidation, { status: "current" }>,
  kind: TreeKind,
): FilesSnapshot {
  const merged = mergeListings(previous, outcome);
  for (const id of outcome.removed) delete merged.listings[id];
  const path = previous.crumbs.map((crumb) => crumb.id);
  return {
    ...previous,
    ...merged,
    crumbs: pathCrumbs(previous.access, path, merged.listings, kind) ?? previous.crumbs,
  };
}
