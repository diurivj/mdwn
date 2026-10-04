import { useEffect, useRef, useState } from "react";

import type { PublicPage } from "~/publications/public-client";
import { commentCharacters, MAX_COMMENT_CHARS } from "./content";
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
  type PublicComment,
  type PublicLinkComments,
  type PublicThreadView,
} from "./public-client";

type ReadyPage = Extract<PublicPage, { status: "ready" }>;

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const stamp = (value: number) => timeFormat.format(new Date(value));

function CommentItem({ comment, thread, editing, deleting, busy, onEdit, onEditText, onSubmitEdit, onCancelEdit,
  onDelete, onConfirmDelete, onCancelDelete }: {
  comment: PublicComment; thread: PublicThreadView; editing: { id: string; text: string } | null;
  deleting: string | null; busy: boolean;
  onEdit: (comment: PublicComment) => void; onEditText: (text: string) => void; onSubmitEdit: () => void; onCancelEdit: () => void;
  onDelete: (comment: PublicComment) => void; onConfirmDelete: (comment: PublicComment) => void; onCancelDelete: () => void;
}) {
  const edit = editing && editing.id === comment.id ? editing : null;
  return <li className="rounded border border-stone-200 p-3">
    <p className="text-sm text-stone-600"><span className="font-medium text-stone-900">
      {thread.pseudonyms.get(comment.authorId) ?? "Unknown author"}</span>
      {" · "}<time dateTime={new Date(comment.createdAt).toISOString()}>{stamp(comment.createdAt)}</time>
      {comment.updatedAt !== comment.createdAt && " · edited"}</p>
    {edit ? <form className="mt-2" onSubmit={(event) => {
      event.preventDefault();
      if (commentCharacters(edit.text) > MAX_COMMENT_CHARS) return;
      onSubmitEdit();
    }}>
      <label className="block text-sm">Edit comment
        <textarea autoFocus value={edit.text} disabled={busy} rows={4}
          onChange={(event) => onEditText(event.target.value)}
          className="mt-1 w-full rounded border p-2" />
      </label>
      <p className="text-sm">{commentCharacters(edit.text)} / 2,000</p>
      <div className="mt-1 flex gap-2">
        <button type="submit" disabled={busy || commentCharacters(edit.text) > MAX_COMMENT_CHARS}
          className="rounded bg-stone-900 px-3 py-1 text-white">Save comment</button>
        <button type="button" disabled={busy} onClick={onCancelEdit}>Cancel</button>
      </div>
    </form> : <p className="mt-2 whitespace-pre-wrap break-words">
      {comment.text ?? <span className="text-rose-700">This comment couldn’t be decrypted on this device.</span>}</p>}
    {!edit && (comment.canEdit || comment.canDelete) && <div className="mt-2 flex gap-2 text-sm">
      {comment.canEdit && comment.text !== null && <button type="button" disabled={busy} onClick={() => onEdit(comment)}>Edit</button>}
      {comment.canDelete && (deleting === comment.id ? <>
        <button type="button" disabled={busy} className="text-rose-700" onClick={() => onConfirmDelete(comment)}>Confirm delete</button>
        <button type="button" disabled={busy} onClick={onCancelDelete}>Cancel</button>
      </> : <button type="button" disabled={busy} className="text-rose-700" onClick={() => onDelete(comment)}>Delete</button>)}
    </div>}
  </li>;
}

/**
 * The Public reader's Comment section. It renders only explicitly public epochs
 * under the document, with no Private/Public selector, and never receives a
 * Collaborators-only epoch. Posting requires a signed-in, device-bound Session;
 * the fragment capability stays in this browser.
 */
