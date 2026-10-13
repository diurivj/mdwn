import { type ReactNode, useEffect, useId, useState, useSyncExternalStore } from "react";

import type {
  CommentAudience,
  PublicationErrorCode,
  PublicationFailure,
  PublicationLifecycle,
  PublicationState,
  SettingsChange,
} from "~/shared/publications/lifecycle";
import { publicParticipationSuspensionNotice } from "~/shared/security/public-participation";
import { cx } from "~/ui/cx";
import { CheckIcon, CopyIcon, ExternalLinkIcon, GlobeIcon, PencilIcon, RefreshIcon } from "~/ui/icons";
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
  "link-required":
    "This device can’t show the current link, so it can’t open its comments to the public. Create a new link instead.",
  "pseudonym-pending":
    "Your Public pseudonym update is in progress. Finish or cancel it on the Public pseudonym page before changing authors.",
  "rotation-required": "Secure access must finish updating before the Public link or comment audience can change.",
  unavailable: "The change could not be confirmed. Try again.",
};

/** What each Comment audience means, in the publish form, the settings form and the summary. */
const audiences: Record<CommentAudience, { label: string; description: string }> = {
  public: {
    label: "Public",
    description: "Anyone with the link can read them. Posting needs a signed-in mdwn account.",
  },
  collaborators_only: {
    label: "Collaborators only",
    description: "Only you and the people this File is shared with can read or post. Link readers see none.",
  },
};

/** The settings the authoritative state shows, as the settings form starts them. */
function currentSettings(state: PublicationState): SettingsChange {
  return {
    audience: state.comments?.audience ?? null,
    includeSelf: state.publication?.authors.some((author) => author.self) ?? false,
  };
}

