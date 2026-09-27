import { useEffect, useRef, useState } from "react";
import { useBlocker } from "react-router";

import { loadDirectory, loadFile, type DirectoryListing, type LoadedFile, type RootAccess } from "./client";
import { commitFileSave, FileChangedError, FILE_LIMIT_FEEDBACK, FILE_SOURCE_LIMIT,
  sourceBytes, withinFileLimit } from "./editor-client";
import { useFileLease } from "./edit-lease";
import { MarkdownPreview } from "./MarkdownPreview";

type SaveStatus = "Unsaved" | "Saving" | "Saved" | "Couldn't save";
type EditorState = { source: string; savedSource: string; file: LoadedFile;
  listing: DirectoryListing; status: SaveStatus; conflict: boolean; rejected: boolean };

function protectedDraft(state: EditorState): boolean {
  return state.status !== "Saved" || state.source !== state.savedSource;
}

export function FileEditor({ fileId, access, file, listing, parentKey, onCommitted, flushRef }: {
  fileId: string; access: RootAccess; file: LoadedFile; listing: DirectoryListing;
  parentKey: Uint8Array; onCommitted: (file: LoadedFile, listing: DirectoryListing) => void;
  flushRef: React.RefObject<(() => Promise<boolean>) | null>;
}) {
  const [state, setState] = useState<EditorState>(() => ({ source: file.markdown,
    savedSource: file.markdown, file, listing,
    status: withinFileLimit(file.markdown) ? "Saved" : "Couldn't save", conflict: false, rejected: false }));
  const current = useRef(state);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [notice, setNotice] = useState("");
  const [refreshingLease, setRefreshingLease] = useState(false);
  const [leavingFailed, setLeavingFailed] = useState(false);
  const composing = useRef(false);
  const pending = useRef<Promise<boolean> | null>(null);
  const lease = useFileLease(fileId);
  const wasOwner = useRef(false);
  const needsFreshRead = useRef(false);
  const blocker = useBlocker(() => protectedDraft(current.current));

  function update(fn: (old: EditorState) => EditorState) {
    current.current = fn(current.current);
    setState(current.current);
  }

  async function reload(): Promise<boolean> {
    try {
      const freshListing = await loadDirectory(access, file.parentId, parentKey);
      const entry = freshListing.entries.find((candidate) => candidate.nodeId === fileId);
      if (!entry || entry.kind !== "file") throw new Error("File unavailable");
      const freshFile = await loadFile(access, fileId, file.parentId, parentKey, entry);
      update(() => ({ source: freshFile.markdown, savedSource: freshFile.markdown,
        file: freshFile, listing: freshListing,
        status: withinFileLimit(freshFile.markdown) ? "Saved" : "Couldn't save",
        conflict: false, rejected: false }));
      onCommitted(freshFile, freshListing);
      setNotice("");
      return true;
    } catch { setNotice("The File could not be reloaded. Your local draft is still here."); return false; }
  }

  async function doFlush(): Promise<boolean> {
    while (true) {
      const draft = current.current;
      if (draft.conflict || !withinFileLimit(draft.source)) {
        update((old) => ({ ...old, status: "Couldn't save" }));
        return false;
      }
      if (draft.source === draft.savedSource) {
        update((old) => ({ ...old, status: "Saved" }));
        return true;
      }
      if (!lease.owner) return false;
      update((old) => ({ ...old, status: "Saving" }));
      try {
        const saved = await commitFileSave({ access, fileId, file: draft.file, source: draft.source,
          listing: draft.listing, parentKey });
        update((old) => ({ ...old, file: saved.file, listing: saved.listing,
          savedSource: draft.source, status: old.source === draft.source ? "Saved" : "Unsaved" }));
        onCommitted(saved.file, saved.listing);
      } catch (error) {
        update((old) => ({ ...old, status: "Couldn't save", conflict: error instanceof FileChangedError }));
        setNotice(error instanceof FileChangedError
          ? "This File changed elsewhere. Your local draft was not overwritten."
          : "Your draft could not be saved. It remains in this tab.");
        return false;
      }
    }
  }

  function flush(): Promise<boolean> {
    if (pending.current) return pending.current;
    const work = doFlush();
    pending.current = work;
    void work.finally(() => { if (pending.current === work) pending.current = null; });
    return work;
  }
  flushRef.current = flush;
  useEffect(() => () => { flushRef.current = null; }, [flushRef]);

  useEffect(() => {
    if (state.status !== "Unsaved" || state.conflict || !lease.owner) return;
    const timer = window.setTimeout(() => { void flush(); }, 750);
    return () => window.clearTimeout(timer);
  }, [state.source, state.status, state.conflict, lease.owner]);

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (lease.owner) void flush();
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [lease.owner]);

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (protectedDraft(current.current)) { event.preventDefault(); event.returnValue = ""; }
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  useEffect(() => {
    if (blocker.state !== "blocked") { setLeavingFailed(false); return; }
    let active = true;
    void flush().then((saved) => {
      if (!active) return;
      if (saved) blocker.proceed();
      else setLeavingFailed(true);
    });
    return () => { active = false; };
  }, [blocker.state]);

  useEffect(() => {
    if (lease.owner && !wasOwner.current && needsFreshRead.current) {
      // A transferred lease starts from the latest verified File, not the read-only tab's old snapshot.
      needsFreshRead.current = false;
      void reload().then((ok) => { if (ok) setRefreshingLease(false); });
    }
    wasOwner.current = lease.owner;
  }, [lease.owner]);

  function acceptEdit(proposed: string, textarea?: HTMLTextAreaElement) {
    if (!lease.owner || refreshingLease || proposed === current.current.source) return;
    const size = sourceBytes(proposed), previous = sourceBytes(current.current.source);
    if (size > FILE_SOURCE_LIMIT && !(previous > FILE_SOURCE_LIMIT && size < previous)) {
      if (textarea) textarea.value = current.current.source;
      update((old) => ({ ...old, rejected: true }));
      return;
    }
    setNotice("");
    update((old) => ({ ...old, source: proposed, rejected: false,
      status: old.conflict || size > FILE_SOURCE_LIMIT ? "Couldn't save"
        : proposed === old.savedSource ? "Saved" : "Unsaved" }));
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

  async function overwrite() {
    if (!withinFileLimit(current.current.source) || !lease.owner || pending.current) return;
    const source = current.current.source;
    update((old) => ({ ...old, status: "Saving" }));
    try {
      const latestListing = await loadDirectory(access, file.parentId, parentKey);
      const entry = latestListing.entries.find((item) => item.nodeId === fileId);
      if (!entry || entry.kind !== "file") throw new Error("File unavailable");
      const latestFile = await loadFile(access, fileId, file.parentId, parentKey, entry);
      const saved = await commitFileSave({ access, fileId, file: latestFile, listing: latestListing, parentKey, source });
      update((old) => ({ ...old, file: saved.file, listing: saved.listing, savedSource: source,
        conflict: false, status: old.source === source ? "Saved" : "Unsaved" }));
      onCommitted(saved.file, saved.listing);
      setNotice("");
    } catch (error) {
      update((old) => ({ ...old, status: "Couldn't save", conflict: error instanceof FileChangedError || old.conflict }));
      setNotice("Overwrite did not complete. Your local draft is still here; review the latest File before retrying.");
    }
  }

  const bytes = sourceBytes(state.source);
  const oversized = bytes > FILE_SOURCE_LIMIT;
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
      <button type="button" className="ml-3 underline" onClick={() => void reload().then((ok) => {
        if (ok) setRefreshingLease(false);
      })}>Retry opening File</button>
    </div>}
    {lease.transferRequested && <div className="mt-3 rounded border p-3" role="dialog" aria-label="Transfer editing">
      <p>Another tab wants to edit this File. Save your changes or explicitly discard them first.</p>
      <div className="mt-2 flex gap-3">
        <button type="button" onClick={() => void flush().then((saved) => { if (saved) void lease.finishTransfer(); })}>Save and transfer</button>
        <button type="button" disabled={state.status === "Saving"} onClick={() => {
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
      <button type="button" onClick={() => blocker.proceed()}>Discard and leave</button>
    </div>}
    {state.status === "Couldn't save" && <div className="mt-3 rounded border p-3" role="group" aria-label="Unsaved draft options">
      {oversized && <p>This File is over the limit. It is readable and exportable; reduce content to save.</p>}
      {state.conflict && <p>Review the conflicting File before choosing whether to overwrite it.</p>}
      <div className="mt-2 flex flex-wrap gap-3">
        <button type="button" onClick={() => void copyDraft()}>Copy local draft</button>
        <button type="button" onClick={downloadDraft}>Download local draft</button>
        <button type="button" onClick={() => void reload()}>Reload and discard local draft</button>
        {state.conflict && !oversized && lease.owner && <button type="button" onClick={() => void overwrite()}>Confirm overwrite</button>}
        {oversized && <button type="button" onClick={() => document.getElementById(`source-${fileId}`)?.focus()}>Reduce content</button>}
        {!oversized && !state.conflict && lease.owner && <button type="button" onClick={() => void flush()}>Retry save</button>}
      </div>
    </div>}
    <div className="mt-6 flex gap-3 lg:hidden" role="group" aria-label="File view">
      <button type="button" aria-pressed={view === "edit"} onClick={() => setView("edit")}>Edit</button>
      <button type="button" aria-pressed={view === "preview"} onClick={() => setView("preview")}>Preview</button>
    </div>
    <div className="mt-4 grid min-h-[50vh] gap-4 lg:grid-cols-2">
      <section className={`${view === "preview" ? "hidden lg:block" : ""}`} aria-label="Editor">
        <h2 className="mb-2 font-medium">Markdown source</h2>
        <textarea id={`source-${fileId}`} readOnly={!lease.owner || refreshingLease} value={state.source}
          aria-label="Markdown source" onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={(event) => { composing.current = false; acceptEdit(event.currentTarget.value, event.currentTarget); }}
          onPaste={(event) => {
            if (!lease.owner || refreshingLease) { event.preventDefault(); return; }
            const target = event.currentTarget;
            const proposed = state.source.slice(0, target.selectionStart) + event.clipboardData.getData("text/plain") +
              state.source.slice(target.selectionEnd);
            if (!withinFileLimit(proposed) && !(sourceBytes(state.source) > FILE_SOURCE_LIMIT &&
                sourceBytes(proposed) < sourceBytes(state.source))) {
              event.preventDefault(); update((old) => ({ ...old, rejected: true }));
            }
          }}
          onChange={(event) => { if (!composing.current) acceptEdit(event.currentTarget.value, event.currentTarget); }}
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
