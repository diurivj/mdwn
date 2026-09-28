import { useEffect, useRef, useState } from "react";

import { CommentsUnavailableError, createPrivateThread, deletePrivateComment, editPrivateComment,
  loadPrivateThread, postPrivateComment, provisionThreadDevices, type LoadedComment, type LoadedThread,
  type ThreadSubject } from "./client";
import { COMMENT_CHARACTER_LIMIT, commentLength, CommentTextError, normalizeCommentText } from "./crypto";

type Ready = Extract<LoadedThread, { status: "ready" }>;
type View = { status: "loading" } | { status: "unavailable" } | { status: "error" } |
  { status: "loaded"; thread: LoadedThread; later: LoadedComment[] };

function explain(error: unknown): string {
  if (error instanceof CommentTextError) {
    return error.code === "too_long" ? `A Comment can be at most ${COMMENT_CHARACTER_LIMIT} characters.` :
      error.code === "empty" ? "Write a Comment first." : "A Comment can contain only text and line breaks.";
  }
  if (error instanceof CommentsUnavailableError) {
    if (error.code === "rotation_pending") return "Comments are paused while access to this File is updated.";
    if (error.code === "file_changed") return "This File changed elsewhere. Reload the page to comment.";
    if (error.code === "thread_changed") return "Comments changed elsewhere. Your text is still here; try again.";
    if (error.code === "not_found") return "Comments are unavailable.";
  }
  return "That didn't work. Your text is still here; try again.";
}

function Counter({ text, label }: { text: string; label: string }) {
  const length = commentLength(text);
  return <p className={`text-xs ${length > COMMENT_CHARACTER_LIMIT ? "text-rose-700" : "text-stone-500"}`}
    role="status" aria-label={label}>{length} / {COMMENT_CHARACTER_LIMIT}</p>;
}

/**
 * The File's Private Comment thread. Bodies and pseudonyms are decrypted here and
 * rendered as plain text only; the composer sits at the bottom of the thread.
 */
