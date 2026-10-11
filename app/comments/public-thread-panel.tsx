import { useCallback, useEffect, useRef, useState } from "react";

import { PSEUDONYM_UPDATE_PENDING_MESSAGE } from "~/account/pseudonym-client";
import { publicParticipationSuspensionNotice } from "~/shared/security/public-participation";
import type { FilesSnapshot } from "~/tree/navigation-client";
import { CommentItem } from "./comment-item";
import { CommentReportControl } from "./comment-report-control";
import { commentCharacters, MAX_COMMENT_CHARS } from "../shared/comments/content";
import {
  createFilePublicComment,
  deleteFilePublicComment,
  editFilePublicComment,
  loadFilePublicComments,
  loadMoreFilePublicComments,
  PublicCommentsChangedError,
  PublicCommentsLimitedError,
  PublicCommentsNotFoundError,
  PublicCommentsPreparingError,
  PublicCommentsPseudonymPendingError,
  PublicCommentsSealedError,
  PublicCommentsSignInError,
  PublicCommentsSuspendedError,
  type FilePublicComments,
  type PublicThreadView,
} from "./public-client";
import { cx } from "~/ui/cx";
import { buttonClass, fieldClass, noticeClass, textButtonClass } from "~/ui/styles";

type PanelState =
  | { status: "loading" }
  | { status: "preparing" }
  | { status: "failed"; message: string }
  | FilePublicComments;

/**
 * The authenticated workspace's Public Comment inspector. History is read
 * through this device's epoch envelopes on the File route; the Publication
 * fragment is never received or retained here.
 */
export function PublicThreadPanel({ fileId, snapshot }: { fileId: string; snapshot: FilesSnapshot }) {
  const [panel, setPanel] = useState<PanelState>({ status: "loading" });
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const lifetime = useRef<AbortController | null>(null);
  const accessRef = useRef(snapshot.access);
  useEffect(() => {
    accessRef.current = snapshot.access;
  }, [snapshot.access]);

  const reload = useCallback(
    async (signal: AbortSignal) => {
      try {
        const next = await loadFilePublicComments(accessRef.current, fileId, signal);
        if (!signal.aborted) setPanel(next);
        return next;
      } catch (error) {
        if (signal.aborted) return null;
        if (error instanceof PublicCommentsPreparingError) setPanel({ status: "preparing" });
        else if (error instanceof PublicCommentsNotFoundError)
          setPanel({ status: "failed", message: "This File’s public comments are unavailable." });
        else if (error instanceof PublicCommentsChangedError)
          setPanel({ status: "failed", message: "Public comments changed on another device. Reopen this File." });
        else setPanel({ status: "failed", message: "Public comments could not be loaded. Try again." });
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
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

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
      const next = await loadMoreFilePublicComments(panel.thread, controller.signal);
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

  async function mutate(action: (thread: PublicThreadView, signal: AbortSignal) => Promise<void>) {
    const controller = lifetime.current;
    if (!controller || panel.status !== "ready" || busy || controller.signal.aborted) return;
    setBusy(true);
    setMessage("");
    try {
      await action(panel.thread, controller.signal);
      await reload(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof PublicCommentsChangedError)
        setMessage("Comments changed on another device. Reopen this File.");
      else if (error instanceof PublicCommentsSealedError)
        setMessage("Secure access must finish updating before comments can change.");
      else if (error instanceof PublicCommentsPseudonymPendingError) setMessage(PSEUDONYM_UPDATE_PENDING_MESSAGE);
      else if (error instanceof PublicCommentsNotFoundError) setMessage("This comment is no longer available.");
      else if (error instanceof PublicCommentsLimitedError)
        setMessage("You’ve reached the comment limit for now. Try again later.");
      else if (error instanceof PublicCommentsSuspendedError)
        setMessage(publicParticipationSuspensionNotice(error.suspendedUntil));
      else if (error instanceof PublicCommentsSignInError) setMessage("This browser can’t post comments right now.");
      else setMessage("The change could not be confirmed. Try again.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  const retry = () => {
    const controller = lifetime.current;
    if (controller) {
      setPanel({ status: "loading" });
      void reload(controller.signal);
    }
  };
  if (panel.status === "loading")
    return (
      <section aria-label="Public comments" className="mt-4">
        <p role="status" className="text-sm text-muted">
          Loading public comments…
        </p>
      </section>
    );
  if (panel.status === "preparing")
    return (
      <section aria-label="Public comments" className="mt-4">
        <p role="status" className="text-sm text-muted">
          Secure public comment access is being prepared on this device.
        </p>
      </section>
    );
  if (panel.status === "failed")
    return (
      <section aria-label="Public comments" className="mt-4">
        <p role="alert" className={noticeClass("danger")}>
          {panel.message}
        </p>
        <button type="button" className={cx(buttonClass("secondary", "sm"), "mt-3")} onClick={retry}>
          Retry public comments
        </button>
      </section>
    );
  if (panel.status === "absent")
    return (
      <section aria-label="Public comments" className="mt-4">
        <p className="text-sm text-muted">
          {panel.publicationId
            ? "This Publication’s public Comment thread isn’t set up yet."
            : "Publish this File to open a Public comment thread."}
        </p>
      </section>
    );

  const thread = panel.thread;
  const tooLong = commentCharacters(draft) > MAX_COMMENT_CHARS;
  const audience = thread.audience === "public" ? "Public" : "Collaborators only";
  return (
    <section aria-label="Public comments" className="mt-4 flex min-h-0 flex-1 flex-col">
      <p role="status" className="text-[13px] text-muted">
        Audience: <span className="font-medium text-ink">{audience}</span>
      </p>
      {message && (
        <p role="alert" className={cx(noticeClass("danger"), "mt-2")}>
          {message}
        </p>
      )}
      <ol aria-label="Public comments" className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {thread.comments.map((comment) => (
          <CommentItem
            key={comment.id}
            comment={comment}
            pseudonym={thread.pseudonyms.get(comment.authorId)}
            viewerAccountId={thread.viewerAccountId}
            note={comment.epochId !== thread.currentEpochId ? "earlier audience" : undefined}
            editing={editing}
            deleting={deleting}
            busy={busy}
            reportControl={
              thread.postingState === "ready" && comment.authorId !== thread.viewerAccountId ? (
                <CommentReportControl commentId={comment.id} />
              ) : undefined
            }
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
                await editFilePublicComment(thread, selected, edit.text, signal);
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
                await deleteFilePublicComment(thread, full, signal);
                setDeleting(null);
              })
            }
          />
        ))}
        {!thread.comments.length && (
          <li className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
            No public comments yet.
          </li>
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
            await createFilePublicComment(accessRef.current, thread, draft, signal);
            setDraft("");
          });
        }}
      >
        <label className="block text-sm font-medium text-ink" htmlFor="public-thread-comment">
          Add a public comment
          <textarea
            id="public-thread-comment"
            value={draft}
            disabled={busy}
            rows={3}
            placeholder="Plain text only"
            onChange={(event) => setDraft(event.target.value)}
            className={cx(fieldClass("sm"), "mt-2 resize-none font-normal")}
          />
        </label>
        <div className="mt-2 flex items-center justify-between gap-2">
          <p role="status" className={cx("text-xs tabular-nums", tooLong ? "text-danger" : "text-muted")}>
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
