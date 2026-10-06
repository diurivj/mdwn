import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Link } from "react-router";

import { beginCandidate, loadEnrollmentPage, pollCandidate, type PendingCandidate } from "~/enrollment/ceremony-client";
import { useOwnedProvisioning } from "~/device/owned-provision-hook";

import type { Route } from "./+types/enroll-device";

export function meta() {
  return [{ title: "Enroll this device — mdwn" }];
}

/** Candidate keys and QR data are handled only after hydration in this browser. */
export function clientLoader({ request }: Route.ClientLoaderArgs) {
  return loadEnrollmentPage(request.signal);
}

export function HydrateFallback() {
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <h1 className="text-2xl font-semibold">Preparing device enrollment…</h1>
    </main>
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
    <main className="mx-auto max-w-xl px-4 py-12">
      <Link to="/" className="text-sm underline">
        mdwn
      </Link>
      {loaderData.state === "signed-out" ? (
        <>
          <h1 className="mt-8 text-2xl font-semibold">Sign in to enroll this device</h1>
          <p className="mt-4">
            <Link to="/sign-in" className="underline">
              Sign in with a passkey
            </Link>{" "}
            to continue.
          </p>
        </>
      ) : loaderData.state === "failed" ? (
        <>
          <h1 className="mt-8 text-2xl font-semibold">Enrollment unavailable</h1>
          <p className="mt-4">Please try again.</p>
        </>
      ) : phase === "active" ? (
        <>
          <h1 className="mt-8 text-2xl font-semibold">Device access ready</h1>
          <p className="mt-4">
            <Link to="/account/device-access" className="underline">
              Open your Files
            </Link>
          </p>
        </>
      ) : phase === "sign-in-again" ? (
        <>
          <h1 className="mt-8 text-2xl font-semibold">Device approved</h1>
          <p className="mt-4">Sign in again with your passkey to finish binding this browser.</p>
          <Link to="/sign-in" className="mt-3 inline-block underline">
            Sign in
          </Link>
        </>
      ) : phase === "restart" ? (
        <>
          <h1 className="mt-8 text-2xl font-semibold">Restart device enrollment</h1>
          <p role="alert" className="mt-4">
            This pairing attempt is no longer available. Start again on this browser.
          </p>
          <button
            type="button"
            className="mt-5 rounded-md bg-stone-900 px-4 py-2 text-white"
            onClick={() => {
              setPending(null);
              setPhase("start");
            }}
          >
            Start again
          </button>
        </>
      ) : phase === "setup" ? (
        <>
          <h1 className="mt-8 text-2xl font-semibold">Setting up your Files securely…</h1>
          <p role="status" className="mt-4">
            {provisioning
              ? "Your Account-owned Files are being prepared on this device."
              : "Your Account-owned Files are ready on this device."}
          </p>
          <Link to="/account/device-access" className="mt-4 inline-block underline">
            Continue to Files
          </Link>
        </>
      ) : phase === "start" ? (
        <>
          <h1 className="mt-8 text-2xl font-semibold">Enroll this device</h1>
          <p className="mt-4">Confirm with your passkey, then scan the QR code using an existing active device.</p>
          <label htmlFor="enrollment-label" className="mt-5 block text-sm font-medium">
            Device label (optional)
          </label>
          <input
            id="enrollment-label"
            maxLength={80}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            className="mt-2 w-full rounded-md border border-stone-300 p-2"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void start();
            }}
            className="mt-5 rounded-md bg-stone-900 px-4 py-2 text-white disabled:opacity-60"
          >
            Create pairing QR code
          </button>
        </>
      ) : (
        <>
          <h1 className="mt-8 text-2xl font-semibold">
            {phase === "scan" ? "Scan this QR code" : "Waiting for approval"}
          </h1>
          <p className="mt-4">
            Open{" "}
            <Link to="/enroll-device/approve" className="underline">
              Approve a device
            </Link>{" "}
            on your existing device and scan this code.
          </p>
          <canvas
            ref={canvas}
            role="img"
            aria-label="Device pairing QR code"
            className="mt-5 max-w-full rounded-md border border-stone-300 bg-white p-2"
          />
          <label htmlFor="pairing-link" className="mt-5 block text-sm font-medium">
            Pairing link
          </label>
          <input
            id="pairing-link"
            aria-label="Pairing link"
            readOnly
            value={pending?.pairingLink ?? ""}
            className="mt-2 w-full rounded-md border border-stone-300 p-2 font-mono text-xs"
          />
          {phase === "scan" && (
            <button
              type="button"
              onClick={() => setPhase("waiting")}
              className="mt-4 rounded-md border border-stone-300 px-4 py-2"
            >
              I've scanned it
            </button>
          )}
        </>
      )}
    </main>
  );
}
