import { useState, type FormEvent } from "react";

import {
  publicParticipationSuspensionNotice,
  REPORT_CATEGORIES,
  REPORT_CATEGORY_LABELS,
  type ReportCategory,
} from "~/shared/security/public-participation";
import { PublicCommentsLimitedError, PublicCommentsSuspendedError, reportPublicComment } from "./public-client";

/**
 * Category-only report control (ticket 26). It sends an opaque Comment ID and
 * one fixed category — never the comment text, a capability, or a request
 * identifier — and states that Owner hard deletion, not a report, removes an
 * unwanted comment.
 */
export function CommentReportControl({ commentId }: { commentId: string }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  if (sent)
    return (
      <span role="status" className="text-stone-500">
        Report received.
      </span>
    );
  if (!open)
    return (
      <button type="button" className="text-stone-600 underline" onClick={() => setOpen(true)}>
        Report
      </button>
    );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!category || busy) return;
    setBusy(true);
    setMessage("");
    try {
      await reportPublicComment(commentId, category);
      setSent(true);
    } catch (error) {
      if (error instanceof PublicCommentsLimitedError) setMessage("You’ve reached the report limit for now.");
      else if (error instanceof PublicCommentsSuspendedError)
        setMessage(publicParticipationSuspensionNotice(error.suspendedUntil));
      else setMessage("The report couldn’t be sent. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mt-1 w-full space-y-2" onSubmit={(event) => void submit(event)}>
      <fieldset>
        <legend className="text-stone-600">Report this comment</legend>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          {REPORT_CATEGORIES.map((value) => (
            <label key={value} className="flex items-center gap-1">
              <input
                type="radio"
                name={`report-${commentId}`}
                checked={category === value}
                disabled={busy}
                onChange={() => setCategory(value)}
              />{" "}
              {REPORT_CATEGORY_LABELS[value]}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-stone-500">
        A report sends only a category and this comment’s ID, never its text. It doesn’t delete anything; the File’s
        owner can delete any comment.
      </p>
      {message && (
        <p role="alert" className="text-rose-700">
          {message}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !category} className="rounded border px-3 py-1">
          {busy ? "Sending…" : "Send report"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setMessage("");
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
