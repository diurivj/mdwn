import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { FILE_SOURCE_FEEDBACK, FILE_SOURCE_LIMIT, fileSourceBytes } from "~/shared/crypto/file-source";

import { CommentsPanel } from "~/comments/comments-panel";
import { cx } from "~/ui/cx";
import { CommentIcon, CopyIcon, DownloadIcon, EyeIcon, RefreshIcon } from "~/ui/icons";
import { buttonClass, noticeClass } from "~/ui/styles";

import { MarkdownPreview } from "./markdown-preview";
import type { FilesSnapshot } from "./navigation-client";
import { type SaveStatus, useFileDraft } from "./use-file-draft";
import type { FileDocument } from "../shared/tree/file-client";
import type { DirectoryListing } from "../shared/tree/client";

/** Rendering Markdown is the costly part of a keystroke; it re-renders only when its source changes. */
const Preview = memo(function Preview({ source }: { source: string }) {
  return <MarkdownPreview source={source} />;
});

const statusTone: Record<SaveStatus, string> = {
  Saved: "bg-success-soft text-success",
  Unsaved: "bg-warning-soft text-warning",
  Saving: "bg-warning-soft text-warning",
  "Couldn't save": "bg-danger-soft text-danger",
};

function RightPaneToggle({
  view,
  onShowPreview,
  onShowComments,
}: {
  view: "edit" | "preview" | "comments";
  onShowPreview: () => void;
  onShowComments: () => void;
}) {
  return (
    <div className="hidden max-w-full flex-wrap items-center border border-line bg-cream lg:flex">
      <button
        type="button"
        aria-pressed={view !== "comments"}
        onClick={onShowPreview}
        className="eyebrow inline-flex items-center gap-1.5 px-3 py-2 text-ink-soft transition-colors hover:bg-paper aria-pressed:bg-ink aria-pressed:text-paper"
      >
        <EyeIcon className="size-3.5" />
        Preview
      </button>
      <button
        type="button"
        aria-pressed={view === "comments"}
        onClick={onShowComments}
        className="eyebrow inline-flex items-center gap-1.5 px-3 py-2 text-ink-soft transition-colors hover:bg-paper aria-pressed:bg-ink aria-pressed:text-paper"
      >
        <CommentIcon className="size-3.5" />
        Comments
      </button>
    </div>
  );
}

