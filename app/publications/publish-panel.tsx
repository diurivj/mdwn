import { useEffect, useState, useSyncExternalStore } from "react";

import type { CommentAudience, PublicationErrorCode, PublicationLifecycle } from "~/shared/publications/lifecycle";
import { publicParticipationSuspensionNotice } from "~/shared/security/public-participation";
import { cx } from "~/ui/cx";
import { CheckIcon, CopyIcon, ExternalLinkIcon, GlobeIcon, RefreshIcon } from "~/ui/icons";
import { buttonClass, fieldClass, labelClass, noticeClass, textButtonClass } from "~/ui/styles";

const panelClass = "mt-5 animate-fade border border-line bg-cream p-5 sm:p-7";

const messages: Record<Exclude<PublicationErrorCode, "suspended">, string> = {
  changed: "This File’s publication changed on another device. Refresh and try again.",
  exists: "This File is already published.",
  "file-changed": "This File was saved on another device. Publishing uses the latest saved version — try again.",
  limited: "You’ve reached today’s publishing limit. Try again later.",
  "not-found": "No Account with access to this File matches that handle or share identifier.",
  "too-large": "Reduce this File within the source limit before publishing it.",
  "author-exists": "That Account is already credited.",
  "author-limit": "This Publication already credits the maximum number of authors.",
  "link-required": "Paste the complete public link (including the part after #) to enable public comments.",
  "pseudonym-pending":
    "Your Public pseudonym update is in progress. Finish or cancel it on the Public pseudonym page before changing authors.",
  "rotation-required": "Secure access must finish updating before the Public link or comment audience can change.",
  unavailable: "The change could not be confirmed. Try again.",
};

/**
 * Contextual Publication management. The Owner publishes (which approves any
 * pending requests), sees the one-time complete link, and opts in to authors;
 * a Collaborator can only request publication. The lifecycle module owns
 * candidate retention, read ordering, teardown and every mutation's
 * pending/error/refresh coordination; this adapter renders that state and
 * forwards the person's decisions. No panel state is persisted.
 */
