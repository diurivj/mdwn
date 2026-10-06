import { Link } from "react-router";

import { privateRequest, PrivateAccessError, type PrivateAccessState } from "~/shared/device/private-client";
import { ownedProvisioningKind } from "~/shared/device/owned-provision-client";
import { useOwnedProvisioning } from "~/device/owned-provision-hook";
import { SharedProvisioning } from "~/sharing/shared-provisioning";

import type { Route } from "./+types/device-access";

export function meta() {
  return [{ title: "Device access — mdwn" }];
}

type Access = {
  state: "ready" | PrivateAccessState;
  rootId?: string;
  provisioning?: "recovery" | "enrollment" | "unknown" | null;
};

/** Browser-only: neither private ciphertext nor even the Account status enters SSR. */
export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<Access> {
  try {
    const response = await privateRequest("/api/private/bootstrap", { method: "POST", signal: request.signal });
    if (!response.ok) return { state: "unavailable" };
    const bootstrap = (await response.json()) as { rootDirectoryId: string };
    try {
      return {
        state: "ready",
        rootId: bootstrap.rootDirectoryId,
        provisioning: await ownedProvisioningKind(request.signal),
      };
    } catch (error) {
      if (request.signal.aborted) throw error;
      return { state: "ready", rootId: bootstrap.rootDirectoryId, provisioning: "unknown" };
    }
  } catch (error) {
    if (request.signal.aborted) throw error;
    return { state: error instanceof PrivateAccessError ? error.state : "unavailable" };
  }
}

export function HydrateFallback() {
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <h1 className="text-2xl font-semibold">Checking device access…</h1>
    </main>
  );
}

export default function DeviceAccess({ loaderData }: Route.ComponentProps) {
  const { state } = loaderData;
  const restoring = useOwnedProvisioning(Boolean(loaderData.provisioning));
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <Link to="/" className="text-sm underline">
        mdwn
      </Link>
      {state === "ready" ? (
        <>
          <h1 className="mt-8 text-2xl font-semibold">Private access ready</h1>
          <p className="mt-4">This browser has an active Encryption device.</p>
          <SharedProvisioning />
          {loaderData.rootId && (
            <Link to={`/d/${loaderData.rootId}`} className="mt-4 block underline">
              Open Files
            </Link>
          )}
          <Link to="/enroll-device/approve" className="mt-4 inline-block underline">
            Approve another device
          </Link>
          {restoring && (
            <p role="status" className="mt-4">
              {loaderData.provisioning === "recovery"
                ? "Restoring your Files securely…"
                : "Setting up your Files securely…"}
            </p>
          )}
        </>
      ) : state === "signed-out" ? (
        <>
          <h1 className="mt-8 text-2xl font-semibold">Sign in to access your Files</h1>
          <p className="mt-4">
            <Link to="/sign-in" className="underline">
              Sign in with a passkey
            </Link>{" "}
            to continue.
          </p>
        </>
      ) : state === "unprovisioned" || state === "device-lost" ? (
        <>
          <h1 className="mt-8 text-2xl font-semibold">Restore private access</h1>
          <p className="mt-4">
            {state === "device-lost"
              ? "This browser no longer has the keys for its bound Encryption device. No private request was sent."
              : "This Session has no active Encryption device. A passkey alone cannot open private material."}
          </p>
          <p className="mt-3">
            Use an existing active device for enrollment, or{" "}
            <Link to="/recover-files" className="underline">
              recover your Files with your recovery phrase
            </Link>{" "}
            if no device is available.
          </p>
          <Link to="/enroll-device" className="mt-4 block underline">
            Enroll this device
          </Link>
          <Link to="/account/security" className="mt-4 inline-block underline">
            Account security
          </Link>
        </>
      ) : (
        <>
          <h1 className="mt-8 text-2xl font-semibold">Private access unavailable</h1>
          <p className="mt-4">
            No private material was displayed. Refresh to check device and registry state again, or use account security
            for help.
          </p>
          <Link to="/account/security" className="mt-4 inline-block underline">
            Account security
          </Link>
        </>
      )}
    </main>
  );
}
