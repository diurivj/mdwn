import { useEffect, useRef, useState } from "react";
import { FILE_SOURCE_FEEDBACK, FILE_SOURCE_LIMIT, fileSourceBytes } from "~/crypto/file-source";

import { CommentsPanel } from "~/comments/CommentsPanel";

import { MarkdownPreview } from "./MarkdownPreview";
import type { FilesSnapshot } from "./navigation-client";
import { useFileDraft } from "./useFileDraft";
import type { FileDocument } from "./file-client";
import type { DirectoryListing } from "./client";

function RightPaneToggle({ view, onShowPreview, onShowComments }: {
  view: "edit" | "preview" | "comments"; onShowPreview: () => void; onShowComments: () => void;
}) {
  return <div className="mb-2 hidden items-center gap-2 lg:flex">
    <button type="button" aria-pressed={view !== "comments"} onClick={onShowPreview}
      className="rounded border px-2 py-0.5 text-sm">Preview</button>
    <button type="button" aria-pressed={view === "comments"} onClick={onShowComments}
      className="rounded border px-2 py-0.5 text-sm">Comments</button>
  </div>;
}

export function FileEditor({ fileId, snapshot, view, showEdit, onShowPreview, onShowComments, onCurrent, onStructuralReady, structuralBusy, onNavigationStart }: {
  fileId: string; snapshot: FilesSnapshot; view: "edit" | "preview" | "comments"; showEdit: () => void;
  onShowPreview: () => void; onShowComments: () => void;
  onCurrent: (file: FileDocument, listing: DirectoryListing | null) => void;
  onStructuralReady: (ready: boolean) => void; structuralBusy: boolean; onNavigationStart: () => void;
}) {
  const { draft, status, conflict, rejected, edit, composition, blocker, navigationFailed,
    loading, reload, proposeOverwrite, overwriteProposal, confirmOverwrite, cancelOverwrite, lease } = useFileDraft(fileId, snapshot, onCurrent, onNavigationStart);
  const composing = useRef(false);
  const sourceInput = useRef<HTMLTextAreaElement>(null);
  const [compositionValue, setCompositionValue] = useState<string | null>(null);
  useEffect(() => {
    onStructuralReady(status === "Saved" && compositionValue === null && !loading && !overwriteProposal);
  }, [status, compositionValue, loading, overwriteProposal, onStructuralReady]);
  const canEdit = snapshot.file?.canEdit === true;
  const editingBlocked = !canEdit || structuralBusy || !lease.editable || loading || overwriteProposal !== null;
  const bytes = fileSourceBytes(draft);
  const [copyFailed, setCopyFailed] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(draft); setCopyFailed(false); }
    catch { setCopyFailed(true); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([draft], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "local-draft.md"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
  return <><p role="status" aria-label="File save status" className="mt-3">{status}</p>
    {!canEdit && <p role="status">Read-only — you can comment</p>}
    {canEdit && !lease.editable && <div role="status" className="mt-2">
      {lease.state === "unavailable" ? "Editing unavailable. This browser could not coordinate File editing." :
        lease.state === "checking" ? "Checking editing access…" :
          lease.state === "transferring" ? "Saving before transferring editing…" : "Read-only — this File is being edited in another tab."}
      {lease.state === "read-only" && <button type="button" disabled={lease.requested} onClick={lease.request} className="ml-3 underline">
        {lease.requested ? "Requesting editing…" : "Edit here"}</button>}
    </div>}
    {status === "Couldn't save" && <section aria-label="Draft recovery" className="mt-3 rounded border border-amber-300 p-3">
      {conflict && <p role="alert">This File changed on another device. Your local draft is intact.</p>}
      {bytes > FILE_SOURCE_LIMIT && <p role="alert">This File is over the source limit. Reduce content to save.</p>}
      <div className="mt-2 flex flex-wrap gap-3">
        <button type="button" onClick={() => void copy()}>Copy local draft</button>
        <button type="button" onClick={download}>Download local draft</button>
        <button type="button" disabled={loading} onClick={() => void reload()}>Reload and discard</button>
        {bytes > FILE_SOURCE_LIMIT && <button type="button" onClick={() => {
          showEdit(); requestAnimationFrame(() => sourceInput.current?.focus());
        }}>Reduce content</button>}
        {canEdit && conflict && <button type="button" disabled={loading || !lease.editable || bytes > FILE_SOURCE_LIMIT} onClick={() => void proposeOverwrite()}>Overwrite…</button>}
      </div>
      {copyFailed && <p role="alert">Copy failed. Download your local draft instead.</p>}
    </section>}
    <div className="mt-4 grid min-h-[50vh] gap-4 lg:grid-cols-2">
    <section className={view === "edit" ? "" : "hidden lg:block"} aria-label="Editor">
      <h2 className="mb-2 font-medium">Markdown source</h2>
      <textarea ref={sourceInput} readOnly={editingBlocked} value={compositionValue ?? draft}
        onChange={(event) => {
          if (editingBlocked) return;
          if (composing.current) setCompositionValue(event.target.value);
          else edit(event.target.value);
        }}
        onCompositionStart={(event) => {
          if (editingBlocked) return;
          composing.current = true; composition(true); setCompositionValue(event.currentTarget.value);
        }}
        onCompositionEnd={(event) => {
          const value = event.currentTarget.value;
          composing.current = false; composition(false); setCompositionValue(null);
          if (editingBlocked || !edit(value)) event.currentTarget.value = draft;
        }}
        onPaste={(event) => {
          if (editingBlocked) { event.preventDefault(); return; }
          if (composing.current) return;
          event.preventDefault();
          const textarea = event.currentTarget;
          const text = event.clipboardData.getData("text/plain");
          if (!text) return; // Non-text clipboard contents must not delete the selection.
          const start = textarea.selectionStart;
          const next = draft.slice(0, start) + text + draft.slice(textarea.selectionEnd);
          if (edit(next)) {
            // Commit the accepted value before its caret. React's matching value
            // update preserves it, with no delayed work to override newer editing.
            textarea.value = next;
            textarea.setSelectionRange(start + text.length, start + text.length);
          }
        }} aria-label="Markdown source"
        className="h-[50vh] w-full resize-none rounded border border-stone-300 bg-white p-3 font-mono text-sm" />
      {bytes >= FILE_SOURCE_FEEDBACK && <p role="status">{bytes.toLocaleString("en-US")} / 262,144</p>}
      {(bytes === FILE_SOURCE_LIMIT || rejected) && <p role="status">File limit reached</p>}
    </section>
    <section className={view === "comments" ? "hidden" : view === "preview" ? "" : "hidden lg:block"} aria-label="Preview">
      <RightPaneToggle view={view} onShowPreview={onShowPreview} onShowComments={onShowComments} />
      <h2 className="mb-2 font-medium">Preview</h2>
      <div className="min-h-[50vh] rounded border border-stone-300 bg-white p-3"><MarkdownPreview source={draft} /></div>
    </section>
    {view === "comments" && <section className="min-h-[50vh]" aria-label="Comment inspector">
      <RightPaneToggle view={view} onShowPreview={onShowPreview} onShowComments={onShowComments} />
      <CommentsPanel fileId={fileId} snapshot={snapshot} />
    </section>}
  </div>
    {lease.transferPrompt && <div role="dialog" aria-modal="true" aria-label="Transfer editing" className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
      <div className="max-w-md rounded bg-white p-5"><p>Another tab requested editing. Save your work or explicitly discard it before transferring.</p>
        <div className="mt-4 flex flex-wrap gap-3"><button type="button" onClick={() => void lease.transfer()}>Save and transfer</button>
          <button type="button" onClick={() => void lease.transfer(true)}>Discard draft and transfer</button>
          <button type="button" onClick={lease.keepEditing}>Keep editing</button></div>
      </div>
    </div>}
    {overwriteProposal && <div role="dialog" aria-modal="true" aria-label="Confirm overwrite" className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
      <div className="max-w-md rounded bg-white p-5"><p>Replace the current File with your local draft? Nothing will be merged.</p>
        <div className="mt-4 flex gap-3"><button type="button" onClick={cancelOverwrite}>Cancel</button>
          <button type="button" disabled={bytes > FILE_SOURCE_LIMIT} onClick={() => void confirmOverwrite()}>Overwrite File</button></div>
      </div>
    </div>}
    {blocker.state === "blocked" && (navigationFailed ?
      <div role="dialog" aria-modal="true" aria-label="Unsaved File" className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
        <div className="max-w-md rounded bg-white p-5"><p>Your draft couldn't be saved. Keep editing, or explicitly discard it before leaving.</p>
          <div className="mt-4 flex gap-3"><button type="button" onClick={() => blocker.reset()}>Keep editing</button>
            <button type="button" onClick={() => blocker.proceed()}>Discard draft and leave</button></div>
        </div>
      </div> : <p role="status">Saving before leaving…</p>)}
  </>;
}
