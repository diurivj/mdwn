import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useBlocker, useNavigate, useNavigation, useRevalidator } from "react-router";
import { isSignupRecoveryConfirmationPending, RecoveryConfirmationPendingError } from "~/signup/recovery-gate";

import {
  createTreeChild, loadDirectory, NameConflictError, NamespaceChangedError,
  reorderTreeChild, moveTreeChild, deleteTreeChild, DirectoryTooLargeError,
  openChildDirectory, prepareTreeCreate, prepareTreeRename, renameTreeChild, TreeCommitUncertainError, TreeNotFoundError,
  type DirectoryListing, type TreeEntry, type TreeKind,
} from "./client";
import { FileEditor } from "./FileEditor";
import { expandedPreferenceKey, savedExpanded, type FilesPageData, type FilesSnapshot } from "./navigation-client";

type DialogFields = {
  kind: TreeKind; parentId: string; requestedName: string;
  review?: "local" | "changed"; needsRefresh?: boolean;
};
type Dialog = DialogFields & (
  { operation: "create" } |
  { operation: "rename"; nodeId: string } |
  { operation: "move"; nodeId: string; destinationId: string; path: { id: string; name: string }[] } |
  { operation: "delete"; nodeId: string; consent: boolean; tooLarge?: boolean } |
  { operation: "reorder"; nodeId: string; direction: "up" | "down" }
);
const dialogLabels = {
  create: { label: "Create a name", heading: "New", submit: "Create" },
  rename: { label: "Rename", heading: "Rename", submit: "Rename" },
  move: { label: "Move", heading: "Move", submit: "Move" },
  delete: { label: "Delete permanently", heading: "Delete permanently", submit: "Delete permanently" },
  reorder: { label: "Reorder", heading: "Reorder", submit: "Retry reorder" },
};

/** RR supports one blocker: File drafts own it; other views observe the
 * same synchronous navigation-intent boundary without blocking the person.
 */
function NavigationIntentObserver({ onStart }: { onStart: () => void }) {
  useBlocker(() => { onStart(); return false; });
  return null;
}

