import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useFetcher, useRevalidator } from "react-router";
import type { clientAction, clientLoader } from "~/routes/resources/sharing";
import { migrateOwnedFile } from "~/tree/editor-client";
import type { FilesSnapshot } from "~/tree/navigation-client";
import { inviteSharedRoot, mergeSharingPage, namedRoot, resolveRecipient, stageShareInviteAction,
  type GrantRoot, type InvitationCursors, type InvitationsPage, type OwnerGrant, type ShareInvitePreparationStage,
  type ShareItem } from "./client";

const sharingResource = "/resources/sharing";
type InvitationList = "incoming" | "outgoing" | "grants";
type InvitationPageRequest = "first" | InvitationList;

function collectionUrl(collection: "roots" | "invitations", cursors: Record<string, string | null | undefined> = {}) {
  const query = new URLSearchParams({ collection });
  for (const [key, cursor] of Object.entries(cursors)) {
    if (cursor) query.set(key, cursor);
  }
  return `${sharingResource}?${query}`;
}

function incomingUrl(cursor?: string | null) {
  return collectionUrl("invitations", cursor ? { incomingCursor: cursor } : {});
}

function ownerInvitationsUrl(request: InvitationPageRequest, cursor?: string | null) {
  const cursors: InvitationCursors = {};
  if (cursor && request === "outgoing") cursors.outgoingCursor = cursor;
  if (cursor && request === "grants") cursors.grantsCursor = cursor;
  return collectionUrl("invitations", cursors);
}

