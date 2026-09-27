import { useEffect, useRef, useState } from "react";
import { useBlocker, useNavigation } from "react-router";

import { loadDirectory, loadFile, type DirectoryListing, type LoadedFile, type RootAccess } from "./client";
import { commitFileSave, FileChangedError, FILE_LIMIT_FEEDBACK, FILE_SOURCE_LIMIT,
  sourceBytes, withinFileLimit } from "./editor-client";
import { useFileLease } from "./edit-lease";
import { MarkdownPreview } from "./MarkdownPreview";

type SaveStatus = "Unsaved" | "Saving" | "Saved" | "Couldn't save";
type Operation = "save" | "overwrite" | "reload";
type EditorState = { source: string; savedSource: string; file: LoadedFile;
  listing: DirectoryListing; status: SaveStatus; conflict: boolean; rejected: boolean; busy: Operation | null };

type Pending = { kind: Operation; promise: Promise<boolean> };

function acceptableEdit(proposed: string, previous: string): boolean {
  const size = sourceBytes(proposed), before = sourceBytes(previous);
  return size <= FILE_SOURCE_LIMIT || (before > FILE_SOURCE_LIMIT && size < before);
}

export function FileEditor({ fileId, access, file, listing, parentKey, onCommitted, flushRef,
  editingFrozen, authorityVerified }: {
  fileId: string; access: RootAccess; file: LoadedFile; listing: DirectoryListing;
  parentKey: Uint8Array; onCommitted: (file: LoadedFile, listing: DirectoryListing) => void;
  flushRef: React.RefObject<(() => Promise<boolean>) | null>;
  editingFrozen: boolean; authorityVerified: boolean;
}) {
  const [state, setState] = useState<EditorState>(() => ({ source: file.markdown,
    savedSource: file.markdown, file, listing, busy: null,
    status: withinFileLimit(file.markdown) ? "Saved" : "Couldn't save", conflict: false, rejected: false }));
  const current = useRef(state);
  const [composition, setComposition] = useState<string | null>(null);
  const [compositionEpoch, setCompositionEpoch] = useState(0);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [notice, setNotice] = useState("");
  const [refreshingLease, setRefreshingLease] = useState(false);
  const [leavingFailed, setLeavingFailed] = useState(false);
  const composing = useRef(false);
  const pending = useRef<Pending | null>(null);
  const alive = useRef(true);
  // Async saves and window shortcuts must use today's verified authority, not their starting render.
  const currentAuthority = useRef(authorityVerified);
  currentAuthority.current = authorityVerified;
  const lease = useFileLease(fileId, () => pending.current?.promise);
  const wasOwner = useRef(false);
  const needsFreshRead = useRef(false);
  const protectedDraft = () => Boolean(pending.current || composing.current ||
    current.current.status !== "Saved" || current.current.source !== current.current.savedSource);
  const blocker = useBlocker(protectedDraft);
  const navigation = useNavigation();
  // An approved navigation leaves the old route mounted while its clientLoader runs.
  // Neither a visual control nor a synthetic late input may accept a disposable draft.
  const editingLocked = editingFrozen || !authorityVerified || navigation.state !== "idle" ||
    blocker.state === "proceeding" || !lease.owner || refreshingLease || state.busy === "reload";

  function update(fn: (old: EditorState) => EditorState) {
    if (!alive.current) return;
    current.current = fn(current.current);
    setState(current.current);
  }

  // A verified clientLoader may advance the parent listing independently of the File (e.g. same-tab rename).
  // Never take a stale listing, and never replace an in-memory draft with a changed representation.
  useEffect(() => {
    const old = current.current;
    if (file.parentId !== old.file.parentId || listing.directoryId !== file.parentId) return;
    if (file.revision < old.file.revision) return;
    if (file.representationId === old.file.representationId && file.revision === old.file.revision) {
      const oldEntry = old.listing.entries.find((entry) => entry.nodeId === fileId);
      const entry = listing.entries.find((candidate) => candidate.nodeId === fileId);
      if (entry?.kind === "file" && entry.keyEnvelope === oldEntry?.keyEnvelope &&
          listing.entriesRevision > old.listing.entriesRevision) {
        update((previous) => ({ ...previous, listing }));
      }
    } else if (!pending.current && !composing.current) {
      if (old.source === old.savedSource && old.status === "Saved") {
        update((previous) => ({ ...previous, source: file.markdown, savedSource: file.markdown,
          file, listing, status: withinFileLimit(file.markdown) ? "Saved" : "Couldn't save",
          conflict: false, rejected: false }));
      } else if (!old.conflict) {
        update((previous) => ({ ...previous, conflict: true, status: "Couldn't save" }));
        setNotice("This File changed elsewhere. Your local draft was not overwritten.");
      }
    }
  }, [fileId, file, listing]);

  /** One exclusive operation covers encryption, the Worker mutation, and verification reads. */
  function exclusive(kind: Operation, action: () => Promise<boolean>): Promise<boolean> {
    if (pending.current) return pending.current.promise;
    update((old) => ({ ...old, busy: kind, status: kind === "reload" ? old.status : "Saving" }));
    const work = Promise.resolve().then(action).finally(() => {
      if (pending.current?.promise !== work) return;
      pending.current = null;
      update((old) => ({ ...old, busy: null, status: old.status === "Saving"
        ? old.conflict || !withinFileLimit(old.source) ? "Couldn't save"
          : old.source === old.savedSource ? "Saved" : "Unsaved"
        : old.status }));
    });
    pending.current = { kind, promise: work };
    return work;
  }

  function reload(): Promise<boolean> {
    if (!authorityVerified) return Promise.resolve(false);
    if (pending.current) return pending.current.promise;
    return exclusive("reload", async () => {
      try {
        const parentId = current.current.file.parentId;
        const freshListing = await loadDirectory(access, parentId, parentKey);
        const entry = freshListing.entries.find((candidate) => candidate.nodeId === fileId);
        if (!entry || entry.kind !== "file") throw new Error("File unavailable");
        const freshFile = await loadFile(access, fileId, parentId, parentKey, entry);
        if (!alive.current || !lease.isOwner()) return false;
        update((old) => ({ ...old, source: freshFile.markdown, savedSource: freshFile.markdown,
          file: freshFile, listing: freshListing,
          status: withinFileLimit(freshFile.markdown) ? "Saved" : "Couldn't save",
          conflict: false, rejected: false }));
        onCommitted(freshFile, freshListing);
        setNotice("");
        return true;
      } catch {
        if (alive.current) setNotice("The File could not be reloaded. Your local draft is still here.");
        return false;
      }
    });
  }

  async function doFlush(): Promise<boolean> {
    while (alive.current && currentAuthority.current && lease.isOwner()) {
      const draft = current.current;
      if (draft.conflict || !withinFileLimit(draft.source)) {
        update((old) => ({ ...old, status: "Couldn't save" }));
        return false;
      }
      if (draft.source === draft.savedSource && draft.status !== "Couldn't save") return true;
      try {
        const saved = await commitFileSave({ access, fileId, file: draft.file, source: draft.source,
          listing: draft.listing, parentKey });
        if (!alive.current || !lease.isOwner()) return false;
        update((old) => ({ ...old, file: saved.file, listing: saved.listing,
          savedSource: draft.source, status: "Saving" }));
        onCommitted(saved.file, saved.listing);
        setNotice("");
      } catch (error) {
        if (alive.current) {
          update((old) => ({ ...old, status: "Couldn't save", conflict: error instanceof FileChangedError }));
          setNotice(error instanceof FileChangedError
            ? "This File changed elsewhere. Your local draft was not overwritten."
            : "Your draft could not be saved. It remains in this tab.");
        }
        return false;
      }
    }
    return false;
  }

  function flush(): Promise<boolean> {
    if (!currentAuthority.current || !alive.current || composing.current) return Promise.resolve(false);
    if (pending.current) return pending.current.promise.then(() =>
      alive.current && currentAuthority.current ? flushRef.current?.() ?? false : false);
    if (current.current.source === current.current.savedSource && current.current.status === "Saved") return Promise.resolve(true);
    if (!lease.isOwner()) return Promise.resolve(false);
    return exclusive("save", doFlush);
  }
  flushRef.current = flush;
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; flushRef.current = null; };
  }, [flushRef]);

  useEffect(() => {
    if (!authorityVerified || editingFrozen || state.status !== "Unsaved" || state.conflict ||
        !lease.owner || composing.current || pending.current) return;
    const timer = window.setTimeout(() => { void flush(); }, 750);
    return () => window.clearTimeout(timer);
  }, [state.source, state.status, state.conflict, lease.owner, state.busy, compositionEpoch,
    authorityVerified, editingFrozen]);

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (lease.isOwner()) void flushRef.current?.();
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [lease.owner]);

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (protectedDraft()) { event.preventDefault(); event.returnValue = ""; }
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  useEffect(() => {
    if (blocker.state !== "blocked") { setLeavingFailed(false); return; }
    let active = true;
    void flush().then((saved) => {
      if (!active) return;
      if (saved && !protectedDraft()) blocker.proceed();
      else setLeavingFailed(true);
    });
    return () => { active = false; };
  }, [blocker.state]);

  useEffect(() => {
    if (lease.owner && !wasOwner.current && needsFreshRead.current) {
      // A transferred lease starts from the latest verified File, not the read-only tab's old snapshot.
      needsFreshRead.current = false;
      void reload().then((ok) => { if (ok && alive.current) setRefreshingLease(false); });
    }
    wasOwner.current = lease.owner;
  }, [lease.owner]);

  function restoreTextarea(textarea: HTMLTextAreaElement) {
    const position = Math.min(textarea.selectionStart, current.current.source.length);
    textarea.value = current.current.source;
    textarea.setSelectionRange(position, position);
  }

  function acceptEdit(proposed: string, textarea?: HTMLTextAreaElement) {
    if (editingLocked || !lease.isOwner() || pending.current?.kind === "reload") {
      if (textarea) restoreTextarea(textarea);
      return;
    }
    if (proposed === current.current.source) return;
    if (!acceptableEdit(proposed, current.current.source)) {
      if (textarea) restoreTextarea(textarea);
      update((old) => ({ ...old, rejected: true }));
      return;
    }
    setNotice("");
    update((old) => ({ ...old, source: proposed, rejected: false,
      status: old.conflict || !withinFileLimit(proposed) ? "Couldn't save"
        : old.busy === "save" || old.busy === "overwrite" ? "Saving"
          : proposed === old.savedSource && old.status !== "Couldn't save" ? "Saved" : "Unsaved" }));
  }

  async function copyDraft() {
    try { await navigator.clipboard.writeText(current.current.source); setNotice("Local draft copied."); }
    catch { setNotice("Copy unavailable. Download your local draft instead."); }
  }

  function downloadDraft() {
    const url = URL.createObjectURL(new Blob([current.current.source], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "draft.md";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function overwrite(): Promise<boolean> {
    if (!currentAuthority.current || editingFrozen) return Promise.resolve(false);
    if (pending.current) return pending.current.promise;
    if (!withinFileLimit(current.current.source) || !lease.isOwner() || composing.current) return Promise.resolve(false);
    return exclusive("overwrite", async () => {
      const source = current.current.source;
      try {
        const parentId = current.current.file.parentId;
        const latestListing = await loadDirectory(access, parentId, parentKey);
        const entry = latestListing.entries.find((item) => item.nodeId === fileId);
        if (!entry || entry.kind !== "file") throw new Error("File unavailable");
        const latestFile = await loadFile(access, fileId, parentId, parentKey, entry);
        if (!alive.current || !currentAuthority.current || !lease.isOwner()) return false;
        const saved = await commitFileSave({ access, fileId, file: latestFile, listing: latestListing, parentKey, source });
        if (!alive.current || !lease.isOwner()) return false;
        update((old) => ({ ...old, file: saved.file, listing: saved.listing, savedSource: source,
          conflict: false, status: "Saving" }));
        onCommitted(saved.file, saved.listing);
        setNotice("");
        // Editing may have continued while the overwrite was in flight; flush that draft next.
        return true;
      } catch (error) {
        if (alive.current) {
          update((old) => ({ ...old, status: "Couldn't save", conflict: error instanceof FileChangedError || old.conflict }));
          setNotice("Overwrite did not complete. Your local draft is still here; review the latest File before retrying.");
        }
        return false;
      }
    });
  }

  const bytes = sourceBytes(state.source);
  const oversized = bytes > FILE_SOURCE_LIMIT;
  const busy = state.busy !== null;
  return <>
    <p className="mt-3 text-sm" role="status" aria-label="Save status">{state.status}</p>
    {(bytes >= FILE_LIMIT_FEEDBACK || state.rejected) && <p className="text-sm" role="status">
      {bytes} / {FILE_SOURCE_LIMIT} bytes{bytes >= FILE_SOURCE_LIMIT || state.rejected ? " — File limit reached" : ""}
    </p>}
    {notice && <p role="alert" className="mt-2 text-rose-700">{notice}</p>}
    {!lease.owner && <div className="mt-3 rounded border p-3" role="status">
      <p>Read-only in this tab. Another tab may be editing this File.</p>
      <button type="button" className="underline" disabled={lease.requesting}
        onClick={() => { needsFreshRead.current = true; setRefreshingLease(true); void lease.requestTransfer(); }}>
        {lease.requesting ? "Requesting edit lease…" : "Edit here"}</button>
      {lease.requesting && <button type="button" className="ml-3 underline" onClick={() => {
        lease.cancelRequest(); setRefreshingLease(false); needsFreshRead.current = false;
      }}>Cancel request</button>}
    </div>}
    {lease.owner && refreshingLease && <div role="status" className="mt-3">
      Refreshing the latest File before editing…
      <button type="button" className="ml-3 underline" disabled={busy} onClick={() => void reload().then((ok) => {
        if (ok && alive.current) setRefreshingLease(false);
      })}>Retry opening File</button>
    </div>}
    {lease.transferRequested && <div className="mt-3 rounded border p-3" role="dialog" aria-label="Transfer editing">
      <p>Another tab wants to edit this File. Save your changes or explicitly discard them first.</p>
      <div className="mt-2 flex gap-3">
        <button type="button" disabled={busy || editingFrozen || !authorityVerified || composing.current} onClick={() => void flush().then((saved) => {
          if (saved && !protectedDraft() && lease.isOwner()) void lease.finishTransfer();
        })}>Save and transfer</button>
        <button type="button" disabled={busy || editingFrozen || !authorityVerified || composing.current} onClick={() => {
          if (pending.current || !lease.isOwner()) return;
          update((old) => ({ ...old, source: old.savedSource,
            status: withinFileLimit(old.savedSource) ? "Saved" : "Couldn't save", conflict: false }));
          void lease.finishTransfer();
        }}>Discard and transfer</button>
        <button type="button" onClick={lease.keepEditing}>Keep editing</button>
      </div>
    </div>}
    {leavingFailed && blocker.state === "blocked" && <div role="dialog" aria-label="Unsaved File" className="mt-3 rounded border p-3">
      <p>Your File could not be saved. Stay to keep your draft, or explicitly discard it to leave.</p>
      <button type="button" onClick={() => blocker.reset()}>Stay</button>
      <button type="button" disabled={busy} onClick={() => { if (!pending.current) blocker.proceed(); }}>Discard and leave</button>
    </div>}
    {(state.status === "Couldn't save" || !authorityVerified) && <div className="mt-3 rounded border p-3" role="group" aria-label="Unsaved draft options">
      {oversized && <p>This File is over the limit. It is readable and exportable; reduce content to save.</p>}
      {state.conflict && <p>Review the conflicting File before choosing whether to overwrite it.</p>}
      <div className="mt-2 flex flex-wrap gap-3">
        <button type="button" onClick={() => void copyDraft()}>Copy local draft</button>
        <button type="button" onClick={downloadDraft}>Download local draft</button>
        <button type="button" disabled={busy || editingFrozen || !authorityVerified} onClick={() => void reload()}>Reload and discard local draft</button>
        {state.conflict && !oversized && lease.owner && <button type="button" disabled={busy || editingFrozen || !authorityVerified}
          onClick={() => void overwrite().then((ok) => { if (ok && current.current.source !== current.current.savedSource) void flush(); })}>
          Confirm overwrite</button>}
        {oversized && <button type="button" onClick={() => document.getElementById(`source-${fileId}`)?.focus()}>Reduce content</button>}
        {!oversized && !state.conflict && lease.owner && <button type="button" disabled={busy || editingFrozen || !authorityVerified}
          onClick={() => void flush()}>Retry save</button>}
      </div>
    </div>}
    <div className="mt-6 flex gap-3 lg:hidden" role="group" aria-label="File view">
      <button type="button" aria-pressed={view === "edit"} onClick={() => setView("edit")}>Edit</button>
      <button type="button" aria-pressed={view === "preview"} onClick={() => setView("preview")}>Preview</button>
    </div>
    <div className="mt-4 grid min-h-[50vh] gap-4 lg:grid-cols-2">
      <section className={`${view === "preview" ? "hidden lg:block" : ""}`} aria-label="Editor">
        <h2 className="mb-2 font-medium">Markdown source</h2>
        <textarea id={`source-${fileId}`} readOnly={editingLocked}
          value={composition ?? state.source} aria-label="Markdown source"
          onCompositionStart={(event) => {
            if (editingLocked || !lease.isOwner()) { event.preventDefault(); return; }
            composing.current = true; setComposition(event.currentTarget.value);
          }}
          onCompositionEnd={(event) => {
            const proposed = event.currentTarget.value;
            composing.current = false;
            setComposition(null);
            acceptEdit(proposed, event.currentTarget);
            // The prior debounce may have fired while composing, even when the final edit is
            // unchanged or rejected. Re-arm it for the last accepted source, never IME bytes.
            setCompositionEpoch((epoch) => epoch + 1);
          }}
          onPaste={(event) => {
            if (editingLocked || !lease.isOwner() || composing.current) {
              event.preventDefault(); return;
            }
            const target = event.currentTarget;
            const source = current.current.source;
            const proposed = source.slice(0, target.selectionStart) + event.clipboardData.getData("text/plain") +
              source.slice(target.selectionEnd);
            if (!acceptableEdit(proposed, source)) {
              event.preventDefault(); update((old) => ({ ...old, rejected: true }));
            }
          }}
          onChange={(event) => {
            if (editingLocked) { restoreTextarea(event.currentTarget); return; }
            if (composing.current) setComposition(event.currentTarget.value);
            else acceptEdit(event.currentTarget.value, event.currentTarget);
          }}
          className="h-[50vh] w-full resize-none rounded border border-stone-300 bg-white p-3 font-mono text-sm" />
      </section>
      <section className={`${view === "edit" ? "hidden lg:block" : ""}`} aria-label="Preview">
        <h2 className="mb-2 font-medium">Preview</h2>
        <div className="min-h-[50vh] rounded border border-stone-300 bg-white p-3">
          <MarkdownPreview source={state.source} />
        </div>
      </section>
    </div>
  </>;
}
