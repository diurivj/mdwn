import { redirect } from "react-router";

import { ownedProvisioningKind } from "~/shared/device/owned-provision-client";
import { FilesFallback } from "~/tree/files-fallback";
import { FilesPage } from "~/tree/files-page";
import { loadLibraryPage } from "~/tree/navigation-client";
import type { ChromeHandle } from "~/ui/chrome";

import type { Route } from "./+types/files";

export const handle: ChromeHandle = { chrome: "workspace" };

export function meta() {
  return [{ title: "Library — mdwn" }];
}

/**
 * The library's stable address: its root folder, opened from the same
 * bootstrap that proves this browser can open it. No Session or Encryption
 * device, or an owned-key job still in progress, hands over to device access,
 * which explains what is missing and resumes the job; a root that fails after
 * that shows the library's own unavailable state.
 */
export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  // An unreadable job is "unknown": device access then resumes it rather than assume it finished.
  const provisioning = ownedProvisioningKind(request.signal).catch(() => "unknown" as const);
  const page = await loadLibraryPage(request.signal);
  if (page.status === "access" || (await provisioning) !== null) return redirect("/account/device-access");
  return page;
}

export function HydrateFallback() {
  return <FilesFallback />;
}

export default function Files({ loaderData }: Route.ComponentProps) {
  const rootId = loaderData.snapshot?.access.rootId ?? "";
  return <FilesPage key={rootId} nodeId={rootId} kind="directory" initial={loaderData} />;
}
