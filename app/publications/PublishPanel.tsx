import { useCallback, useEffect, useRef, useState } from "react";

import type { FilesSnapshot } from "~/tree/navigation-client";
import {
  addAccountAuthor, addSelfAuthor, changeCommentAudience, continuePublicationTeardown, loadPublicationState, publishFile,
  PublicationError, removeAuthor, removePublicationRequest, requestPublication, rotatePublicationLink, unpublishPublication,
  type CommentAudience, type PreparedPublicLink, type PublicationState, type TeardownProgress,
} from "./publications-client";
import { loadFile } from "~/tree/client";

type PanelState = { status: "loading" } | { status: "failed" } | { status: "ready"; state: PublicationState };

const messages: Record<PublicationError["code"], string> = {
  changed: "This File’s publication changed on another device. Refresh and try again.",
  exists: "This File is already published.",
  "file-changed": "This File was saved on another device. Publishing uses the latest saved version — try again.",
  limited: "You’ve reached today’s publishing limit. Try again later.",
  "not-found": "No Account with access to this File matches that handle or share identifier.",
  "too-large": "Reduce this File within the source limit before publishing it.",
  "author-exists": "That Account is already credited.",
  "author-limit": "This Publication already credits the maximum number of authors.",
  "link-required": "Paste the complete public link (including the part after #) to enable public comments.",
  "pseudonym-pending": "Your Public pseudonym update is in progress. Finish or cancel it on the Public pseudonym page before changing authors.",
  "rotation-required": "Secure access must finish updating before the Public link or comment audience can change.",
  unavailable: "The change could not be confirmed. Try again.",
};

/**
 * Contextual Publication management. The Owner publishes (which approves any
 * pending requests), sees the one-time complete link, and opts in to authors;
 * a Collaborator can only request publication. No panel state is persisted.
 */
