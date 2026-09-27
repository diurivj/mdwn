import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";

import {
  createTreeChild, loadAncestors, loadDirectory, loadFile, NameConflictError, NamespaceChangedError,
  openChildDirectory, openRoot, prepareTreeCreate, prepareTreeRename, renameTreeChild, TreeNotFoundError,
  type DirectoryListing, type RootAccess, type TreeEntry, type TreeKind,
} from "./client";

type Crumb = { id: string; name: string };
type Snapshot = {
  access: RootAccess;
  listings: Record<string, DirectoryListing>;
  keys: Record<string, Uint8Array>;
  crumbs: Crumb[];
  markdown: string | null;
};
type Dialog = {
  operation: "create" | "rename"; kind: TreeKind; parentId: string; nodeId?: string;
  requestedName: string; review?: "local" | "changed";
};

const prefKey = (accountId: string) => `mdwn:files-expanded:${accountId}`;
function savedExpanded(accountId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(prefKey(accountId)) ?? "[]");
    return Array.isArray(parsed) ? parsed.slice(0, 200).filter((value): value is string => typeof value === "string") : [];
  } catch { return []; }
}

async function selectedPath(nodeId: string, kind: TreeKind): Promise<Snapshot> {
  const access = await openRoot();
  const path = await loadAncestors(nodeId);
  if (path[0] !== access.rootId) throw new TreeNotFoundError();
  const listings: Record<string, DirectoryListing> = {};
  const keys: Record<string, Uint8Array> = { [access.rootId]: access.rootKey };
  const crumbs: Crumb[] = [{ id: access.rootId, name: "Files" }];
  let markdown: string | null = null;
  for (let index = 0; index < path.length; index++) {
    const parent = path[index]!;
    const key = keys[parent];
    if (!key) throw new TreeNotFoundError();
    if (index === path.length - 1 && kind === "file") break;
    const listing = await loadDirectory(access, parent, key);
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
    const file = await loadFile(access, nodeId, keys[parent]);
    if (file.parentId !== parent) throw new TreeNotFoundError();
    markdown = file.markdown;
  }
  // Preferences are browser-only, never encoded in a deep link. Restore only
  // descendants discoverable through a decrypted Directory in this Account.
  const pending = new Set(savedExpanded(access.vaultId));
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
        listings[id] = await loadDirectory(access, id, key);
        progressed = true;
      } catch { /* An old local preference must not block opening the selected object. */ }
    }
    if (!progressed) break;
  }
  return { access, listings, keys, crumbs, markdown };
}

