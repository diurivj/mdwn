import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { OutgoingShare } from "~/shared/sharing/relationships-client";
import {
  prepareShare,
  type SharePreparationProgress,
  selectAutomaticPreparations,
} from "~/shared/sharing/share-staging-client";
import { type SharingFailure, sharingFailure } from "~/shared/sharing/sharing-errors";
import { buttonClass, linkClass } from "~/ui/styles";

/**
 * **Prepare secure access** for a pending Share: this Owner device stages the
 * Grant and Comment-capability envelopes for every current recipient device.
 * Preparation is resumable and safe to repeat, so leaving the page only
 * pauses it.
 */

/** A secure access update must finish first; links to where the Owner runs it. */
export function SecureAccessUpdateRequired() {
  return (
    <>
      A secure access update for this item must finish first.{" "}
      <Link to="/account/key-rotations" className={linkClass}>
        Review secure access updates
      </Link>
    </>
  );
}

/** Why a preparation pass stopped, worded for the Owner. */
export function PreparationFailure({ failure }: { failure: SharingFailure }) {
  switch (failure) {
    case "sealed":
      return <SecureAccessUpdateRequired />;
    case "access":
      return <>Use an enrolled device with a current Session to prepare secure access.</>;
    case "changed":
      return <>This invitation or the recipient’s devices changed while secure access was being prepared. Try again.</>;
    case "not-found":
      return <>This invitation no longer exists. It may have been accepted, declined or cancelled.</>;
    case "missing-source":
      return (
        <>
          Access to some existing Comments on this item can’t be prepared from any device, so the recipient can’t accept
          yet.
        </>
      );
    case "too-large":
      return <>This item has too many recipient devices or Comment threads to prepare in one pass.</>;
    default:
      return <>Secure access could not be prepared. The invitation is kept; try Prepare secure access again.</>;
  }
}

export function progressLabel(progress: SharePreparationProgress | null): string {
  return progress && progress.total > 0
    ? `Preparing secure access… ${progress.prepared} of ${progress.total} keys`
    : "Preparing secure access…";
}

/** The row action on a pending outgoing Share. */
export function PrepareSecureAccess({ shareId, busy }: { shareId: string; busy: boolean }) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "working"; progress: SharePreparationProgress | null }
    | { kind: "done" }
    | { kind: "failed"; failure: SharingFailure }
  >({ kind: "idle" });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function run() {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setState({ kind: "working", progress: null });
    try {
      await prepareShare(shareId, {
        signal: current.signal,
        onProgress: (progress) => {
          if (!current.signal.aborted) setState({ kind: "working", progress });
        },
      });
      if (!current.signal.aborted) setState({ kind: "done" });
    } catch (error) {
      if (!current.signal.aborted) setState({ kind: "failed", failure: sharingFailure(error) });
    }
  }

  return (
    <div className="flex basis-full flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy || state.kind === "working"}
        onClick={() => void run()}
        className={buttonClass("secondary", "sm")}
      >
        Prepare secure access
      </button>
      {state.kind === "working" && (
        <p role="status" className="text-sm text-muted">
          {progressLabel(state.progress)}
        </p>
      )}
      {state.kind === "done" && (
        <p role="status" className="text-sm text-ink-soft">
          Secure access prepared. The recipient can accept now.
        </p>
      )}
      {state.kind === "failed" && (
        <p role="alert" className="text-sm text-warning">
          <PreparationFailure failure={state.failure} />
        </p>
      )}
    </div>
  );
}

/**
 * Prepare the newest pending Shares (`selectAutomaticPreparations`) once per
 * visit: recipient devices enrolled after an invitation get covered when the
 * Owner next opens Sharing. Failures stay quiet; the row action remains.
 */
export function useAutomaticPreparation(outgoing: readonly OutgoingShare[], enabled: boolean) {
  const [active, setActive] = useState(false);
  // Revalidation replaces the list; the visit's pass is chosen when it starts.
  const latest = useRef(outgoing);
  latest.current = outgoing;
  useEffect(() => {
    if (!enabled) return;
    const chosen = selectAutomaticPreparations(latest.current.map((share) => share.shareId));
    if (!chosen.length) return;
    const controller = new AbortController();
    setActive(true);
    void (async () => {
      for (const shareId of chosen) {
        if (controller.signal.aborted) return;
        try {
          await prepareShare(shareId, { signal: controller.signal });
        } catch {
          /* The row's Prepare secure access action reports failures. */
        }
      }
      if (!controller.signal.aborted) setActive(false);
    })();
    return () => {
      controller.abort();
      // A cancelled pass must not leave "Preparing…" showing.
      setActive(false);
    };
  }, [enabled]);
  return active;
}
