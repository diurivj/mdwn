import { FilesPage } from "~/tree/FilesPage";
import { loadFilesPage } from "~/tree/navigation-client";

import type { Route } from "./+types/file";

export function meta() { return [{ title: "Files — mdwn" }]; }

/** Browser-only private data, never serialized into document HTML/hydration. */
export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  return loadFilesPage(params.fileId, "file", request.signal);
}

export function HydrateFallback() {
  return <main className="p-8" role="status">Opening Files…</main>;
}

export default function FileRoute({ params, loaderData }: Route.ComponentProps) {
  return <FilesPage key={params.fileId} nodeId={params.fileId}
    kind="file" initial={loaderData} />;
}
