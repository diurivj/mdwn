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
  type CommentView,
  type CommentsState,
  type PrivateComments,
} from "../shared/comments/comments-client";
import { CommentItem } from "./comment-item";
import { commentCharacters, MAX_COMMENT_CHARS } from "../shared/comments/content";
import { PublicThreadPanel } from "./public-thread-panel";
import type { FilesSnapshot } from "~/tree/navigation-client";

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
  // with the same File authority. Keep the latest access in a ref so only a
  // File change resets the composer, edit or pending state.
  const accessRef = useRef(snapshot.access);
  useEffect(() => {
    accessRef.current = snapshot.access;
  }, [snapshot.access]);

  const reload = useCallback(
    async (signal: AbortSignal) => {
      try {
        const next = await loadPrivateComments(accessRef.current, fileId, signal, snapshot.file?.capabilityKey ?? null);
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
      <section aria-label="Private comments" className="mt-4 lg:mt-0">
        <p role="status">Loading comments…</p>
      </section>
    );
  if (panel.status === "failed")
    return (
      <section aria-label="Private comments" className="mt-4 lg:mt-0">
        <p role="alert">{panel.message}</p>
        <button
          type="button"
          className="mt-2 rounded border px-3 py-1"
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
      <section aria-label="Private comments" className="mt-4 lg:mt-0">
        <p role="status">Secure comment access is being prepared on this device.</p>
      </section>
    );
  if (panel.status === "absent")
    return (
      <section aria-label="Private comments" className="mt-4 lg:mt-0">
        <p>Comments aren’t set up for this File yet.</p>
      </section>
    );

  const thread = panel.thread;
  const tooLong = commentCharacters(draft) > MAX_COMMENT_CHARS;
  return (
    <section aria-label="Private comments" className="mt-4 flex min-h-0 flex-col lg:mt-0">
      {message && (
        <p role="alert" className="mt-2 text-rose-700">
          {message}
        </p>
      )}
      <ol aria-label="Private comments" className="mt-3 flex-1 space-y-3 overflow-y-auto pr-1">
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
        {!thread.comments.length && <li className="text-stone-500">No comments yet.</li>}
      </ol>
      {thread.nextCursor !== null && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void loadMore()}
          className="mt-3 self-start rounded border px-3 py-1 text-sm"
        >
          Load more comments
        </button>
      )}
      <form
        className="mt-4 border-t border-stone-200 pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft || tooLong) return;
          void mutate(async (_thread, signal) => {
            await createPrivateComment(accessRef.current, thread, draft, signal);
            setDraft("");
          });
        }}
      >
        <label className="block text-sm" htmlFor="private-comment">
          Add a private comment
          <textarea
            id="private-comment"
            value={draft}
            disabled={busy}
            rows={3}
            placeholder="Plain text only"
            onChange={(event) => setDraft(event.target.value)}
            className="mt-1 w-full rounded border border-stone-300 p-2"
          />
        </label>
        <div className="mt-1 flex items-center justify-between gap-2">
          <p role="status" className={tooLong ? "text-rose-700" : "text-stone-500"}>
            {commentCharacters(draft)} / 2,000
          </p>
          <button
            type="submit"
            disabled={busy || !draft || tooLong}
            className="rounded bg-stone-900 px-3 py-1 text-white"
          >
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
      className={
        selected === kind
          ? "rounded border border-stone-900 bg-stone-900 px-3 py-0.5 text-sm text-white"
          : "rounded border border-stone-300 px-3 py-0.5 text-sm"
      }
    >
      {label}
    </button>
  );
  return (
    <div className="flex min-h-0 flex-col">
      <div role="tablist" aria-label="Comment thread" className="flex items-center gap-2">
        {tab("private", "Private")}
        {tab("public", "Public")}
      </div>
      <div role="tabpanel" id={`${selected}-thread-panel`} aria-labelledby={`${selected}-thread-tab`}>
        {selected === "public" ? (
          <PublicThreadPanel fileId={fileId} snapshot={snapshot} />
        ) : (
          <PrivateCommentsPanel fileId={fileId} snapshot={snapshot} />
        )}
      </div>
    </div>
  );
}