function describeError(error: PublicationFailure): string {
  const message =
    error.code === "suspended" ? publicParticipationSuspensionNotice(error.suspendedUntil) : messages[error.code];
  return error.newLinkCreated
    ? `The new link is ready, but not every setting was saved. ${message} Save changes applies the rest to this link.`
    : message;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * Contextual Publication management. The Owner publishes (which approves any
 * pending requests), sees and copies the complete link, reads how the File is
 * published, and changes that either on the current link or with a new one; a
 * Collaborator can only request publication. The lifecycle module owns
 * candidate retention, read ordering, teardown and every mutation's
 * pending/error/refresh coordination; this adapter renders that state and
 * forwards the person's decisions. No panel state is persisted.
 */
export function PublishPanel({ lifecycle, fileReady }: { lifecycle: PublicationLifecycle; fileReady: boolean }) {
  const view = useSyncExternalStore(lifecycle.subscribe, lifecycle.getState, lifecycle.getState);
  const [settings, setSettings] = useState<SettingsChange>({ audience: "public", includeSelf: false });
  const [editing, setEditing] = useState<SettingsChange | null>(null);
  const [address, setAddress] = useState("");
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const [confirming, setConfirming] = useState(false);

  // The panel's own lifetime: closing aborts its cancellable work, reopening
  // reloads authoritative state and resumes teardown while still deleting.
  useEffect(() => {
    lifecycle.attachPanel();
    return () => lifecycle.detachPanel();
  }, [lifecycle]);

  async function saveSettings(next: SettingsChange, newLink: boolean) {
    if (await lifecycle.changeSettings(next, { newLink })) setEditing(null);
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
  const shownMessage = view.error ? describeError(view.error) : "";

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
  const live = publication?.state === "active";
  const collaborators = publication?.authors.filter((author) => !author.self) ?? [];

  return (
    <section aria-label="Publish" className={cx(panelClass, "space-y-6")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow text-accent">Public page</p>
          <h2 className="mt-1 font-display text-[1.9rem] font-light leading-tight tracking-tight">
            {!state.isOwner ? "Publication" : live ? "Published" : publication ? "Unpublishing" : "Publish"}
          </h2>
        </div>
        {live && (
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
                  Only you see this link here: mdwn keeps it encrypted with your own keys, so any of your devices can
                  show it again and mdwn can’t read it.
                </p>
              </div>
            ) : (
              <div className="space-y-3 border border-line bg-paper p-4">
                <p className="font-medium text-ink">This link can’t be shown here</p>
                <p className="text-sm leading-relaxed text-ink-soft">
                  It was created before mdwn kept an encrypted copy for you, so only the page that created it could show
                  it. Create a new link to see and copy it here from now on. The current link stops working; Public
                  Comments stay.
                </p>
                <button
                  type="button"
                  disabled={working || !view.canOperate}
                  className={buttonClass("secondary", "sm")}
                  onClick={() => void saveSettings(currentSettings(state), true)}
                >
                  <RefreshIcon />
                  Create new link
                </button>
              </div>
            )}
            {editing ? (
              <form
                aria-label="Change settings"
                className="space-y-5 border-t border-line pt-6"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveSettings(editing, false);
                }}
              >
                <h3 className="eyebrow text-ink">Change settings</h3>
                <SettingsFields value={editing} onChange={setEditing} disabled={working} />
                <SettingsActions
                  draft={editing}
                  state={state}
                  linkShown={completeLink !== null}
                  disabled={working || !view.canOperate}
                  onNewLink={() => void saveSettings(editing, true)}
                  onCancel={() => setEditing(null)}
                  cancelDisabled={working}
                />
              </form>
            ) : (
              <SettingsSummary state={state} disabled={working} onChange={() => setEditing(currentSettings(state))} />
            )}
            <section aria-label="Credited collaborators" className="border-t border-line pt-6">
              <h3 className="eyebrow text-ink">Credited collaborators</h3>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-soft">
                Credit someone this File is shared with: their Public pseudonym appears as an author once their own
                device confirms it. Credits keep the current link.
              </p>
              {collaborators.length > 0 && (
                <ul aria-label="Authors" className="mt-3 border-t border-line">
                  {collaborators.map((author) => (
                    <li
                      key={author.declarationId}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-3 text-sm"
                    >
                      <span className="font-medium">Collaborator {author.ordinal}</span>
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
              )}
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
            </section>
            <section aria-label="Unpublish" className="border-t border-line pt-6">
              <h3 className="eyebrow text-ink">Unpublish</h3>
              {confirming ? (
                <div className="mt-2 space-y-3">
                  <p role="alert" className={noticeClass("danger")}>
                    Unpublishing permanently deletes this Public link, the Public representation, and{" "}
                    {state.commentCount} Public {state.commentCount === 1 ? "Comment" : "Comments"}. It can’t be undone,
                    and copies already downloaded can’t be recalled.
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
                  <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-soft">
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
            </section>
          </>
        ) : (
          <>
            <p className="max-w-3xl text-sm leading-relaxed text-ink-soft">
              Not published. Publishing creates a read-only public link to the latest saved version of this File, and
              the page updates whenever the File is saved. Anyone with the complete link can read it. mdwn never
              receives the part of the link after # in readable form. Copies someone has already downloaded can’t be
              recalled.
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
            <div className="border border-line bg-paper p-4">
              <SettingsFields value={settings} onChange={setSettings} disabled={working} />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={working || !fileReady || !view.canOperate}
                className={buttonClass("primary")}
                onClick={() => void lifecycle.publish({ ...settings, audience: settings.audience ?? "public" })}
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
        <div className="space-y-3 text-sm text-ink-soft">
          <p role="status">
            This File is published by its Owner.
            {publication.authors.length > 0 &&
              ` You’re credited as an author (${publication.authors[0]!.declared ? "shown publicly" : "waiting for this device"}).`}
          </p>
          {state.comments && (
            <p>
              Comments: <span className="font-medium text-ink">{audiences[state.comments.audience].label}</span>.{" "}
              {audiences[state.comments.audience].description}
            </p>
          )}
        </div>
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

/** The two choices a File is published with, for publishing and for changing them later. */
function SettingsFields({
  value,
  onChange,
  disabled,
}: {
  value: SettingsChange;
  onChange: (next: SettingsChange) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <fieldset className="min-w-0">
        <legend className="eyebrow text-ink">Comments</legend>
        <div className="mt-3 space-y-3">
          {(["public", "collaborators_only"] as const).map((audience) => (
            <div key={audience} className="flex items-start gap-2.5 text-sm">
              <input
                id={`${id}-${audience}`}
                type="radio"
                name={`${id}-audience`}
                className="mt-1"
                checked={value.audience === audience}
                disabled={disabled}
                aria-describedby={`${id}-${audience}-description`}
                onChange={() => onChange({ ...value, audience })}
              />
              <div className="min-w-0">
                <label htmlFor={`${id}-${audience}`} className="font-medium text-ink">
                  {audiences[audience].label}
                </label>
                <p id={`${id}-${audience}-description`} className="text-ink-soft">
                  {audiences[audience].description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </fieldset>
      <fieldset className="min-w-0">
        <legend className="eyebrow text-ink">Authors</legend>
        <div className="mt-3 flex items-start gap-2.5 text-sm">
          <input
            id={`${id}-self`}
            type="checkbox"
            className="mt-1"
            checked={value.includeSelf}
            disabled={disabled}
            aria-describedby={`${id}-self-description`}
            onChange={(event) => onChange({ ...value, includeSelf: event.target.checked })}
          />
          <div className="min-w-0">
            <label htmlFor={`${id}-self`} className="font-medium text-ink">
              Show my Public pseudonym as an author
            </label>
            <p id={`${id}-self-description`} className="text-ink-soft">
              Without it the page names no author.
            </p>
          </div>
        </div>
      </fieldset>
    </div>
  );
}

/**
 * Applying changed settings: on the current link, or on a new one that
 * retires it. Making Comments public on the current link needs its complete
 * link, so that choice is only offered here while this browser can show it.
 */
function SettingsActions({
  draft,
  state,
  linkShown,
  disabled,
  onNewLink,
  onCancel,
  cancelDisabled,
}: {
  draft: SettingsChange;
  state: PublicationState;
  linkShown: boolean;
  disabled: boolean;
  onNewLink: () => void;
  onCancel: () => void;
  cancelDisabled: boolean;
}) {
  const current = currentSettings(state);
  const changed = draft.audience !== (state.comments?.audience ?? null) || draft.includeSelf !== current.includeSelf;
  const needsLink = draft.audience === "public" && state.comments?.audience !== "public";
  return (
    <div className="space-y-3">
      {needsLink && !linkShown && (
        <p role="status" className={noticeClass("info")}>
          This device can’t show the current link, so public comments need a new link.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={disabled || !changed || (needsLink && !linkShown)}
          className={buttonClass("primary", "sm")}
        >
          Save changes
        </button>
        <button type="button" disabled={disabled} onClick={onNewLink} className={buttonClass("secondary", "sm")}>
          <RefreshIcon />
          {changed ? "Save and create new link" : "Create new link"}
        </button>
        <button type="button" disabled={cancelDisabled} onClick={onCancel} className={buttonClass("ghost", "sm")}>
          Cancel
        </button>
      </div>
      <p className="max-w-2xl text-xs leading-relaxed text-muted">
        Save changes keeps the current link. A new link replaces it: the current link stops working, so anyone using it
        will need the new one. Public Comments stay either way.
      </p>
    </div>
  );
}

/** How the File is published right now, from the authoritative state. */
function SettingsSummary({
  state,
  disabled,
  onChange,
}: {
  state: PublicationState;
  disabled: boolean;
  onChange: () => void;
}) {
  const publication = state.publication!;
  const audience = state.comments?.audience;
  const self = publication.authors.find((author) => author.self);
  const credited = publication.authors.filter((author) => !author.self);
  const authors = [
    ...(self ? [self.declared ? "Your Public pseudonym" : "Your Public pseudonym (being added)"] : []),
    ...credited.map(
      (author) => `Collaborator ${author.ordinal}${author.declared ? "" : " (waiting for their device)"}`,
    ),
  ];
  return (
    <section aria-label="How it’s published" className="border-t border-line pt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="eyebrow text-ink">How it’s published</h3>
        <button type="button" disabled={disabled} onClick={onChange} className={buttonClass("secondary", "sm")}>
          <PencilIcon />
          Change settings
        </button>
      </div>
      <dl className="mt-3 divide-y divide-line border-y border-line text-sm">
        <SummaryRow term="Comments">
          {audience ? (
            <>
              <span className="font-medium text-ink">{audiences[audience].label}.</span>{" "}
              {audiences[audience].description}
            </>
          ) : (
            <>
              <span className="font-medium text-ink">Off.</span> Link readers see no comments.
            </>
          )}
        </SummaryRow>
        <SummaryRow term="Authors">
          {authors.length ? (
            <span className="font-medium text-ink">{authors.join(", ")}</span>
          ) : (
            <>
              <span className="font-medium text-ink">None.</span> The page names no author.
            </>
          )}
        </SummaryRow>
        <SummaryRow term="Published">{dateFormat.format(new Date(publication.createdAt))}</SummaryRow>
      </dl>
    </section>
  );
}

function SummaryRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
      <dt className="eyebrow pt-0.5 text-muted">{term}</dt>
      <dd className="leading-relaxed text-ink-soft">{children}</dd>
    </div>
  );
}
