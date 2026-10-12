import type { ShouldRevalidateFunction } from "react-router";
import { FilesFallback } from "~/tree/files-fallback";
import { FilesPage } from "~/tree/files-page";
import type { ChromeHandle } from "~/ui/chrome";
import { loadFilesPage } from "~/tree/navigation-client";
import { fileSaveAction } from "~/shared/tree/file-client";

import type { Route } from "./+types/file";

export const handle: ChromeHandle = { chrome: "workspace" };

export function meta() {
  return [{ title: "Library — mdwn" }];
}

/** Browser-only private data, never serialized into document HTML/hydration. */
export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  return loadFilesPage(params.fileId, "file", request.signal);
}

/** Ciphertext is prepared locally; the client action alone submits the proof-guarded mutation. */
export async function clientAction({ request, params }: Route.ClientActionArgs) {
  return fileSaveAction(params.fileId, request);
}

export function shouldRevalidate({ actionResult, defaultShouldRevalidate }: Parameters<ShouldRevalidateFunction>[0]) {
  // A save owns its revision advancement. Revalidation must not replace a newer in-memory draft.
  return actionResult?.operationId ? false : defaultShouldRevalidate;
}

export function HydrateFallback() {
  return <FilesFallback />;
}

export default function FileRoute({ params, loaderData }: Route.ComponentProps) {
  return <FilesPage key={params.fileId} nodeId={params.fileId} kind="file" initial={loaderData} />;
}
