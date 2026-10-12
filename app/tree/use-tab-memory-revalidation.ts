import { type Dispatch, type RefObject, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import { useNavigation, useRevalidator } from "react-router";

import { onPrivateTabMemoryCleared, privateTabMemorySuspended } from "~/shared/device/private-tab-memory";
import { coalescedRunner } from "~/shared/tree/coalesced-runner";
import type { TreeKind } from "~/shared/tree/client";
import { treeCache } from "~/shared/tree/tab-tree-cache";
import { type FilesPageData, type FilesSnapshot, mergeRevalidated, revalidateFilesPage } from "./navigation-client";

/**
 * Ticket 57: keep a Files page current while it renders from this tab's
 * verified memory.
 *
 * - A page rendered from memory, a tab the person returns to, and a listing
 *   another tab changed are revalidated in the background. Current listings,
 *   keys and names merge into the snapshot without ever going back to an older
 *   listing; the File and its in-memory draft are never replaced.
 * - A selected node that left its path, lost private access, another tab's
 *   `clear`, or a return to the tab after its hidden-timeout clear reloads the
 *   route once through the cold walk, but only once a File's draft is saved.
 */
export function useTabMemoryRevalidation(page: {
  initial: FilesPageData;
  snapshot: FilesSnapshot | null;
  setSnapshot: Dispatch<SetStateAction<FilesSnapshot | null>>;
  status: FilesPageData["status"];
  kind: TreeKind;
  fileReady: boolean;
  lifetime: RefObject<AbortController | null>;
}) {
  const { initial, snapshot, setSnapshot, status, kind, fileReady, lifetime } = page;
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const snapshotNow = useRef(snapshot);
  useEffect(() => {
    snapshotNow.current = snapshot;
  }, [snapshot]);
  const [backgroundDue, setBackgroundDue] = useState(false);
  const [reloadDue, setReloadDue] = useState(false);

  // The page is keyed per node, so its kind never changes.
  const run = useMemo(
    () =>
      coalescedRunner(async () => {
        // Each pass reads the current page lifetime: a pass asked for during an aborted one still runs.
        const current = snapshotNow.current;
        const signal = lifetime.current?.signal;
        if (!current || !signal || signal.aborted || privateTabMemorySuspended()) return;
        const outcome = await revalidateFilesPage(current, kind, signal).catch(() => null);
        if (!outcome || signal.aborted) return;
        if (outcome.status === "changed" || outcome.status === "access") setReloadDue(true);
        else if (outcome.status === "current")
          setSnapshot((previous) =>
            previous && previous.access === current.access ? mergeRevalidated(previous, outcome, kind) : previous,
          );
      }),
    [kind, lifetime, setSnapshot],
  );

  useEffect(() => {
    if (initial.status === "ready" && initial.fromMemory) setBackgroundDue(true);
  }, [initial]);
  useEffect(() => {
    if (!backgroundDue || status !== "ready") return;
    setBackgroundDue(false);
    void run();
  }, [backgroundDue, status, run]);
  useEffect(() => {
    const returned = () => {
      if (document.visibilityState === "visible") setBackgroundDue(true);
    };
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", returned);
    const unsubscribe = treeCache.subscribe((directoryIds) => {
      if (directoryIds.some((id) => snapshotNow.current?.listings[id])) setBackgroundDue(true);
    });
    // One route reload per clear event; the reload's own access errors clear locally and notify nothing.
    const unlisten = onPrivateTabMemoryCleared(() => setReloadDue(true));
    return () => {
      window.removeEventListener("focus", returned);
      document.removeEventListener("visibilitychange", returned);
      unsubscribe();
      unlisten();
    };
  }, []);
  useEffect(() => {
    if (!reloadDue || (kind === "file" && !fileReady) || navigation.state !== "idle" || revalidator.state !== "idle")
      return;
    setReloadDue(false);
    void revalidator.revalidate();
  }, [reloadDue, kind, fileReady, navigation.state, revalidator]);
}