export function FilesPage({ nodeId, kind, initial }: { nodeId: string; kind: TreeKind; initial: FilesPageData }) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const [snapshot, setSnapshot] = useState<FilesSnapshot | null>(initial.snapshot);
  const [status, setStatus] = useState<FilesPageData["status"]>(initial.status);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [drawer, setDrawer] = useState(false);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submission = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => { controller.abort(); lifetime.current?.abort(); };
  }, []);
  const onNavigationStart = useCallback(() => {
    lifetime.current?.abort();
    lifetime.current = new AbortController();
    if (submission.current) setMessage("Navigation interrupted this operation. Refresh Files before trying again.");
    submission.current = false;
    setSubmitting(false);
    setDialog(null);
  }, []);
  const route = useRef(`${kind}/${nodeId}`);
  const [structuralReady, setStructuralReady] = useState(false);
  const [editorParent, setEditorParent] = useState(initial.snapshot?.file?.parentId);
  const fileReady = structuralReady && editorParent === snapshot?.file?.parentId;

  useEffect(() => {
    if (editorParent === snapshot?.file?.parentId) return;
    // Release the previous editor's Web Lock before the new parent-bound draft mounts.
    setStructuralReady(false);
    const frame = requestAnimationFrame(() => setEditorParent(snapshot?.file?.parentId));
    return () => cancelAnimationFrame(frame);
  }, [editorParent, snapshot?.file?.parentId]);
  const [message, setMessage] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  const busy = submitting || revalidator.state !== "idle" || navigation.state !== "idle";
  const recoveryPending = isSignupRecoveryConfirmationPending();

  useEffect(() => {
    setSnapshot((previous) => initial.snapshot && previous && dialog && route.current === `${kind}/${nodeId}`
      ? { ...initial.snapshot, keys: { ...previous.keys, ...initial.snapshot.keys },
        listings: { ...previous.listings, ...initial.snapshot.listings } }
      : initial.snapshot);
    setStatus(initial.status);
    if (route.current !== `${kind}/${nodeId}`) {
      setDialog(null);
      setStructuralReady(false);
      setView("edit");
      route.current = `${kind}/${nodeId}`;
    }
    if (initial.snapshot) setExpanded(Array.from(new Set([
      ...savedExpanded(initial.snapshot.access.actorAccountId),
      ...initial.snapshot.crumbs.slice(0, -1).map((item) => item.id), initial.snapshot.access.rootId,
    ])));
  }, [initial, nodeId, kind]);

  async function toggle(entry: TreeEntry) {
    const signal = lifetime.current?.signal;
    if (!snapshot || entry.kind !== "directory" || !signal || signal.aborted) return;
    if (expanded.includes(entry.nodeId)) {
      const next = expanded.filter((id) => id !== entry.nodeId);
      setExpanded(next);
      localStorage.setItem(expandedPreferenceKey(snapshot.access.actorAccountId), JSON.stringify(next));
      return;
    }
    try {
      const parentId = Object.values(snapshot.listings).find((listing) =>
        listing.entries.some((child) => child.nodeId === entry.nodeId))?.directoryId;
      const parentKey = parentId && snapshot.keys[parentId];
      if (!parentKey) throw new Error("private tree unavailable");
      const key = await openChildDirectory(snapshot.access, parentKey, entry);
      const listing = await loadDirectory(snapshot.access, entry.nodeId, key, signal);
      if (signal.aborted) return;
      setSnapshot((previous) => previous && ({ ...previous,
        keys: { ...previous.keys, [entry.nodeId]: key },
        listings: { ...previous.listings, [entry.nodeId]: listing },
      }));
      const next = [...expanded, entry.nodeId];
      setExpanded(next);
      localStorage.setItem(expandedPreferenceKey(snapshot.access.actorAccountId), JSON.stringify(next));
    } catch { if (!signal.aborted) setMessage("This folder could not be opened. Refresh and try again."); }
  }

  function startCreate(createKind: TreeKind) {
    if (!snapshot) return;
    const parentId = kind === "directory" ? nodeId : snapshot.crumbs.at(-2)?.id;
    if (!parentId || !snapshot.listings[parentId] || snapshot.listings[parentId].canCreate === false) return;
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

  async function refreshed(current: Dialog, signal: AbortSignal): Promise<FilesSnapshot> {
    if (!snapshot) throw new Error("private tree unavailable");
    const ids = new Set([current.parentId, ...(current.operation === "move" ? [current.destinationId] : []),
      ...(current.operation === "delete" && current.kind === "directory" ? [current.nodeId] : [])]);
    const listings = { ...snapshot.listings };
    for (const id of ids) listings[id] = await loadDirectory(snapshot.access, id, snapshot.keys[id]!, signal);
    signal.throwIfAborted();
    const next = { ...snapshot, listings };
    setSnapshot(next);
    return next;
  }

  function startStructural(action: { operation: "move" } | { operation: "delete" } | { operation: "reorder"; direction: "up" | "down" }) {
    if (!snapshot || busy || (kind === "file" && !fileReady)) return;
    const parentId = snapshot.crumbs.at(-2)?.id;
    const entry = parentId && snapshot.listings[parentId]?.entries.find((item) => item.nodeId === nodeId);
    if (!parentId || !entry) return;
    const fields = { kind, parentId, nodeId, requestedName: entry.name };
    const current: Dialog = action.operation === "move" ? { ...fields, operation: "move",
      destinationId: snapshot.access.rootId, path: [{ id: snapshot.access.rootId, name: "Files" }] }
      : action.operation === "delete" ? { ...fields, operation: "delete", consent: false }
        : { ...fields, ...action };
    setMessage("");
    setDialog(current);
    if (current.operation === "reorder") void submit(current);
  }

  async function chooseFolder(entry: TreeEntry) {
    const signal = lifetime.current?.signal;
    if (!snapshot || dialog?.operation !== "move" || busy || submission.current || !signal || signal.aborted) return;
    submission.current = true; setSubmitting(true);
    try {
      const parentId = dialog.destinationId;
      const key = await openChildDirectory(snapshot.access, snapshot.keys[parentId]!, entry);
      const listing = await loadDirectory(snapshot.access, entry.nodeId, key, signal);
      if (signal.aborted) return;
      setSnapshot((previous) => previous && ({ ...previous,
        keys: { ...previous.keys, [entry.nodeId]: key }, listings: { ...previous.listings, [entry.nodeId]: listing } }));
      setDialog({ ...dialog, destinationId: entry.nodeId, path: [...dialog.path, { id: entry.nodeId, name: entry.name }],
        review: undefined });
    } catch { if (!signal.aborted) setMessage("This folder could not be opened. Refresh and try again."); }
    finally { if (!signal.aborted) { submission.current = false; setSubmitting(false); } }
  }

  async function submit(current: Dialog) {
    const signal = lifetime.current?.signal;
    if (!snapshot || busy || submission.current || !signal || signal.aborted || (current.operation !== "create" && kind === "file" && !fileReady)) return;
    if (current.operation === "delete" && (!current.consent || current.tooLarge)) return;
    if (current.operation === "move" && current.destinationId === current.parentId) return;
    submission.current = true;
    setSubmitting(true);
    setMessage("");
    try {
      const active = current.needsRefresh ? await refreshed(current, signal) : snapshot;
      const parent = active.listings[current.parentId];
      const key = active.keys[current.parentId];
      if (!parent || !key || parent.canCreate === false) throw new Error("private tree unavailable");
      if (current.operation === "create") {
        const payload = await prepareTreeCreate({ vaultId: snapshot.access.vaultId,
          parentId: current.parentId, parentKey: key, entriesRevision: parent.entriesRevision,
          existingNames: parent.entries.map((entry) => entry.name), requestedName: current.requestedName,
          kind: current.kind });
        const created = await createTreeChild(snapshot.access, current.parentId, payload, parent, key, signal);
        if (signal.aborted) return;
        setDialog(null);
        navigate(`/${current.kind === "directory" ? "d" : "f"}/${created.nodeId}`);
      } else if (current.operation === "reorder" || current.operation === "move" || current.operation === "delete") {
        if (current.operation === "reorder") await reorderTreeChild(active.access, parent, key, current.nodeId, current.direction, signal);
        else if (current.operation === "move") await moveTreeChild(active.access, parent, key,
          active.listings[current.destinationId]!, active.keys[current.destinationId]!, current.nodeId, current.requestedName, signal);
        else await deleteTreeChild(active.access, parent, key, current.nodeId, current.kind === "directory"
          ? active.listings[current.nodeId]?.entriesRevision : undefined, signal);
        if (signal.aborted) return;
        setDialog(null);
        if (current.operation === "delete") navigate(`/d/${current.parentId}`);
        else revalidator.revalidate();
      } else {
        const entry = parent.entries.find((item) => item.nodeId === current.nodeId);
        if (!entry) throw new TreeNotFoundError();
        const payload = await prepareTreeRename({ vaultId: snapshot.access.vaultId,
          parentId: current.parentId, parentKey: key, nodeId: entry.nodeId,
          entriesRevision: parent.entriesRevision,
          existingNames: parent.entries.filter((item) => item.nodeId !== entry.nodeId).map((item) => item.name),
          requestedName: current.requestedName, order: entry.order });
        await renameTreeChild(snapshot.access, current.parentId, entry.nodeId, payload, parent, key, signal);
        if (signal.aborted) return;
        setDialog(null);
        revalidator.revalidate();
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof NameConflictError) setDialog({ ...current, review: "local", needsRefresh: true });
      else if (error instanceof NamespaceChangedError) {
        setDialog(current.operation === "delete" ? { ...current, review: "changed", needsRefresh: true, consent: false }
          : { ...current, review: "changed", needsRefresh: true });
        try { await refreshed(current, signal); }
        catch { if (!signal.aborted) setMessage("The folder could not be refreshed. Try again."); }
      }
      else if (error instanceof DirectoryTooLargeError && current.operation === "delete") setDialog({ ...current, tooLarge: true, consent: false });
      else if (error instanceof TreeNotFoundError) { setDialog(null); setStatus("not-found"); }
      else if (error instanceof TreeCommitUncertainError) {
        setDialog(null);
        setMessage("The change may have been saved, but its local checkpoint failed. Refresh Files before trying again.");
      } else if (error instanceof RecoveryConfirmationPendingError) {
        setDialog(null);
        setMessage("Confirm your saved recovery phrase and codes before creating Files.");
      } else setMessage("The change could not be confirmed. Refresh Files before trying again.");
    } finally { if (!signal.aborted) { submission.current = false; setSubmitting(false); } }
  }

  async function refreshAndRetry(current: Dialog) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    if (current.operation === "delete") {
      if (busy || submission.current) return;
      submission.current = true; setSubmitting(true);
      try {
        await refreshed(current, signal);
        if (signal.aborted) return;
        setDialog({ ...current, review: undefined, needsRefresh: false, consent: false });
      } catch { if (!signal.aborted) setMessage("The folder could not be refreshed. Try again."); }
      finally { if (!signal.aborted) { submission.current = false; setSubmitting(false); } }
    } else await submit({ ...current, review: undefined, needsRefresh: true });
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
  if (status === "provisioning") return <main className="p-8"><p role="status">Shared content is being securely provisioned</p></main>;
  if (status !== "ready" || !snapshot) return <main className="p-8"><h1 className="text-xl font-semibold">Files unavailable</h1>
    <p>Check this device’s access or try again.</p><Link to="/account/device-access" className="underline">Device access</Link></main>;

  const selected = snapshot.crumbs.at(-1)?.name ?? "Files";
  const structuralParent = kind === "directory" ? nodeId : snapshot.file?.parentId;
  const canCreate = !!structuralParent && snapshot.listings[structuralParent]?.canCreate !== false &&
    !!snapshot.listings[structuralParent];
  const canChangeStructure = nodeId !== snapshot.access.rootId &&
    snapshot.listings[snapshot.crumbs.at(-2)?.id ?? ""]?.canCreate !== false;
  return <main className="mx-auto min-h-dvh max-w-screen-2xl lg:grid lg:grid-cols-[18rem_minmax(0,1fr)]">
    {(kind === "directory" || editorParent !== snapshot.file?.parentId) && <NavigationIntentObserver onStart={onNavigationStart} />}
    {drawer && <button type="button" aria-label="Close Files tree" onClick={() => setDrawer(false)}
      className="fixed inset-0 z-10 bg-black/30 lg:hidden" />}
    <aside className={`${drawer ? "block" : "hidden"} fixed inset-y-0 left-0 z-20 w-72 overflow-y-auto border-r border-stone-200 bg-stone-50 p-4 shadow-lg lg:static lg:block lg:w-auto lg:shadow-none`} aria-label="Files tree">
      <div className="mb-4 flex items-center justify-between"><Link to="/" className="font-semibold">mdwn</Link>
        <button type="button" onClick={() => setDrawer(false)} className="lg:hidden">Close tree</button></div>
      <Link to={`/${snapshot.access.rootKind === "file" ? "f" : "d"}/${snapshot.access.rootId}`} className="mb-2 block font-medium hover:underline">{snapshot.access.rootKind === "file" ? "Shared File" : "Files"}</Link>
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
        {canCreate && <><button type="button" disabled={busy || recoveryPending} onClick={() => startCreate("directory")} className="rounded border px-2 py-1">New folder</button>
        <button type="button" disabled={busy || recoveryPending} onClick={() => startCreate("file")} className="rounded border px-2 py-1">New File</button></>}
        {canChangeStructure && <button type="button" disabled={busy || recoveryPending || (kind === "file" && !fileReady)} onClick={startRename} className="rounded border px-2 py-1">Rename</button>}
      </div>
      {canChangeStructure && <div className="mt-3 flex flex-wrap gap-2">
        {(["up", "down"] as const).map((direction) => {
          const entries = snapshot.listings[snapshot.crumbs.at(-2)?.id ?? ""]?.entries ?? [];
          const index = entries.findIndex((entry) => entry.nodeId === nodeId);
          return <button key={direction} type="button" disabled={busy || recoveryPending || (kind === "file" && !fileReady) ||
            index < 0 || (direction === "up" ? index === 0 : index === entries.length - 1)}
            onClick={() => startStructural({ operation: "reorder", direction })} className="rounded border px-2 py-1">Move {direction}</button>;
        })}
        <button type="button" disabled={busy || recoveryPending || (kind === "file" && !fileReady)} onClick={() => startStructural({ operation: "move" })} className="rounded border px-2 py-1">Move</button>
        <button type="button" disabled={busy || recoveryPending || (kind === "file" && !fileReady)} onClick={() => startStructural({ operation: "delete" })} className="rounded border px-2 py-1">Delete</button>
        {kind === "file" && !fileReady && <p role="status">Save your draft before changing this File’s name or location, order, or deleting it.</p>}
      </div>}
      {recoveryPending && <p role="status" className="mt-3">Confirm your saved recovery phrase and codes before creating Files.</p>}
      {busy && <p role="status" className="mt-3">Updating Files…</p>}
      {message && <p role="alert" className="mt-3 text-rose-700">{message}</p>}
      {kind === "file" ? <>
        <div className="mt-6 flex gap-2 lg:hidden"><button type="button" onClick={() => setView("edit")}
          aria-pressed={view === "edit"}>Edit</button><button type="button" onClick={() => setView("preview")}
          aria-pressed={view === "preview"}>Preview</button></div>
        {editorParent === snapshot.file?.parentId ? <FileEditor key={`${nodeId}/${snapshot.file?.parentId}`} fileId={nodeId} snapshot={snapshot} view={view} showEdit={() => setView("edit")}
          onStructuralReady={setStructuralReady} structuralBusy={busy || dialog !== null} onNavigationStart={onNavigationStart}
          onCurrent={(file, listing) => setSnapshot((previous) => previous && ({ ...previous,
            file, listings: listing ? { ...previous.listings, [listing.directoryId]: listing } : previous.listings }))} /> : <p role="status">Opening moved File…</p>}
      </> : <p className="mt-8 text-stone-500">Choose a File from the tree or create one here.</p>}
    </section>
    {dialog && <div role="dialog" aria-modal="true" aria-label={dialogLabels[dialog.operation].label}
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={(event) => { event.preventDefault(); void submit(dialog); }}
        className="w-full max-w-md rounded bg-white p-5 shadow-lg">
        <h2 className="text-lg font-semibold">{dialog.operation === "create" ? `New ${dialog.kind === "file" ? "File" : "folder"}` : dialogLabels[dialog.operation].heading}</h2>
        {!["delete", "reorder"].includes(dialog.operation) && <label className="mt-4 block">Name <input ref={nameInput} autoFocus value={dialog.requestedName} disabled={busy}
          onChange={(event) => setDialog({ ...dialog, requestedName: event.target.value, review: undefined })}
          className="mt-1 w-full rounded border p-2" /></label>}
        {dialog.operation === "move" && <section aria-label="Destination folder" className="mt-4">
          <p>Destination: {dialog.path.at(-1)?.name}</p>
          <nav aria-label="Destination breadcrumbs" className="flex flex-wrap gap-2">
            {dialog.path.map((folder, index) => <button key={folder.id} type="button" disabled={busy}
              onClick={() => setDialog({ ...dialog, destinationId: folder.id, path: dialog.path.slice(0, index + 1), review: undefined })}>{folder.name}</button>)}
          </nav>
          <div className="mt-2 flex flex-col items-start">
            {snapshot.listings[dialog.destinationId]?.entries.filter((entry) => entry.kind === "directory" && entry.nodeId !== nodeId)
              .map((entry) => <button key={entry.nodeId} type="button" disabled={busy} onClick={() => void chooseFolder(entry)}
                aria-label={`Open destination ${entry.name}`}>{entry.name}</button>)}
          </div>
          {dialog.destinationId === dialog.parentId && <p>Select a different folder.</p>}
        </section>}
        {dialog.operation === "delete" && <>
          <p className="mt-4">Permanently delete {dialog.requestedName}{kind === "directory" ? " and all its descendants" : ""}? There is no trash or restore. This cannot recall downloads or guarantee when provider-managed backups are erased.</p>
          <p>Folders can only be deleted whole when they contain at most 500 nodes.</p>
          {dialog.tooLarge ? <p role="alert">This folder contains more than 500 nodes. Reduce the subtree by moving or deleting smaller folders or Files first. Nothing was deleted.</p> :
            <label className="mt-3 block"><input type="checkbox" checked={dialog.consent ?? false} disabled={busy || !!dialog.review}
              onChange={(event) => setDialog({ ...dialog, consent: event.target.checked })} /> I understand deletion is irreversible.</label>}
        </>}
        {dialog.review === "local" && <p role="alert" className="mt-3">That name is already in this folder. Choose another name; nothing was overwritten.</p>}
        {dialog.review === "changed" && <p role="alert" className="mt-3">This folder changed on another device. Nothing was added, replaced, or overwritten.</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" disabled={busy} onClick={() => setDialog(null)} className="rounded border px-3 py-1">Cancel</button>
          {dialog.review === "changed" && <button type="button" disabled={busy}
            onClick={() => void refreshAndRetry(dialog)} className="rounded border px-3 py-1">Refresh and retry</button>}
          {dialog.review && !["delete", "reorder"].includes(dialog.operation) && <button type="button" disabled={busy} onClick={() => { setDialog({ ...dialog, review: undefined, needsRefresh: true }); nameInput.current?.focus(); }}
            className="rounded border px-3 py-1">Rename</button>}
          {!dialog.review && !(dialog.operation === "delete" && dialog.tooLarge) && <button type="submit" disabled={busy ||
            (dialog.operation === "delete" && !dialog.consent) || (dialog.operation === "move" && dialog.destinationId === dialog.parentId)} className="rounded bg-stone-900 px-3 py-1 text-white">
            {submitting ? "Working…" : dialogLabels[dialog.operation].submit}</button>}
        </div>
      </form>
    </div>}
  </main>;
}
