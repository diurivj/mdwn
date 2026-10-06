import { useState } from "react";
import { Link, useRevalidator } from "react-router";

import { PrivateAccessError, type PrivateAccessState } from "~/shared/device/private-client";
import {
  DeviceListChangedError,
  loadDeviceInventory,
  removeListedDevice,
  type DeviceInventory,
} from "~/device/management-client";

import type { Route } from "./+types/account-devices";

type Screen = { state: "ready"; inventory: DeviceInventory } | { state: PrivateAccessState | "failed" };

export function meta() {
  return [{ title: "Encryption devices — mdwn" }];
}

/** Browser-only decryption. No Account inventory is sent through SSR. */
export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<Screen> {
  try {
    return { state: "ready", inventory: await loadDeviceInventory(request.signal) };
  } catch (error) {
    if (request.signal.aborted) throw error;
    return { state: error instanceof PrivateAccessError ? error.state : "failed" };
  }
}

export function HydrateFallback() {
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <h1 className="text-2xl font-semibold">Loading Encryption devices…</h1>
    </main>
  );
}

export default function AccountDevices({ loaderData }: Route.ComponentProps) {
  const revalidator = useRevalidator();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [typedLabel, setTypedLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<"removed" | "changed" | "failed" | null>(null);
  const inventory = loaderData.state === "ready" ? loaderData.inventory : null;
  const activeCount = inventory?.devices.filter((item) => item.state === "active").length ?? 0;
  const confirming = inventory?.devices.find((item) => item.id === confirmingId);
  const remove = async () => {
    if (!inventory || !confirming || busy) return;
    const controller = new AbortController();
    setBusy(true);
    setNotice(null);
    try {
      await removeListedDevice(inventory, confirming, typedLabel, controller.signal);
      setNotice("removed");
      revalidator.revalidate();
    } catch (error) {
      setNotice(error instanceof DeviceListChangedError ? "changed" : "failed");
      revalidator.revalidate();
    } finally {
      setConfirmingId(null);
      setTypedLabel("");
      setBusy(false);
    }
  };
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <Link className="text-sm underline" to="/">
        mdwn
      </Link>
      <h1 className="mt-8 text-2xl font-semibold">Encryption devices</h1>
      <p className="mt-3 text-sm text-stone-600">
        Removing a device stops its future private access. It cannot erase plaintext, keys, or ciphertext already cached
        on that device.
      </p>
      {inventory ? (
        <>
          <ul className="mt-7 space-y-3">
            {inventory.devices.map((device) => (
              <li className="rounded-md border border-stone-200 bg-white p-4" key={device.id}>
                <p className="font-medium">{device.label}</p>
                <p className="mt-1 text-sm text-stone-600">{device.state === "active" ? "Active" : "Removed"}</p>
                <p className="mt-1 text-sm text-stone-600">Added {new Date(device.createdAt).toLocaleString()}</p>
                <p className="mt-1 text-sm text-stone-600">
                  Last recorded use:{" "}
                  {device.lastUseAt === null ? "Not recorded" : new Date(device.lastUseAt).toLocaleDateString()}
                </p>
                {device.state === "active" && device.id !== inventory.currentDeviceId && activeCount > 1 ? (
                  <button
                    type="button"
                    className="mt-3 rounded-md border border-red-700 px-3 py-2 text-sm text-red-800 disabled:opacity-60"
                    disabled={busy || revalidator.state !== "idle"}
                    onClick={() => {
                      setConfirmingId(device.id);
                      setTypedLabel("");
                      setNotice(null);
                    }}
                  >
                    Remove device
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {confirming && (
            <section className="mt-6 rounded-md border border-red-700 p-4" aria-label="Confirm device removal">
              <h2 className="text-lg font-medium">Remove {confirming.label}?</h2>
              <p className="mt-2 text-sm">
                This stops future private access for this device, but cannot recall anything it already cached.
              </p>
              <label htmlFor="confirm-device-label" className="mt-4 block text-sm">
                Type {confirming.label} to confirm
              </label>
              <input
                id="confirm-device-label"
                type="text"
                value={typedLabel}
                autoComplete="off"
                onChange={(event) => setTypedLabel(event.target.value)}
                className="mt-2 w-full rounded-md border border-stone-300 p-2"
              />
              <div className="mt-4 flex gap-3">
                <button
                  type="button"
                  disabled={busy || typedLabel !== confirming.label}
                  onClick={() => {
                    void remove();
                  }}
                  className="rounded-md bg-red-800 px-4 py-2 text-white disabled:opacity-60"
                >
                  Confirm removal
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setConfirmingId(null);
                    setTypedLabel("");
                  }}
                  className="rounded-md border border-stone-300 px-4 py-2 disabled:opacity-60"
                >
                  Cancel
                </button>
              </div>
            </section>
          )}
          {activeCount === 1 && (
            <p className="mt-5 text-sm">
              This is the last active device. You cannot remove it here. Sign out instead, or use Files recovery to
              replace lost devices.
            </p>
          )}
        </>
      ) : (
        <p role="alert" className="mt-6">
          {loaderData.state === "signed-out"
            ? "Sign in to manage your Encryption devices."
            : loaderData.state === "unprovisioned" || loaderData.state === "device-lost"
              ? "This browser cannot manage Encryption devices. Enroll it on another active device or recover your Files."
              : "Device inventory unavailable. Refresh and try again."}
        </p>
      )}
      {notice && (
        <p role={notice === "removed" ? "status" : "alert"} className="mt-4 text-sm">
          {notice === "removed"
            ? "Device removed. Other devices can continue after refreshing their access."
            : notice === "changed"
              ? "Device list changed. Review it and confirm again."
              : "Device removal failed. Review the device list and try again."}
        </p>
      )}
      <div className="mt-8 flex flex-wrap gap-4 text-sm">
        <Link to="/account/security" className="underline">
          Account security and sign out
        </Link>
        <Link to="/recover-files" className="underline">
          Files recovery
        </Link>
      </div>
    </main>
  );
}
