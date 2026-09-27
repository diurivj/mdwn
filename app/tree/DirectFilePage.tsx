import { useEffect, useRef, useState } from "react";
import { Link, useNavigation, useRevalidator } from "react-router";
import { SharedNavigation } from "~/sharing/SharingUI";
import { FileEditor } from "./FileEditor";
import type { DirectFilesSnapshot, FilesPageData } from "./navigation-client";

/** A direct File scope has no parent, sibling, Directory key, path or owned root. */
export function DirectFilePage({ fileId, initial }: { fileId: string; initial: FilesPageData }) {
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const [snapshot, setSnapshot] = useState<DirectFilesSnapshot | null>(
    initial.status === "ready" && initial.snapshot.scope === "direct-file" ? initial.snapshot : null);
  const flush = useRef<(() => Promise<boolean>) | null>(null);
  const status = initial.status;
  useEffect(() => {
    if (initial.status === "ready" && initial.snapshot.scope === "direct-file") setSnapshot(initial.snapshot);
    else if (initial.status === "not-found" || initial.status === "provisioning") setSnapshot(null);
  }, [initial]);
  if (status === "provisioning") return <main role="status" className="p-8">Shared content is being securely provisioned</main>;
  if (status === "not-found") return <main className="p-8"><h1>Not found</h1><p>This File is unavailable.</p></main>;
  if (!snapshot || snapshot.file.fileId !== fileId) return <main className="p-8"><h1>Files unavailable</h1>
    <p>Check this device’s access or try again.</p></main>;
  const verified = status === "ready" && revalidator.state === "idle";
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
