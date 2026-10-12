import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Link } from "react-router";

import { beginCandidate, loadEnrollmentPage, pollCandidate, type PendingCandidate } from "~/enrollment/ceremony-client";
import { useOwnedProvisioning } from "~/device/owned-provision-hook";
import type { ChromeHandle } from "~/ui/chrome";
import { cx } from "~/ui/cx";
import { ArrowRightIcon, CheckIcon, QrIcon, RefreshIcon } from "~/ui/icons";
import { FocusLayout, PageIntro } from "~/ui/page-layouts";
import { buttonClass, fieldClass, labelClass, linkClass, noticeClass } from "~/ui/styles";

import type { Route } from "./+types/enroll-device";

export const handle: ChromeHandle = { chrome: "account" };

export function meta() {
  return [{ title: "Enroll this device — mdwn" }];
}

/** Candidate keys and QR data are handled only after hydration in this browser. */
export function clientLoader({ request }: Route.ClientLoaderArgs) {
  return loadEnrollmentPage(request.signal);
}

export function HydrateFallback() {
  return (
    <FocusLayout>
      <PageIntro eyebrow="New device" title="Preparing device enrollment…" />
    </FocusLayout>
  );
}

export default function EnrollDevice({ loaderData }: Route.ComponentProps) {
  const [pending, setPending] = useState<PendingCandidate | null>(loaderData.pending ?? null);
  const [phase, setPhase] = useState<"start" | "scan" | "waiting" | "setup" | "restart" | "active" | "sign-in-again">(
    loaderData.state === "pending"
      ? "scan"
      : loaderData.state === "ready"
        ? "active"
        : loaderData.state === "sign-in-again"
          ? "sign-in-again"
          : "start",
  );
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const provisioning = useOwnedProvisioning(phase === "setup");

  useEffect(() => {
    if (!pending || !canvas.current || (phase !== "scan" && phase !== "waiting")) return;
    void QRCode.toCanvas(canvas.current, pending.pairingLink, {
      errorCorrectionLevel: "L",
      width: 512,
      margin: 2,
    }).catch(() => setPhase("restart"));
  }, [pending, phase]);

  useEffect(() => {
    if (!pending || (phase !== "scan" && phase !== "waiting")) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await pollCandidate(pending, controller.signal);
        if (controller.signal.aborted) return;
        if (result === "committed") setPhase("setup");
        else
          timer = setTimeout(() => {
            void poll();
          }, 1_500);
      } catch {
        if (!controller.signal.aborted) setPhase("restart");
      }
    };
    timer = setTimeout(() => {
      void poll();
    }, 1_500);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [pending, phase]);

  const start = async () => {
    setBusy(true);
    const controller = new AbortController();
    try {
      const created = await beginCandidate(controller.signal, label);
      setPending(created);
      setPhase("scan");
    } catch {
      setPhase("restart");
    } finally {
      setBusy(false);
    }
  };

  return (
    <FocusLayout>
      {loaderData.state === "signed-out" ? (
        <>
          <PageIntro eyebrow="New device" title="Sign in to enroll this device">
            <p>Enrollment starts with your passkey on this browser.</p>
          </PageIntro>
          <Link to="/sign-in" className={cx(buttonClass("primary", "lg"), "mt-8")}>
            Sign in with a passkey
            <ArrowRightIcon />
          </Link>
        </>
      ) : loaderData.state === "failed" ? (
        <PageIntro eyebrow="New device" title="Enrollment unavailable">
          <p>Please try again.</p>
        </PageIntro>
      ) : phase === "active" ? (
        <>
          <PageIntro eyebrow="New device" title="Device access ready">
            <p>This browser can open your Files.</p>
          </PageIntro>
          <Link to="/account/device-access" className={cx(buttonClass("primary", "lg"), "mt-8")}>
            Open your library
            <ArrowRightIcon />
          </Link>
        </>
      ) : phase === "sign-in-again" ? (
        <>
          <PageIntro eyebrow="New device" title="Device approved">
            <p>Sign in again with your passkey to finish binding this browser.</p>
          </PageIntro>
          <Link to="/sign-in" className={cx(buttonClass("primary", "lg"), "mt-8")}>
            Sign in
            <ArrowRightIcon />
          </Link>
        </>
      ) : phase === "restart" ? (
        <>
          <PageIntro eyebrow="New device" title="Restart device enrollment" />
          <p role="alert" className={cx(noticeClass("warning"), "mt-6")}>
            This pairing attempt is no longer available. Start again on this browser.
          </p>
          <button
            type="button"
            className={cx(buttonClass("primary"), "mt-6")}
            onClick={() => {
              setPending(null);
              setPhase("start");
            }}
          >
            <RefreshIcon />
            Start again
          </button>
        </>
      ) : phase === "setup" ? (
        <>
          <PageIntro eyebrow="New device" title="Setting up your Files securely…" />
          <p role="status" className={cx(noticeClass(provisioning ? "info" : "success"), "mt-6")}>
            {provisioning
              ? "Your Account-owned Files are being prepared on this device."
              : "Your Account-owned Files are ready on this device."}
          </p>
          <Link to="/account/device-access" className={cx(buttonClass("primary"), "mt-6")}>
            Continue to Files
            <ArrowRightIcon />
          </Link>
        </>
      ) : phase === "start" ? (
        <>
          <PageIntro eyebrow="New device" title="Enroll this device">
            <p>Confirm with your passkey, then scan the QR code using an existing active device.</p>
          </PageIntro>
          <div className="mt-8 border border-line bg-cream p-6 sm:p-8">
            <label htmlFor="enrollment-label" className={labelClass}>
              Device label (optional)
            </label>
            <input
              id="enrollment-label"
              maxLength={80}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. Work laptop"
              className={cx(fieldClass(), "mt-2")}
            />
            <p className="mt-2 text-xs text-muted">Encrypted in this browser before it’s saved.</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void start();
              }}
              className={cx(buttonClass("primary"), "mt-6")}
            >
              <QrIcon />
              Create pairing QR code
            </button>
          </div>
        </>
      ) : (
        <>
          <PageIntro eyebrow="New device" title={phase === "scan" ? "Scan this QR code" : "Waiting for approval"}>
            <p>
              Open{" "}
              <Link to="/enroll-device/approve" className={linkClass}>
                Approve a device
              </Link>{" "}
              on your existing device and scan this code.
            </p>
          </PageIntro>
          <div className="mt-8 border border-line bg-cream p-6 sm:p-8">
            <canvas
              ref={canvas}
              role="img"
              aria-label="Device pairing QR code"
              className="mx-auto block aspect-square w-full max-w-xs border border-line bg-white p-2"
            />
            <label htmlFor="pairing-link" className={cx(labelClass, "mt-6")}>
              Pairing link
            </label>
            <input
              id="pairing-link"
              aria-label="Pairing link"
              readOnly
              value={pending?.pairingLink ?? ""}
              className={cx(fieldClass("sm"), "mt-2 font-mono text-xs")}
            />
            {phase === "scan" ? (
              <button
                type="button"
                onClick={() => setPhase("waiting")}
                className={cx(buttonClass("secondary"), "mt-5")}
              >
                <CheckIcon />
                I've scanned it
              </button>
            ) : (
              <p className="mt-5 flex items-center gap-2 text-sm text-muted">
                <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-accent" />
                Waiting for your other device…
              </p>
            )}
          </div>
        </>
      )}
    </FocusLayout>
  );
}
