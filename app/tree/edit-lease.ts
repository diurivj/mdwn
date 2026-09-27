import { useEffect, useRef, useState } from "react";

/** Web Locks arbitrate ownership; BroadcastChannel only requests transfer, never grants it. */
export function useFileLease(fileId: string) {
  const [owner, setOwner] = useState(false);
  const [transferRequested, setTransferRequested] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const release = useRef<(() => void) | null>(null);
  const lifetime = useRef<Promise<void> | null>(null);
  const waiting = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const ownerRef = useRef(false);

  async function acquire(signal?: AbortSignal): Promise<boolean> {
    if (!mounted.current || !navigator.locks || ownerRef.current) return ownerRef.current;
    let resolved!: (value: boolean) => void;
    const result = new Promise<boolean>((done) => { resolved = done; });
    lifetime.current = navigator.locks.request(`mdwn:file-edit:${fileId}`,
      signal ? { signal } : { ifAvailable: true }, async (lock) => {
        if (!lock || !mounted.current) { resolved(false); return; }
        ownerRef.current = true;
        setOwner(true);
        setRequesting(false);
        let unlock!: () => void;
        const held = new Promise<void>((done) => { unlock = done; });
        release.current = unlock;
        resolved(true);
        await held;
        ownerRef.current = false;
        release.current = null;
        if (mounted.current) setOwner(false);
      }).then(() => undefined, () => { resolved(false); });
    return result;
  }

  useEffect(() => {
    mounted.current = true;
    if (typeof BroadcastChannel !== "undefined") {
      const opened = new BroadcastChannel(`mdwn:file-edit:${fileId}`);
      channel.current = opened;
      opened.onmessage = (event: MessageEvent<{ type: string }>) => {
        if (event.data?.type === "request" && ownerRef.current) setTransferRequested(true);
      };
    }
    void acquire();
    return () => {
      mounted.current = false;
      waiting.current?.abort();
      release.current?.();
      channel.current?.close();
      channel.current = null;
    };
  }, [fileId]);

  async function requestTransfer(): Promise<void> {
    if (ownerRef.current || waiting.current) return;
    setRequesting(true);
    if (await acquire()) return; // The other tab closed before the request.
    if (!channel.current || !navigator.locks) { setRequesting(false); return; }
    const controller = new AbortController();
    waiting.current = controller;
    channel.current.postMessage({ type: "request" });
    await acquire(controller.signal); // Queued lock handoff also works in WebKit when a tab is backgrounded.
    if (waiting.current === controller) waiting.current = null;
  }

  async function finishTransfer(): Promise<void> {
    if (!ownerRef.current) return;
    const held = lifetime.current;
    release.current?.();
    if (held) await held;
    setTransferRequested(false);
  }

  function cancelRequest() {
    waiting.current?.abort();
    waiting.current = null;
    setRequesting(false);
  }

  return { owner, requesting, transferRequested, requestTransfer, cancelRequest, finishTransfer,
    keepEditing: () => setTransferRequested(false) };
}
