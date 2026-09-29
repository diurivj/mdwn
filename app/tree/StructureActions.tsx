import { useEffect, useRef, useState } from "react";
import { RecoveryConfirmationPendingError } from "~/signup/recovery-gate";
import { loadDirectory, NameConflictError, NamespaceChangedError, openChildDirectory, TreeCommitUncertainError,
  TreeNotFoundError, type TreeKind } from "./client";
import type { FilesSnapshot } from "./navigation-client";
import { deleteTreeNode, moveTreeChild, reorderTreeChild, TreeStructureError } from "./structure-client";

type Dialog = { operation: "delete" } | { operation: "move"; destinationId: string };
type Outcome = { navigateTo: string } | { revalidate: true };

/** Folders visible in this tab's decrypted tree, labelled by their path. */
function destinations(snapshot: FilesSnapshot, nodeId: string, kind: TreeKind, parentId: string) {
  const parents = new Map<string, { parentId: string; name: string }>();
  for (const listing of Object.values(snapshot.listings)) {
    for (const entry of listing.entries) {
      if (entry.kind === "directory") parents.set(entry.nodeId, { parentId: listing.directoryId, name: entry.name });
    }
  }
  const rootLabel = snapshot.access.rootLabel ?? "Files";
  const options: { id: string; label: string }[] = [];
  for (const id of [snapshot.access.rootId, ...parents.keys()]) {
    const names: string[] = [];
    let current = id, inside = false, known = true;
    for (let depth = 0; current !== snapshot.access.rootId; depth++) {
      const parent = parents.get(current);
      if (!parent || depth > 100) { known = false; break; }
      if (current === nodeId) inside = true;
      names.unshift(parent.name);
      current = parent.parentId;
    }
    if (!known || id === parentId || (kind === "directory" && (inside || id === nodeId))) continue;
    options.push({ id, label: [rootLabel, ...names].join(" / ") });
  }
  return options.sort((a, b) => a.label.localeCompare(b.label));
}

function refusal(error: unknown, operation: "delete" | "move" | "reorder"): string {
  const nothing = operation === "delete" ? "Nothing was deleted." : operation === "move" ? "Nothing was moved." :
    "Nothing was changed.";
  if (error instanceof TreeStructureError) {
    if (error.code === "subtree_limit_exceeded") {
      return "This folder contains more than 500 items. Delete or move some of its contents first, then try again. Nothing was deleted.";
    }
    if (error.code === "move_leaves_shared_scope") {
      return `Someone with access to the shared folder around this folder would keep its key if it moved outside. ${nothing}`;
    }
    if (error.code === "rotation_pending") {
      return `Access changes to this shared content are still being applied. Try again once they finish. ${nothing}`;
    }
    return `This File changed on another device. Refresh and try again. ${nothing}`;
  }
  if (error instanceof NameConflictError) {
    return "That folder already has a File or folder with this name. Rename it first; nothing was moved or overwritten.";
  }
  if (error instanceof NamespaceChangedError) {
    return "This folder changed on another device. Nothing was added, replaced, or overwritten.";
  }
  if (error instanceof TreeCommitUncertainError) {
    return "The change may have been saved, but its local checkpoint failed. Refresh Files before trying again.";
  }
  if (error instanceof RecoveryConfirmationPendingError) {
    return "Confirm your saved recovery phrase and codes before changing Files.";
  }
  return `The change could not be confirmed. Refresh Files before trying again. ${nothing}`;
}

/**
 * Reorder, move and hard-delete controls for the selected node. Every operation
 * re-reads and verifies the affected listings first; the Worker rechecks
 * authority and both revisions in one conditional transaction.
 */
