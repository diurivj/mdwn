import { useEffect, useRef, useState } from "react";

import type { PublicPage } from "~/publications/public-client";
import { publicParticipationSuspensionNotice } from "~/shared/security/public-participation";
import { CommentItem } from "./comment-item";
import { CommentReportControl } from "./comment-report-control";
import { commentCharacters, MAX_COMMENT_CHARS } from "../shared/comments/content";
import {
  deleteLinkPublicComment,
  editLinkPublicComment,
  loadMoreLinkPublicComments,
  postLinkPublicComment,
  PublicCommentsChangedError,
  PublicCommentsLimitedError,
  PublicCommentsNotFoundError,
  PublicCommentsSealedError,
  PublicCommentsSignInError,
  PublicCommentsSuspendedError,
  type PublicLinkComments,
} from "./public-client";
import { cx } from "~/ui/cx";
import { buttonClass, fieldClass, linkClass, noticeClass, textButtonClass } from "~/ui/styles";

type ReadyPage = Extract<PublicPage, { status: "ready" }>;

/**
 * The Public reader's Comment section. It renders only explicitly public epochs
 * under the document, with no Private/Public selector, and never receives a
 * Collaborators-only epoch. Posting requires a signed-in, device-bound Session;
 * the fragment capability stays in this browser.
 */
export function PublicComments({
  page,
  linkId,
  onRefresh,
}: {
  page: ReadyPage;
  linkId: string;
  onRefresh: () => void;
}) {
  const [view, setView] = useState<PublicLinkComments | null>(page.comments);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const lifetime = useRef<AbortController | null>(null);
  const shownThread = useRef<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  // A revalidation for the same thread must never clear an unsent draft; only a
  // different link/thread resets composer, edit or pending delete state.
  useEffect(() => {
    const threadId = page.comments?.status === "ready" ? page.comments.thread.threadId : null;
    if (shownThread.current !== threadId) {
      shownThread.current = threadId;
      setDraft("");
      setEditing(null);
      setDeleting(null);
      setMessage("");
    }
    setView(page.comments);
  }, [page.comments]);

  if (!view) return null;
  if (view.status === "unavailable") {
    if (!view.threadId) return null;
    return (
      <section aria-label="Public comments" className="mt-16 border-t border-line pt-10">
        <h2 className="font-display text-3xl font-light leading-tight tracking-tight">Comments</h2>
        <p className="mt-2 text-ink-soft">Sign in to see or add comments if you have access to this file.</p>
      </section>
    );
  }
  const thread = view.thread;

  function fail(error: unknown) {
    if (error instanceof PublicCommentsSignInError) {
      setMessage(
        error.state === "unprovisioned"
          ? "This browser isn’t set up to post comments. Finish device setup in your Account settings."
          : "Sign in to add a comment.",
      );
    } else if (error instanceof PublicCommentsLimitedError) {
      setMessage("You’ve reached the comment limit for now. Try again later.");
    } else if (error instanceof PublicCommentsSuspendedError) {
      setMessage(publicParticipationSuspensionNotice(error.suspendedUntil));
    } else if (error instanceof PublicCommentsSealedError) {
      setMessage("Secure access must finish updating before comments can change.");
    } else if (error instanceof PublicCommentsChangedError || error instanceof PublicCommentsNotFoundError) {
      setMessage("Comments changed on another device. Refresh to see the latest.");
    } else setMessage("The change couldn’t be confirmed. Try again.");
    onRefresh();
  }

  async function mutate(action: (signal: AbortSignal) => Promise<void>) {
    const controller = lifetime.current;
    if (!controller || busy || controller.signal.aborted) return;
    setBusy(true);
    setMessage("");
    try {
      await action(controller.signal);
      onRefresh();
    } catch (error) {
      if (!controller.signal.aborted) fail(error);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  const tooLong = commentCharacters(draft) > MAX_COMMENT_CHARS;
  return (
    <section aria-label="Public comments" className="mt-16 border-t border-line pt-10">
      <h2 className="font-display text-3xl font-light leading-tight tracking-tight">Comments</h2>
      {message && (
        <p role="alert" className={cx(noticeClass("danger"), "mt-4")}>
          {message}
        </p>
      )}
      <ol aria-label="Public comments" className="mt-6 border-t border-line">
        {thread.comments.map((comment) => (
          <CommentItem
            key={comment.id}
            comment={comment}
            pseudonym={thread.pseudonyms.get(comment.authorId)}
            viewerAccountId={thread.viewerAccountId}
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
              void mutate(async (signal) => {
                const selected = thread.comments.find((item) => item.id === edit.id);
                if (!selected) return;
                await editLinkPublicComment(thread, linkId, selected, edit.text, signal);
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
              void mutate(async (signal) => {
                const full = thread.comments.find((item) => item.id === selected.id);
                if (!full) return;
                await deleteLinkPublicComment(thread, linkId, full, signal);
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
          className={cx(textButtonClass(), "mt-3")}
          onClick={() =>
            void (async () => {
              const controller = lifetime.current;
              if (!controller || busy || controller.signal.aborted) return;
              setBusy(true);
              setMessage("");
              try {
                const next = await loadMoreLinkPublicComments(thread, controller.signal);
                if (controller.signal.aborted) return;
                setView({
                  status: "ready",
                  thread: {
                    ...thread,
                    comments: [...thread.comments, ...next.comments],
                    pseudonyms: next.pseudonyms,
                    nextCursor: next.nextCursor,
                  },
                });
              } catch (error) {
                if (!controller.signal.aborted) fail(error);
              } finally {
                if (!controller.signal.aborted) setBusy(false);
              }
            })()
          }
        >
          Load more comments
        </button>
      )}
      {thread.postingState === "signed-out" && (
        <p className="mt-6 border border-line bg-cream px-4 py-3 text-sm text-ink-soft">
          <a href="/sign-in" className={linkClass}>
            Sign in
          </a>{" "}
          to add a comment.
        </p>
      )}
      {thread.postingState === "unprovisioned" && (
        <p className="mt-6 border border-line bg-cream px-4 py-3 text-sm text-ink-soft">
          This browser isn’t set up to post comments. Finish device setup in your Account settings.
        </p>
      )}
      {thread.postingState === "ready" && (
        <form
          className="mt-6 border-y border-line bg-paper py-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft || tooLong) return;
            void mutate(async (signal) => {
              await postLinkPublicComment(thread, linkId, draft, signal);
              setDraft("");
            });
          }}
        >
          <label className="block text-sm font-medium text-ink" htmlFor="public-comment">
            Add a public comment
            <textarea
              id="public-comment"
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
      )}
    </section>
  );
}
