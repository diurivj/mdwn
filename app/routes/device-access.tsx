import { Link } from "react-router";

import { loadDeviceAccess } from "~/device/access-client";
import { useOwnedProvisioning } from "~/device/owned-provision-hook";
import { SharedProvisioning } from "~/sharing/shared-provisioning";
import type { ChromeHandle } from "~/ui/chrome";
import { cx } from "~/ui/cx";
import { ArrowRightIcon, FolderIcon, KeyIcon, QrIcon, ShieldIcon } from "~/ui/icons";
import { AccountLayout, PageIntro, SkeletonLines } from "~/ui/page-layouts";
import { buttonClass, linkClass, noticeClass } from "~/ui/styles";

import type { Route } from "./+types/device-access";

export const handle: ChromeHandle = { chrome: "account" };

export function meta() {
  return [{ title: "Device access — mdwn" }];
}

/** Browser-only: neither private ciphertext nor even the Account status enters SSR. */
export function clientLoader({ request }: Route.ClientLoaderArgs) {
  return loadDeviceAccess(request.signal);
}

export function HydrateFallback() {
  return (
    <AccountLayout busy>
      <PageIntro eyebrow="Files access" title="Checking device access…" />
      <SkeletonLines className="mt-10 max-w-xl" />
    </AccountLayout>
  );
}

const tileClass =
  "group flex min-w-0 flex-col border-b border-line p-6 transition-colors last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0";

export default function DeviceAccess({ loaderData }: Route.ComponentProps) {
  const { state } = loaderData;
  const restoring = useOwnedProvisioning(Boolean(loaderData.provisioning));
  return (
    <AccountLayout>
      {state === "ready" ? (
        <>
          <PageIntro eyebrow="Files access" title="Private access ready">
            <p>This browser has an active Encryption device.</p>
          </PageIntro>
          {restoring && (
            <p role="status" className={cx(noticeClass("info"), "mt-6 max-w-xl")}>
              {loaderData.provisioning === "recovery"
                ? "Restoring your Files securely…"
                : "Setting up your Files securely…"}
            </p>
          )}
          <div className="mt-8 grid border-y border-line sm:grid-cols-2">
            {loaderData.rootId && (
              <Link to={`/d/${loaderData.rootId}`} className={cx(tileClass, "bg-ink text-paper hover:bg-ink-soft")}>
                <FolderIcon className="size-6 text-paper" />
                <span className="mt-6 font-display text-3xl font-light leading-tight tracking-tight">Open Files</span>
                <span className="mt-1 text-sm text-paper/70">Write, organize and publish.</span>
                <ArrowRightIcon className="mt-6 size-5" />
              </Link>
            )}
            <Link to="/enroll-device/approve" className={cx(tileClass, "bg-paper hover:bg-cream")}>
              <QrIcon className="size-6 text-accent" />
              <span className="mt-6 font-display text-3xl font-light leading-tight tracking-tight">
                Approve another device
              </span>
              <span className="mt-1 text-sm text-ink-soft">Scan the QR code shown on your new browser.</span>
              <ArrowRightIcon className="mt-6 size-5 text-muted" />
            </Link>
          </div>
          <div className="mt-6 border-y border-line bg-cream p-6 text-sm">
            <SharedProvisioning />
          </div>
        </>
      ) : state === "signed-out" ? (
        <>
          <PageIntro eyebrow="Files access" title="Sign in to access your Files">
            <p>Your Files stay encrypted until your passkey and an approved device open them.</p>
          </PageIntro>
          <Link to="/sign-in" className={cx(buttonClass("primary", "lg"), "mt-8")}>
            Sign in with a passkey
            <ArrowRightIcon />
          </Link>
        </>
      ) : state === "unprovisioned" || state === "device-lost" ? (
        <>
          <PageIntro eyebrow="Files access" title="Restore private access">
            <p>
              {state === "device-lost"
                ? "This browser no longer has the keys for its bound Encryption device. No private request was sent."
                : "This Session has no active Encryption device. A passkey alone cannot open private material."}
            </p>
          </PageIntro>
          <div className="mt-8 grid border-y border-line sm:grid-cols-2">
            <Link to="/enroll-device" className={cx(tileClass, "bg-ink text-paper hover:bg-ink-soft")}>
              <QrIcon className="size-6 text-paper" />
              <span className="mt-6 font-display text-3xl font-light leading-tight tracking-tight">
                Enroll this device
              </span>
              <span className="mt-1 text-sm text-paper/70">Approve it from a device you already use.</span>
              <ArrowRightIcon className="mt-6 size-5" />
            </Link>
            <div className={cx(tileClass, "bg-paper")}>
              <KeyIcon className="size-6 text-accent" />
              <p className="mt-6 text-sm leading-relaxed text-ink-soft">
                Use an existing active device for enrollment, or{" "}
                <Link to="/recover-files" className={linkClass}>
                  recover your Files with your recovery phrase
                </Link>{" "}
                if no device is available.
              </p>
            </div>
          </div>
          <Link to="/account/security" className={cx(buttonClass("secondary"), "mt-8")}>
            <ShieldIcon />
            Account security
          </Link>
        </>
      ) : (
        <>
          <PageIntro eyebrow="Files access" title="Private access unavailable">
            <p>
              No private material was displayed. Refresh to check device and registry state again, or use account
              security for help.
            </p>
          </PageIntro>
          <Link to="/account/security" className={cx(buttonClass("secondary"), "mt-8")}>
            <ShieldIcon />
            Account security
          </Link>
        </>
      )}
    </AccountLayout>
  );
}