export function PublishPanel({ fileId, snapshot, fileReady, links, onPrepared }: {
  fileId: string; snapshot: FilesSnapshot; fileReady: boolean;
  links: ReadonlyMap<string, PreparedPublicLink>; onPrepared: (link: PreparedPublicLink) => void;
}) {
  const [panel, setPanel] = useState<PanelState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [includeSelf, setIncludeSelf] = useState(false);
  const [audience, setAudience] = useState<CommentAudience>("public");
  const [linkInput, setLinkInput] = useState("");
  const [address, setAddress] = useState("");
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<TeardownProgress | null>(null);
  const [teardownAttempt, setTeardownAttempt] = useState(0);
  const [teardownFailed, setTeardownFailed] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const accessRef = useRef(snapshot.access);
  useEffect(() => { accessRef.current = snapshot.access; }, [snapshot.access]);
  const parentId = snapshot.file?.parentId ?? null;
  const parentKey = parentId ? snapshot.keys[parentId] : snapshot.access.rootKey;

  const reload = useCallback(async (signal: AbortSignal) => {
    try {
      const state = await loadPublicationState(fileId, signal);
      if (!signal.aborted) setPanel({ status: "ready", state });
    } catch { if (!signal.aborted) setPanel({ status: "failed" }); }
  }, [fileId]);

  // A failed or superseded attempt must never be shown as the active link. The
  // map is keyed by path identifier so a rotation keeps both candidates.
  const completeLinkFor = useCallback((value: { linkId?: string | null } | null | undefined) =>
    value?.linkId ? links.get(value.linkId)?.url ?? null : null, [links]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setPanel({ status: "loading" }); setMessage(""); setBusy(false);
    setConfirming(false); setProgress(null); setTeardownFailed(false);
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  // The Owner's browser finishes a sealed teardown in idempotent bounded
  // batches and shows progress until the Publication row is gone.
  const deleting = panel.status === "ready" && panel.state.isOwner && panel.state.publication?.state === "deleting";
  useEffect(() => {
    if (!deleting) return;
    const controller = new AbortController();
    let active = true;
    setTeardownFailed(false);
    void (async () => {
      try {
        let next = await continuePublicationTeardown(fileId, controller.signal);
        while (active && !next.done) {
          setProgress(next);
          next = await continuePublicationTeardown(fileId, controller.signal);
        }
        if (!active) return;
        setProgress(next);
        await reload(controller.signal);
      } catch {
        if (!active || controller.signal.aborted) return;
        setTeardownFailed(true);
        await reload(controller.signal);
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [deleting, teardownAttempt, fileId, reload]);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || busy) return;
    setBusy(true); setMessage("");
    try {
      await action(controller.signal);
      await reload(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      setMessage(error instanceof PublicationError ? messages[error.code] : messages.unavailable);
      await reload(controller.signal);
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }

  async function changeAudience(next: CommentAudience, signal: AbortSignal) {
    const file = await loadFile(accessRef.current, fileId, parentKey!, signal);
    if (!file.publication || file.publication.publicationId !== publication?.publicationId) throw new PublicationError("changed");
    const link = completeLinkFor(file.publication) ?? linkInput.trim() ?? "";
    await changeCommentAudience(accessRef.current, fileId, {
      publicationId: file.publication.publicationId, linkId: file.publication.linkId,
      publicKey: file.publication.publicKey, expectedEpochId: panel.status === "ready" ? panel.state.comments?.epochId ?? null : null,
      threadId: panel.status === "ready" ? panel.state.comments?.threadId ?? null : null,
    }, next, link || null, signal);
    setLinkInput("");
  }

  // A failed or superseded attempt must never be shown as the active link.
  const completeLink = panel.status === "ready" ? completeLinkFor(panel.state.publication) : null;
  async function copy() {
    if (!completeLink) return;
    try { await navigator.clipboard.writeText(completeLink); setCopied("copied"); }
    catch { setCopied("failed"); }
  }

  if (panel.status === "loading") return <section aria-label="Publish" className="mt-4 rounded border border-stone-200 p-4">
    <p role="status">Loading publication…</p></section>;
  if (panel.status === "failed") return <section aria-label="Publish" className="mt-4 rounded border border-stone-200 p-4">
    <p role="alert">Publication details could not be loaded.</p>
    <button type="button" className="mt-2 rounded border px-3 py-1" onClick={() => {
      const controller = lifetime.current; if (controller) { setPanel({ status: "loading" }); void reload(controller.signal); } }}>Retry</button>
  </section>;

  const { state } = panel;
  const publication = state.publication;
  const ownRequest = state.requests.find((request) => request.own);
  const teardown = progress ?? state.teardown ?? { commentTotal: 0, commentsRemaining: 0 };
  return <section aria-label="Publish" className="mt-4 space-y-3 rounded border border-stone-200 bg-white p-4">
    <h2 className="font-medium">{state.isOwner ? "Publish" : "Publication"}</h2>
    {message && <p role="alert" className="text-rose-700">{message}</p>}
    {publication?.state === "deleting" ? <div className="space-y-2">
      <p role="status">Deleting public material…</p>
      {state.isOwner && <p className="text-sm text-stone-600">
        {teardown.commentTotal - teardown.commentsRemaining} of {teardown.commentTotal} Public
        {teardown.commentTotal === 1 ? " Comment" : " Comments"} deleted.</p>}
      {state.isOwner && teardownFailed && <button type="button"
        onClick={() => setTeardownAttempt((attempt) => attempt + 1)}
        className="rounded border px-3 py-1 text-sm">Continue deleting</button>}
    </div> : state.isOwner ? publication ? <>
      <p role="status">Published. Anyone with the complete link can read the latest saved version of this File.</p>
      {completeLink ? <div className="space-y-2">
        <label className="block text-sm">Public link
          <input readOnly value={completeLink} onFocus={(event) => event.currentTarget.select()}
            className="mt-1 w-full rounded border border-stone-300 p-2 font-mono text-xs" /></label>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => void copy()} className="rounded border px-3 py-1">Copy link</button>
          <a href={completeLink} target="_blank" rel="noopener noreferrer" className="underline">Open public page</a>
          {copied === "copied" && <span role="status">Copied.</span>}
          {copied === "failed" && <span role="alert">Copy failed. Select the link and copy it.</span>}
        </div>
        <p className="text-sm text-stone-600">Copy this link now. mdwn never stores the key after #, so it can’t show this link again.</p>
      </div> : <p className="text-sm text-stone-600">The complete link was shown when you published. mdwn never stores the key after #, so it can’t show the link again.</p>}
      <div>
        <h3 className="text-sm font-medium">Comments</h3>
        <p className="text-sm text-stone-600">Audience: <span className="font-medium text-stone-900">
          {state.comments ? state.comments.audience === "public" ? "Public" : "Collaborators only" : "Not set up"}</span></p>
        {state.comments?.audience !== "public" && !completeLink && <label className="mt-1 block text-sm">
          Complete public link
          <input value={linkInput} disabled={busy} onChange={(event) => setLinkInput(event.target.value)}
            className="mt-1 block w-full rounded border border-stone-300 p-1 font-mono text-xs"
            placeholder="https://…/p/…#v1.…" />
        </label>}
        <div className="mt-2 flex flex-wrap gap-2">
          {state.comments?.audience === "public"
            ? <button type="button" disabled={busy} className="rounded border px-3 py-1 text-sm"
              onClick={() => void run((signal) => changeAudience("collaborators_only", signal))}>Make comments collaborators only</button>
            : <button type="button" disabled={busy} className="rounded border px-3 py-1 text-sm"
              onClick={() => void run((signal) => changeAudience("public", signal))}>
              {state.comments ? "Make comments public" : "Set up public comments"}</button>}
        </div>
      </div>
      <div>
        <h3 className="text-sm font-medium">Authors</h3>
        {publication.authors.length ? <ul aria-label="Authors" className="mt-1 space-y-1">{publication.authors.map((author) =>
          <li key={author.declarationId} className="flex flex-wrap items-center gap-2 text-sm">
            <span>{author.self ? "You (your Public pseudonym)" : `Collaborator ${author.ordinal}`}</span>
            <span className="text-stone-500">{author.declared ? "shown publicly" : "waiting for their device"}</span>
            <button type="button" disabled={busy} onClick={() => void run((signal) => removeAuthor(fileId, author.declarationId, signal))}
              className="underline">Remove</button>
          </li>)}</ul> : <p className="text-sm text-stone-600">No author is shown publicly. Attribution is off until you add one.</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          {!publication.authors.some((author) => author.self) && <button type="button" disabled={busy}
            onClick={() => void run(async (signal) => {
              const file = await loadFile(accessRef.current, fileId, parentKey!, signal);
              if (!file.publication) throw new PublicationError("changed");
              await addSelfAuthor(accessRef.current, fileId, file.publication, signal);
            })} className="rounded border px-3 py-1 text-sm">Show my Public pseudonym</button>}
        </div>
        <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(event) => {
          event.preventDefault();
          if (!address) return;
          void run(async (signal) => { await addAccountAuthor(fileId, publication.publicationId, address, signal); setAddress(""); });
        }}>
          <label className="text-sm">Credit a collaborator by share handle or share identifier
            <input value={address} disabled={busy} onChange={(event) => setAddress(event.target.value)}
              className="mt-1 block w-72 max-w-full rounded border border-stone-300 p-1" /></label>
          <button type="submit" disabled={busy || !address} className="rounded border px-3 py-1 text-sm">Add author</button>
        </form>
      </div>
      <div>
        <h3 className="text-sm font-medium">Public link</h3>
        <p className="text-sm text-stone-600">Rotating creates a new link and immediately retires the current one. This File’s
          Public Comments and history stay, and the new link shows them.</p>
        <button type="button" disabled={busy || !parentKey} className="mt-2 rounded border px-3 py-1 text-sm"
          onClick={() => void run(async (signal) => {
            await rotatePublicationLink({ access: accessRef.current, fileId, parentKey: parentKey!, signal, onPrepared });
          })}>Rotate link</button>
      </div>
      <div>
        <h3 className="text-sm font-medium">Unpublish</h3>
        {confirming ? <div className="mt-1 space-y-2">
          <p role="alert" className="text-sm text-stone-600">Unpublishing permanently deletes this Public link, the Public
            representation, and {state.commentCount} Public {state.commentCount === 1 ? "Comment" : "Comments"}. It can’t be
            undone, and copies already downloaded can’t be recalled.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} className="rounded bg-rose-700 px-3 py-1 text-sm text-white"
              onClick={() => void run(async (signal) => { setConfirming(false); await unpublishPublication(fileId, signal); })}>
              Unpublish and permanently delete {state.commentCount} Public {state.commentCount === 1 ? "Comment" : "Comments"}</button>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)}
              className="rounded border px-3 py-1 text-sm">Cancel</button>
          </div>
        </div> : <>
          <p className="text-sm text-stone-600">Unpublishing is permanent: it seals the link immediately and deletes the Public
            representation and every Public Comment.</p>
          <button type="button" disabled={busy} onClick={() => {
            setConfirming(true);
            // Refresh the current opaque count so the confirmation is honest.
            const controller = lifetime.current;
            if (controller && !controller.signal.aborted) void reload(controller.signal);
          }} className="mt-2 rounded border px-3 py-1 text-sm">Unpublish…</button>
        </>}
      </div>
    </> : <>
      <p className="text-sm text-stone-600">Publishing creates a read-only public link to the latest saved version of this File. Anyone
        with the complete link can read it, and it updates when this File is saved. mdwn never receives the part of the link after #.
        Copies someone has already downloaded can’t be recalled.</p>
      {state.requests.length > 0 && <div>
        <p role="status">{state.requests.length === 1 ? "A collaborator asked" : `${state.requests.length} collaborators asked`} you
          to publish this File. Publishing approves every request.</p>
        <ul aria-label="Publication requests" className="mt-1 space-y-1">{state.requests.map((request, index) =>
          <li key={request.requestId} className="flex items-center gap-2 text-sm">Request {index + 1}
            <button type="button" disabled={busy} className="underline"
              onClick={() => void run((signal) => removePublicationRequest(fileId, request.requestId, signal))}>Deny</button>
          </li>)}</ul>
      </div>}
      <label className="block text-sm"><input type="checkbox" checked={includeSelf} disabled={busy}
        onChange={(event) => setIncludeSelf(event.target.checked)} /> Show my Public pseudonym as an author</label>
      <button type="button" disabled={busy || !fileReady || !parentKey} className="rounded bg-stone-900 px-3 py-1 text-white"
        onClick={() => void run(async (signal) => {
          await publishFile({ access: accessRef.current, fileId, parentId, parentKey: parentKey!,
            includeSelf, audience, signal, onPrepared });
        })}>{busy ? "Publishing…" : "Publish File"}</button>
      <fieldset className="text-sm">
        <legend>Comments audience</legend>
        <label className="mr-3"><input type="radio" name="audience" checked={audience === "public"} disabled={busy}
          onChange={() => setAudience("public")} /> Public</label>
        <label><input type="radio" name="audience" checked={audience === "collaborators_only"} disabled={busy}
          onChange={() => setAudience("collaborators_only")} /> Collaborators only</label>
      </fieldset>
      {!fileReady && <p role="status" className="text-sm">Save your draft before publishing.</p>}
    </> : publication ? <p role="status">This File is published by its Owner.{publication.authors.length > 0 &&
      ` You’re credited as an author (${publication.authors[0]!.declared ? "shown publicly" : "waiting for this device"}).`}</p>
      : ownRequest ? <>
        <p role="status">You asked the Owner to publish this File. A request creates no public link.</p>
        <button type="button" disabled={busy} className="rounded border px-3 py-1"
          onClick={() => void run((signal) => removePublicationRequest(fileId, ownRequest.requestId, signal))}>Cancel request</button>
      </> : <>
        <p className="text-sm text-stone-600">Only this File’s Owner can publish it. You can ask them to.</p>
        <button type="button" disabled={busy} className="rounded border px-3 py-1"
          onClick={() => void run((signal) => requestPublication(fileId, signal))}>Send request</button>
      </>}
  </section>;
}
