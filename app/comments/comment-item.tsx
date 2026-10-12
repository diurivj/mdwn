import { commentCharacters, MAX_COMMENT_CHARS } from "../shared/comments/content";
import type { ReactNode } from "react";
import { cx } from "~/ui/cx";
import { buttonClass, fieldClass, textButtonClass } from "~/ui/styles";

/**
 * One displayed Comment, shared by the Private inspector and the authenticated
 * Public inspector. Bodies are plain text with line feeds only: HTML and
 * Markdown are never interpreted, and an unreadable body stays visible with an
 * explicit display failure.
 */
export type CommentItemView = {
  id: string;
  authorId: string;
  text: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  canEdit: boolean;
  canDelete: boolean;
};

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const stamp = (value: number) => timeFormat.format(new Date(value));

export function CommentItem({
  comment,
  pseudonym,
  viewerAccountId,
  note,
  editing,
  deleting,
  busy,
  onEdit,
  onEditText,
  onSubmitEdit,
  onCancelEdit,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
  reportControl,
}: {
  comment: CommentItemView;
  pseudonym: string | undefined;
  viewerAccountId: string | null;
  note?: string;
  editing: { id: string; text: string } | null;
  deleting: string | null;
  busy: boolean;
  onEdit: (comment: CommentItemView) => void;
  onEditText: (text: string) => void;
  onSubmitEdit: () => void;
  onCancelEdit: () => void;
  onDelete: (comment: CommentItemView) => void;
  onConfirmDelete: (comment: CommentItemView) => void;
  onCancelDelete: () => void;
  /** Inline category-only report control; absent for surfaces that cannot report. */
  reportControl?: ReactNode;
}) {
  const edit = editing && editing.id === comment.id ? editing : null;
  return (
    <li className="border-b border-line px-4 py-4">
      <p className="font-mono text-[12px] text-muted">
        <span className="font-sans text-[14px] font-medium text-ink">
          {pseudonym ?? (comment.authorId === viewerAccountId ? "You" : "Unknown author")}
        </span>
        {" · "}
        <time dateTime={new Date(comment.createdAt).toISOString()}>{stamp(comment.createdAt)}</time>
        {comment.updatedAt !== comment.createdAt && " · edited"}
        {note && ` · ${note}`}
      </p>
      {edit ? (
        <form
          className="mt-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (commentCharacters(edit.text) > MAX_COMMENT_CHARS) return;
            onSubmitEdit();
          }}
        >
          <label className="block text-sm font-medium text-ink">
            Edit comment
            <textarea
              // biome-ignore lint/a11y/noAutofocus: focus follows the user's explicit Edit action on this comment.
              autoFocus
              value={edit.text}
              disabled={busy}
              rows={4}
              onChange={(event) => onEditText(event.target.value)}
              className={cx(fieldClass("sm"), "mt-2 resize-none font-normal")}
            />
          </label>
          <p className="mt-1 font-mono text-xs tabular-nums text-muted">{commentCharacters(edit.text)} / 2,000</p>
          <div className="mt-2 flex gap-2">
            <button
              type="submit"
              disabled={busy || commentCharacters(edit.text) > MAX_COMMENT_CHARS}
              className={buttonClass("primary", "sm")}
            >
              Save comment
            </button>
            <button type="button" disabled={busy} onClick={onCancelEdit} className={buttonClass("ghost", "sm")}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p className="mt-1.5 whitespace-pre-wrap break-words text-[14.5px] leading-relaxed text-ink-soft">
          {comment.text ?? <span className="text-danger">This comment couldn’t be decrypted on this device.</span>}
        </p>
      )}
      {(comment.canEdit || comment.canDelete || reportControl) && !edit && (
        <div className="-ml-2 mt-2 flex flex-wrap items-center gap-1 text-[13px]">
          {comment.canEdit && comment.text !== null && (
            <button type="button" disabled={busy} onClick={() => onEdit(comment)} className={textButtonClass()}>
              Edit
            </button>
          )}
          {comment.canDelete &&
            (deleting === comment.id ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  className={textButtonClass("danger")}
                  onClick={() => onConfirmDelete(comment)}
                >
                  Confirm delete
                </button>
                <button type="button" disabled={busy} onClick={onCancelDelete} className={textButtonClass()}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={busy}
                className={textButtonClass("danger")}
                onClick={() => onDelete(comment)}
              >
                Delete
              </button>
            ))}
          {reportControl}
        </div>
      )}
    </li>
  );
}
