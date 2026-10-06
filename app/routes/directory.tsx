import { FilesPage } from "~/tree/files-page";
import { loadFilesPage } from "~/tree/navigation-client";

import type { Route } from "./+types/directory";

export function meta() { return [{ title: "Files — mdwn" }]; }

/** Browser-only private data, never serialized into document HTML/hydration. */
export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  return loadFilesPage(params.directoryId, "directory", request.signal);
}

export function HydrateFallback() {
  return <main className="p-8" role="status">Opening Files…</main>;
}

export default function DirectoryRoute({ params, loaderData }: Route.ComponentProps) {
  return <FilesPage key={params.directoryId} nodeId={params.directoryId}
    kind="directory" initial={loaderData} />;
}
