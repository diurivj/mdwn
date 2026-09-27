import {
  loadAncestors, loadDirectory, loadDirectFile, loadFile, openChildDirectory, openRoot,
  SharedProvisioningError, TreeNotFoundError,
  type DirectoryListing, type LoadedDirectFile, type LoadedFile, type RootAccess, type TreeKind,
} from "./client";
import { privateRequest } from "~/device/private-client";
import { namedRoot, openGrantedDirectory, sharedRoots, type GrantRoot } from "~/sharing/client";

export type Crumb = { id: string; name: string };
export type FilesSnapshot = {
  scope: "owned" | "directory-grant";
  canEditMarkdown: boolean; canCreateChild: boolean;
  access: RootAccess;
  listings: Record<string, DirectoryListing>;
  keys: Record<string, Uint8Array>;
  crumbs: Crumb[];
  file: LoadedFile | null;
};
export type DirectFilesSnapshot = { scope: "direct-file"; actorAccountId: string;
  ownerId: string; grantId: string; name: string; permission: "read_only" | "read_write";
  canEditMarkdown: boolean;
  file: LoadedDirectFile };
export type RootFilesPageData = { status: "ready"; snapshot: FilesSnapshot } |
  { status: "not-found" | "unavailable" | "provisioning"; snapshot: null };
export type FilesPageData = { status: "ready"; snapshot: FilesSnapshot | DirectFilesSnapshot } |
  { status: "not-found" | "unavailable" | "provisioning"; snapshot: null };

export const expandedPreferenceKey = (accountId: string) => `mdwn:files-expanded:${accountId}`;
export function savedExpanded(accountId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(expandedPreferenceKey(accountId)) ?? "[]");
    return Array.isArray(parsed) ? parsed.slice(0, 200).filter((value): value is string => typeof value === "string") : [];
  } catch { return []; }
}

async function selectedPath(nodeId: string, kind: TreeKind, signal: AbortSignal,
  access: RootAccess, path: string[], canEditMarkdown = true, canCreateChild = true): Promise<FilesSnapshot> {
  if (path[0] !== access.rootId) throw new TreeNotFoundError();
  const listings: Record<string, DirectoryListing> = {};
  const keys: Record<string, Uint8Array> = { [access.rootId]: access.rootKey };
  const crumbs: Crumb[] = [{ id: access.rootId, name: access.rootLabel ?? "Files" }];
  let file: LoadedFile | null = null;
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
    if (!parent || !keys[parent]) throw new TreeNotFoundError();
    const entry = listings[parent]?.entries.find((child) => child.nodeId === nodeId);
    if (!entry || entry.kind !== "file") throw new TreeNotFoundError();
    file = await loadFile(access, nodeId, parent, keys[parent], entry, signal);
  }
  // Preferences are browser-only, never encoded in a deep link. Restore only
  // descendants discoverable through a decrypted Directory in this Account.
  const pending = new Set(savedExpanded(access.actorAccountId ?? access.vaultId));
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
  signal.throwIfAborted();
  return { scope: access.scope === "directory-grant" ? "directory-grant" : "owned",
    canEditMarkdown, canCreateChild, access, listings, keys, crumbs, file };
}

/** Browser-only clientLoader data; direct File scopes never request ancestry/bootstrap. */
export async function loadFilesPage(nodeId: string, kind: TreeKind, signal: AbortSignal): Promise<FilesPageData> {
  try {
    const response = await privateRequest("/api/private/sharing/scope", { method: "POST",
      body: JSON.stringify({ nodeId, kind }), signal });
    if (response.status === 404) throw new TreeNotFoundError();
    if (!response.ok) throw new Error("Files unavailable");
    const scope = await response.json() as { scope: "owned" | "directory-grant" | "direct-file";
      grantId?: string; path?: string[]; canEditMarkdown?: boolean; canCreateChild?: boolean };
    signal.throwIfAborted();
    if (scope.scope === "owned") {
      const access = await openRoot(signal);
      return { status: "ready", snapshot: await selectedPath(nodeId, kind, signal,
        access, await loadAncestors(nodeId, signal)) };
    }
    if (!scope.grantId) throw new TreeNotFoundError();
    const state = await fetch("/api/device/state", { cache: "no-store", signal });
    if (!state.ok) throw new Error("Device unavailable");
    const { accountId: actorAccountId } = await state.json() as { accountId: string };
    const roots = await sharedRoots(signal);
    const root: GrantRoot | undefined = roots.find((r) => r.grantId === scope.grantId);
    if (!root || root.status !== "ready") throw new SharedProvisioningError();
    const name = await namedRoot(root, actorAccountId);
    signal.throwIfAborted();
    if (scope.scope === "direct-file") {
      if (kind !== "file" || root.kind !== "file" || root.targetId !== nodeId) throw new TreeNotFoundError();
      const file = await loadDirectFile(actorAccountId, nodeId, signal);
      signal.throwIfAborted();
      return { status: "ready", snapshot: { scope: "direct-file", actorAccountId,
        ownerId: root.ownerId, grantId: root.grantId, permission: root.permission,
        canEditMarkdown: scope.canEditMarkdown === true, name, file } };
    }
    if (scope.scope !== "directory-grant" || root.kind !== "directory" ||
        !scope.path || scope.path[0] !== root.targetId || scope.path.at(-1) !== nodeId ||
        scope.path.length > 101) throw new TreeNotFoundError();
    const key = await openGrantedDirectory(root, actorAccountId);
    signal.throwIfAborted();
    const access: RootAccess = { scope: "directory-grant", vaultId: root.ownerId,
      actorAccountId, rootId: root.targetId, rootKey: new Uint8Array(key),
      grantId: root.grantId, rootLabel: name };
    return { status: "ready", snapshot: await selectedPath(nodeId, kind, signal, access, scope.path,
      scope.canEditMarkdown === true, scope.canCreateChild === true) };
  } catch (error) {
    if (signal.aborted) throw error;
    return { status: error instanceof SharedProvisioningError ? "provisioning" :
      error instanceof TreeNotFoundError ? "not-found" : "unavailable", snapshot: null };
  }
}
