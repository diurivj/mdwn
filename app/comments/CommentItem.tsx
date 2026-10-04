import { commentCharacters, MAX_COMMENT_CHARS } from "./content";

/**
 * One displayed Comment, shared by the Private inspector and the authenticated
 * Public inspector. Bodies are plain text with line feeds only: HTML and
 * Markdown are never interpreted, and an unreadable body stays visible with an
 * explicit display failure.
 */
export type CommentItemView = {
  id: string; authorId: string; text: string | null; revision: number;
  createdAt: number; updatedAt: number; canEdit: boolean; canDelete: boolean;
};

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const stamp = (value: number) => timeFormat.format(new Date(value));

export function CommentItem({ comment, pseudonym, viewerAccountId, note, editing, deleting, busy, onEdit,
  onEditText, onSubmitEdit, onCancelEdit, onDelete, onConfirmDelete, onCancelDelete }: {
  comment: CommentItemView; pseudonym: string | undefined; viewerAccountId: string | null; note?: string;
  editing: { id: string; text: string } | null; deleting: string | null; busy: boolean;
  onEdit: (comment: CommentItemView) => void; onEditText: (text: string) => void; onSubmitEdit: () => void;
  onCancelEdit: () => void; onDelete: (comment: CommentItemView) => void;
  onConfirmDelete: (comment: CommentItemView) => void; onCancelDelete: () => void;
}) {
  const edit = editing && editing.id === comment.id ? editing : null;
  return <li className="rounded border border-stone-200 p-3">
    <p className="text-sm text-stone-600"><span className="font-medium text-stone-900">
      {pseudonym ?? (comment.authorId === viewerAccountId ? "You" : "Unknown author")}</span>
      {" · "}<time dateTime={new Date(comment.createdAt).toISOString()}>{stamp(comment.createdAt)}</time>
      {comment.updatedAt !== comment.createdAt && " · edited"}{note && ` · ${note}`}</p>
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
    {(comment.canEdit || comment.canDelete) && !edit && <div className="mt-2 flex gap-2 text-sm">
      {comment.canEdit && comment.text !== null && <button type="button" disabled={busy} onClick={() => onEdit(comment)}>Edit</button>}
      {comment.canDelete && (deleting === comment.id ? <>
        <button type="button" disabled={busy} className="text-rose-700" onClick={() => onConfirmDelete(comment)}>Confirm delete</button>
        <button type="button" disabled={busy} onClick={onCancelDelete}>Cancel</button>
      </> : <button type="button" disabled={busy} className="text-rose-700" onClick={() => onDelete(comment)}>Delete</button>)}
    </div>}
  </li>;
}