/** No loader serializes private ciphertext or decrypted names into SSR HTML. */
export function FilesWorkspace({ nodeId, kind }: { nodeId: string; kind: TreeKind }) {
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "not-found" | "unavailable">("loading");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [drawer, setDrawer] = useState(false);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);

  async function reload() {
    setStatus("loading");
    try {
      const next = await selectedPath(nodeId, kind);
      setSnapshot(next);
      setExpanded((previous) => Array.from(new Set([
        ...savedExpanded(next.access.vaultId), ...previous, ...next.crumbs.slice(0, -1).map((item) => item.id),
        next.access.rootId,
      ])));
      setStatus("ready");
    } catch (error) {
      setSnapshot(null);
      setStatus(error instanceof TreeNotFoundError ? "not-found" : "unavailable");
    }
  }
  useEffect(() => {
    let active = true;
    setStatus("loading");
    void selectedPath(nodeId, kind).then((next) => {
      if (!active) return;
      setSnapshot(next);
      setExpanded(Array.from(new Set([
        ...savedExpanded(next.access.vaultId), ...next.crumbs.slice(0, -1).map((item) => item.id),
        next.access.rootId,
      ])));
      setStatus("ready");
      setView("edit");
    }).catch((error: unknown) => {
      if (!active) return;
      setSnapshot(null);
      setStatus(error instanceof TreeNotFoundError ? "not-found" : "unavailable");
    });
    return () => { active = false; };
  }, [nodeId, kind]);

  async function toggle(entry: TreeEntry) {
    if (!snapshot || entry.kind !== "directory") return;
    if (expanded.includes(entry.nodeId)) {
      const next = expanded.filter((id) => id !== entry.nodeId);
      setExpanded(next);
      localStorage.setItem(prefKey(snapshot.access.vaultId), JSON.stringify(next));
      return;
    }
    try {
      const parentId = Object.values(snapshot.listings).find((listing) =>
        listing.entries.some((child) => child.nodeId === entry.nodeId))?.directoryId;
      const parentKey = parentId && snapshot.keys[parentId];
      if (!parentKey) throw new Error("private tree unavailable");
      const key = await openChildDirectory(snapshot.access, parentKey, entry);
      const listing = await loadDirectory(snapshot.access, entry.nodeId, key);
      setSnapshot((previous) => previous && ({ ...previous,
        keys: { ...previous.keys, [entry.nodeId]: key },
        listings: { ...previous.listings, [entry.nodeId]: listing },
      }));
      const next = [...expanded, entry.nodeId];
      setExpanded(next);
      localStorage.setItem(prefKey(snapshot.access.vaultId), JSON.stringify(next));
    } catch { setMessage("This folder could not be opened. Refresh and try again."); }
  }

  function startCreate(createKind: TreeKind) {
    if (!snapshot) return;
    const parentId = kind === "directory" ? nodeId : snapshot.crumbs.at(-2)?.id;
    if (!parentId || !snapshot.listings[parentId]) return;
    setMessage("");
    setDialog({ operation: "create", kind: createKind, parentId, requestedName: "" });
  }

  function startRename() {
    if (!snapshot || nodeId === snapshot.access.rootId) return;
    const parentId = snapshot.crumbs.at(-2)?.id;
    const entry = parentId && snapshot.listings[parentId]?.entries.find((item) => item.nodeId === nodeId);
    if (!entry || !parentId) return;
    setMessage("");
    setDialog({ operation: "rename", kind, parentId, nodeId, requestedName: entry.name });
  }

  async function submit(current: Dialog, listing?: DirectoryListing) {
    if (!snapshot || submitting) return;
    setSubmitting(true);
    setMessage("");
    try {
      const parent = listing ?? snapshot.listings[current.parentId];
      const key = snapshot.keys[current.parentId];
      if (!parent || !key) throw new Error("private tree unavailable");
      if (current.operation === "create") {
        const payload = await prepareTreeCreate({ vaultId: snapshot.access.vaultId,
          parentId: current.parentId, parentKey: key, entriesRevision: parent.entriesRevision,
          existingNames: parent.entries.map((entry) => entry.name), requestedName: current.requestedName,
          kind: current.kind });
        const created = await createTreeChild(snapshot.access, current.parentId, payload);
        setDialog(null);
        navigate(`/${current.kind === "directory" ? "d" : "f"}/${created.nodeId}`);
      } else {
        const entry = parent.entries.find((item) => item.nodeId === current.nodeId);
        if (!entry) throw new TreeNotFoundError();
        const payload = await prepareTreeRename({ vaultId: snapshot.access.vaultId,
          parentId: current.parentId, parentKey: key, nodeId: entry.nodeId,
          entriesRevision: parent.entriesRevision,
          existingNames: parent.entries.filter((item) => item.nodeId !== entry.nodeId).map((item) => item.name),
          requestedName: current.requestedName, order: entry.order });
        await renameTreeChild(entry.nodeId, payload);
        setDialog(null);
        await reload();
      }
    } catch (error) {
      if (error instanceof NameConflictError) setDialog({ ...current, review: "local" });
      else if (error instanceof NamespaceChangedError) setDialog({ ...current, review: "changed" });
      else if (error instanceof TreeNotFoundError) { setDialog(null); setStatus("not-found"); }
      else setMessage("The change could not be completed. Nothing was added or renamed.");
    } finally { setSubmitting(false); }
  }

  async function refreshAndRetry(current: Dialog) {
    if (!snapshot || submitting) return;
    setSubmitting(true);
    try {
      const listing = await loadDirectory(snapshot.access, current.parentId, snapshot.keys[current.parentId]!);
      setSnapshot((previous) => previous && ({ ...previous,
        listings: { ...previous.listings, [current.parentId]: listing } }));
      setDialog({ ...current, review: undefined });
      setSubmitting(false);
      await submit({ ...current, review: undefined }, listing);
    } catch {
      setMessage("The folder could not be refreshed. Try again.");
      setSubmitting(false);
    }
  }

  function directoryItems(directoryId: string, depth = 0): React.ReactNode {
    if (!snapshot || depth > 100) return null;
    const listing = snapshot.listings[directoryId];
    if (!listing) return null;
    return listing.entries.map((entry) => <div key={entry.nodeId}>
      <div className={`flex items-center gap-1 rounded px-1 py-0.5 ${entry.nodeId === nodeId ? "bg-stone-200" : ""}`}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}>
        {entry.kind === "directory" ? <button type="button" aria-label={`${expanded.includes(entry.nodeId) ? "Collapse" : "Expand"} ${entry.name}`}
          onClick={() => void toggle(entry)} className="w-5 text-left">{expanded.includes(entry.nodeId) ? "▾" : "▸"}</button>
          : <span className="w-5" aria-hidden="true">·</span>}
        <Link to={`/${entry.kind === "directory" ? "d" : "f"}/${entry.nodeId}`}
          onClick={() => setDrawer(false)} className="min-w-0 truncate hover:underline">{entry.name}</Link>
      </div>
      {entry.kind === "directory" && expanded.includes(entry.nodeId) && directoryItems(entry.nodeId, depth + 1)}
    </div>);
  }

  if (status === "loading") return <main className="p-8" role="status">Opening Files…</main>;
  if (status === "not-found") return <main className="p-8"><h1 className="text-xl font-semibold">Not found</h1>
    <p>This File or folder is unavailable.</p><Link to="/account/device-access" className="underline">Files access</Link></main>;
  if (status !== "ready" || !snapshot) return <main className="p-8"><h1 className="text-xl font-semibold">Files unavailable</h1>
    <p>Check this device’s access or try again.</p><Link to="/account/device-access" className="underline">Device access</Link></main>;

  const selected = snapshot.crumbs.at(-1)?.name ?? "Files";
  return <main className="mx-auto min-h-dvh max-w-screen-2xl md:grid md:grid-cols-[18rem_minmax(0,1fr)]">
    <aside className={`${drawer ? "block" : "hidden"} border-r border-stone-200 bg-stone-50 p-4 md:block`} aria-label="Files tree">
      <div className="mb-4 flex items-center justify-between"><Link to="/" className="font-semibold">mdwn</Link>
        <button type="button" onClick={() => setDrawer(false)} className="md:hidden">Close tree</button></div>
      <Link to={`/d/${snapshot.access.rootId}`} className="mb-2 block font-medium hover:underline">Files</Link>
      <nav aria-label="Files">{directoryItems(snapshot.access.rootId)}</nav>
    </aside>
    <section className="min-w-0 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => setDrawer(true)} className="rounded border px-2 py-1 md:hidden">Tree</button>
        <nav aria-label="Breadcrumbs" className="flex min-w-0 flex-wrap gap-2 text-sm">
          {snapshot.crumbs.map((crumb, index) => <span key={crumb.id} className="min-w-0">
            {index > 0 && <span aria-hidden="true" className="mr-2 text-stone-400">/</span>}
            <Link to={`/${index === snapshot.crumbs.length - 1 && kind === "file" ? "f" : "d"}/${crumb.id}`}
              className="hover:underline">{crumb.name}</Link>
          </span>)}
        </nav>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-2"><h1 className="mr-auto text-2xl font-semibold">{selected}</h1>
        <button type="button" onClick={() => startCreate("directory")} className="rounded border px-2 py-1">New folder</button>
        <button type="button" onClick={() => startCreate("file")} className="rounded border px-2 py-1">New File</button>
        {nodeId !== snapshot.access.rootId && <button type="button" onClick={startRename} className="rounded border px-2 py-1">Rename</button>}
      </div>
      {message && <p role="alert" className="mt-3 text-rose-700">{message}</p>}
      {kind === "file" ? <>
        <div className="mt-6 flex gap-2 md:hidden"><button type="button" onClick={() => setView("edit")}
          aria-pressed={view === "edit"}>Edit</button><button type="button" onClick={() => setView("preview")}
          aria-pressed={view === "preview"}>Preview</button></div>
        <div className="mt-4 grid min-h-[50vh] gap-4 lg:grid-cols-2">
          <section className={`${view === "preview" ? "hidden md:block" : ""}`} aria-label="Editor">
            <h2 className="mb-2 font-medium">Markdown source</h2>
            <textarea readOnly value={snapshot.markdown ?? ""} aria-label="Markdown source (read only)"
              className="h-[50vh] w-full resize-none rounded border border-stone-300 bg-white p-3 font-mono text-sm" />
            <p className="text-xs text-stone-500">Editing and autosave arrive in the next milestone.</p>
          </section>
          <section className={`${view === "edit" ? "hidden md:block" : ""}`} aria-label="Preview">
            <h2 className="mb-2 font-medium">Preview</h2>
            <div className="min-h-[50vh] rounded border border-stone-300 bg-white p-3">
              {(snapshot.markdown ?? "").split("\n").map((line, index) => line.startsWith("# ")
                ? <h3 className="mb-3 text-xl font-semibold" key={index}>{line.slice(2)}</h3>
                : <p className="whitespace-pre-wrap" key={index}>{line || "\u00a0"}</p>)}
            </div>
          </section>
        </div>
      </> : <p className="mt-8 text-stone-500">Choose a File from the tree or create one here.</p>}
    </section>
    {dialog && <div role="dialog" aria-modal="true" aria-label={dialog.operation === "create" ? "Create a name" : "Rename"}
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={(event) => { event.preventDefault(); void submit(dialog); }}
        className="w-full max-w-md rounded bg-white p-5 shadow-lg">
        <h2 className="text-lg font-semibold">{dialog.operation === "create" ? `New ${dialog.kind === "file" ? "File" : "folder"}` : "Rename"}</h2>
        <label className="mt-4 block">Name <input ref={nameInput} autoFocus value={dialog.requestedName}
          onChange={(event) => setDialog({ ...dialog, requestedName: event.target.value, review: undefined })}
          className="mt-1 w-full rounded border p-2" /></label>
        {dialog.review === "local" && <p role="alert" className="mt-3">That name is already in this folder. Choose another name; nothing was overwritten.</p>}
        {dialog.review === "changed" && <p role="alert" className="mt-3">This folder changed on another device. Nothing was added, replaced, or overwritten.</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => setDialog(null)} className="rounded border px-3 py-1">Cancel</button>
          {dialog.review === "changed" && <button type="button" disabled={submitting}
            onClick={() => void refreshAndRetry(dialog)} className="rounded border px-3 py-1">Refresh and retry</button>}
          {dialog.review && <button type="button" onClick={() => { setDialog({ ...dialog, review: undefined }); nameInput.current?.focus(); }}
            className="rounded border px-3 py-1">Rename</button>}
          {!dialog.review && <button type="submit" disabled={submitting} className="rounded bg-stone-900 px-3 py-1 text-white">
            {submitting ? "Working…" : dialog.operation === "create" ? "Create" : "Rename"}</button>}
        </div>
      </form>
    </div>}
  </main>;
}
