import { useEffect, useRef, useState } from "react";
import { newOpaqueId } from "~/shared/opaque-id";

type LeaseState = "checking" | "owner" | "read-only" | "transferring" | "unavailable";
type Actions = { flush: () => Promise<boolean>; reload: () => Promise<boolean>; discard: () => Promise<void> };
type LeaseMessage = { type: "transfer" | "owner" | "declined"; requestId?: string };

/** Web Locks provide exclusivity; BroadcastChannel carries only opaque transfer messages, never drafts. */
export function useFileLease(accountId: string, fileId: string, actions: Actions) {
  const [state, setState] = useState<LeaseState>("checking");
  const [transferPrompt, setTransferPrompt] = useState(false);
  const [requested, setRequested] = useState(false);
  const actionsRef = useRef(actions); actionsRef.current = actions;
  const owner = useRef(false);
  const release = useRef<(() => void) | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const acquire = useRef<((wait: boolean, refresh: boolean) => void) | null>(null);
  const transferId = useRef<string | null>(null);
  const requestId = useRef<string | null>(null);
  const requestAbort = useRef<AbortController | null>(null);
  const alive = useRef(false);

  async function transfer(discard = false) {
    if (!owner.current || !transferId.current) return;
    setTransferPrompt(false); setState("transferring");
    if (discard) await actionsRef.current.discard();
    else if (!await actionsRef.current.flush()) {
      if (alive.current && owner.current) { setState("owner"); setTransferPrompt(true); }
      return;
    }
    if (!alive.current || !owner.current) return;
    transferId.current = null; owner.current = false; setState("read-only");
    release.current?.();
  }

  useEffect(() => {
    alive.current = true;
    if (!navigator.locks || typeof BroadcastChannel === "undefined") {
      setState("unavailable"); return () => { alive.current = false; };
    }
    const name = `mdwn:file-edit:${accountId}:${fileId}`;
    const messages = new BroadcastChannel(name);
    channel.current = messages;
    const controllers = new Set<AbortController>();
    function hold(wait: boolean, refresh: boolean) {
      const controller = new AbortController(); controllers.add(controller);
      if (wait) requestAbort.current = controller;
      void navigator.locks.request(name, wait ? { signal: controller.signal } : { ifAvailable: true }, async (lock) => {
        if (!alive.current || !lock) { if (alive.current) setState("read-only"); return; }
        if (refresh && !await actionsRef.current.reload()) {
          if (alive.current) setState("unavailable"); return;
        }
        if (!alive.current) return;
        owner.current = true; requestId.current = null;
        setRequested(false); setState("owner"); messages.postMessage({ type: "owner" } satisfies LeaseMessage);
        await new Promise<void>((resolve) => { release.current = resolve; });
        owner.current = false; release.current = null;
      }).catch((error: unknown) => {
        if (alive.current && !(error instanceof DOMException && error.name === "AbortError")) setState("unavailable");
      }).finally(() => controllers.delete(controller));
    }
    acquire.current = hold;
    messages.onmessage = (event: MessageEvent<LeaseMessage>) => {
      if (!alive.current || !event.data || typeof event.data !== "object") return;
      if (event.data.type === "transfer" && typeof event.data.requestId === "string" && owner.current && !transferId.current) {
        transferId.current = event.data.requestId; void transfer();
      } else if (event.data.type === "owner" && requestId.current) {
        messages.postMessage({ type: "transfer", requestId: requestId.current } satisfies LeaseMessage);
      } else if (event.data.type === "declined" && event.data.requestId === requestId.current) {
        requestAbort.current?.abort(); requestId.current = null; setRequested(false); setState("read-only");
      }
    };
    hold(false, false);
    const hide = () => { owner.current = false; release.current?.(); for (const c of controllers) c.abort(); };
    const show = (event: PageTransitionEvent) => { if (event.persisted) hold(false, true); };
    window.addEventListener("pagehide", hide); window.addEventListener("pageshow", show);
    return () => {
      alive.current = false; hide(); messages.close(); channel.current = null; acquire.current = null;
      window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", show);
    };
  }, [accountId, fileId]);

  function request() {
    if (owner.current || requested || !channel.current || !acquire.current) return;
    const id = newOpaqueId(); requestId.current = id; setRequested(true);
    channel.current.postMessage({ type: "transfer", requestId: id } satisfies LeaseMessage);
    acquire.current(true, true);
  }
  function keepEditing() {
    if (transferId.current) channel.current?.postMessage({ type: "declined", requestId: transferId.current } satisfies LeaseMessage);
    transferId.current = null; setTransferPrompt(false); setState("owner");
  }
  return { state, editable: state === "owner", owns: () => owner.current, requested, request,
    transferPrompt, transfer, keepEditing };
}
