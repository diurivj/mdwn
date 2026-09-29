import { useEffect, useRef, useState } from "react";

import { getDevice } from "~/device/store";
import type { RootAccess } from "~/tree/client";
import { runPendingProvisioning } from "./needs-client";
import { runPendingRotations } from "./rotation-client";

type State = { status: "idle" } | { status: "running"; done: number; total: number } | { status: "failed" };

/** One runner per tab: a new check waits for the one in flight instead of racing it. */
let inFlight: Promise<number> | null = null;

/**
 * The Owner's browser replaces keys after a revoke, leave or permission change (ticket 19) and
 * then fulfils outstanding provisioning needs (ticket 20): rotation's barrier drains first, then
 * the current-epoch material is re-sealed for every active device an enrollment or recovery left
 * behind. Server access already ended; writes beneath the affected folder or File resume when it
 * finishes.
 */
export function RotationStatus({ access, trigger, onComplete }: { access: RootAccess; trigger: unknown;
  onComplete: () => void }) {
  const [state, setState] = useState<State>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const device = await getDevice(access.actorAccountId ?? access.vaultId);
        if (!device) return;
        const signer = { deviceId: device.deviceId, assertionKey: device.assertionKeyPair.privateKey };
        const report = (done: number, total: number) => {
          if (!cancelled && alive.current) setState({ status: "running", done, total });
        };
        inFlight ??= (async () => {
          const jobs = await runPendingRotations(access, signer,
            (progress) => report(progress.done, progress.total));
          const needs = await runPendingProvisioning(access, signer,
            (progress) => report(progress.done, progress.targets));
          return jobs + needs;
        })().finally(() => { inFlight = null; });
        const ran = await inFlight;
        if (cancelled || !alive.current) return;
        setState({ status: "idle" });
        if (ran) onComplete();
      } catch {
        if (!cancelled && alive.current) setState({ status: "failed" });
      }
    })();
    return () => { cancelled = true; };
  }, [access.vaultId, trigger, attempt]);

  if (state.status === "running") {
    return <p role="status" className="mt-3 text-sm">
      Replacing keys for shared content{state.total ? ` (${state.done} of ${state.total})` : ""}… Editing
      beneath it resumes when this finishes. Copies already downloaded can't be recalled.</p>;
  }
  if (state.status === "failed") {
    return <div role="alert" className="mt-3 text-sm">
      Replacing keys for shared content didn't finish. Access already ended; editing beneath it stays paused.
      <button type="button" className="ml-2 underline" onClick={() => setAttempt((value) => value + 1)}>
        Resume key replacement</button>
    </div>;
  }
  return null;
}