export function PublicComments({ page, linkId, onRefresh }: { page: ReadyPage; linkId: string; onRefresh: () => void }) {
  const [view, setView] = useState<PublicLinkComments | null>(page.comments);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const shownThread = useRef<string | null>(null);
  // A revalidation for the same thread must never clear an unsent draft; only a
  // different link/thread resets composer, edit or pending delete state.
  useEffect(() => {
    const threadId = page.comments?.status === "ready" ? page.comments.thread.threadId : null;
    if (shownThread.current !== threadId) {
      shownThread.current = threadId;
      setDraft(""); setEditing(null); setDeleting(null); setMessage("");
    }
    setView(page.comments);
  }, [page.comments]);

  if (!view) return null;
  if (view.status === "unavailable") {
    if (!view.threadId) return null;
    return <section aria-label="Public comments" className="mt-12 border-t border-stone-200 pt-6">
      <h2 className="text-lg font-medium">Comments</h2>
      <p className="mt-2 text-stone-600">Sign in to see or add comments if you have access to this file.</p>
    </section>;
  }
  const thread = view.thread;

  function fail(error: unknown) {
    if (error instanceof PublicCommentsSignInError) {
      setMessage(error.state === "unprovisioned"
        ? "This browser isn’t set up to post comments. Finish device setup in your Account settings."
        : "Sign in to add a comment.");
    } else if (error instanceof PublicCommentsLimitedError) {
      setMessage("You’ve reached the comment limit for now. Try again later.");
    } else if (error instanceof PublicCommentsSealedError) {
      setMessage("Secure access must finish updating before comments can change.");
    } else if (error instanceof PublicCommentsChangedError || error instanceof PublicCommentsNotFoundError) {
      setMessage("Comments changed on another device. Refresh to see the latest.");
    } else setMessage("The change couldn’t be confirmed. Try again.");
    onRefresh();
  }

  async function mutate(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setMessage("");
    try { await action(); onRefresh(); }
    catch (error) { fail(error); }
    finally { setBusy(false); }
  }

  const tooLong = commentCharacters(draft) > MAX_COMMENT_CHARS;
  return <section aria-label="Public comments" className="mt-12 border-t border-stone-200 pt-6">
    <h2 className="text-lg font-medium">Comments</h2>
    {message && <p role="alert" className="mt-2 text-rose-700">{message}</p>}
    <ol aria-label="Public comments" className="mt-3 space-y-3">
      {thread.comments.map((comment) => <CommentItem key={comment.id} comment={comment} thread={thread}
        editing={editing} deleting={deleting} busy={busy}
        onEdit={(selected) => { setDeleting(null); setEditing({ id: selected.id, text: selected.text ?? "" }); }}
        onEditText={(text) => { if (editing) setEditing({ id: editing.id, text }); }}
        onSubmitEdit={() => { if (!editing) return; const edit = editing;
          void mutate(async () => { await editLinkPublicComment(thread, linkId, thread.comments.find((item) => item.id === edit.id)!, edit.text);
            setEditing(null); }); }}
        onCancelEdit={() => setEditing(null)}
        onDelete={(selected) => { setEditing(null); setDeleting(selected.id); }}
        onCancelDelete={() => setDeleting(null)}
        onConfirmDelete={(selected) => void mutate(async () => {
          await deleteLinkPublicComment(thread, linkId, selected); setDeleting(null); })} />)}
      {!thread.comments.length && <li className="text-stone-500">No comments yet.</li>}
    </ol>
    {thread.nextCursor !== null && <button type="button" disabled={busy} className="mt-3 rounded border px-3 py-1 text-sm"
      onClick={() => void (async () => {
        if (busy) return;
        setBusy(true); setMessage("");
        try {
          const next = await loadMoreLinkPublicComments(thread);
          setView({ status: "ready", thread: { ...thread, comments: [...thread.comments, ...next.comments],
            pseudonyms: next.pseudonyms, nextCursor: next.nextCursor } });
        } catch (error) { fail(error); }
        finally { setBusy(false); }
      })()}>Load more comments</button>}
    {thread.postingState === "signed-out" && <p className="mt-4 border-t border-stone-200 pt-3 text-sm">
      <a href="/sign-in" className="underline">Sign in</a> to add a comment.</p>}
    {thread.postingState === "unprovisioned" && <p className="mt-4 border-t border-stone-200 pt-3 text-sm text-stone-600">
      This browser isn’t set up to post comments. Finish device setup in your Account settings.</p>}
    {thread.postingState === "ready" && <form className="mt-4 border-t border-stone-200 pt-3" onSubmit={(event) => {
      event.preventDefault();
      if (!draft || tooLong) return;
      void mutate(async () => { await postLinkPublicComment(thread, linkId, draft); setDraft(""); });
    }}>
      <label className="block text-sm" htmlFor="public-comment">Add a public comment
        <textarea id="public-comment" value={draft} disabled={busy} rows={3} placeholder="Plain text only"
          onChange={(event) => setDraft(event.target.value)}
          className="mt-1 w-full rounded border border-stone-300 p-2" />
      </label>
      <div className="mt-1 flex items-center justify-between gap-2">
        <p role="status" className={tooLong ? "text-rose-700" : "text-stone-500"}>{commentCharacters(draft)} / 2,000</p>
        <button type="submit" disabled={busy || !draft || tooLong} className="rounded bg-stone-900 px-3 py-1 text-white">
          {busy ? "Working…" : "Comment"}</button>
      </div>
    </form>}
  </section>;
}
