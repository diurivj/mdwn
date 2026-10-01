import { useEffect, useRef, useState } from "react";
import { useBeforeUnload, useBlocker, useFetcher } from "react-router";

import { FILE_SOURCE_LIMIT, fileSourceBytes } from "~/crypto/file-source";
import { newOpaqueId } from "~/opaque-id";
import { loadDirectory, loadFile, rememberListing, type DirectoryListing } from "./client";
import { prepareFileSave, withFileListing, type FileDocument, type FileSavePayload, type FileSaveResult } from "./file-client";
import type { FilesSnapshot } from "./navigation-client";
import { useFileLease } from "./useFileLease";

export type SaveStatus = "Unsaved" | "Saving" | "Saved" | "Couldn't save";

/** A serialized tab-local draft. Router mutations never carry Markdown or capability keys. */
export function useFileDraft(fileId: string, snapshot: FilesSnapshot,
  onCurrent: (file: FileDocument, listing: DirectoryListing) => void, onNavigationStart: () => void) {
  const document = useRef(snapshot.file!);
  const parentKey = snapshot.keys[document.current.parentId]!;
  const listing = useRef(snapshot.listings[document.current.parentId]!);
  const draftRef = useRef(document.current.markdown);
  const [draft, setDraft] = useState(draftRef.current);
  const [status, setStatus] = useState<SaveStatus>(document.current.sourceBytes > FILE_SOURCE_LIMIT ? "Couldn't save" : "Saved");
  const [navigationFailed, setNavigationFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [overwriteProposal, setOverwriteProposal] = useState<{ document: FileDocument; listing: DirectoryListing } | null>(null);
  const [conflict, setConflict] = useState(false);
  const conflictRef = useRef(false);
  const [rejected, setRejected] = useState(false);
  const composing = useRef(false);
  function composition(active: boolean) {
    composing.current = active;
    if (active) clearTimeout(timer.current);
    else if (!conflictRef.current && draftRef.current !== document.current.markdown &&
      fileSourceBytes(draftRef.current) <= FILE_SOURCE_LIMIT) {
      // Resume the retained valid draft even if the eventual composition proposal is rejected.
      timer.current = setTimeout(() => { void flush(); }, 750);
    }
  }
  const fetcher = useFetcher<FileSaveResult>();
  const pending = useRef<{ id: string; resolve: (result: FileSaveResult) => void } | null>(null);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    if (fetcher.data && pending.current && fetcher.data.operationId === pending.current.id) {
      pending.current.resolve(fetcher.data);
      pending.current = null;
    }
  }, [fetcher.data]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      if (pending.current) pending.current.resolve({ operationId: pending.current.id, state: "failed" });
    };
  }, []);

  function submit(payload: FileSavePayload): Promise<FileSaveResult> {
    return new Promise((resolve) => {
      const id = newOpaqueId();
      pending.current = { id, resolve };
      void fetcher.submit({ operationId: id, payload }, {
        method: "post", encType: "application/json", action: `/f/${fileId}`,
      });
    });
  }

  async function save(): Promise<boolean> {
    if (conflictRef.current || fileSourceBytes(draftRef.current) > FILE_SOURCE_LIMIT) return false;
    if (draftRef.current === document.current.markdown) { setStatus("Saved"); return true; }
    setStatus("Saving");
    const source = draftRef.current;
    try {
      let prepared = await prepareFileSave(snapshot.access, fileId, parentKey, document.current, source, listing.current);
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!mounted.current) return false;
        const result = await submit(prepared.payload);
        if (!mounted.current) return false;
        if (result.state === "conflict") {
          conflictRef.current = true; setConflict(true); break;
        }
        if (result.state === "folder-changed") {
          listing.current = await loadDirectory(snapshot.access, document.current.parentId, parentKey);
          prepared = { ...prepared, ...await withFileListing(snapshot.access, fileId, parentKey, prepared.payload, listing.current) };
          continue;
        }
        if (result.state !== "saved") break;
        // Advance only the saved snapshot: edits typed while it was in flight stay local.
        document.current = prepared.document;
        listing.current = prepared.listing;
        rememberListing(snapshot.access.vaultId, listing.current.directoryId,
          result.entriesRevision, prepared.payload.listingHead.digest);
        onCurrent(document.current, listing.current);
        setStatus(draftRef.current === source ? "Saved" : "Unsaved");
        return true;
      }
    } catch { /* Generic failure preserves the exact in-memory draft. */ }
    if (mounted.current) setStatus("Couldn't save");
    return false;
  }

  const lease = useFileLease(snapshot.access.vaultId, fileId, { flush, reload, discard });

  async function flush(): Promise<boolean> {
    clearTimeout(timer.current);
    if (!lease.owns()) return false;
    while (inFlight.current) if (!await inFlight.current) return false;
    if (!mounted.current || composing.current || conflictRef.current || fileSourceBytes(draftRef.current) > FILE_SOURCE_LIMIT) return false;
    if (draftRef.current === document.current.markdown) return true;
    const task = save();
    inFlight.current = task;
    const saved = await task;
    if (inFlight.current === task) inFlight.current = null;
    return saved && draftRef.current !== document.current.markdown ? flush() : saved;
  }

  const warn = () => composing.current || inFlight.current !== null || status === "Couldn't save" ||
    draftRef.current !== document.current.markdown || fileSourceBytes(draftRef.current) > FILE_SOURCE_LIMIT;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    // Invalidate structural continuations synchronously, before a slow next
    // clientLoader starts. Waiting for unmount leaves the old page alive.
    onNavigationStart();
    return currentLocation.pathname !== nextLocation.pathname && warn();
  });
  useBeforeUnload((event) => { if (warn()) { event.preventDefault(); event.returnValue = ""; } });
  useEffect(() => {
    if (blocker.state !== "blocked") { setNavigationFailed(false); return; }
    let active = true;
    void flush().then((saved) => {
      if (!active) return;
      if (saved) blocker.proceed();
      else setNavigationFailed(true);
    });
    return () => { active = false; };
  }, [blocker]);

  async function current() {
    const parentId = document.current.parentId;
    const [file, parent] = await Promise.all([
      loadFile(snapshot.access, fileId, parentKey),
      loadDirectory(snapshot.access, parentId, parentKey),
    ]);
    if (file.parentId !== parentId) throw new Error("File changed");
    return { document: file, listing: parent };
  }

  async function reload(): Promise<boolean> {
    clearTimeout(timer.current);
    setLoading(true);
    try {
      if (inFlight.current) await inFlight.current;
      const latest = await current();
      if (!mounted.current) return false;
      document.current = latest.document; listing.current = latest.listing;
      onCurrent(document.current, listing.current);
      draftRef.current = latest.document.markdown; setDraft(draftRef.current);
      conflictRef.current = false; setConflict(false); setRejected(false); setOverwriteProposal(null);
      setStatus(latest.document.sourceBytes > FILE_SOURCE_LIMIT ? "Couldn't save" : "Saved");
      return true;
    } catch { if (mounted.current) setStatus("Couldn't save"); return false; }
    finally { if (mounted.current) setLoading(false); }
  }

  async function proposeOverwrite() {
    if (!lease.editable) return;
    if (fileSourceBytes(draftRef.current) > FILE_SOURCE_LIMIT) { setRejected(true); return; }
    setLoading(true);
    try { const latest = await current(); if (mounted.current) setOverwriteProposal(latest); }
    catch { if (mounted.current) setStatus("Couldn't save"); }
    finally { if (mounted.current) setLoading(false); }
  }

  async function confirmOverwrite() {
    if (!lease.editable || !overwriteProposal || fileSourceBytes(draftRef.current) > FILE_SOURCE_LIMIT) return;
    // The proposal pins the revision being replaced. A later winner still conflicts.
    document.current = overwriteProposal.document; listing.current = overwriteProposal.listing;
    conflictRef.current = false; setConflict(false); setOverwriteProposal(null);
    await flush();
  }

  async function discard() {
    clearTimeout(timer.current);
    while (inFlight.current) await inFlight.current;
    draftRef.current = document.current.markdown; setDraft(draftRef.current);
    conflictRef.current = false; setConflict(false); setRejected(false); setOverwriteProposal(null);
    setStatus(document.current.sourceBytes > FILE_SOURCE_LIMIT ? "Couldn't save" : "Saved");
  }

  function edit(value: string): boolean {
    if (!lease.editable || loading || overwriteProposal) return false;
    const nextBytes = fileSourceBytes(value), previousBytes = fileSourceBytes(draftRef.current);
    if (nextBytes > FILE_SOURCE_LIMIT && !(previousBytes > FILE_SOURCE_LIMIT && nextBytes < previousBytes)) {
      setRejected(true); return false;
    }
    setRejected(false);
    draftRef.current = value; setDraft(value);
    setStatus(conflictRef.current || nextBytes > FILE_SOURCE_LIMIT ? "Couldn't save" : value === document.current.markdown ? "Saved" : "Unsaved");
    clearTimeout(timer.current);
    if (!conflictRef.current && nextBytes <= FILE_SOURCE_LIMIT && value !== document.current.markdown) {
      timer.current = setTimeout(() => { void flush(); }, 750);
    }
    return true;
  }

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault(); void flush();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });

  return { draft, status, conflict, rejected, edit, flush, composition, blocker, navigationFailed,
    loading, reload, proposeOverwrite, overwriteProposal, confirmOverwrite, lease,
    cancelOverwrite: () => setOverwriteProposal(null) };
}
