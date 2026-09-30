import { useEffect, useRef, useState } from "react";
import { Link, useFetcher, useNavigation, useRevalidator } from "react-router";
import { SharedNavigation } from "~/sharing/SharingUI";
import type { clientAction } from "~/routes/resources/sharing";
import { isV7 } from "~/tree/wire";
import { FileEditor } from "./FileEditor";
import type { DirectFilesSnapshot, FilesPageData } from "./navigation-client";

/** A direct File scope has no parent, sibling, Directory key, path or owned root. */
export function DirectFilePage({ fileId, initial }: { fileId: string; initial: FilesPageData }) {
  const fetcher = useFetcher<typeof clientAction>();
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const [actionRevalidating, setActionRevalidating] = useState(false);
  const handledAction = useRef<unknown>(null);
  const [snapshot, setSnapshot] = useState<DirectFilesSnapshot | null>(
    initial.status === "ready" && initial.snapshot.scope === "direct-file" ? initial.snapshot : null);
  const flush = useRef<(() => Promise<boolean>) | null>(null);
  const status = initial.status;
  const appliedInitial = useRef(initial);
  useEffect(() => {
    appliedInitial.current = initial;
    if (initial.status === "ready" && initial.snapshot.scope === "direct-file") setSnapshot(initial.snapshot);
    else if (initial.status === "not-found" || initial.status === "provisioning") setSnapshot(null);
  }, [initial]);
  useEffect(() => {
    const result = fetcher.data;
    if (fetcher.state !== "idle" || !result || result.intent !== "provision-direct-file" ||
        handledAction.current === result) return;
    handledAction.current = result;
    setActionRevalidating(true);
    void (async () => {
      try { await revalidator.revalidate(); }
      catch { /* Stay nameless if the authoritative route refresh fails. */ }
      finally { setActionRevalidating(false); }
    })();
  }, [fetcher.data, fetcher.state, revalidator.revalidate]);
  if (status === "provisioning") {
    const needsRevalidation = fetcher.state === "idle" &&
      fetcher.data?.intent === "provision-direct-file" && handledAction.current !== fetcher.data;
    const busy = fetcher.state !== "idle" || revalidator.state !== "idle" ||
      navigation.state !== "idle" || actionRevalidating || needsRevalidation;
    const validFileId = isV7(fileId);
    return <main role="status" className="p-8">
      <p>Shared content is being securely provisioned</p>
      {fetcher.state === "idle" && fetcher.data?.intent === "provision-direct-file" &&
        fetcher.data.state === "error" && <p role="alert">Secure access could not be checked. Try again.</p>}
      {validFileId && <fetcher.Form method="post" action="/resources/sharing" className="mt-4">
        <input type="hidden" name="intent" value="provision-direct-file" />
        <input type="hidden" name="fileId" value={fileId} />
        <button type="submit" disabled={busy} className="underline disabled:opacity-60">
          {busy ? "Checking secure access" : "Retry secure access"}
        </button>
      </fetcher.Form>}
    </main>;
  }
  if (status === "not-found") return <main className="p-8"><h1>Not found</h1><p>This File is unavailable.</p></main>;
  if (!snapshot || snapshot.file.fileId !== fileId) return <main className="p-8"><h1>Files unavailable</h1>
    <p>Check this device’s access or try again.</p></main>;
  const verified = status === "ready" && revalidator.state === "idle" && appliedInitial.current === initial;
  return <main className="mx-auto max-w-screen-xl p-4 md:p-8">
    <nav aria-label="Breadcrumbs"><Link to={`/f/${fileId}`}>{snapshot.name}</Link></nav>
    <header className="mt-4"><h1 className="text-2xl font-semibold">{snapshot.name}</h1><p className="text-sm text-stone-500">Shared as</p></header>
    {(status !== "ready" || revalidator.state !== "idle") && <div role="alert" className="mt-4">
      Files could not be verified. Your local draft remains in this tab; edits and writes are paused.
      <button type="button" onClick={() => revalidator.revalidate()} className="ml-2 underline">Retry Files</button>
    </div>}
    <FileEditor direct actorAccountId={snapshot.actorAccountId} fileId={fileId} file={snapshot.file}
      flushRef={flush} editingFrozen={!verified || navigation.state !== "idle"}
      authorityVerified={verified} writable={snapshot.canEditMarkdown}
      onCommitted={(file) => setSnapshot((old) => old ? { ...old, file } : null)} />
    <aside className="mt-8 border-t pt-4"><SharedNavigation actorAccountId={snapshot.actorAccountId} /></aside>
  </main>;
}