export function StructureActions({ snapshot, nodeId, kind, name, disabled, flush, onWorking, onDone, onNotFound }: {
  snapshot: FilesSnapshot; nodeId: string; kind: TreeKind; name: string; disabled: boolean;
  flush: () => Promise<boolean>; onWorking: (working: boolean) => void;
  onDone: (outcome: Outcome) => Promise<void> | void; onNotFound: () => void;
}) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [message, setMessage] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const parentId = snapshot.crumbs.at(-2)?.id;
  const siblings = parentId ? snapshot.listings[parentId]?.entries ?? [] : [];
  const position = siblings.findIndex((entry) => entry.nodeId === nodeId);
  if (!parentId || position < 0 || nodeId === snapshot.access.rootId || !snapshot.canCreateChild) return null;
  const options = destinations(snapshot, nodeId, kind, parentId);

  async function run(operation: "delete" | "move" | "reorder", work: () => Promise<Outcome>) {
    if (disabled) return;
    onWorking(true);
    setMessage("");
    try {
      // A structural change must not race the selected File's pending save.
      if (!await flush()) {
        if (alive.current) setMessage("Your File could not be saved. Keep or explicitly discard its draft before changing this folder.");
        return;
      }
      const outcome = await work();
      // The write is done, but a newer navigation wins: if this tree unmounted while the request
      // was in flight, never redirect or revalidate from the dead component.
      if (!alive.current) return;
      setDialog(null);
      await onDone(outcome);
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof TreeNotFoundError) { setDialog(null); onNotFound(); return; }
      setMessage(refusal(error, operation));
    } finally { if (alive.current) onWorking(false); }
  }

  async function parentState() {
    const key = snapshot.keys[parentId!];
    if (!key) throw new Error("private tree unavailable");
    return { listing: await loadDirectory(snapshot.access, parentId!, key), key };
  }

  const reorder = (direction: "up" | "down") => run("reorder", async () => {
    await reorderTreeChild(snapshot.access, await parentState(), nodeId, direction);
    return { revalidate: true };
  });
  const remove = () => run("delete", async () => {
    await deleteTreeNode(snapshot.access, await parentState(), nodeId);
    return { navigateTo: `/d/${parentId}` };
  });
  async function capability(directoryId: string): Promise<Uint8Array> {
    const known = snapshot.keys[directoryId];
    if (known) return known;
    const listing = Object.values(snapshot.listings).find((item) =>
      item.entries.some((entry) => entry.nodeId === directoryId && entry.kind === "directory"));
    const parentKey = listing && snapshot.keys[listing.directoryId];
    if (!listing || !parentKey) throw new Error("private tree unavailable");
    return openChildDirectory(snapshot.access, parentKey, listing.entries.find((entry) => entry.nodeId === directoryId)!);
  }
  const move = (destinationId: string) => run("move", async () => {
    const key = await capability(destinationId);
    const [source, destination] = await Promise.all([parentState(),
      loadDirectory(snapshot.access, destinationId, key).then((listing) => ({ listing, key }))]);
    await moveTreeChild(snapshot.access, nodeId, source, destination);
    return { revalidate: true };
  });

  return <>
    <button type="button" disabled={disabled || position === 0} onClick={() => void reorder("up")}
      className="rounded border px-2 py-1">Move up</button>
    <button type="button" disabled={disabled || position === siblings.length - 1} onClick={() => void reorder("down")}
      className="rounded border px-2 py-1">Move down</button>
    <button type="button" disabled={disabled || !options.length} onClick={() => {
      setMessage(""); setDialog({ operation: "move", destinationId: options[0]!.id }); }}
      className="rounded border px-2 py-1">Move to…</button>
    <button type="button" disabled={disabled} onClick={() => { setMessage(""); setDialog({ operation: "delete" }); }}
      className="rounded border border-rose-300 px-2 py-1 text-rose-800">Delete</button>
    {message && !dialog && <p role="alert" className="basis-full text-rose-700">{message}</p>}
    {dialog && <div role="dialog" aria-modal="true" aria-label={dialog.operation === "delete" ? "Delete" : "Move"}
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
      <form className="w-full max-w-md rounded bg-white p-5 shadow-lg" onSubmit={(event) => {
        event.preventDefault();
        void (dialog.operation === "delete" ? remove() : move(dialog.destinationId));
      }}>
        {dialog.operation === "delete" ? <>
          <h2 className="text-lg font-semibold">Delete “{name}”?</h2>
          <p className="mt-3">{kind === "directory"
            ? "This permanently deletes the folder and everything inside it, including its sharing."
            : "This permanently deletes the File, its sharing and its comments."} There is no trash or restore,
            and copies other people already opened or downloaded cannot be recalled.</p>
        </> : <>
          <h2 className="text-lg font-semibold">Move “{name}”</h2>
          <label className="mt-4 block">Destination folder <select value={dialog.destinationId}
            onChange={(event) => setDialog({ operation: "move", destinationId: event.target.value })}
            className="mt-1 w-full rounded border p-2">
            {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select></label>
          <p className="mt-2 text-sm text-stone-600">Expand a folder in the tree to list the folders inside it.</p>
        </>}
        {message && <p role="alert" className="mt-3 text-rose-700">{message}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => setDialog(null)} className="rounded border px-3 py-1">Cancel</button>
          <button type="submit" disabled={disabled} className={`rounded px-3 py-1 text-white ${
            dialog.operation === "delete" ? "bg-rose-700" : "bg-stone-900"}`}>
            {disabled ? "Working…" : dialog.operation === "delete" ? "Delete permanently" : "Move"}</button>
        </div>
      </form>
    </div>}
  </>;
}
