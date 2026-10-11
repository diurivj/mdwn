import { useEffect, useRef, useState } from "react";

import { approveFromPairingLink } from "~/enrollment/ceremony-client";
import type { ChromeHandle } from "~/ui/chrome";
import { cx } from "~/ui/cx";
import { CheckIcon, QrIcon } from "~/ui/icons";
import { AccountLayout, PageIntro } from "~/ui/page-layouts";
import { buttonClass, fieldClass, labelClass, noticeClass } from "~/ui/styles";

export const handle: ChromeHandle = { chrome: "account" };

export function meta() {
  return [{ title: "Approve a device — mdwn" }];
}

export function clientLoader() {
  return { ready: true };
}

export function HydrateFallback() {
  return (
    <AccountLayout busy>
      <PageIntro eyebrow="Devices" title="Preparing approval…" />
    </AccountLayout>
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
    <AccountLayout>
      <PageIntro eyebrow="Devices" title="Approve a device">
        <p>Use this active device to scan the QR code shown on your new browser.</p>
      </PageIntro>
      <div className="mt-8 max-w-xl border border-line bg-cream p-6 sm:p-8">
        <ol className="divide-y divide-line border-y border-line text-sm text-ink-soft">
          <li className="flex gap-3 py-3">
            <span className="font-mono text-[12px] text-muted">1</span>
            On the new browser, sign in and choose Enroll this device.
          </li>
          <li className="flex gap-3 py-3">
            <span className="font-mono text-[12px] text-muted">2</span>
            Scan its QR code here, or paste its pairing link.
          </li>
          <li className="flex gap-3 py-3">
            <span className="font-mono text-[12px] text-muted">3</span>
            Approve, then finish setup on the new browser.
          </li>
        </ol>
        <button
          type="button"
          onClick={() => {
            setResult("idle");
            setScanning(true);
          }}
          disabled={scanning || busy}
          className={cx(buttonClass("secondary"), "mt-6")}
        >
          <QrIcon />
          Scan QR code
        </button>
        {scanning && (
          <video
            ref={video}
            autoPlay
            muted
            playsInline
            aria-label="QR code camera preview"
            className="mt-5 w-full border border-line bg-ink"
          />
        )}
        <label htmlFor="approval-link" className={cx(labelClass, "mt-6")}>
          Pairing link
        </label>
        <input
          id="approval-link"
          aria-label="Pairing link"
          value={link}
          onChange={(event) => setLink(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="https://…/enroll-device/approve#…"
          className={cx(fieldClass("sm"), "mt-2 font-mono text-xs")}
        />
        <button
          type="button"
          disabled={busy || !link}
          onClick={() => {
            void approve();
          }}
          className={cx(buttonClass("primary"), "mt-5")}
        >
          <CheckIcon />
          Approve device
        </button>
      </div>
      {result === "success" && (
        <p role="status" className={cx(noticeClass("success"), "mt-6 max-w-xl")}>
          Approval sent. Finish setup on your new browser.
        </p>
      )}
      {result === "failed" && (
        <p role="alert" className={cx(noticeClass("danger"), "mt-6 max-w-xl")}>
          This pairing attempt is unavailable. Restart on the new browser and try again.
        </p>
      )}
    </AccountLayout>
  );
}
