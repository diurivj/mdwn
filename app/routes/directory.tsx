import { FilesFallback } from "~/tree/files-fallback";
import { FilesPage } from "~/tree/files-page";
import type { ChromeHandle } from "~/ui/chrome";
import { loadFilesPage } from "~/tree/navigation-client";

import type { Route } from "./+types/directory";

export const handle: ChromeHandle = { chrome: "workspace" };

export function meta() {
  return [{ title: "Library — mdwn" }];
}

/** Browser-only private data, never serialized into document HTML/hydration. */
export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  return loadFilesPage(params.directoryId, "directory", request.signal);
}

export function HydrateFallback() {
  return <FilesFallback />;
}

export default function DirectoryRoute({ params, loaderData }: Route.ComponentProps) {
  return <FilesPage key={params.directoryId} nodeId={params.directoryId} kind="directory" initial={loaderData} />;
}