export function SharedNavigation({ actorAccountId }: { actorAccountId: string }) {
  const rootsFetcher = useFetcher<typeof clientLoader>();
  const invitationsFetcher = useFetcher<typeof clientLoader>();
  const actionFetcher = useFetcher<typeof clientAction>();
  const [roots, setRoots] = useState<{ root: GrantRoot; name: string | null }[]>([]);
  const [pending, setPending] = useState<ShareItem[]>([]);
  const [nextRootCursor, setNextRootCursor] = useState<string | null>(null);
  const [nextIncomingCursor, setNextIncomingCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const revalidator = useRevalidator();
  const processedRoots = useRef<unknown>(undefined);
  const processedInvitations = useRef<unknown>(undefined);
  const processedAction = useRef<unknown>(undefined);
  const rootGeneration = useRef(0);
  const rootRequestActor = useRef(actorAccountId);
  const invitationRequestActor = useRef(actorAccountId);
  const invitationRequest = useRef<InvitationPageRequest>("first");

  const loadRoots = useCallback((cursor?: string | null) => {
    rootRequestActor.current = actorAccountId;
    rootsFetcher.load(collectionUrl("roots", cursor ? { cursor } : {}));
  }, [actorAccountId, rootsFetcher.load]);
  const loadIncoming = useCallback((request: InvitationPageRequest, cursor?: string | null) => {
    invitationRequest.current = request;
    invitationRequestActor.current = actorAccountId;
    invitationsFetcher.load(incomingUrl(request === "incoming" ? cursor : undefined));
  }, [actorAccountId, invitationsFetcher.load]);
  const refresh = useCallback(() => {
    rootGeneration.current++;
    setRoots([]);
    setPending([]);
    setNextRootCursor(null);
    setNextIncomingCursor(null);
    setError("");
    loadRoots();
    loadIncoming("first");
  }, [loadIncoming, loadRoots]);

  useEffect(() => { refresh(); }, [actorAccountId, refresh]);

  useEffect(() => {
    const result = rootsFetcher.data;
    if (rootsFetcher.state !== "idle" || !result || result === processedRoots.current) return;
    processedRoots.current = result;
    if (rootRequestActor.current !== actorAccountId || result.state !== "success" || result.collection !== "roots") {
      if (result.state === "error" && rootRequestActor.current === actorAccountId) {
        setError("Shared content could not be verified. Retry.");
      }
      return;
    }
    const generation = ++rootGeneration.current;
    void Promise.all(result.roots.map(async (root) => ({ root,
      name: root.status === "ready" ? await namedRoot(root, actorAccountId) : null })))
      .then((page) => {
        if (generation !== rootGeneration.current || rootRequestActor.current !== actorAccountId) return;
        setRoots((current) => mergeSharingPage(current, page, (item) => item.root.grantId));
        setNextRootCursor(result.nextCursor);
        setError("");
      })
      .catch(() => {
        if (generation === rootGeneration.current && rootRequestActor.current === actorAccountId) {
          setError("Shared content could not be verified. Retry.");
        }
      });
  }, [actorAccountId, rootsFetcher.data, rootsFetcher.state]);

  useEffect(() => {
    const result = invitationsFetcher.data;
    if (invitationsFetcher.state !== "idle" || !result || result === processedInvitations.current) return;
    processedInvitations.current = result;
    if (invitationRequestActor.current !== actorAccountId || result.state !== "success" || result.collection !== "invitations") {
      if (result.state === "error" && invitationRequestActor.current === actorAccountId) {
        setError("Invitations could not be loaded. Retry.");
      }
      return;
    }
    const request = invitationRequest.current;
    setPending((current) => request === "first" ? result.incoming :
      mergeSharingPage(current, result.incoming, (item) => item.id));
    setNextIncomingCursor(result.next.incomingCursor);
    setError("");
  }, [actorAccountId, invitationsFetcher.data, invitationsFetcher.state]);

  useEffect(() => {
    const result = actionFetcher.data;
    if (actionFetcher.state !== "idle" || !result || result === processedAction.current) return;
    processedAction.current = result;
    if (result.state === "success") {
      refresh();
      revalidator.revalidate();
    } else {
      setError("The Share could not be updated. Refresh and try again.");
    }
  }, [actionFetcher.data, actionFetcher.state, refresh, revalidator]);

  const actionBusy = actionFetcher.state !== "idle";
  return <div className="mt-5 border-t pt-4" aria-label="Shared content">
    <h2 className="font-medium">Shared with me</h2>
    {roots.map(({ root, name }) => <div key={root.grantId} className="mt-2 text-sm">
      {name ? <Link className="underline" to={`/${root.kind === "file" ? "f" : "d"}/${root.targetId}`}>
        {name} <span className="text-stone-500">(Shared as)</span></Link>
        : <span role="status">Shared content is being securely provisioned</span>}
      <actionFetcher.Form method="post" action={sharingResource} className="inline">
        <input type="hidden" name="itemId" value={root.grantId} />
        <button type="submit" name="intent" value="leave" disabled={actionBusy}
          className="ml-2 underline disabled:opacity-60">Leave</button>
      </actionFetcher.Form>
    </div>)}
    {rootsFetcher.state !== "idle" && <p role="status" className="mt-2 text-sm">Loading shared content…</p>}
    {nextRootCursor && <button type="button" disabled={rootsFetcher.state !== "idle"}
      onClick={() => loadRoots(nextRootCursor)} className="mt-2 text-sm underline disabled:opacity-60">
      Load more shared content
    </button>}
    {pending.length > 0 && <div className="mt-4" aria-label="Invitations">
      <h3 className="font-medium">Invitations</h3>
      {pending.map((item) => <div key={item.id} className="mt-2 text-sm">
        <span>Invitation to a {item.kind === "file" ? "File" : "folder"} ({item.permission === "read_write" ? "read/write" : "read-only"})</span>
        <actionFetcher.Form method="post" action={sharingResource} className="ml-2 inline">
          <input type="hidden" name="itemId" value={item.id} />
          <button type="submit" name="intent" value="accept" disabled={actionBusy}
            className="underline disabled:opacity-60">Accept</button>
        </actionFetcher.Form>
        <actionFetcher.Form method="post" action={sharingResource} className="ml-2 inline">
          <input type="hidden" name="itemId" value={item.id} />
          <button type="submit" name="intent" value="decline" disabled={actionBusy}
            className="underline disabled:opacity-60">Decline</button>
        </actionFetcher.Form>
      </div>)}
      {nextIncomingCursor && <button type="button" disabled={invitationsFetcher.state !== "idle"}
        onClick={() => loadIncoming("incoming", nextIncomingCursor)} className="mt-2 text-sm underline disabled:opacity-60">
        Load more invitations
      </button>}
    </div>}
    {actionBusy && <p role="status" className="mt-2 text-sm">Updating Shares…</p>}
    {actionFetcher.state === "idle" && actionFetcher.data?.state === "success" &&
      <p role="status" className="mt-2 text-sm">{actionFetcher.data.message}</p>}
    {error && <p role="alert" className="mt-2 text-sm">{error} <button type="button" className="underline" onClick={refresh}>Retry</button></p>}
  </div>;
}

/** Owner panel gets its label from an already authenticated, locally decrypted listing. */
export function SharePanel({ snapshot, nodeId, kind, name, onUpdated }: {
  snapshot: FilesSnapshot; nodeId: string; kind: "file" | "directory"; name: string;
  onUpdated: (next: FilesSnapshot) => void;
}) {
  const invitationsFetcher = useFetcher<typeof clientLoader>();
  const actionFetcher = useFetcher<typeof clientAction>();
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [permission, setPermission] = useState<"read_only" | "read_write">("read_only");
  const [page, setPage] = useState<InvitationsPage | null>(null);
  const [error, setError] = useState("");
  const [preparationStage, setPreparationStage] = useState<ShareInvitePreparationStage | null>(null);
  const pageRequest = useRef<InvitationPageRequest>("first");
  const processedInvitations = useRef<unknown>(undefined);
  const processedAction = useRef<unknown>(undefined);
  const requestActor = useRef(snapshot.access.actorAccountId ?? snapshot.access.vaultId);
  const actorAccountId = snapshot.access.actorAccountId ?? snapshot.access.vaultId;

  const loadPage = useCallback((request: InvitationPageRequest, cursor?: string | null) => {
    pageRequest.current = request;
    requestActor.current = actorAccountId;
    invitationsFetcher.load(ownerInvitationsUrl(request, cursor));
  }, [actorAccountId, invitationsFetcher.load]);
  const refresh = useCallback(() => {
    setPage(null);
    setError("");
    setPreparationStage(null);
    loadPage("first");
  }, [loadPage]);

  useEffect(() => {
    processedInvitations.current = invitationsFetcher.data;
    if (open) refresh();
  }, [nodeId, open, refresh]);

  useEffect(() => {
    const result = invitationsFetcher.data;
    if (!open || invitationsFetcher.state !== "idle" || !result || result === processedInvitations.current) return;
    processedInvitations.current = result;
    if (requestActor.current !== actorAccountId || result.state !== "success" || result.collection !== "invitations") {
      if (result.state === "error" && requestActor.current === actorAccountId) {
        setError("Shares could not be loaded. Refresh and try again.");
      }
      return;
    }
    const request = pageRequest.current;
    setPage((current) => {
      if (!current || request === "first") return result;
      const next = { ...current.next };
      if (request === "outgoing") next.outgoingCursor = result.next.outgoingCursor;
      if (request === "grants") next.grantsCursor = result.next.grantsCursor;
      return {
        incoming: mergeSharingPage(current.incoming, result.incoming, (item) => item.id),
        outgoing: mergeSharingPage(current.outgoing, result.outgoing, (item) => item.id),
        grants: mergeSharingPage(current.grants, result.grants, (item) => item.grantId),
        next,
      };
    });
    setError("");
  }, [actorAccountId, invitationsFetcher.data, invitationsFetcher.state, open]);

  useEffect(() => {
    const result = actionFetcher.data;
    if (actionFetcher.state !== "idle" || !result || result === processedAction.current) return;
    processedAction.current = result;
    if (result.state === "success") {
      setError("");
      setPreparationStage(null);
      if (result.intent === "invite") setAddress("");
      if (open) refresh();
    } else {
      const stage = "preparationStage" in result ? result.preparationStage : null;
      setPreparationStage(result.intent === "invite" ? stage : null);
      setError(result.intent === "invite"
        ? "This invitation could not be prepared. Refresh and try again."
        : "The Share could not be updated. Refresh and try again.");
    }
  }, [actionFetcher.data, actionFetcher.state, open, refresh]);

  function submitInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actionFetcher.state !== "idle") return;
    setError("");
    setPreparationStage(null);
    let operationId: string;
    try {
      operationId = stageShareInviteAction(async (signal) => {
        let current = snapshot;
        if (kind === "file" && snapshot.file && !snapshot.file.v2) {
          const parentId = snapshot.file.parentId;
          const migrated = await migrateOwnedFile({ access: snapshot.access, fileId: nodeId,
            file: snapshot.file, listing: snapshot.listings[parentId]!, parentKey: snapshot.keys[parentId]! });
          signal.throwIfAborted();
          current = { ...snapshot, file: migrated.file,
            listings: { ...snapshot.listings, [parentId]: migrated.listing } };
          onUpdated(current);
        }
        const recipient = await resolveRecipient(address, signal);
        return inviteSharedRoot(current, nodeId, kind, name, recipient, permission, signal);
      });
      const form = new FormData();
      form.set("intent", "invite");
      form.set("operationId", operationId);
      actionFetcher.submit(form, { method: "post", action: sharingResource });
    } catch {
      setError("This invitation could not be prepared. Refresh and try again.");
    }
  }

  const actionBusy = actionFetcher.state !== "idle";
  const outgoing = page?.outgoing.filter((item) => item.targetId === nodeId) ?? [];
  const active = page?.grants.filter((grant) => grant.targetId === nodeId) ?? [];
  const actionMessage = !actionBusy && actionFetcher.data?.state === "success"
    ? actionFetcher.data.message
    : "";

  return <div className="relative">
    <button type="button" disabled={actionBusy} onClick={() => setOpen((value) => !value)}
      className="rounded border px-2 py-1 disabled:opacity-60">Share</button>
    {open && <div role="region" aria-label="Share this content" className="absolute right-0 z-10 w-80 rounded border bg-white p-4 shadow-lg">
      <h2 className="font-semibold">Share {kind === "file" ? "File" : "folder"}</h2>
      <actionFetcher.Form method="post" action={sharingResource} onSubmit={submitInvite} className="mt-3">
        <input type="hidden" name="intent" value="invite" />
        <label className="block text-sm">Exact share ID or @handle
          <input className="mt-1 w-full rounded border p-1" required value={address}
            onChange={(event) => setAddress(event.target.value)} /></label>
        <label className="mt-2 block text-sm">Permission
          <select value={permission} onChange={(event) =>
            setPermission(event.target.value as "read_only" | "read_write")} className="ml-2 rounded border p-1">
            <option value="read_only">Read-only</option>
            <option value="read_write">Read/write</option>
          </select></label>
        <button type="submit" disabled={actionBusy || !address}
          className="mt-3 rounded bg-stone-900 px-3 py-1 text-white disabled:opacity-60">
          {actionBusy ? "Preparing invitation…" : "Invite"}
        </button>
      </actionFetcher.Form>
      <h3 className="mt-4 font-medium">Outgoing invitations</h3>
      {outgoing.map((item) => <div key={item.id} className="mt-1 flex items-center text-sm">
        <span>Pending ({item.permission})</span>
        <actionFetcher.Form method="post" action={sharingResource} className="ml-2 inline">
          <input type="hidden" name="itemId" value={item.id} />
          <button type="submit" name="intent" value="cancel" disabled={actionBusy}
            className="underline disabled:opacity-60">Cancel</button>
        </actionFetcher.Form>
      </div>)}
      {page?.next.outgoingCursor && <button type="button" disabled={invitationsFetcher.state !== "idle"}
        onClick={() => loadPage("outgoing", page.next.outgoingCursor)} className="mt-2 text-sm underline disabled:opacity-60">
        Load more outgoing invitations
      </button>}
      <h3 className="mt-4 font-medium">Active Shares</h3>
      {active.map((grant: OwnerGrant) => <div key={grant.grantId} className="mt-2 text-sm">
        {grant.permission}
        <actionFetcher.Form method="post" action={sharingResource} className="ml-2 inline">
          <input type="hidden" name="itemId" value={grant.grantId} />
          <input type="hidden" name="permission" value={grant.permission === "read_only" ? "read_write" : "read_only"} />
          <button type="submit" name="intent" value="change-permission" disabled={actionBusy}
            className="underline disabled:opacity-60">Change permission</button>
        </actionFetcher.Form>
        <actionFetcher.Form method="post" action={sharingResource} className="ml-2 inline">
          <input type="hidden" name="itemId" value={grant.grantId} />
          <button type="submit" name="intent" value="revoke" disabled={actionBusy}
            className="underline disabled:opacity-60">Revoke</button>
        </actionFetcher.Form>
      </div>)}
      {page?.next.grantsCursor && <button type="button" disabled={invitationsFetcher.state !== "idle"}
        onClick={() => loadPage("grants", page.next.grantsCursor)} className="mt-2 text-sm underline disabled:opacity-60">
        Load more Shares
      </button>}
      {invitationsFetcher.state !== "idle" && <p role="status" className="mt-2 text-sm">Loading Shares…</p>}
      {actionBusy && <p role="status" className="mt-2 text-sm">Updating Share…</p>}
      {actionMessage && <p role="status" className="mt-2 text-sm">
        {actionMessage}{actionFetcher.data?.intent === "invite"
          ? " The recipient sees no name until accepting and provisioning completes."
          : ""}
      </p>}
      {error && <p role="alert" data-preparation-stage={preparationStage ?? undefined}
        className="mt-2 text-sm">{error}</p>}
    </div>}
  </div>;
}
