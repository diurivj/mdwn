import { useEffect, useState } from "react";
import { Link, useRevalidator } from "react-router";
import { migrateOwnedFile } from "~/tree/editor-client";
import type { FilesSnapshot } from "~/tree/navigation-client";
import { acceptInvitation, cancelInvitation, changeGrantPermission, declineInvitation,
  invitations, inviteSharedRoot, leaveGrant, namedRoot, resolveRecipient, revokeGrant, sharedRoots,
  type GrantRoot, type OwnerGrant, type ShareItem } from "./client";

export function SharedNavigation({ actorAccountId }: { actorAccountId: string }) {
  const [roots, setRoots] = useState<{ root: GrantRoot; name: string | null }[]>([]);
  const [pending, setPending] = useState<ShareItem[]>([]);
  const [error, setError] = useState("");
  const revalidator = useRevalidator();
  async function refresh(signal?: AbortSignal) {
    try {
      const [all, invites] = await Promise.all([sharedRoots(signal), invitations()]);
      const named = await Promise.all(all.map(async (root) => ({ root,
        name: root.status === "ready" ? await namedRoot(root, actorAccountId) : null })));
      signal?.throwIfAborted();
      setRoots(named);
      setPending(invites.incoming);
    } catch { if (!signal?.aborted) setError("Shared content could not be verified. Retry."); }
  }
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [actorAccountId]);
  async function decide(id: string, accept: boolean) {
    try {
      if (accept) await acceptInvitation(id);
      else await declineInvitation(id);
      await refresh();
      revalidator.revalidate();
    } catch { setError("The invitation changed. Refresh before trying again."); }
  }
  return <div className="mt-5 border-t pt-4" aria-label="Shared content">
    <h2 className="font-medium">Shared with me</h2>
    {roots.map(({ root, name }) => <div key={root.grantId} className="mt-2 text-sm">
      {name ? <Link className="underline" to={`/${root.kind === "file" ? "f" : "d"}/${root.targetId}`}>
        {name} <span className="text-stone-500">(Shared as)</span></Link>
        : <span role="status">Shared content is being securely provisioned</span>}
      <button type="button" className="ml-2 underline" onClick={() => void leaveGrant(root.grantId).then(() => refresh()).catch(() => setError("Try again."))}>Leave</button>
    </div>)}
    {pending.length > 0 && <div className="mt-4" aria-label="Invitations">
      <h3 className="font-medium">Invitations</h3>
      {pending.map((item) => <div key={item.id} className="mt-2 text-sm">
        <span>Invitation to a {item.kind === "file" ? "File" : "folder"} ({item.permission === "read_write" ? "read/write" : "read-only"})</span>
        <button className="ml-2 underline" type="button" onClick={() => void decide(item.id, true)}>Accept</button>
        <button className="ml-2 underline" type="button" onClick={() => void decide(item.id, false)}>Decline</button>
      </div>)}
    </div>}
    {error && <p role="alert">{error} <button type="button" className="underline" onClick={() => void refresh()}>Retry</button></p>}
  </div>;
}

/** Owner panel gets its label from an already authenticated, locally decrypted listing. */
export function SharePanel({ snapshot, nodeId, kind, name, onUpdated }: {
  snapshot: FilesSnapshot; nodeId: string; kind: "file" | "directory"; name: string;
  onUpdated: (next: FilesSnapshot) => void;
}) {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [permission, setPermission] = useState<"read_only" | "read_write">("read_only");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [outgoing, setOutgoing] = useState<(ShareItem & { targetId: string })[]>([]);
  const [active, setActive] = useState<OwnerGrant[]>([]);
  async function refresh() {
    const list = await invitations();
    setOutgoing(list.outgoing.filter((item) => item.targetId === nodeId));
    setActive(list.grants.filter((root) => root.targetId === nodeId));
  }
  async function invite() {
    setWorking(true); setMessage("");
    try {
      let current = snapshot;
      if (kind === "file" && snapshot.file && !snapshot.file.v2) {
        const parentId = snapshot.file.parentId;
        const migrated = await migrateOwnedFile({ access: snapshot.access, fileId: nodeId,
          file: snapshot.file, listing: snapshot.listings[parentId]!, parentKey: snapshot.keys[parentId]! });
        current = { ...snapshot, file: migrated.file, listings: { ...snapshot.listings, [parentId]: migrated.listing } };
        onUpdated(current);
      }
      const recipient = await resolveRecipient(address);
      await inviteSharedRoot(current, nodeId, kind, name, recipient, permission);
      setAddress("");
      setMessage("Invitation sent. The recipient sees no name until accepting and provisioning completes.");
      await refresh();
    } catch { setMessage("This invitation could not be prepared. Refresh and try again."); }
    finally { setWorking(false); }
  }
  return <div className="relative">
    <button type="button" disabled={working} onClick={() => { setOpen((value) => !value); void refresh().catch(() => setMessage("Could not load Shares.")); }}
      className="rounded border px-2 py-1">Share</button>
    {open && <div role="region" aria-label="Share this content" className="absolute right-0 z-10 w-80 rounded border bg-white p-4 shadow-lg">
      <h2 className="font-semibold">Share {kind === "file" ? "File" : "folder"}</h2>
      <label className="mt-3 block text-sm">Exact share ID or @handle
        <input className="mt-1 w-full rounded border p-1" value={address} onChange={(event) => setAddress(event.target.value)} /></label>
      <label className="mt-2 block text-sm">Permission
        <select value={permission} onChange={(event) => setPermission(event.target.value as "read_only" | "read_write")}
          className="ml-2 rounded border p-1"><option value="read_only">Read-only</option>
          <option value="read_write">Read/write</option></select></label>
      <button type="button" disabled={working || !address} onClick={() => void invite()} className="mt-3 rounded bg-stone-900 px-3 py-1 text-white">Invite</button>
      <h3 className="mt-4 font-medium">Outgoing invitations</h3>
      {outgoing.map((item) => <div key={item.id} className="mt-1 text-sm">Pending ({item.permission})
        <button type="button" className="ml-2 underline" onClick={() => void cancelInvitation(item.id).then(refresh).catch(() => setMessage("Try again."))}>Cancel</button></div>)}
      {active.map((root) => <div key={root.grantId} className="mt-2 text-sm">
        {root.permission} <button type="button" className="ml-2 underline" onClick={() => void changeGrantPermission(root.grantId,
          root.permission === "read_only" ? "read_write" : "read_only").then(refresh).catch(() => setMessage("Try again."))}>Change permission</button>
        <button type="button" className="ml-2 underline" onClick={() => void revokeGrant(root.grantId).then(refresh).catch(() => setMessage("Try again."))}>Revoke</button>
      </div>)}
      {message && <p role="status" className="mt-2 text-sm">{message}</p>}
    </div>}
  </div>;
}