export function FileEditor({
  fileId,
  snapshot,
  view,
  showEdit,
  onShowPreview,
  onShowComments,
  onCurrent,
  onStructuralReady,
  structuralBusy,
  onNavigationStart,
}: {
  fileId: string;
  snapshot: FilesSnapshot;
  view: "edit" | "preview" | "comments";
  showEdit: () => void;
  onShowPreview: () => void;
  onShowComments: () => void;
  onCurrent: (file: FileDocument, listing: DirectoryListing | null) => void;
  onStructuralReady: (ready: boolean) => void;
  structuralBusy: boolean;
  onNavigationStart: () => void;
}) {
  const {
    draft,
    status,
    conflict,
    rejected,
    edit,
    composition,
    blocker,
    navigationFailed,
    loading,
    reload,
    proposeOverwrite,
    overwriteProposal,
    confirmOverwrite,
    cancelOverwrite,
    lease,
  } = useFileDraft(fileId, snapshot, onCurrent, onNavigationStart);
  const composing = useRef(false);
  const sourceInput = useRef<HTMLTextAreaElement>(null);
  const [compositionValue, setCompositionValue] = useState<string | null>(null);
  useEffect(() => {
    onStructuralReady(status === "Saved" && compositionValue === null && !loading && !overwriteProposal);
  }, [status, compositionValue, loading, overwriteProposal, onStructuralReady]);
  const canEdit = snapshot.file?.canEdit === true;
  const editingBlocked = !canEdit || structuralBusy || !lease.editable || loading || overwriteProposal !== null;
  const bytes = fileSourceBytes(draft);
  // Typing stays immediate; the preview follows as soon as the browser is free.
  const previewSource = useDeferredValue(draft);
  const words = useMemo(() => countWords(previewSource), [previewSource]);
  const [copyFailed, setCopyFailed] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(draft);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([draft], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "local-draft.md";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
  return (
    <>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        {canEdit && <p className="hidden text-xs text-muted sm:block">Saves automatically · ⌘S or Ctrl+S</p>}
        {!canEdit && (
          <p role="status" className="eyebrow border border-line bg-cream px-3 py-1.5 text-ink-soft">
            Read-only — you can comment
          </p>
        )}
        {canEdit && !lease.editable && (
          <div
            role="status"
            className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 border border-line bg-cream px-3 py-1.5 font-mono text-[12px] text-ink-soft"
          >
            {lease.state === "unavailable"
              ? "Editing unavailable. This browser could not coordinate File editing."
              : lease.state === "checking"
                ? "Checking editing access…"
                : lease.state === "transferring"
                  ? "Saving before transferring editing…"
                  : "Read-only — this File is being edited in another tab."}
            {lease.state === "read-only" && (
              <button
                type="button"
                disabled={lease.requested}
                onClick={lease.request}
                className="font-medium text-accent underline underline-offset-4 disabled:opacity-50"
              >
                {lease.requested ? "Requesting editing…" : "Edit here"}
              </button>
            )}
          </div>
        )}
        <p
          role="status"
          aria-label="File save status"
          className={cx(
            "eyebrow ml-auto inline-flex items-center gap-2 border border-current/20 px-3 py-1.5 transition-colors",
            statusTone[status],
          )}
        >
          <span
            aria-hidden="true"
            className={cx("size-1.5 rounded-full bg-current", status === "Saving" && "animate-pulse")}
          />
          {status}
        </p>
      </div>
      {status === "Couldn't save" && (
        <section aria-label="Draft recovery" className={cx(noticeClass("warning"), "mt-4 space-y-3")}>
          {conflict && <p role="alert">This File changed on another device. Your local draft is intact.</p>}
          {bytes > FILE_SOURCE_LIMIT && <p role="alert">This File is over the source limit. Reduce content to save.</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void copy()} className={buttonClass("secondary", "sm")}>
              <CopyIcon />
              Copy local draft
            </button>
            <button type="button" onClick={download} className={buttonClass("secondary", "sm")}>
              <DownloadIcon />
              Download local draft
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() => void reload()}
              className={buttonClass("secondary", "sm")}
            >
              <RefreshIcon />
              Reload and discard
            </button>
            {bytes > FILE_SOURCE_LIMIT && (
              <button
                type="button"
                onClick={() => {
                  showEdit();
                  requestAnimationFrame(() => sourceInput.current?.focus());
                }}
                className={buttonClass("secondary", "sm")}
              >
                Reduce content
              </button>
            )}
            {canEdit && conflict && (
              <button
                type="button"
                disabled={loading || !lease.editable || bytes > FILE_SOURCE_LIMIT}
                onClick={() => void proposeOverwrite()}
                className={buttonClass("danger-quiet", "sm")}
              >
                Overwrite…
              </button>
            )}
          </div>
          {copyFailed && <p role="alert">Copy failed. Download your local draft instead.</p>}
        </section>
      )}
      <div className="mt-4 grid gap-4 lg:grid-cols-2 lg:gap-5">
        <section className={view === "edit" ? "min-w-0" : "hidden min-w-0 lg:block"} aria-label="Editor">
          <div
            className={cx(
              "flex flex-col overflow-hidden border border-line transition-colors focus-within:border-ink focus-within:ring-1 focus-within:ring-ink",
              editingBlocked ? "bg-sand" : "bg-cream",
            )}
          >
            <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line px-5 py-2">
              <h2 className="eyebrow text-muted">Markdown source</h2>
              <span className="font-mono text-[12px] tabular-nums text-muted">
                {previewSource.length ? `${words.toLocaleString("en-US")} words` : "Empty"}
              </span>
            </div>
            <textarea
              ref={sourceInput}
              readOnly={editingBlocked}
              value={compositionValue ?? draft}
              onChange={(event) => {
                if (editingBlocked) return;
                if (composing.current) setCompositionValue(event.target.value);
                else edit(event.target.value);
              }}
              onCompositionStart={(event) => {
                if (editingBlocked) return;
                composing.current = true;
                composition(true);
                setCompositionValue(event.currentTarget.value);
              }}
              onCompositionEnd={(event) => {
                const value = event.currentTarget.value;
                composing.current = false;
                composition(false);
                setCompositionValue(null);
                if (editingBlocked || !edit(value)) event.currentTarget.value = draft;
              }}
              onPaste={(event) => {
                if (editingBlocked) {
                  event.preventDefault();
                  return;
                }
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
              }}
              aria-label="Markdown source"
              placeholder={canEdit ? "# Start writing…" : undefined}
              className="h-[62vh] min-h-[22rem] w-full resize-none bg-transparent px-5 py-4 font-mono text-[13.5px] leading-[1.7] text-ink outline-none placeholder:text-muted/60"
            />
          </div>
          {bytes >= FILE_SOURCE_FEEDBACK && (
            <p role="status" className="mt-2 text-xs tabular-nums text-muted">
              {bytes.toLocaleString("en-US")} / 262,144
            </p>
          )}
          {(bytes === FILE_SOURCE_LIMIT || rejected) && (
            <p role="status" className="mt-1 text-xs font-medium text-danger">
              File limit reached
            </p>
          )}
        </section>
        <section
          className={view === "comments" ? "hidden" : view === "preview" ? "min-w-0" : "hidden min-w-0 lg:block"}
          aria-label="Preview"
        >
          <div className="flex flex-col overflow-hidden border border-line bg-cream">
            <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line px-5 py-2">
              <h2 className="eyebrow text-muted">Preview</h2>
              <RightPaneToggle view={view} onShowPreview={onShowPreview} onShowComments={onShowComments} />
            </div>
            <div className="prose-markdown h-[62vh] min-h-[22rem] overflow-y-auto px-6 py-5 sm:px-8 sm:py-7">
              {previewSource.trim() ? (
                <Preview source={previewSource} />
              ) : (
                <p className="text-muted">Nothing to preview yet.</p>
              )}
            </div>
          </div>
        </section>
        {view === "comments" && (
          <section aria-label="Comment inspector" className="min-w-0">
            <div className="flex flex-col overflow-hidden border border-line bg-cream">
              <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line px-5 py-2">
                <h2 className="eyebrow text-muted">Comments</h2>
                <RightPaneToggle view={view} onShowPreview={onShowPreview} onShowComments={onShowComments} />
              </div>
              <div className="flex h-[62vh] min-h-[22rem] flex-col px-5 py-4">
                <CommentsPanel fileId={fileId} snapshot={snapshot} />
              </div>
            </div>
          </section>
        )}
      </div>
      {lease.transferPrompt && (
        <div role="dialog" aria-modal="true" aria-label="Transfer editing" className="modal-backdrop z-[70]">
          <div className="modal-panel max-w-md">
            <p className="eyebrow text-accent">Editing</p>
            <p className="mt-2 font-display text-2xl font-light leading-snug tracking-tight">
              Another tab requested editing. Save your work or explicitly discard it before transferring.
            </p>
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={lease.keepEditing} className={buttonClass("ghost")}>
                Keep editing
              </button>
              <button type="button" onClick={() => void lease.transfer(true)} className={buttonClass("danger-quiet")}>
                Discard draft and transfer
              </button>
              <button type="button" onClick={() => void lease.transfer()} className={buttonClass("primary")}>
                Save and transfer
              </button>
            </div>
          </div>
        </div>
      )}
      {overwriteProposal && (
        <div role="dialog" aria-modal="true" aria-label="Confirm overwrite" className="modal-backdrop z-[70]">
          <div className="modal-panel max-w-md">
            <p className="eyebrow text-accent">Overwrite</p>
            <p className="mt-2 font-display text-2xl font-light leading-snug tracking-tight">
              Replace the current File with your local draft? Nothing will be merged.
            </p>
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={cancelOverwrite} className={buttonClass("ghost")}>
                Cancel
              </button>
              <button
                type="button"
                disabled={bytes > FILE_SOURCE_LIMIT}
                onClick={() => void confirmOverwrite()}
                className={buttonClass("danger")}
              >
                Overwrite File
              </button>
            </div>
          </div>
        </div>
      )}
      {blocker.state === "blocked" &&
        (navigationFailed ? (
          <div role="dialog" aria-modal="true" aria-label="Unsaved File" className="modal-backdrop z-[70]">
            <div className="modal-panel max-w-md">
              <p className="eyebrow text-accent">Unsaved File</p>
              <p className="mt-2 font-display text-2xl font-light leading-snug tracking-tight">
                Your draft couldn't be saved. Keep editing, or explicitly discard it before leaving.
              </p>
              <div className="mt-6 flex flex-wrap justify-end gap-2">
                <button type="button" onClick={() => blocker.proceed()} className={buttonClass("danger-quiet")}>
                  Discard draft and leave
                </button>
                <button type="button" onClick={() => blocker.reset()} className={buttonClass("primary")}>
                  Keep editing
                </button>
              </div>
            </div>
          </div>
        ) : (
          <p role="status" className="mt-3 text-sm text-muted">
            Saving before leaving…
          </p>
        ))}
    </>
  );
}

/** A rough word count for the source header; Markdown punctuation is not counted. */
function countWords(source: string): number {
  return source.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
}
