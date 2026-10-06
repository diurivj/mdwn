import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { approveFromPairingLink } from "~/enrollment/ceremony-client";

export function meta() {
  return [{ title: "Approve a device — mdwn" }];
}

export function clientLoader() {
  return { ready: true };
}

export function HydrateFallback() {
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <h1 className="text-2xl font-semibold">Preparing approval…</h1>
    </main>
  );
}

export default function ApproveDevice() {
  const [link, setLink] = useState("");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"idle" | "success" | "failed">("idle");
  const video = useRef<HTMLVideoElement>(null);
  const controls = useRef<{ stop(): void } | null>(null);

  useEffect(() => {
    const hash = location.hash.slice(1);
    if (hash) {
      setLink(`${location.origin}/enroll-device/approve#${hash}`);
      history.replaceState(history.state, "", "/enroll-device/approve");
    }
    return () => controls.current?.stop();
  }, []);

  useEffect(() => {
    if (!scanning || !video.current) return;
    let disposed = false;
    const preview = video.current;
    void import("@zxing/browser")
      .then(async ({ BrowserQRCodeReader }) => {
        const reader = new BrowserQRCodeReader();
        const scanner = await reader.decodeFromVideoDevice(undefined, preview, (value, _error, active) => {
          if (value && !disposed) {
            setLink(value.getText());
            active.stop();
            setScanning(false);
          }
        });
        if (disposed) scanner.stop();
        else controls.current = scanner;
      })
      .catch(() => {
        if (!disposed) {
          setScanning(false);
          setResult("failed");
        }
      });
    return () => {
      disposed = true;
      controls.current?.stop();
      controls.current = null;
    };
  }, [scanning]);

  const approve = async () => {
    setBusy(true);
    setResult("idle");
    const controller = new AbortController();
    try {
      await approveFromPairingLink(link, controller.signal);
      setLink("");
      setResult("success");
    } catch {
      setResult("failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <Link to="/" className="text-sm underline">
        mdwn
      </Link>
      <h1 className="mt-8 text-2xl font-semibold">Approve a device</h1>
      <p className="mt-4">Use this active device to scan the QR code shown on your new browser.</p>
      <button
        type="button"
        onClick={() => {
          setResult("idle");
          setScanning(true);
        }}
        disabled={scanning || busy}
        className="mt-5 rounded-md border border-stone-300 px-4 py-2 disabled:opacity-60"
      >
        Scan QR code
      </button>
      {scanning && (
        <video
          ref={video}
          autoPlay
          muted
          playsInline
          aria-label="QR code camera preview"
          className="mt-4 w-full rounded-md border border-stone-300"
        />
      )}
      <label htmlFor="approval-link" className="mt-5 block text-sm font-medium">
        Pairing link
      </label>
      <input
        id="approval-link"
        aria-label="Pairing link"
        value={link}
        onChange={(event) => setLink(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        className="mt-2 w-full rounded-md border border-stone-300 p-2 font-mono text-xs"
      />
      <button
        type="button"
        disabled={busy || !link}
        onClick={() => {
          void approve();
        }}
        className="mt-5 rounded-md bg-stone-900 px-4 py-2 text-white disabled:opacity-60"
      >
        Approve device
      </button>
      {result === "success" && (
        <p role="status" className="mt-4">
          Approval sent. Finish setup on your new browser.
        </p>
      )}
      {result === "failed" && (
        <p role="alert" className="mt-4">
          This pairing attempt is unavailable. Restart on the new browser and try again.
        </p>
      )}
    </main>
  );
}