export function CommentsPanel({ subject, authorityVerified }: { subject: ThreadSubject | null;
  authorityVerified: boolean }) {
  const [view, setView] = useState<View>({ status: "loading" });
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ commentId: string; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const alive = useRef(true);
  const provisioning = useRef(false);

  async function refresh(signal?: AbortSignal): Promise<LoadedThread | null> {
    if (!subject) return null;
    try {
      const thread = await loadPrivateThread(subject, { signal });
      if (!alive.current || signal?.aborted) return null;
      setView({ status: "loaded", thread, later: [] });
      // Any current reader envelopes the key to direct devices still waiting for it.
      if (thread.status === "ready" && !provisioning.current &&
          thread.directDevices.some((device) => !device.provisioned)) {
        provisioning.current = true;
        void provisionThreadDevices(subject, thread).catch(() => undefined)
          .finally(() => { provisioning.current = false; });
      }
      return thread;
    } catch (error) {
      if (!alive.current || signal?.aborted) return null;
      setView({ status: error instanceof CommentsUnavailableError && error.code === "not_found" ?
        "unavailable" : "error" });
      return null;
    }
  }

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => { alive.current = false; controller.abort(); };
  }, [subject]);

  async function run(action: () => Promise<void>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setNotice("");
    try {
      await action();
      return true;
    } catch (error) {
      if (alive.current) setNotice(explain(error));
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function post() {
    if (!subject || view.status !== "loaded") return;
    const text = draft;
    const posted = await run(async () => {
      normalizeCommentText(text);
      let thread = view.thread;
      if (thread.status === "empty") {
        // The first Comment creates the File's one Private thread; losing that race is fine.
        try { await createPrivateThread(subject, thread.directDevices); }
        catch (error) {
          if (!(error instanceof CommentsUnavailableError && error.code === "thread_changed")) throw error;
        }
        thread = await loadPrivateThread(subject);
      }
      if (thread.status !== "ready") throw new CommentsUnavailableError("thread_changed");
      await postPrivateComment(subject, thread, text);
    });
    if (posted && alive.current) setDraft((current) => current === text ? "" : current);
    await refresh();
  }

  async function saveEdit(thread: Ready, comment: LoadedComment, text: string) {
    if (!subject) return;
    const saved = await run(async () => { await editPrivateComment(subject, thread, comment, text); });
    if (saved && alive.current) setEditing(null);
    await refresh();
  }

  async function remove(commentId: string) {
    const removed = await run(async () => { await deletePrivateComment(commentId); });
    if (removed && alive.current) setConfirming(null);
    await refresh();
  }

  /** Pages run oldest first; the next page appends newer Comments above the composer. */
  async function showMore(thread: Ready, later: LoadedComment[]) {
    if (!subject || !thread.nextCursor) return;
    await run(async () => {
      const next = await loadPrivateThread(subject, { cursor: thread.nextCursor! });
      if (next.status !== "ready") throw new CommentsUnavailableError("thread_changed");
      if (alive.current) setView({ status: "loaded", thread: { ...next, comments: thread.comments },
        later: [...later, ...next.comments] });
    });
  }

  const header = <div className="mb-3 flex items-center gap-2" role="group" aria-label="Comment thread">
    <button type="button" aria-pressed="true" className="rounded border border-stone-900 px-2 py-0.5 text-sm">
      Private</button>
  </div>;
  if (!subject) {
    return <div>{header}<p className="text-sm text-stone-600">Comments open after this File's next save.</p></div>;
  }
  if (view.status === "loading") return <div>{header}<p role="status" className="text-sm">Loading comments…</p></div>;
  if (view.status === "unavailable") return <div>{header}<p role="alert">Comments are unavailable.</p></div>;
  if (view.status === "error") {
    return <div>{header}<p role="alert">Comments could not be loaded.</p>
      <button type="button" className="underline" onClick={() => { setView({ status: "loading" }); void refresh(); }}>
        Retry comments</button></div>;
  }
  const thread = view.thread;
  if (thread.status === "legacy") {
    return <div>{header}<p className="text-sm text-stone-600">Comments open after this File's next save.</p></div>;
  }
  if (thread.status === "provisioning") {
    return <div>{header}<p role="status" className="text-sm">
      Secure access to these comments is being prepared. It completes when someone with access opens them.</p>
      <button type="button" className="mt-2 underline" onClick={() => void refresh()}>Check again</button></div>;
  }
  const ready = thread.status === "ready" ? thread : null;
  const list = [...(ready?.comments ?? []), ...view.later];
  const canDeleteAny = (thread.status === "ready" || thread.status === "empty") && thread.canDeleteAny;
  const disabled = busy || !authorityVerified;
  return <div className="flex min-h-[50vh] flex-col">
    {header}
    {list.length === 0 && <p className="text-sm text-stone-600">No comments yet.</p>}
    <ol aria-label="Private comments" className="flex-1 space-y-3">
      {list.map((comment) => <li key={comment.commentId} className="rounded border border-stone-200 p-2"
        aria-label={`Comment by ${comment.pseudonym ?? "unknown author"}`}>
        <p className="text-sm font-medium">{comment.pseudonym ?? "Unknown author"}{comment.own ? " (you)" : ""}
          <span className="ml-2 font-normal text-stone-500">
            {new Date(comment.createdAt).toLocaleString()}{comment.updatedAt > comment.createdAt ? " · edited" : ""}
          </span></p>
        {editing?.commentId === comment.commentId && ready ? <form className="mt-1" onSubmit={(event) => {
          event.preventDefault(); void saveEdit(ready, comment, editing.text);
        }}>
          <textarea aria-label="Edit comment" value={editing.text} rows={3}
            onChange={(event) => setEditing({ commentId: comment.commentId, text: event.target.value })}
            className="w-full rounded border border-stone-300 p-2 text-sm" />
          <Counter text={editing.text} label="Edited comment length" />
          <div className="mt-1 flex gap-3 text-sm">
            <button type="submit" disabled={disabled}>Save comment</button>
            <button type="button" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form> : <p className="mt-1 whitespace-pre-wrap break-words text-sm">{comment.text}</p>}
        {editing?.commentId !== comment.commentId && <div className="mt-1 flex gap-3 text-sm">
          {comment.own && <button type="button" disabled={disabled}
            onClick={() => { setConfirming(null); setEditing({ commentId: comment.commentId, text: comment.text }); }}>
            Edit</button>}
          {(comment.own || canDeleteAny) && (confirming === comment.commentId
            ? <span role="group" aria-label="Confirm deletion" className="flex gap-3">
              <span>Delete permanently? This can't be undone.</span>
              <button type="button" disabled={disabled} className="text-rose-700"
                onClick={() => void remove(comment.commentId)}>Delete permanently</button>
              <button type="button" onClick={() => setConfirming(null)}>Keep</button>
            </span>
            : <button type="button" disabled={disabled} onClick={() => setConfirming(comment.commentId)}>Delete</button>)}
        </div>}
      </li>)}
    </ol>
    {ready?.nextCursor && <button type="button" className="mt-2 text-sm underline" disabled={busy}
      onClick={() => void showMore(ready, view.later)}>Show more comments</button>}
    {notice && <p role="alert" className="mt-2 text-sm text-rose-700">{notice}</p>}
    <form className="mt-4 border-t pt-3" onSubmit={(event) => { event.preventDefault(); void post(); }}>
      <textarea aria-label="Private comment" value={draft} rows={3} placeholder="Add a private comment"
        onChange={(event) => setDraft(event.target.value)}
        className="w-full rounded border border-stone-300 bg-white p-2 text-sm" />
      <div className="mt-1 flex items-center justify-between">
        <Counter text={draft} label="Comment length" />
        <button type="submit" disabled={disabled || !draft.trim() || commentLength(draft) > COMMENT_CHARACTER_LIMIT}
          className="rounded bg-stone-900 px-3 py-1 text-sm text-white disabled:opacity-50">
          {busy ? "Posting…" : "Post"}</button>
      </div>
    </form>
  </div>;
}
