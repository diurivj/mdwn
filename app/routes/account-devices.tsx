import { useState } from "react";
import { Link, useRevalidator } from "react-router";

import { PrivateAccessError, type PrivateAccessState } from "~/shared/device/private-client";
import {
  DeviceListChangedError,
  loadDeviceInventory,
  removeListedDevice,
  type DeviceInventory,
} from "~/device/management-client";

import type { ChromeHandle } from "~/ui/chrome";
import { cx } from "~/ui/cx";
import { DevicesIcon, QrIcon, ShieldIcon, TrashIcon } from "~/ui/icons";
import { AccountLayout, PageIntro, SkeletonLines } from "~/ui/page-layouts";
import { buttonClass, fieldClass, labelClass, noticeClass } from "~/ui/styles";

import type { Route } from "./+types/account-devices";

type Screen = { state: "ready"; inventory: DeviceInventory } | { state: PrivateAccessState | "failed" };

export const handle: ChromeHandle = { chrome: "account" };

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
    <AccountLayout busy>
      <PageIntro eyebrow="Devices" title="Loading Encryption devices…" />
      <SkeletonLines className="mt-10 max-w-xl" />
    </AccountLayout>
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
    <AccountLayout>
      <PageIntro eyebrow="Devices" title="Encryption devices">
        <p>
          Removing a device stops its future private access. It cannot erase plaintext, keys, or ciphertext already
          cached on that device.
        </p>
      </PageIntro>
      {inventory ? (
        <>
          <ul className="mt-10 grid gap-4 md:grid-cols-2">
            {inventory.devices.map((device) => (
              <li
                className={cx(
                  "flex flex-col rounded-3xl p-6 ring-1",
                  device.state === "active" ? "bg-paper ring-line" : "bg-cream/50 text-ink-soft ring-line/70",
                )}
                key={device.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="grid size-11 place-items-center rounded-full bg-cream text-accent ring-1 ring-line">
                    <DevicesIcon className="size-5" />
                  </span>
                  <span className="flex flex-wrap justify-end gap-1.5">
                    {device.id === inventory.currentDeviceId && (
                      <span className="rounded-full bg-ink px-2.5 py-1 text-[11px] font-medium text-paper">
                        This browser
                      </span>
                    )}
                    <span
                      className={cx(
                        "rounded-full px-2.5 py-1 text-[11px] font-medium",
                        device.state === "active" ? "bg-success-soft text-success" : "bg-sand text-muted",
                      )}
                    >
                      {device.state === "active" ? "Active" : "Removed"}
                    </span>
                  </span>
                </div>
                <p className="mt-5 font-serif text-2xl leading-tight">{device.label}</p>
                <dl className="mt-3 space-y-1 text-sm text-ink-soft">
                  <div className="flex gap-2">
                    <dt className="text-muted">Added</dt>
                    <dd>{new Date(device.createdAt).toLocaleString()}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-muted">Last recorded use:</dt>
                    <dd>
                      {device.lastUseAt === null ? "Not recorded" : new Date(device.lastUseAt).toLocaleDateString()}
                    </dd>
                  </div>
                </dl>
                {device.state === "active" && device.id !== inventory.currentDeviceId && activeCount > 1 ? (
                  <button
                    type="button"
                    className={cx(buttonClass("danger-quiet", "sm"), "mt-5 self-start")}
                    disabled={busy || revalidator.state !== "idle"}
                    onClick={() => {
                      setConfirmingId(device.id);
                      setTypedLabel("");
                      setNotice(null);
                    }}
                  >
                    <TrashIcon />
                    Remove device
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {confirming && (
            <section
              className="mt-6 animate-fade rounded-3xl bg-danger-soft/50 p-6 ring-1 ring-danger/25 sm:p-8"
              aria-label="Confirm device removal"
            >
              <h2 className="font-serif text-3xl leading-tight">Remove {confirming.label}?</h2>
              <p className="mt-2 text-sm text-ink-soft">
                This stops future private access for this device, but cannot recall anything it already cached.
              </p>
              <label htmlFor="confirm-device-label" className={cx(labelClass, "mt-5")}>
                Type {confirming.label} to confirm
              </label>
              <input
                id="confirm-device-label"
                type="text"
                value={typedLabel}
                autoComplete="off"
                onChange={(event) => setTypedLabel(event.target.value)}
                className={cx(fieldClass(), "mt-2 max-w-md")}
              />
              <div className="mt-5 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy || typedLabel !== confirming.label}
                  onClick={() => {
                    void remove();
                  }}
                  className={buttonClass("danger")}
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
                  className={buttonClass("ghost")}
                >
                  Cancel
                </button>
              </div>
            </section>
          )}
          {activeCount === 1 && (
            <p className={cx(noticeClass("info"), "mt-6 max-w-2xl")}>
              This is the last active device. You cannot remove it here. Sign out instead, or use Files recovery to
              replace lost devices.
            </p>
          )}
        </>
      ) : (
        <p role="alert" className={cx(noticeClass("warning"), "mt-8 max-w-2xl")}>
          {loaderData.state === "signed-out"
            ? "Sign in to manage your Encryption devices."
            : loaderData.state === "unprovisioned" || loaderData.state === "device-lost"
              ? "This browser cannot manage Encryption devices. Enroll it on another active device or recover your Files."
              : "Device inventory unavailable. Refresh and try again."}
        </p>
      )}
      {notice && (
        <p
          role={notice === "removed" ? "status" : "alert"}
          className={cx(noticeClass(notice === "removed" ? "success" : "danger"), "mt-6 max-w-2xl")}
        >
          {notice === "removed"
            ? "Device removed. Other devices can continue after refreshing their access."
            : notice === "changed"
              ? "Device list changed. Review it and confirm again."
              : "Device removal failed. Review the device list and try again."}
        </p>
      )}
      <div className="mt-10 flex flex-wrap gap-2 border-t border-line pt-6">
        <Link to="/enroll-device/approve" className={buttonClass("secondary", "sm")}>
          <QrIcon />
          Approve a new device
        </Link>
        <Link to="/account/security" className={buttonClass("ghost", "sm")}>
          <ShieldIcon />
          Account security and sign out
        </Link>
        <Link to="/recover-files" className={buttonClass("ghost", "sm")}>
          Files recovery
        </Link>
      </div>
    </AccountLayout>
  );
}
