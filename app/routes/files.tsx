import { redirect } from "react-router";

import { loadDeviceAccess } from "~/device/access-client";
import { FilesFallback } from "~/tree/files-fallback";
import type { ChromeHandle } from "~/ui/chrome";

import type { Route } from "./+types/files";

export const handle: ChromeHandle = { chrome: "workspace" };

export function meta() {
  return [{ title: "Files — mdwn" }];
}

/**
 * A stable address for "my Files": opens the root Directory once this browser
 * can, and otherwise hands over to device access, which explains what is
 * missing and resumes any owned-key job.
 */
export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const access = await loadDeviceAccess(request.signal);
  if (access.state === "ready" && access.rootId && !access.provisioning) return redirect(`/d/${access.rootId}`);
  return redirect("/account/device-access");
}

export function HydrateFallback() {
  return <FilesFallback />;
}

export default function Files() {
  return <FilesFallback />;
}
