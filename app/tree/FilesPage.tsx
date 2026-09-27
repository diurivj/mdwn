import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useNavigation, useRevalidator } from "react-router";
import { isSignupRecoveryConfirmationPending, RecoveryConfirmationPendingError } from "~/signup/recovery-gate";

import {
  createTreeChild, loadDirectory, NameConflictError, NamespaceChangedError,
  openChildDirectory, prepareTreeCreate, prepareTreeRename, renameTreeChild, TreeCommitUncertainError, TreeNotFoundError,
  type DirectoryListing, type TreeEntry, type TreeKind,
} from "./client";
import { FileEditor } from "./FileEditor";
import { expandedPreferenceKey, savedExpanded, type FilesPageData, type FilesSnapshot } from "./navigation-client";

type Dialog = {
  operation: "create" | "rename"; kind: TreeKind; parentId: string; nodeId?: string;
  requestedName: string; review?: "local" | "changed";
};

export function FilesPage({ nodeId, kind, initial }: { nodeId: string; kind: TreeKind; initial: FilesPageData }) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const [snapshot, setSnapshot] = useState<FilesSnapshot | null>(initial.snapshot);
  const [status, setStatus] = useState<FilesPageData["status"]>(initial.status);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [drawer, setDrawer] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  const flushEditor = useRef<(() => Promise<boolean>) | null>(null);
  const busy = submitting || revalidator.state !== "idle" || navigation.state !== "idle";
  const recoveryPending = isSignupRecoveryConfirmationPending();

  useEffect(() => {
    setSnapshot(initial.snapshot);
    setStatus(initial.status);
    setDialog(null);
    if (initial.snapshot) setExpanded(Array.from(new Set([
      ...savedExpanded(initial.snapshot.access.vaultId),
      ...initial.snapshot.crumbs.slice(0, -1).map((item) => item.id), initial.snapshot.access.rootId,
    ])));
  }, [initial, nodeId, kind]);

  async function toggle(entry: TreeEntry) {
    if (!snapshot || entry.kind !== "directory") return;
    if (expanded.includes(entry.nodeId)) {
      const next = expanded.filter((id) => id !== entry.nodeId);
      setExpanded(next);
      localStorage.setItem(expandedPreferenceKey(snapshot.access.vaultId), JSON.stringify(next));
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
      localStorage.setItem(expandedPreferenceKey(snapshot.access.vaultId), JSON.stringify(next));
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
    if (!snapshot || busy) return;
    setSubmitting(true);
    setMessage("");
    try {
      // A structural change to the selected File's parent must not race its pending save.
      if (flushEditor.current && !await flushEditor.current()) {
        setMessage("Your File could not be saved. Keep or explicitly discard its draft before changing this folder.");
        return;
      }
      const key = snapshot.keys[current.parentId];
      const parent = listing ?? (flushEditor.current && key
        ? await loadDirectory(snapshot.access, current.parentId, key) : snapshot.listings[current.parentId]);
      if (!parent || !key) throw new Error("private tree unavailable");
      if (current.operation === "create") {
        const payload = await prepareTreeCreate({ vaultId: snapshot.access.vaultId,
          parentId: current.parentId, parentKey: key, entriesRevision: parent.entriesRevision,
          existingNames: parent.entries.map((entry) => entry.name), requestedName: current.requestedName,
          kind: current.kind });
        const created = await createTreeChild(snapshot.access, current.parentId, payload, parent, key);
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
        await renameTreeChild(snapshot.access, current.parentId, entry.nodeId, payload, parent, key);
        setDialog(null);
        revalidator.revalidate();
      }
    } catch (error) {
      if (error instanceof NameConflictError) setDialog({ ...current, review: "local" });
      else if (error instanceof NamespaceChangedError) setDialog({ ...current, review: "changed" });
      else if (error instanceof TreeNotFoundError) { setDialog(null); setStatus("not-found"); }
      else if (error instanceof TreeCommitUncertainError) {
        setDialog(null);
        setMessage("The change may have been saved, but its local checkpoint failed. Refresh Files before trying again.");
      } else if (error instanceof RecoveryConfirmationPendingError) {
        setDialog(null);
        setMessage("Confirm your saved recovery phrase and codes before creating Files.");
      } else setMessage("The change could not be confirmed. Refresh Files before trying again.");
    } finally { setSubmitting(false); }
  }

  async function refreshAndRetry(current: Dialog) {
    if (!snapshot || busy) return;
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

  if (status === "not-found") return <main className="p-8"><h1 className="text-xl font-semibold">Not found</h1>
    <p>This File or folder is unavailable.</p><Link to="/account/device-access" className="underline">Files access</Link></main>;
  if (status !== "ready" || !snapshot) return <main className="p-8"><h1 className="text-xl font-semibold">Files unavailable</h1>
    <p>Check this device’s access or try again.</p><Link to="/account/device-access" className="underline">Device access</Link></main>;

  const selected = snapshot.crumbs.at(-1)?.name ?? "Files";
  return <main className="mx-auto min-h-dvh max-w-screen-2xl lg:grid lg:grid-cols-[18rem_minmax(0,1fr)]">
    {drawer && <button type="button" aria-label="Close Files tree" onClick={() => setDrawer(false)}
      className="fixed inset-0 z-10 bg-black/30 lg:hidden" />}
    <aside className={`${drawer ? "block" : "hidden"} fixed inset-y-0 left-0 z-20 w-72 overflow-y-auto border-r border-stone-200 bg-stone-50 p-4 shadow-lg lg:static lg:block lg:w-auto lg:shadow-none`} aria-label="Files tree">
      <div className="mb-4 flex items-center justify-between"><Link to="/" className="font-semibold">mdwn</Link>
        <button type="button" onClick={() => setDrawer(false)} className="lg:hidden">Close tree</button></div>
      <Link to={`/d/${snapshot.access.rootId}`} className="mb-2 block font-medium hover:underline">Files</Link>
      <nav aria-label="Files">{directoryItems(snapshot.access.rootId)}</nav>
    </aside>
    <section className="min-w-0 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => setDrawer(true)} className="rounded border px-2 py-1 lg:hidden">Tree</button>
        <nav aria-label="Breadcrumbs" className="flex min-w-0 flex-wrap gap-2 text-sm">
          {snapshot.crumbs.map((crumb, index) => <span key={crumb.id} className="min-w-0">
            {index > 0 && <span aria-hidden="true" className="mr-2 text-stone-400">/</span>}
            <Link to={`/${index === snapshot.crumbs.length - 1 && kind === "file" ? "f" : "d"}/${crumb.id}`}
              className="hover:underline">{crumb.name}</Link>
          </span>)}
        </nav>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-2"><h1 className="mr-auto text-2xl font-semibold">{selected}</h1>
        <button type="button" disabled={busy || recoveryPending} onClick={() => startCreate("directory")} className="rounded border px-2 py-1">New folder</button>
        <button type="button" disabled={busy || recoveryPending} onClick={() => startCreate("file")} className="rounded border px-2 py-1">New File</button>
        {nodeId !== snapshot.access.rootId && <button type="button" disabled={busy || recoveryPending} onClick={startRename} className="rounded border px-2 py-1">Rename</button>}
      </div>
      {recoveryPending && <p role="status" className="mt-3">Confirm your saved recovery phrase and codes before creating Files.</p>}
      {busy && <p role="status" className="mt-3">Updating Files…</p>}
      {message && <p role="alert" className="mt-3 text-rose-700">{message}</p>}
      {kind === "file" && snapshot.file && snapshot.crumbs.at(-2)?.id && snapshot.keys[snapshot.crumbs.at(-2)!.id]
        ? <FileEditor fileId={nodeId} access={snapshot.access} file={snapshot.file}
          listing={snapshot.listings[snapshot.file.parentId]!} parentKey={snapshot.keys[snapshot.file.parentId]!}
          flushRef={flushEditor} onCommitted={(file, listing) => setSnapshot((old) => old && ({ ...old, file,
            listings: { ...old.listings, [listing.directoryId]: listing },
            crumbs: old.crumbs.map((crumb) => crumb.id === nodeId
              ? { ...crumb, name: listing.entries.find((entry) => entry.nodeId === nodeId)?.name ?? crumb.name }
              : crumb),
          }))} />
        : <p className="mt-8 text-stone-500">Choose a File from the tree or create one here.</p>}
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
          {dialog.review === "changed" && <button type="button" disabled={busy}
            onClick={() => void refreshAndRetry(dialog)} className="rounded border px-3 py-1">Refresh and retry</button>}
          {dialog.review && <button type="button" onClick={() => { setDialog({ ...dialog, review: undefined }); nameInput.current?.focus(); }}
            className="rounded border px-3 py-1">Rename</button>}
          {!dialog.review && <button type="submit" disabled={busy} className="rounded bg-stone-900 px-3 py-1 text-white">
            {submitting ? "Working…" : dialog.operation === "create" ? "Create" : "Rename"}</button>}
        </div>
      </form>
    </div>}
  </main>;
}
