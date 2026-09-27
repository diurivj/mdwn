import { useRef } from "react";
import { FilesPage } from "~/tree/FilesPage";
import { DirectFilePage } from "~/tree/DirectFilePage";
import type { RootFilesPageData } from "~/tree/navigation-client";
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
  const last = useRef<"direct-file" | "hierarchy" | null>(null);
  if (loaderData.status === "ready") last.current = loaderData.snapshot.scope === "direct-file" ? "direct-file" : "hierarchy";
  if (last.current === "direct-file" || loaderData.status === "provisioning") {
    return <DirectFilePage key={params.fileId} fileId={params.fileId} initial={loaderData} />;
  }
  return <FilesPage key={params.fileId} nodeId={params.fileId}
    kind="file" initial={loaderData as RootFilesPageData} />;
}
