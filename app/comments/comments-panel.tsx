import { useCallback, useEffect, useRef, useState } from "react";

import { PSEUDONYM_UPDATE_PENDING_MESSAGE } from "~/account/pseudonym-client";
import {
  CommentsChangedError,
  CommentsNotFoundError,
  CommentsSealedError,
  PseudonymUpdatePendingError,
  createPrivateComment,
  createPrivateThread,
  deletePrivateComment,
  editPrivateComment,
  loadMorePrivateComments,
  loadPrivateComments,
  type CommentsState,
  type PrivateComments,
} from "../shared/comments/comments-client";
import { CommentItem } from "./comment-item";
import { commentCharacters, MAX_COMMENT_CHARS } from "../shared/comments/content";
import { PublicThreadPanel } from "./public-thread-panel";
import type { FilesSnapshot } from "~/tree/navigation-client";
import { cx } from "~/ui/cx";
import { buttonClass, fieldClass, noticeClass, textButtonClass } from "~/ui/styles";

type PanelState = { status: "loading" } | { status: "failed"; message: string } | CommentsState;

/**
 * The Private Comment inspector. Thread ciphertext is fetched through the
 * proof-guarded Comment endpoint and decrypted only in this browser.
 */
function PrivateCommentsPanel({ fileId, snapshot }: { fileId: string; snapshot: FilesSnapshot }) {
  const [panel, setPanel] = useState<PanelState>({ status: "loading" });
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const lifetime = useRef<AbortController | null>(null);
  const creating = useRef(false);
  // Revalidation (rename, save, provisioning) produces a new snapshot object
  // with the same File authority. Keep the latest access and File capability
  // key in refs so only a File change resets the composer, edit or pending
  // state.
  const accessRef = useRef(snapshot.access);
  const capabilityRef = useRef(snapshot.file?.capabilityKey ?? null);
  useEffect(() => {
    accessRef.current = snapshot.access;
    capabilityRef.current = snapshot.file?.capabilityKey ?? null;
  }, [snapshot.access, snapshot.file?.capabilityKey]);

  const reload = useCallback(
    async (signal: AbortSignal) => {
      try {
        const next = await loadPrivateComments(accessRef.current, fileId, signal, capabilityRef.current);
        if (!signal.aborted) setPanel(next);
        return next;
      } catch (error) {
        if (signal.aborted) return null;
        if (error instanceof CommentsNotFoundError)
          setPanel({ status: "failed", message: "This File’s comments are unavailable." });
        else if (error instanceof CommentsChangedError)
          setPanel({ status: "failed", message: "Comments changed on another device. Reopen this File." });
        else setPanel({ status: "failed", message: "Comments could not be loaded. Try again." });
        return null;
      }
    },
    [fileId],
  );

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setPanel({ status: "loading" });
    setDraft("");
    setEditing(null);
    setDeleting(null);
    setMessage("");
    setBusy(false);
    creating.current = false;
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  // The Owner creates the one Private thread on first open; any other reader
  // sees the not-yet-available state until an Owner device does.
  useEffect(() => {
    if (panel.status !== "absent" || !panel.canCreate || creating.current) return;
    const controller = lifetime.current;
    if (!controller) return;
    creating.current = true;
    setBusy(true);
    void (async () => {
      try {
        await createPrivateThread(accessRef.current, fileId, controller.signal);
        await reload(controller.signal);
      } catch {
        if (!controller.signal.aborted)
          setPanel({ status: "failed", message: "Comments could not be prepared. Try again." });
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    })();
  }, [panel, fileId, reload]);

  async function loadMore() {
    const controller = lifetime.current;
    if (
      !controller ||
      panel.status !== "ready" ||
      busy ||
      controller.signal.aborted ||
      panel.thread.nextCursor === null
    )
      return;
    setBusy(true);
    setMessage("");
    try {
      const next = await loadMorePrivateComments(panel.thread, controller.signal);
      if (controller.signal.aborted) return;
      setPanel({
        status: "ready",
        thread: {
          ...panel.thread,
          comments: [...panel.thread.comments, ...next.comments],
          pseudonyms: next.pseudonyms,
          nextCursor: next.nextCursor,
        },
      });
    } catch {
      if (!controller.signal.aborted) setMessage("More comments could not be loaded. Try again.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function mutate(action: (thread: PrivateComments, signal: AbortSignal) => Promise<void>) {
    const controller = lifetime.current;
    if (!controller || panel.status !== "ready" || busy || controller.signal.aborted) return;
    setBusy(true);
    setMessage("");
    try {
      await action(panel.thread, controller.signal);
      await reload(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof CommentsChangedError) setMessage("Comments changed on another device. Reopen this File.");
      else if (error instanceof CommentsSealedError)
        setMessage("Secure access must finish updating before comments can change.");
      else if (error instanceof PseudonymUpdatePendingError) setMessage(PSEUDONYM_UPDATE_PENDING_MESSAGE);
      else if (error instanceof CommentsNotFoundError) setMessage("This comment is no longer available.");
      else setMessage("The change could not be confirmed. Try again.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  if (panel.status === "loading")
    return (
      <section aria-label="Private comments" className="mt-4">
        <p role="status" className="text-sm text-muted">
          Loading comments…
        </p>
      </section>
    );
  if (panel.status === "failed")
    return (
      <section aria-label="Private comments" className="mt-4">
        <p role="alert" className={noticeClass("danger")}>
          {panel.message}
        </p>
        <button
          type="button"
          className={cx(buttonClass("secondary", "sm"), "mt-3")}
          onClick={() => {
            const controller = lifetime.current;
            if (controller) {
              setPanel({ status: "loading" });
              void reload(controller.signal);
            }
          }}
        >
          Retry comments
        </button>
      </section>
    );
  if (panel.status === "preparing")
    return (
      <section aria-label="Private comments" className="mt-4">
        <p role="status" className="text-sm text-muted">
          Secure comment access is being prepared on this device.
        </p>
      </section>
    );
  if (panel.status === "absent")
    return (
      <section aria-label="Private comments" className="mt-4">
        <p className="text-sm text-muted">Comments aren’t set up for this File yet.</p>
      </section>
    );

  const thread = panel.thread;
  const tooLong = commentCharacters(draft) > MAX_COMMENT_CHARS;
  return (
    <section aria-label="Private comments" className="mt-4 flex min-h-0 flex-1 flex-col">
      {message && (
        <p role="alert" className={noticeClass("danger")}>
          {message}
        </p>
      )}
      <ol aria-label="Private comments" className="mt-3 min-h-0 flex-1 overflow-y-auto border-t border-line pr-1">
        {thread.comments.map((comment) => (
          <CommentItem
            key={comment.id}
            comment={comment}
            pseudonym={thread.pseudonyms.get(comment.authorId)}
            viewerAccountId={thread.actorAccountId}
            editing={editing}
            deleting={deleting}
            busy={busy}
            onEdit={(selected) => {
              setDeleting(null);
              setEditing({ id: selected.id, text: selected.text ?? "" });
            }}
            onEditText={(text) => {
              if (editing) setEditing({ id: editing.id, text });
            }}
            onSubmitEdit={() => {
              if (!editing) return;
              const edit = editing;
              void mutate(async (_thread, signal) => {
                const selected = thread.comments.find((item) => item.id === edit.id);
                if (!selected) return;
                await editPrivateComment(thread, selected, edit.text, signal);
                setEditing(null);
              });
            }}
            onCancelEdit={() => setEditing(null)}
            onDelete={(selected) => {
              setEditing(null);
              setDeleting(selected.id);
            }}
            onCancelDelete={() => setDeleting(null)}
            onConfirmDelete={(selected) =>
              void mutate(async (_thread, signal) => {
                const full = thread.comments.find((item) => item.id === selected.id);
                if (!full) return;
                await deletePrivateComment(thread, full, signal);
                setDeleting(null);
              })
            }
          />
        ))}
        {!thread.comments.length && (
          <li className="border-b border-line px-4 py-6 text-center text-sm text-muted">No comments yet.</li>
        )}
      </ol>
      {thread.nextCursor !== null && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void loadMore()}
          className={cx(textButtonClass(), "mt-2 self-start")}
        >
          Load more comments
        </button>
      )}
      <form
        className="mt-4 border-t border-line pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft || tooLong) return;
          void mutate(async (_thread, signal) => {
            await createPrivateComment(accessRef.current, thread, draft, signal);
            setDraft("");
          });
        }}
      >
        <label className="block text-sm font-medium text-ink" htmlFor="private-comment">
          Add a private comment
          <textarea
            id="private-comment"
            value={draft}
            disabled={busy}
            rows={3}
            placeholder="Plain text only"
            onChange={(event) => setDraft(event.target.value)}
            className={cx(fieldClass("sm"), "mt-2 resize-none font-normal")}
          />
        </label>
        <div className="mt-2 flex items-center justify-between gap-2">
          <p role="status" className={cx("font-mono text-xs tabular-nums", tooLong ? "text-danger" : "text-muted")}>
            {commentCharacters(draft)} / 2,000
          </p>
          <button type="submit" disabled={busy || !draft || tooLong} className={buttonClass("primary", "sm")}>
            {busy ? "Working…" : "Comment"}
          </button>
        </div>
      </form>
    </section>
  );
}

/**
 * The authenticated thread selector. Private is the default thread; the Public
 * thread loads through its own endpoint and is never combined with it.
 */
export function CommentsPanel({ fileId, snapshot }: { fileId: string; snapshot: FilesSnapshot }) {
  const [selected, setSelected] = useState<"private" | "public">("private");
  const tab = (kind: "private" | "public", label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={selected === kind}
      id={`${kind}-thread-tab`}
      aria-controls={`${kind}-thread-panel`}
      onClick={() => setSelected(kind)}
      className={cx(
        "eyebrow px-3.5 py-2 transition-colors",
        selected === kind ? "bg-ink text-paper" : "text-ink-soft hover:bg-paper hover:text-ink",
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Comment thread"
        className="inline-flex max-w-full flex-wrap items-center self-start border border-line bg-cream"
      >
        {tab("private", "Private")}
        {tab("public", "Public")}
      </div>
      <div
        role="tabpanel"
        id={`${selected}-thread-panel`}
        aria-labelledby={`${selected}-thread-tab`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {selected === "public" ? (
          <PublicThreadPanel fileId={fileId} snapshot={snapshot} />
        ) : (
          <PrivateCommentsPanel fileId={fileId} snapshot={snapshot} />
        )}
      </div>
    </div>
  );
}
