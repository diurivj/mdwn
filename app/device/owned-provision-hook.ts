import { useEffect, useState } from "react";

import { finishOwnedProvisioning } from "./owned-provision-client";

/** Continue an owned-material job while its page remains open and hide status after completion. */
export function useOwnedProvisioning(needed: boolean): boolean {
  const [finished, setFinished] = useState(false);
  useEffect(() => {
    if (!needed) return;
    const controller = new AbortController();
    void finishOwnedProvisioning(controller.signal).then(() => {
      if (!controller.signal.aborted) setFinished(true);
    });
    return () => controller.abort();
  }, [needed]);
  return needed && !finished;
}
