import { ownedProvisioningKind } from "~/shared/device/owned-provision-client";
import { PrivateAccessError, privateRequest, type PrivateAccessState } from "~/shared/device/private-client";

export type DeviceAccess = {
  state: "ready" | PrivateAccessState;
  rootId?: string;
  provisioning?: "recovery" | "enrollment" | "unknown" | null;
};

/**
 * Whether this browser can open its Files, and whether an owned-key job still
 * needs it. Browser-only: neither private ciphertext nor even the Account
 * status enters SSR. Both reads go out together; the job's state matters only
 * once the bootstrap succeeds.
 */
export async function loadDeviceAccess(signal: AbortSignal): Promise<DeviceAccess> {
  // An unreadable job is "unknown": the page then resumes it rather than assume it finished.
  const provisioning = ownedProvisioningKind(signal).catch(() => "unknown" as const);
  try {
    const response = await privateRequest("/api/private/bootstrap", { method: "POST", signal });
    if (!response.ok) return { state: "unavailable" };
    const bootstrap = (await response.json()) as { rootDirectoryId: string };
    return { state: "ready", rootId: bootstrap.rootDirectoryId, provisioning: await provisioning };
  } catch (error) {
    if (signal.aborted) throw error;
    return { state: error instanceof PrivateAccessError ? error.state : "unavailable" };
  }
}