export function PublishPanel({ lifecycle, fileReady }: { lifecycle: PublicationLifecycle; fileReady: boolean }) {
  const view = useSyncExternalStore(lifecycle.subscribe, lifecycle.getState, lifecycle.getState);
  const [includeSelf, setIncludeSelf] = useState(false);
  const [audience, setAudience] = useState<CommentAudience>("public");
  const [linkInput, setLinkInput] = useState("");
  const [address, setAddress] = useState("");
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const [confirming, setConfirming] = useState(false);

  // The panel's own lifetime: closing aborts its cancellable work, reopening
  // reloads authoritative state and resumes teardown while still deleting.
  useEffect(() => {
    lifecycle.attachPanel();
    return () => lifecycle.detachPanel();
  }, [lifecycle]);

  function describeError(code: PublicationErrorCode, suspendedUntil: number | null): string {
    return code === "suspended" ? publicParticipationSuspensionNotice(suspendedUntil) : messages[code];
  }

  async function applyAudience(next: CommentAudience) {
    if (await lifecycle.changeAudience(next, linkInput.trim() || null)) setLinkInput("");
  }

  async function creditCollaborator() {
    if (!address) return;
    if (await lifecycle.addAccountAuthor(address)) setAddress("");
  }

  async function copy() {
    if (!view.completeLink) return;
    try {
      await navigator.clipboard.writeText(view.completeLink);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }

  const working = view.busy;
  const shownMessage = view.error ? describeError(view.error.code, view.error.suspendedUntil) : "";

  if (view.panel === "loading")
    return (
      <section aria-label="Publish" className={panelClass}>
        <p role="status" className="text-sm text-muted">
          Loading publication…
        </p>
      </section>
    );
  if (view.panel === "failed")
    return (
      <section aria-label="Publish" className={panelClass}>
        <p role="alert" className={noticeClass("danger")}>
          Publication details could not be loaded.
        </p>
        <button
          type="button"
          className={cx(buttonClass("secondary", "sm"), "mt-3")}
          onClick={() => lifecycle.retryLoad()}
        >
          Retry
        </button>
      </section>
    );

  const state = view.state;
  if (!state) return null;
  const publication = state.publication;
  const ownRequest = state.requests.find((request) => request.own);
  const teardown = view.progress ?? state.teardown ?? { commentTotal: 0, commentsRemaining: 0 };
  const completeLink = view.completeLink;

  return (
    <section aria-label="Publish" className={cx(panelClass, "space-y-6")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow text-accent">Public page</p>
          <h2 className="mt-1 font-display text-[1.9rem] font-light leading-tight tracking-tight">
            {state.isOwner ? "Publish" : "Publication"}
          </h2>
        </div>
        {publication && publication.state !== "deleting" && (
          <span className="eyebrow inline-flex items-center gap-1.5 border border-success/25 bg-success-soft px-3 py-1.5 text-success">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
            Live
          </span>
        )}
      </div>
      {shownMessage && (
        <p role="alert" className={noticeClass("danger")}>
          {shownMessage}
        </p>
      )}
      {view.deletionComplete && (
        <p role="status" className={noticeClass("success")}>
          Public material deleted. The old Public link and its Public Comments are gone.
        </p>
      )}
      {publication?.state === "deleting" ? (
        <div className="space-y-3">
          <p role="status" className="font-medium">
            Deleting public material…
          </p>
          <p className="text-sm text-ink-soft">
            Public access has ended. Deletion continues automatically, even after you close this page.
          </p>
          {state.isOwner && (
            <p className="text-sm text-ink-soft">
              {teardown.commentTotal - teardown.commentsRemaining} of {teardown.commentTotal} Public
              {teardown.commentTotal === 1 ? " Comment" : " Comments"} deleted.
            </p>
          )}
          {state.isOwner && view.teardownFailed && (
            <button type="button" onClick={() => lifecycle.retryTeardown()} className={buttonClass("secondary", "sm")}>
              Continue deleting
            </button>
          )}
        </div>
      ) : state.isOwner ? (
        publication ? (
          <>
            <p role="status" className="text-sm text-ink-soft">
              Published. Anyone with the complete link can read the latest saved version of this File.
            </p>
            {completeLink ? (
              <div className="space-y-3 border border-line bg-paper p-4">
                <label className={labelClass}>
                  Public link
                  <input
                    readOnly
                    value={completeLink}
                    onFocus={(event) => event.currentTarget.select()}
                    className={cx(fieldClass("sm"), "mt-2 font-mono text-xs")}
                  />
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => void copy()} className={buttonClass("primary", "sm")}>
                    <CopyIcon />
                    Copy link
                  </button>
                  <a
                    href={completeLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonClass("secondary", "sm")}
                  >
                    <ExternalLinkIcon />
                    Open public page
                  </a>
                  {copied === "copied" && (
                    <span role="status" className="inline-flex items-center gap-1 text-sm text-success">
                      <CheckIcon />
                      Copied.
                    </span>
                  )}
                  {copied === "failed" && (
                    <span role="alert" className="text-sm text-danger">
                      Copy failed. Select the link and copy it.
                    </span>
                  )}
                </div>
                <p className="text-xs leading-relaxed text-muted">
                  Copy this link now. mdwn never stores the key after #, so it can’t show this link again.
                </p>
              </div>
            ) : (
              <p className="text-sm text-ink-soft">
                The complete link was shown when you published. mdwn never stores the key after #, so it can’t show the
                link again.
              </p>
            )}
            <div className="grid gap-6 border-t border-line pt-6 md:grid-cols-2">
              <div>
                <h3 className="eyebrow text-ink">Comments</h3>
                <p className="mt-1 text-sm text-ink-soft">
                  Audience:{" "}
                  <span className="font-medium text-ink">
                    {state.comments
                      ? state.comments.audience === "public"
                        ? "Public"
                        : "Collaborators only"
                      : "Not set up"}
                  </span>
                </p>
                {state.comments?.audience !== "public" && !completeLink && (
                  <label className={cx(labelClass, "mt-3")}>
                    Complete public link
                    <input
                      value={linkInput}
                      disabled={working}
                      onChange={(event) => setLinkInput(event.target.value)}
                      className={cx(fieldClass("sm"), "mt-2 font-mono text-xs")}
                      placeholder="https://…/p/…#v1.…"
                    />
                  </label>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {state.comments?.audience === "public" ? (
                    <button
                      type="button"
                      disabled={working}
                      className={buttonClass("secondary", "sm")}
                      onClick={() => void applyAudience("collaborators_only")}
                    >
                      Make comments collaborators only
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={working}
                      className={buttonClass("secondary", "sm")}
                      onClick={() => void applyAudience("public")}
                    >
                      {state.comments ? "Make comments public" : "Set up public comments"}
                    </button>
                  )}
                </div>
              </div>
              <div>
                <h3 className="eyebrow text-ink">Authors</h3>
                {publication.authors.length ? (
                  <ul aria-label="Authors" className="mt-2 border-t border-line">
                    {publication.authors.map((author) => (
                      <li
                        key={author.declarationId}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-3 text-sm"
                      >
                        <span className="font-medium">
                          {author.self ? "You (your Public pseudonym)" : `Collaborator ${author.ordinal}`}
                        </span>
                        <span className="text-xs text-muted">
                          {author.declared ? "shown publicly" : "waiting for their device"}
                        </span>
                        <button
                          type="button"
                          disabled={working}
                          onClick={() => void lifecycle.removeAuthor(author.declarationId)}
                          className={cx(textButtonClass("danger"), "ml-auto")}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-sm text-ink-soft">
                    No author is shown publicly. Attribution is off until you add one.
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {!publication.authors.some((author) => author.self) && (
                    <button
                      type="button"
                      disabled={working}
                      onClick={() => void lifecycle.addSelfAuthor()}
                      className={buttonClass("secondary", "sm")}
                    >
                      Show my Public pseudonym
                    </button>
                  )}
                </div>
                <form
                  className="mt-3 flex flex-wrap items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void creditCollaborator();
                  }}
                >
                  <label className={cx(labelClass, "min-w-0 flex-1")}>
                    Credit a collaborator by share handle or share identifier
                    <input
                      value={address}
                      disabled={working}
                      onChange={(event) => setAddress(event.target.value)}
                      className={cx(fieldClass("sm"), "mt-2")}
                    />
                  </label>
                  <button type="submit" disabled={working || !address} className={buttonClass("secondary", "sm")}>
                    Add author
                  </button>
                </form>
              </div>
            </div>
            <div className="grid gap-6 border-t border-line pt-6 md:grid-cols-2">
              <div>
                <h3 className="eyebrow text-ink">Public link</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-soft">
                  Rotating creates a new link and immediately retires the current one. This File’s Public Comments and
                  history stay, and the new link shows them.
                </p>
                <button
                  type="button"
                  disabled={working || !view.canOperate}
                  className={cx(buttonClass("secondary", "sm"), "mt-3")}
                  onClick={() => void lifecycle.rotateLink()}
                >
                  <RefreshIcon />
                  Rotate link
                </button>
              </div>
              <div>
                <h3 className="eyebrow text-ink">Unpublish</h3>
                {confirming ? (
                  <div className="mt-2 space-y-3">
                    <p role="alert" className={noticeClass("danger")}>
                      Unpublishing permanently deletes this Public link, the Public representation, and{" "}
                      {state.commentCount} Public {state.commentCount === 1 ? "Comment" : "Comments"}. It can’t be
                      undone, and copies already downloaded can’t be recalled.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={working}
                        className={buttonClass("danger", "sm")}
                        onClick={() => {
                          setConfirming(false);
                          void lifecycle.unpublish();
                        }}
                      >
                        Unpublish and permanently delete {state.commentCount} Public{" "}
                        {state.commentCount === 1 ? "Comment" : "Comments"}
                      </button>
                      <button
                        type="button"
                        disabled={working}
                        onClick={() => setConfirming(false)}
                        className={buttonClass("ghost", "sm")}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="mt-1 text-sm leading-relaxed text-ink-soft">
                      Unpublishing is permanent: it seals the link immediately and deletes the Public representation and
                      every Public Comment.
                    </p>
                    <button
                      type="button"
                      disabled={working}
                      onClick={() => {
                        setConfirming(true);
                        void lifecycle.refresh();
                      }}
                      className={cx(buttonClass("danger-quiet", "sm"), "mt-3")}
                    >
                      Unpublish…
                    </button>
                  </>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            <p className="max-w-3xl text-sm leading-relaxed text-ink-soft">
              Publishing creates a read-only public link to the latest saved version of this File. Anyone with the
              complete link can read it, and it updates when this File is saved. mdwn never receives the part of the
              link after #. Copies someone has already downloaded can’t be recalled.
            </p>
            {state.requests.length > 0 && (
              <div className={noticeClass("info")}>
                <p role="status">
                  {state.requests.length === 1
                    ? "A collaborator asked"
                    : `${state.requests.length} collaborators asked`}{" "}
                  you to publish this File. Publishing approves every request.
                </p>
                <ul aria-label="Publication requests" className="mt-2 space-y-1">
                  {state.requests.map((request, index) => (
                    <li key={request.requestId} className="flex items-center gap-2 text-sm">
                      Request {index + 1}
                      <button
                        type="button"
                        disabled={working}
                        className={textButtonClass("danger")}
                        onClick={() => void lifecycle.removePublicationRequest(request.requestId)}
                      >
                        Deny
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-col gap-4 border border-line bg-paper p-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-8">
              <fieldset className="text-sm">
                <legend className="eyebrow text-ink">Comments audience</legend>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-ink-soft">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="audience"
                      checked={audience === "public"}
                      disabled={working}
                      onChange={() => setAudience("public")}
                    />{" "}
                    Public
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="audience"
                      checked={audience === "collaborators_only"}
                      disabled={working}
                      onChange={() => setAudience("collaborators_only")}
                    />{" "}
                    Collaborators only
                  </label>
                </div>
              </fieldset>
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                <input
                  type="checkbox"
                  checked={includeSelf}
                  disabled={working}
                  onChange={(event) => setIncludeSelf(event.target.checked)}
                />{" "}
                Show my Public pseudonym as an author
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={working || !fileReady || !view.canOperate}
                className={buttonClass("primary")}
                onClick={() => void lifecycle.publish({ includeSelf, audience })}
              >
                <GlobeIcon />
                {working ? "Publishing…" : "Publish File"}
              </button>
              {!fileReady && (
                <p role="status" className="text-sm text-muted">
                  Save your draft before publishing.
                </p>
              )}
            </div>
          </>
        )
      ) : publication ? (
        <p role="status" className="text-sm text-ink-soft">
          This File is published by its Owner.
          {publication.authors.length > 0 &&
            ` You’re credited as an author (${publication.authors[0]!.declared ? "shown publicly" : "waiting for this device"}).`}
        </p>
      ) : ownRequest ? (
        <div className="space-y-3">
          <p role="status" className="text-sm text-ink-soft">
            You asked the Owner to publish this File. A request creates no public link.
          </p>
          <button
            type="button"
            disabled={working}
            className={buttonClass("secondary", "sm")}
            onClick={() => void lifecycle.removePublicationRequest(ownRequest.requestId)}
          >
            Cancel request
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-ink-soft">Only this File’s Owner can publish it. You can ask them to.</p>
          <button
            type="button"
            disabled={working}
            className={buttonClass("primary", "sm")}
            onClick={() => void lifecycle.requestPublication()}
          >
            Send request
          </button>
        </div>
      )}
    </section>
  );
}
